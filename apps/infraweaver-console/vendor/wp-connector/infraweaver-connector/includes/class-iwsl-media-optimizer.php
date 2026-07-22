<?php
/**
 * Generic engine behind the gated "Lossless Image Optimization" feature.
 *
 * This is the payload behind the `image_optimization` entitlement, kept separate
 * from the gate (IWSL_Entitlements) and from the codecs (IWSL_Media_Converter
 * implementations) so each can be reasoned about — and tested — in isolation.
 *
 * TRUST MODEL. The feature is console-authoritative: the `image_optimization`
 * flag is written ONLY by the dual-signed `entitlements.set` runner (§7). There
 * is deliberately no self-set path, REST route, AJAX endpoint, cron, or nopriv
 * surface here — this class is a purely-local admin action, mirroring the
 * IWSL_Plus_Feature pattern. The gate is re-checked at three layers (admin page,
 * admin-post handler, and here in run() as STATEMENT 1). run()'s check is the
 * authoritative one: it survives any future caller that forgets the other two.
 *
 * RESIDUAL RISK (honest statement). A site owner with direct database write
 * access can flip the local entitlement option and unlock this without the
 * console — exactly the accepted threat model of the existing `plus` gate. That
 * is bounded by heartbeat staleness: if the console stops managing the site, the
 * signed heartbeat goes stale and the gate re-locks within HEARTBEAT_FRESH_MS
 * (2h), because evaluate() requires state==active AND a fresh signed contact,
 * not merely the flag.
 *
 * SAFETY. Originals are NEVER modified. Every derivative is written to a temp
 * sibling and atomically renamed; a derivative is kept only if it is strictly
 * smaller. No exec/shell_exec/proc_open — in-process Imagick/GD only. Every
 * source passes the full pre-decode gauntlet in guard_source() before any codec
 * sees it. WordPress calls are function_exists-guarded so the engine runs under
 * the zero-dependency test harness with an injected $base_dir + clock.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Media_Optimizer {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'image_optimization';

	/** Default images selected per run when the operator gives no count. */
	const MAX_BATCH = 10;
	/**
	 * Hard ceiling on how many images one run may REQUEST. The operator can ask
	 * for more than MAX_BATCH — the run self-chunks and is bounded by
	 * TIME_BUDGET_MS, reporting `partial` so the remainder is picked up next run.
	 * This is the "queue it as a batch" behaviour without any async surface.
	 */
	const MAX_REQUEST = 200;
	/** Upper bound on posts a single reference-rewrite / dedupe pass will touch. */
	const MAX_REWRITE_POSTS = 500;
	/** Modes: keep the original beside the WebP, or swap the original out for it. */
	const MODE_COPY = 'copy';
	const MODE_REPLACE = 'replace';
	/** Refuse any source larger than 25 MB before decode. */
	const MAX_SOURCE_BYTES = 26214400;
	/** Decompression-bomb ceiling: 40 megapixels. */
	const MAX_PIXELS = 40000000;
	/** Per-side ceiling — also WebP's own 16383px dimension limit. */
	const MAX_DIMENSION = 16383;
	/** Wall-clock budget for a run; stop and report partial past this. */
	const TIME_BUDGET_MS = 20000;
	/** Per-attachment post-meta key recording the derivative we produced. */
	const META_KEY = '_iwsl_media_optimizer';
	/** Transient name for the single-flight run lock. */
	const LOCK_TRANSIENT = 'iwsl_media_optimizer_lock';
	/** Run-lock TTL (seconds). */
	const LOCK_TTL = 60;

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var string Uploads base dir; realpath containment root for every path. */
	private $base_dir;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var array<string, IWSL_Media_Converter> id-keyed converter registry. */
	private $converters;

	/**
	 * @param IWSL_Entitlements                        $entitlements The gate.
	 * @param string|null                              $base_dir     Uploads basedir; defaults to
	 *                                                                wp_get_upload_dir()['basedir'] under WP.
	 *                                                                Injectable for the no-WP test harness.
	 * @param callable|null                            $now_ms       Clock, mirrors IWSL_Entitlements.
	 * @param array<string, IWSL_Media_Converter>|null $converters   Registry override (tests inject fakes);
	 *                                                                defaults to self::converters().
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?string $base_dir = null,
		?callable $now_ms = null,
		?array $converters = null
	) {
		$this->entitlements = $entitlements;
		$this->base_dir     = null !== $base_dir ? $base_dir : self::default_base_dir();
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		$this->converters = null !== $converters ? $converters : self::converters();
	}

	/** Uploads basedir under WordPress, or empty string outside it. */
	private static function default_base_dir(): string {
		if ( function_exists( 'wp_get_upload_dir' ) ) {
			$dir = wp_get_upload_dir();
			if ( is_array( $dir ) && isset( $dir['basedir'] ) && is_string( $dir['basedir'] ) ) {
				return $dir['basedir'];
			}
		}
		return '';
	}

	/**
	 * The id-keyed converter registry. Adding a format is one class + one line
	 * here — this is the "generic solution" the interface exists to enable.
	 *
	 * @return array<string, IWSL_Media_Converter>
	 */
	public static function converters(): array {
		return array(
			'webp_lossless' => new IWSL_WebP_Lossless_Converter(),
		);
	}

	/**
	 * Per-converter availability() for the admin capability table. Side-effect
	 * free — safe on every render.
	 *
	 * @return array<string, array{ id:string, label:string, accepts:string[], availability:array }>
	 */
	public function capabilities(): array {
		$out = array();
		foreach ( $this->converters as $id => $converter ) {
			$out[ $id ] = array(
				'id'           => $converter->id(),
				'label'        => $converter->label(),
				'accepts'      => $converter->accepts(),
				'availability' => $converter->availability(),
			);
		}
		return $out;
	}

	/** Converter ids for the admin `<select>` and handler allow-list. */
	public function converter_ids(): array {
		return array_keys( $this->converters );
	}

	/**
	 * Run one bounded batch of conversions. STATEMENT 1 is the authoritative
	 * entitlement gate — nothing below it runs for a locked site. Batch selection
	 * is always server-side: either the engine queries its own attachments by
	 * the converter's accepted MIMEs (auto), or — when the operator picked
	 * specific images via the media-library picker — the given `$ids` are used,
	 * but ONLY after each one is re-validated here as a real `attachment` post
	 * with an accepted MIME (see select_batch_from_ids()). Either path feeds the
	 * SAME convert_one(), which resolves the file path server-side and runs the
	 * full guard_source() gauntlet — no attachment path ever comes from the
	 * request, only ids, and only after this validation.
	 *
	 * @param int[] $ids Optional operator-picked attachment ids; empty falls back
	 *                    to the auto-selected batch (unchanged prior behaviour).
	 * @return array Immutable run summary.
	 */
	public function run( string $converter_id = 'webp_lossless', int $limit = self::MAX_BATCH, string $mode = self::MODE_COPY, bool $dry = false, string $types = 'auto', array $ids = array(), bool $rewrite = false, bool $skip_optimized = true ): array {
		$limit = max( 1, min( self::MAX_REQUEST, $limit ) );
		$mode  = self::MODE_REPLACE === $mode ? self::MODE_REPLACE : self::MODE_COPY;
		$gate  = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array(
				'ok'        => false,
				'reason'    => 'entitlement-locked',
				'gate'      => $gate,
				'converted' => 0,
			);
		}

		$converter = $this->converters[ $converter_id ] ?? null;
		if ( ! $converter instanceof IWSL_Media_Converter ) {
			return self::refusal( 'unknown-converter' );
		}

		$avail = $converter->availability();
		if ( empty( $avail['ok'] ) ) {
			return self::refusal( 'engine-unavailable', array( 'engine_reason' => (string) $avail['reason'] ) );
		}

		// Resolve the source-type filter to a concrete MIME allow-list. 'auto'
		// means every type the converter accepts; a specific value narrows to it
		// (and is intersected with accepts() so an unknown value selects nothing).
		$accepted = $converter->accepts();
		$mimes    = ( 'auto' === $types )
			? $accepted
			: array_values( array_intersect( $accepted, array( $types ) ) );

		if ( ! $this->acquire_lock() ) {
			return self::refusal( 'busy' );
		}

		$started = ( $this->now_ms )();
		$summary = array(
			'ok'          => true,
			'mode'        => $mode,
			'dry'         => $dry,
			'requested'   => $limit,
			'types'       => $types,
			'source'      => array() === $ids ? 'auto' : 'selection',
			'converter'   => $converter->id(),
			'engine'      => (string) $avail['engine'],
			'converted'   => 0,
			'skipped'     => 0,
			'refused'     => 0,
			'bytes_in'    => 0,
			'bytes_out'   => 0,
			'saved_bytes' => 0,
			'items'        => array(),
			'partial'      => false,
			'rewrote_posts' => 0,
			'elapsed_ms'   => 0,
		);

		// Rewriting page references is a copy-mode-only, live-run-only extra: a dry
		// preview must never touch post content, and replace mode already repoints
		// the canonical attachment (no dangling original URL to rewrite).
		$do_rewrite = $rewrite && ! $dry && self::MODE_COPY === $mode;

		$batch = array() !== $ids
			? $this->select_batch_from_ids( $ids, $mimes, $limit )
			: $this->select_batch( $converter, $limit, $mimes, $skip_optimized );

		try {
			foreach ( $batch as $attachment_id ) {
				if ( ( ( $this->now_ms )() - $started ) >= self::TIME_BUDGET_MS ) {
					$summary['partial'] = true;
					break;
				}
				$result  = $this->convert_one( (int) $attachment_id, $converter, $mode, $dry, $mimes, $do_rewrite );
				$summary = self::fold_result( $summary, $result );
				if ( isset( $result['rewrote'] ) ) {
					$summary['rewrote_posts'] += (int) $result['rewrote'];
				}
			}
		} finally {
			$this->release_lock();
		}

		$summary['elapsed_ms'] = max( 0, ( $this->now_ms )() - $started );
		return $summary;
	}

	/**
	 * Dry-run estimate: convert each candidate to a temp file, measure the exact
	 * WebP size, discard it, and report the total data a real run would save. No
	 * file is kept and no attachment is touched. Same gate + time budget as run(),
	 * so a large request is bounded and reports `partial` when the clock runs out.
	 *
	 * @param int[] $ids Optional operator-picked attachment ids; see run().
	 */
	public function preview( string $converter_id = 'webp_lossless', int $limit = self::MAX_BATCH, string $types = 'auto', array $ids = array(), bool $skip_optimized = true ): array {
		return $this->run( $converter_id, $limit, self::MODE_COPY, true, $types, $ids, false, $skip_optimized );
	}

	/**
	 * Whole-library optimization counters — the source of truth for the progress
	 * popup and its AJAX status endpoint. Returns { total, optimized, remaining }:
	 *
	 *   - total     — image attachments this engine CAN optimize: post_mime_type is
	 *                 in the union of every registered converter's accepted MIMEs, so
	 *                 already-produced WebP derivatives and non-optimizable attachments
	 *                 are excluded (this is the same candidate set select_batch() draws
	 *                 from, so `remaining` tracks what a run actually has left to do);
	 *   - optimized — how many of those already carry this optimizer's derivative
	 *                 tracking meta (self::META_KEY) — i.e. already have an up-to-date
	 *                 lossless copy on record;
	 *   - remaining — max( 0, total - optimized ).
	 *
	 * Two efficient COUNT(*) queries (mirrors the parameterised $wpdb pattern used by
	 * rewrite_post_references()). No user input reaches SQL — the MIME allow-list is
	 * derived from the converter registry and bound through prepare(). Fully guarded:
	 * returns all-zeros outside a WordPress $wpdb context (the no-WP test harness).
	 *
	 * @return array{ total:int, optimized:int, remaining:int }
	 */
	public function library_stats(): array {
		$zero = array( 'total' => 0, 'optimized' => 0, 'remaining' => 0 );

		global $wpdb;
		if ( ! isset( $wpdb ) || ! is_object( $wpdb )
			|| ! method_exists( $wpdb, 'get_var' ) || ! method_exists( $wpdb, 'prepare' ) ) {
			return $zero;
		}

		$mimes = $this->optimizable_mimes();
		if ( array() === $mimes ) {
			return $zero;
		}
		$placeholders = implode( ',', array_fill( 0, count( $mimes ), '%s' ) );

		$total = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->posts}
				 WHERE post_type = 'attachment' AND post_status = 'inherit'
				   AND post_mime_type IN ($placeholders)",
				...$mimes
			)
		);

		$meta_args = array_merge( $mimes, array( self::META_KEY ) );
		$optimized = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->posts} p
				 INNER JOIN {$wpdb->postmeta} m ON m.post_id = p.ID
				 WHERE p.post_type = 'attachment' AND p.post_status = 'inherit'
				   AND p.post_mime_type IN ($placeholders)
				   AND m.meta_key = %s",
				...$meta_args
			)
		);

		$optimized = min( $optimized, $total ); // defensive: subset can never exceed total.
		return array(
			'total'     => $total,
			'optimized' => $optimized,
			'remaining' => max( 0, $total - $optimized ),
		);
	}

	/**
	 * The union of every registered converter's accepted MIME types — the full set
	 * of image types this engine can turn into a WebP. Order-stable, de-duplicated.
	 *
	 * @return string[]
	 */
	private function optimizable_mimes(): array {
		$out = array();
		foreach ( $this->converters as $converter ) {
			foreach ( $converter->accepts() as $mime ) {
				if ( is_string( $mime ) && '' !== $mime && ! in_array( $mime, $out, true ) ) {
					$out[] = $mime;
				}
			}
		}
		return $out;
	}

	/**
	 * Server-side batch selection: this site's own attachments whose MIME is on
	 * the converter's allow-list, oldest id first, capped at MAX_BATCH. Returns
	 * an empty list outside WordPress.
	 *
	 * @return int[]
	 */
	private function select_batch( IWSL_Media_Converter $converter, int $limit = self::MAX_BATCH, array $mimes = array(), bool $skip_optimized = true ): array {
		if ( ! function_exists( 'get_posts' ) ) {
			return array();
		}
		if ( array() === $mimes ) {
			$mimes = $converter->accepts();
		}
		if ( array() === $mimes ) {
			return array(); // A type filter that matched nothing selects nothing.
		}
		$limit = max( 1, min( self::MAX_REQUEST, $limit ) );
		$args  = array(
			'post_type'        => 'attachment',
			'post_status'      => 'inherit',
			'post_mime_type'   => $mimes,
			'fields'           => 'ids',
			'posts_per_page'   => $limit,
			'orderby'          => 'ID',
			'order'            => 'ASC',
			'suppress_filters' => true,
		);
		// "Only optimize images not already optimized": exclude any attachment that
		// already carries this optimizer's derivative-tracking meta, so a repeat run
		// advances to genuinely NEW images and can never re-process (or duplicate) a
		// source it has already converted. Off = re-scan everything (convert_one is
		// still idempotent, so it only re-encodes a source whose bytes/mtime changed).
		if ( $skip_optimized ) {
			$args['meta_query'] = array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
				array(
					'key'     => self::META_KEY,
					'compare' => 'NOT EXISTS',
				),
			);
		}
		$ids = get_posts( $args );
		return is_array( $ids ) ? array_map( 'intval', $ids ) : array();
	}

	/**
	 * Validate an operator-supplied id list from the media-library picker.
	 * UNTRUSTED INPUT: every id is re-checked here, server-side, before it is
	 * ever handed to convert_one() — kept ONLY if `get_post( $id )` is a real
	 * `attachment` post AND `get_post_mime_type( $id )` is in the effective
	 * accepted MIME set for this run. Order is preserved (the order the
	 * operator picked them in), capped at $limit. This is defense-in-depth
	 * alongside convert_one()'s own guard_source() gauntlet — an id that
	 * passes this check still has its file path resolved server-side and
	 * still passes the full pre-decode security checks; nothing here ever
	 * trusts a path from the request.
	 *
	 * @param int[]    $ids   Candidate attachment ids (already deduped/capped by the caller).
	 * @param string[] $mimes Effective accepted MIME set for this run.
	 * @param int      $limit Maximum ids to return.
	 * @return int[]
	 */
	private function select_batch_from_ids( array $ids, array $mimes, int $limit ): array {
		if ( array() === $mimes || ! function_exists( 'get_post' ) || ! function_exists( 'get_post_mime_type' ) ) {
			return array();
		}
		$limit = max( 1, min( self::MAX_REQUEST, $limit ) );
		$out   = array();
		foreach ( $ids as $id ) {
			$id = (int) $id;
			if ( $id <= 0 ) {
				continue;
			}
			$post = get_post( $id );
			if ( ! $post || ! isset( $post->post_type ) || 'attachment' !== $post->post_type ) {
				continue;
			}
			$mime = get_post_mime_type( $id );
			if ( ! is_string( $mime ) || ! in_array( $mime, $mimes, true ) ) {
				continue;
			}
			$out[] = $id;
			if ( count( $out ) >= $limit ) {
				break;
			}
		}
		return $out;
	}

	/**
	 * Convert a single attachment. Resolves the path server-side (never from
	 * request input), runs the full gauntlet, honours idempotency, writes a temp
	 * sibling then atomically renames, and keeps the derivative only if it is
	 * strictly smaller. NEVER touches _wp_attached_file, never regenerates
	 * attachment metadata, never registers a new attachment, never modifies or
	 * unlinks the original.
	 *
	 * @return array{ id:int, basename:string, outcome:string, reason?:string, saving?:int, bytes_in?:int, bytes_out?:int }
	 */
	private function convert_one( int $attachment_id, IWSL_Media_Converter $converter, string $mode = self::MODE_COPY, bool $dry = false, array $mimes = array(), bool $rewrite = false ): array {
		$source = $this->resolve_source_path( $attachment_id );
		$basename = '' === $source ? '' : basename( $source );
		if ( '' === $source ) {
			return self::item( $attachment_id, $basename, 'refused', 'no-source-path' );
		}

		$guard = $this->guard_source( $source, array() === $mimes ? $converter->accepts() : $mimes );
		if ( empty( $guard['ok'] ) ) {
			return self::item( $attachment_id, basename( $source ), 'refused', (string) $guard['reason'] );
		}

		$src_size  = (int) $guard['filesize'];
		$src_mtime = (int) $guard['mtime'];

		// Destination is a contained sibling: foo.png → foo.webp.
		$dest = $this->derivative_path( $source );
		if ( '' === $dest ) {
			return self::item( $attachment_id, basename( $source ), 'refused', 'dest-escape' );
		}

		// Idempotency (copy mode only): an up-to-date derivative already exists for
		// this exact source — skip without re-decoding. Replace mode and dry-run
		// previews always proceed so a swap actually happens / an estimate is shown.
		if ( ! $dry && self::MODE_COPY === $mode
			&& $this->is_current( $attachment_id, $converter, $src_size, $src_mtime, $dest ) ) {
			// Self-heal: an up-to-date derivative on disk may predate attachment
			// registration (or its copy attachment was deleted). Ensure it is in
			// the Media Library before reporting the skip — idempotent, so a copy
			// that already exists is reused, not duplicated.
			$copy_id = $this->register_copy_attachment( $attachment_id, $dest );
			$item    = self::item( $attachment_id, basename( $source ), 'skipped', 'already-current' );
			if ( $copy_id > 0 ) {
				$item['copy_id'] = $copy_id;
				if ( $rewrite ) {
					$item['rewrote'] = $this->rewrite_post_references( $attachment_id, $copy_id );
				}
			}
			return $item;
		}

		$tmp = $dest . '.iwsltmp';
		$this->safe_unlink( $tmp ); // clear any orphaned temp from a crashed run.

		$result = $converter->convert( $source, $tmp );
		if ( empty( $result['ok'] ) ) {
			$this->safe_unlink( $tmp );
			return self::item( $attachment_id, basename( $source ), 'refused', (string) ( $result['reason'] ?? 'convert-failed' ) );
		}

		$bytes_in  = (int) $result['bytes_in'];
		$bytes_out = (int) $result['bytes_out'];

		// Keep only if strictly smaller — a WebP that is not smaller is not worth
		// the extra file. Unlink ONLY the derivative this run just wrote.
		if ( $bytes_out <= 0 || $bytes_out >= $bytes_in ) {
			$this->safe_unlink( $tmp );
			$item              = self::item( $attachment_id, basename( $source ), 'skipped', 'no-savings' );
			$item['bytes_in']  = $bytes_in;
			$item['bytes_out'] = $bytes_out;
			return $item;
		}

		// Dry-run preview: the exact WebP size is now known — report the saving and
		// discard the temp. No rename, no meta, no attachment change whatsoever.
		if ( $dry ) {
			$this->safe_unlink( $tmp );
			$item              = self::item( $attachment_id, basename( $source ), 'converted' );
			$item['bytes_in']  = $bytes_in;
			$item['bytes_out'] = $bytes_out;
			$item['saving']    = $bytes_in - $bytes_out;
			return $item;
		}

		// Atomic publish: rename temp → final derivative.
		if ( ! @rename( $tmp, $dest ) ) {
			$this->safe_unlink( $tmp );
			return self::item( $attachment_id, basename( $source ), 'refused', 'rename-failed' );
		}

		$dest_rel = $this->relative_to_base( $dest );
		$this->write_meta( $attachment_id, $converter, $src_size, $src_mtime, $dest_rel, $bytes_in, $bytes_out );

		$item              = self::item( $attachment_id, basename( $source ), 'converted' );
		$item['bytes_in']  = $bytes_in;
		$item['bytes_out'] = $bytes_out;
		$item['saving']    = $bytes_in - $bytes_out;

		// Replace mode: promote the WebP to the canonical attachment file and
		// remove the original. Best-effort + fail-safe — a failed swap keeps the
		// original intact and is reported per item.
		if ( self::MODE_REPLACE === $mode ) {
			$rep              = $this->replace_original( $attachment_id, $source, $dest );
			$item['replaced'] = ! empty( $rep['ok'] );
			if ( empty( $rep['ok'] ) ) {
				$item['replace_reason'] = (string) ( $rep['reason'] ?? 'replace-failed' );
			}
			return $item;
		}

		// Copy mode: the WebP sits beside the original AND is registered as its
		// own Media Library attachment, so it is visible and reusable — the "add
		// WebP copy" the UI promises. Without this the derivative is an orphan file
		// WordPress never lists. Idempotent: a copy already registered is reused.
		$copy_id = $this->register_copy_attachment( $attachment_id, $dest );
		if ( $copy_id > 0 ) {
			$item['copy_id'] = $copy_id;
			if ( $rewrite ) {
				$item['rewrote'] = $this->rewrite_post_references( $attachment_id, $copy_id );
			}
		}
		return $item;
	}

	/**
	 * COPY-mode publication: register the derivative WebP as its own Media Library
	 * attachment so operators can see and reuse it. Idempotent — if a live copy
	 * attachment already points at this exact file, it is reused (never duplicated
	 * on re-runs or source changes). Fully WordPress-guarded: returns 0 outside a
	 * WP context (the no-WP test harness), leaving behaviour there unchanged.
	 *
	 * @return int New or existing attachment id, or 0 when none could be created.
	 */
	private function register_copy_attachment( int $source_id, string $dest_webp ): int {
		if ( ! function_exists( 'wp_insert_attachment' ) || ! is_file( $dest_webp ) ) {
			return 0;
		}

		$existing = $this->existing_copy_id( $source_id, $dest_webp );
		if ( $existing > 0 ) {
			return $existing;
		}

		$parent = function_exists( 'get_post_field' ) ? (int) get_post_field( 'post_parent', $source_id ) : 0;
		$title  = pathinfo( $dest_webp, PATHINFO_FILENAME );
		$new_id = wp_insert_attachment(
			array(
				'post_mime_type' => 'image/webp',
				'post_title'     => '' !== $title ? $title : basename( $dest_webp ),
				'post_content'   => '',
				'post_status'    => 'inherit',
				'post_parent'    => $parent,
			),
			$dest_webp,
			$parent,
			true
		);
		if ( ( function_exists( 'is_wp_error' ) && is_wp_error( $new_id ) ) || ! is_int( $new_id ) || $new_id <= 0 ) {
			return 0;
		}

		// Generate sub-sizes + metadata for the new WebP attachment (best-effort).
		if ( ! function_exists( 'wp_generate_attachment_metadata' ) && defined( 'ABSPATH' ) ) {
			require_once ABSPATH . 'wp-admin/includes/image.php';
		}
		if ( function_exists( 'wp_generate_attachment_metadata' ) && function_exists( 'wp_update_attachment_metadata' ) ) {
			$meta = wp_generate_attachment_metadata( $new_id, $dest_webp );
			if ( is_array( $meta ) && array() !== $meta ) {
				wp_update_attachment_metadata( $new_id, $meta );
			}
		}

		$this->remember_copy_id( $source_id, $new_id );
		return (int) $new_id;
	}

	/**
	 * The live copy attachment recorded for a source, or 0. A recorded id counts
	 * only if it is still a real `attachment` whose file is exactly our derivative
	 * — so a deleted or repointed copy is treated as absent and re-created.
	 */
	private function existing_copy_id( int $source_id, string $dest_webp ): int {
		$meta = $this->read_meta( $source_id );
		if ( ! is_array( $meta ) || empty( $meta['copy_id'] ) ) {
			return 0;
		}
		$cid = (int) $meta['copy_id'];
		if ( $cid <= 0 || ! function_exists( 'get_post' ) ) {
			return 0;
		}
		$post = get_post( $cid );
		if ( ! $post || 'attachment' !== $post->post_type ) {
			return 0;
		}
		if ( function_exists( 'get_attached_file' ) ) {
			$file = get_attached_file( $cid );
			$real = ( is_string( $file ) && '' !== $file ) ? realpath( $file ) : false;
			if ( false === $real || $real !== realpath( $dest_webp ) ) {
				return 0;
			}
		}
		return $cid;
	}

	/** Record the copy attachment id on the source's derivative meta (merge-in). */
	private function remember_copy_id( int $source_id, int $copy_id ): void {
		if ( ! function_exists( 'update_post_meta' ) ) {
			return;
		}
		$meta = $this->read_meta( $source_id );
		if ( ! is_array( $meta ) ) {
			$meta = array();
		}
		$meta['copy_id'] = $copy_id;
		update_post_meta( $source_id, self::META_KEY, $meta );
	}

	/**
	 * Rewrite every reference to a source image's URLs in post content over to its
	 * WebP copy — the "replace the images on my pages too" companion to copy mode.
	 * The URL map is built server-side from BOTH attachments' metadata (full size +
	 * every shared-dimension sub-size), so `src` and `srcset` entries flip together.
	 * Bounded to MAX_REWRITE_POSTS posts; parameterised LIKE anchor + PHP str_replace
	 * (no user input reaches SQL). Returns the number of posts actually changed.
	 */
	private function rewrite_post_references( int $source_id, int $copy_id, int $max = self::MAX_REWRITE_POSTS ): int {
		if ( $copy_id <= 0 || ! function_exists( 'wp_get_attachment_url' ) ) {
			return 0;
		}
		$map = $this->url_replacement_map( $source_id, $copy_id );
		if ( array() === $map ) {
			return 0;
		}

		global $wpdb;
		if ( ! isset( $wpdb ) || ! is_object( $wpdb ) || ! method_exists( $wpdb, 'get_results' ) ) {
			return 0;
		}

		// Anchor the scan on the source's filename stem (basename without extension):
		// it appears in every size variant's URL, so one LIKE catches src + srcset.
		$src_url = (string) wp_get_attachment_url( $source_id );
		$stem    = pathinfo( $src_url, PATHINFO_FILENAME );
		if ( '' === $stem ) {
			return 0;
		}
		$like = '%' . $wpdb->esc_like( $stem ) . '%';
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT ID, post_content FROM {$wpdb->posts}
				 WHERE post_status NOT IN ('trash','auto-draft')
				   AND post_content LIKE %s
				 LIMIT %d",
				$like,
				max( 1, min( self::MAX_REWRITE_POSTS, $max ) )
			)
		);
		if ( ! is_array( $rows ) ) {
			return 0;
		}

		$search  = array_keys( $map );
		$replace = array_values( $map );
		$changed = 0;
		foreach ( $rows as $row ) {
			$content = (string) $row->post_content;
			$updated = str_replace( $search, $replace, $content );
			if ( $updated === $content ) {
				continue; // stem matched but no exact URL present — leave untouched.
			}
			$ok = $wpdb->update( $wpdb->posts, array( 'post_content' => $updated ), array( 'ID' => (int) $row->ID ) );
			if ( false !== $ok ) {
				++$changed;
				if ( function_exists( 'clean_post_cache' ) ) {
					clean_post_cache( (int) $row->ID );
				}
			}
		}
		return $changed;
	}

	/**
	 * old-URL => new-URL map from a source attachment to its WebP copy: the full
	 * size plus every sub-size the two share by exact WxH dimension (so a rewrite
	 * never points at a size the WebP does not have). URLs are derived from WP,
	 * never from the request. Empty outside a WP context.
	 *
	 * @return array<string,string>
	 */
	private function url_replacement_map( int $source_id, int $copy_id ): array {
		if ( ! function_exists( 'wp_get_attachment_url' ) ) {
			return array();
		}
		$src_full = (string) wp_get_attachment_url( $source_id );
		$dst_full = (string) wp_get_attachment_url( $copy_id );
		if ( '' === $src_full || '' === $dst_full ) {
			return array();
		}
		$map          = array( $src_full => $dst_full );
		$src_meta     = function_exists( 'wp_get_attachment_metadata' ) ? wp_get_attachment_metadata( $source_id ) : array();
		$dst_meta     = function_exists( 'wp_get_attachment_metadata' ) ? wp_get_attachment_metadata( $copy_id ) : array();
		$src_base_url = self::url_dir( $src_full );
		$dst_base_url = self::url_dir( $dst_full );

		if ( is_array( $src_meta ) && ! empty( $src_meta['sizes'] ) && is_array( $src_meta['sizes'] )
			&& is_array( $dst_meta ) && ! empty( $dst_meta['sizes'] ) && is_array( $dst_meta['sizes'] ) ) {
			foreach ( $src_meta['sizes'] as $s ) {
				if ( ! is_array( $s ) || ! isset( $s['file'], $s['width'], $s['height'] ) ) {
					continue;
				}
				$dim = (int) $s['width'] . 'x' . (int) $s['height'];
				foreach ( $dst_meta['sizes'] as $d ) {
					if ( is_array( $d ) && isset( $d['file'], $d['width'], $d['height'] )
						&& $dim === (int) $d['width'] . 'x' . (int) $d['height'] ) {
						$map[ $src_base_url . basename( (string) $s['file'] ) ] = $dst_base_url . basename( (string) $d['file'] );
						break;
					}
				}
			}
		}
		return $map;
	}

	/** The directory portion of a URL, trailing slash included ('' if none). */
	private static function url_dir( string $url ): string {
		$pos = strrpos( $url, '/' );
		return false === $pos ? '' : substr( $url, 0, $pos + 1 );
	}

	/**
	 * Remove originals that already have an up-to-date optimized WebP copy — the
	 * "de-duplicate what I optimized" cleanup for copy mode. For each such source
	 * the page references are repointed to the WebP FIRST (unless $rewrite is
	 * false), THEN the original attachment (and its files) is deleted, so no page
	 * is left pointing at a removed file. Entitlement-gated + single-flight locked
	 * like run(); bounded by $limit; `$dry` counts without deleting anything.
	 *
	 * @return array Immutable summary ({ kind:'dedupe', removed, skipped, ... }).
	 */
	public function remove_optimized_duplicates( bool $dry = false, bool $rewrite = true, int $limit = self::MAX_REQUEST ): array {
		$limit = max( 1, min( self::MAX_REQUEST, $limit ) );
		$gate  = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'kind' => 'dedupe', 'reason' => 'entitlement-locked', 'gate' => $gate, 'removed' => 0 );
		}
		if ( ! function_exists( 'get_posts' ) || ! function_exists( 'wp_delete_attachment' ) ) {
			return array( 'ok' => false, 'kind' => 'dedupe', 'reason' => 'no-wp-context', 'removed' => 0 );
		}
		if ( ! $this->acquire_lock() ) {
			return array( 'ok' => false, 'kind' => 'dedupe', 'reason' => 'busy', 'removed' => 0 );
		}

		$summary = array(
			'ok'            => true,
			'kind'          => 'dedupe',
			'dry'           => $dry,
			'removed'       => 0,
			'skipped'       => 0,
			'rewrote_posts' => 0,
			'freed_bytes'   => 0,
			'items'         => array(),
		);

		try {
			$candidates = get_posts(
				array(
					'post_type'        => 'attachment',
					'post_status'      => 'inherit',
					'fields'           => 'ids',
					'posts_per_page'   => $limit,
					'meta_key'         => self::META_KEY, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
					'orderby'          => 'ID',
					'order'            => 'ASC',
					'suppress_filters' => true,
				)
			);
			$candidates = is_array( $candidates ) ? $candidates : array();

			foreach ( $candidates as $source_id ) {
				$source_id = (int) $source_id;
				$src_path  = $this->resolve_source_path( $source_id );
				$dest      = '' === $src_path ? '' : $this->derivative_path( $src_path );
				$copy_id   = ( '' === $dest ) ? 0 : $this->existing_copy_id( $source_id, $dest );
				$basename  = '' === $src_path ? (string) $source_id : basename( $src_path );

				if ( $copy_id <= 0 ) {
					++$summary['skipped'];
					$summary['items'][] = self::item( $source_id, $basename, 'skipped', 'no-optimized-copy' );
					continue;
				}

				$src_size = ( '' !== $src_path && is_file( $src_path ) ) ? (int) filesize( $src_path ) : 0;

				if ( $dry ) {
					++$summary['removed'];
					$summary['freed_bytes'] += $src_size;
					$summary['items'][]      = self::item( $source_id, $basename, 'removed', 'would-remove' );
					continue;
				}

				if ( $rewrite ) {
					$summary['rewrote_posts'] += $this->rewrite_post_references( $source_id, $copy_id );
				}

				$deleted = wp_delete_attachment( $source_id, true );
				if ( false === $deleted || null === $deleted ) {
					++$summary['skipped'];
					$summary['items'][] = self::item( $source_id, $basename, 'refused', 'delete-failed' );
					continue;
				}
				++$summary['removed'];
				$summary['freed_bytes'] += $src_size;
				$summary['items'][]      = self::item( $source_id, $basename, 'removed', '' );
			}
		} finally {
			$this->release_lock();
		}
		return $summary;
	}

	/**
	 * Teardown: remove this engine's ENTIRE persistent bookkeeping footprint —
	 * the per-attachment derivative-tracking meta (self::META_KEY, which also
	 * carries the registered copy_id) and the single-flight run-lock transient.
	 * Idempotent (check-before-delete) and cheap when already clean: a second
	 * call finds nothing to remove and reports zeros. NEVER touches original
	 * uploads, WebP derivative files already written to disk, the Media Library
	 * copy attachments themselves, or any core WordPress postmeta — only the
	 * bookkeeping this class itself created. Every WP/$wpdb call is guarded so
	 * this runs cleanly under the zero-dependency test harness.
	 *
	 * @return array{ options:int, meta:int, cron:bool, locks:int }
	 */
	public function purge(): array {
		$meta = 0;
		global $wpdb;
		if ( isset( $wpdb ) && is_object( $wpdb ) && method_exists( $wpdb, 'delete' ) ) {
			$deleted = $wpdb->delete( $wpdb->postmeta, array( 'meta_key' => self::META_KEY ) );
			$meta    = is_int( $deleted ) ? $deleted : 0;
		}

		$locks = 0;
		if ( function_exists( 'get_transient' ) && function_exists( 'delete_transient' )
			&& false !== get_transient( self::LOCK_TRANSIENT ) ) {
			delete_transient( self::LOCK_TRANSIENT );
			$locks = 1;
		}

		// This engine persists no settings of its own (no IWSL_Store instance) —
		// 'options' is always 0, kept in the shape for uniformity across engines.
		return array( 'options' => 0, 'meta' => $meta, 'cron' => false, 'locks' => $locks );
	}

	/**
	 * Destructive REPLACE path (opt-in). Points the attachment at the WebP, fixes
	 * its MIME, regenerates sub-sizes as WebP, then deletes the original PNG and
	 * its stale sub-size files. Every step is guarded so a partial failure still
	 * leaves a servable attachment; the PNG is only unlinked AFTER the swap.
	 *
	 * Caveat surfaced to the operator in the UI: any hardcoded `.png` URL in post
	 * content will 404 after replacement — that is the accepted trade of this mode.
	 *
	 * @return array{ ok:bool, reason?:string }
	 */
	private function replace_original( int $attachment_id, string $source_png, string $dest_webp ): array {
		if ( ! function_exists( 'update_attached_file' ) || ! function_exists( 'wp_update_attachment_metadata' ) ) {
			return array( 'ok' => false, 'reason' => 'no-wp-context' );
		}

		$old_meta = function_exists( 'wp_get_attachment_metadata' ) ? wp_get_attachment_metadata( $attachment_id ) : array();
		$dir      = dirname( $source_png );

		// Repoint the attachment at the WebP and correct its MIME first, so even if
		// a later step fails the site already serves the (smaller) WebP.
		update_attached_file( $attachment_id, $dest_webp );
		if ( function_exists( 'wp_update_post' ) ) {
			wp_update_post( array( 'ID' => $attachment_id, 'post_mime_type' => 'image/webp' ) );
		}

		// Regenerate sub-sizes from the WebP.
		if ( ! function_exists( 'wp_generate_attachment_metadata' ) && defined( 'ABSPATH' ) ) {
			require_once ABSPATH . 'wp-admin/includes/image.php';
		}
		if ( function_exists( 'wp_generate_attachment_metadata' ) ) {
			$new_meta = wp_generate_attachment_metadata( $attachment_id, $dest_webp );
			if ( is_array( $new_meta ) && array() !== $new_meta ) {
				wp_update_attachment_metadata( $attachment_id, $new_meta );
			}
		}

		// Purge the original PNG and its now-stale sub-size files (same directory).
		// New sub-sizes carry a .webp extension, so there is no name collision.
		$this->safe_unlink( $source_png );
		if ( is_array( $old_meta ) && isset( $old_meta['sizes'] ) && is_array( $old_meta['sizes'] ) ) {
			foreach ( $old_meta['sizes'] as $size ) {
				if ( isset( $size['file'] ) && is_string( $size['file'] ) ) {
					$this->safe_unlink( $dir . '/' . basename( $size['file'] ) );
				}
			}
		}

		// The WebP is now the canonical file, not a sibling derivative — drop meta.
		if ( function_exists( 'delete_post_meta' ) ) {
			delete_post_meta( $attachment_id, self::META_KEY );
		}
		return array( 'ok' => true );
	}

	/**
	 * The full pre-decode security gauntlet (§C). Engine-independent caps are
	 * authoritative — they refuse before any codec (Imagick/GD) touches the file.
	 * Returns { ok, reason, filesize, mtime, width, height }.
	 *
	 * @return array{ ok:bool, reason:string, filesize:int, mtime:int, width:int, height:int }
	 */
	private function guard_source( string $path, array $accepted_mimes ): array {
		if ( function_exists( 'wp_raise_memory_limit' ) ) {
			wp_raise_memory_limit( 'image' );
		}

		// (1) Path traversal / symlink escape — realpath must resolve INSIDE the
		//     uploads base dir. Paths only ever come from get_attached_file(), but
		//     a symlink planted in uploads could still point out; realpath follows
		//     it, so the containment check catches the escape.
		$real_base = '' === $this->base_dir ? false : realpath( $this->base_dir );
		$real      = realpath( $path );
		if ( false === $real_base || false === $real
			|| 0 !== strpos( $real, rtrim( $real_base, '/' ) . '/' ) ) {
			return self::guard_fail( 'path-escape' );
		}
		if ( ! is_file( $real ) ) {
			return self::guard_fail( 'not-a-file' );
		}

		// (2) Byte ceiling — refuse oversize before any decode.
		$size = (int) filesize( $real );
		if ( $size <= 0 || $size > self::MAX_SOURCE_BYTES ) {
			return self::guard_fail( 'too-large' );
		}

		// (3) MIME by CONTENT, never extension. getimagesize reads the header
		//     (IHDR) without decoding pixels; the sniffed type must be on the
		//     converter's accept list (PNG here).
		$info = @getimagesize( $real );
		if ( false === $info || ! isset( $info[0], $info[1], $info[2] ) ) {
			return self::guard_fail( 'unreadable-image' );
		}
		if ( ! in_array( (int) $info[2], self::accepted_imagetypes( $accepted_mimes ), true ) ) {
			return self::guard_fail( 'mime-mismatch' );
		}

		// (4) Decompression / pixel bomb — reject huge geometries pre-decode.
		$width  = (int) $info[0];
		$height = (int) $info[1];
		if ( $width < 1 || $height < 1 ) {
			return self::guard_fail( 'bad-dimensions' );
		}
		if ( $width > self::MAX_DIMENSION || $height > self::MAX_DIMENSION ) {
			return self::guard_fail( 'dimension-too-large' );
		}
		if ( $width * $height > self::MAX_PIXELS ) {
			return self::guard_fail( 'too-many-pixels' );
		}

		// (5) Belt-and-braces: finfo must AGREE it is a PNG when available.
		if ( function_exists( 'finfo_open' ) ) {
			$finfo = finfo_open( FILEINFO_MIME_TYPE );
			if ( false !== $finfo ) {
				$mime = finfo_file( $finfo, $real );
				finfo_close( $finfo );
				if ( ! in_array( (string) $mime, self::accepted_finfo_mimes( $accepted_mimes ), true ) ) {
					return self::guard_fail( 'mime-mismatch' );
				}
			}
		}

		$mtime = (int) @filemtime( $real );
		return array(
			'ok'       => true,
			'reason'   => '',
			'filesize' => $size,
			'mtime'    => $mtime,
			'width'    => $width,
			'height'   => $height,
		);
	}

	/** Resolve an attachment's ORIGINAL file path server-side. '' outside WP. */
	private function resolve_source_path( int $attachment_id ): string {
		$path = '';
		if ( function_exists( 'wp_get_original_image_path' ) ) {
			$candidate = wp_get_original_image_path( $attachment_id );
			if ( is_string( $candidate ) && '' !== $candidate ) {
				$path = $candidate;
			}
		}
		if ( '' === $path && function_exists( 'get_attached_file' ) ) {
			$candidate = get_attached_file( $attachment_id );
			if ( is_string( $candidate ) && '' !== $candidate ) {
				$path = $candidate;
			}
		}
		return $path;
	}

	/**
	 * The contained sibling derivative path for a source, foo.png → foo-png.webp.
	 * The source EXTENSION is folded into the derivative filename so two originals
	 * that share a stem but differ by extension (logo.png + logo.jpg, both accepted
	 * by webp_lossless) map to DISTINCT derivatives — otherwise the second run's
	 * atomic rename would overwrite the first, and two copy attachments could end up
	 * pointing at one file. Deterministic: the same source always resolves to the
	 * same dest, so idempotency (is_current / existing_copy_id) still round-trips.
	 * Returns '' when the destination directory is not inside the base dir.
	 */
	private function derivative_path( string $source ): string {
		$dir  = dirname( $source );
		$name = pathinfo( $source, PATHINFO_FILENAME );
		$ext  = strtolower( pathinfo( $source, PATHINFO_EXTENSION ) );
		$stem = '' !== $ext ? $name . '-' . $ext : $name;
		$dest = $dir . '/' . $stem . '.webp';

		// Containment on the destination DIRECTORY (the file may not exist yet,
		// so realpath the dir, not the file).
		$real_base = '' === $this->base_dir ? false : realpath( $this->base_dir );
		$real_dir  = realpath( $dir );
		if ( false === $real_base || false === $real_dir
			|| 0 !== strpos( $real_dir . '/', rtrim( $real_base, '/' ) . '/' ) ) {
			return '';
		}
		return $dest;
	}

	/** True when a stored derivative is up to date for this exact source. */
	private function is_current( int $attachment_id, IWSL_Media_Converter $converter, int $src_size, int $src_mtime, string $dest ): bool {
		$meta = $this->read_meta( $attachment_id );
		if ( ! is_array( $meta ) ) {
			return false;
		}
		$matches = isset( $meta['converter'], $meta['source_size'], $meta['source_mtime'] )
			&& $meta['converter'] === $converter->id()
			&& (int) $meta['source_size'] === $src_size
			&& (int) $meta['source_mtime'] === $src_mtime;
		return $matches && is_file( $dest );
	}

	// ── meta / lock helpers (all WordPress calls function_exists-guarded) ──────

	/** @return mixed */
	private function read_meta( int $attachment_id ) {
		if ( function_exists( 'get_post_meta' ) ) {
			return get_post_meta( $attachment_id, self::META_KEY, true );
		}
		return null;
	}

	private function write_meta( int $attachment_id, IWSL_Media_Converter $converter, int $src_size, int $src_mtime, string $dest_rel, int $bytes_in, int $bytes_out ): void {
		if ( ! function_exists( 'update_post_meta' ) ) {
			return;
		}
		update_post_meta(
			$attachment_id,
			self::META_KEY,
			array(
				'converter'    => $converter->id(),
				'source_size'  => $src_size,
				'source_mtime' => $src_mtime,
				'dest_rel'     => $dest_rel,
				'bytes_in'     => $bytes_in,
				'bytes_out'    => $bytes_out,
				'at'           => $this->now_seconds(),
			)
		);
	}

	private function acquire_lock(): bool {
		if ( ! function_exists( 'set_transient' ) || ! function_exists( 'get_transient' ) ) {
			return true; // No transient API (test harness) — single-threaded, no lock needed.
		}
		if ( false !== get_transient( self::LOCK_TRANSIENT ) ) {
			return false;
		}
		set_transient( self::LOCK_TRANSIENT, ( $this->now_ms )(), self::LOCK_TTL );
		return true;
	}

	private function release_lock(): void {
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( self::LOCK_TRANSIENT );
		}
	}

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}

	/** Path relative to the base dir, or the raw path if it isn't inside it. */
	private function relative_to_base( string $path ): string {
		$real_base = '' === $this->base_dir ? false : realpath( $this->base_dir );
		$real      = realpath( $path );
		if ( false === $real_base || false === $real ) {
			return $path;
		}
		$prefix = rtrim( $real_base, '/' ) . '/';
		return 0 === strpos( $real, $prefix ) ? substr( $real, strlen( $prefix ) ) : $real;
	}

	/** Unlink a path only if it is a real file. */
	private function safe_unlink( string $path ): void {
		if ( is_file( $path ) ) {
			@unlink( $path );
		}
	}

	// ── immutable summary builders ─────────────────────────────────────────────

	/** A fresh refusal summary (converted=0), optionally with extra fields. */
	private static function refusal( string $reason, array $extra = array() ): array {
		return array_merge(
			array(
				'ok'        => false,
				'reason'    => $reason,
				'converted' => 0,
			),
			$extra
		);
	}

	/** A fresh per-item record. */
	private static function item( int $id, string $basename, string $outcome, string $reason = '' ): array {
		$item = array(
			'id'       => $id,
			'basename' => $basename,
			'outcome'  => $outcome,
		);
		if ( '' !== $reason ) {
			$item['reason'] = $reason;
		}
		return $item;
	}

	/**
	 * Fold one item into the running summary, returning a NEW summary (never
	 * mutating the input). Items list is capped at MAX_BATCH.
	 */
	private static function fold_result( array $summary, array $item ): array {
		$next = $summary;
		switch ( $item['outcome'] ) {
			case 'converted':
				$next['converted']  += 1;
				$next['bytes_in']   += (int) ( $item['bytes_in'] ?? 0 );
				$next['bytes_out']  += (int) ( $item['bytes_out'] ?? 0 );
				$next['saved_bytes'] += (int) ( $item['saving'] ?? 0 );
				break;
			case 'skipped':
				$next['skipped'] += 1;
				break;
			default:
				$next['refused'] += 1;
				break;
		}
		if ( count( $next['items'] ) < self::MAX_REQUEST ) {
			$next['items'] = array_merge( $next['items'], array( $item ) );
		}
		return $next;
	}

	/**
	 * The getimagesize IMAGETYPE_* constants that correspond to a MIME allow-list.
	 * This is the AUTHORITATIVE content-type check — the extension is never
	 * trusted. Constants that a given PHP build lacks are simply omitted.
	 *
	 * @return int[]
	 */
	private static function accepted_imagetypes( array $mimes ): array {
		$map = array(
			'image/png'  => array( IMAGETYPE_PNG ),
			'image/jpeg' => array( IMAGETYPE_JPEG ),
			'image/gif'  => array( IMAGETYPE_GIF ),
			'image/bmp'  => defined( 'IMAGETYPE_BMP' ) ? array( IMAGETYPE_BMP ) : array(),
			'image/tiff' => array_values(
				array_filter(
					array(
						defined( 'IMAGETYPE_TIFF_II' ) ? IMAGETYPE_TIFF_II : null,
						defined( 'IMAGETYPE_TIFF_MM' ) ? IMAGETYPE_TIFF_MM : null,
					),
					'is_int'
				)
			),
		);
		$out = array();
		foreach ( $mimes as $mime ) {
			if ( isset( $map[ $mime ] ) ) {
				$out = array_merge( $out, $map[ $mime ] );
			}
		}
		return array_values( array_unique( $out ) );
	}

	/**
	 * finfo MIME strings accepted for a given allow-list, including the common
	 * libmagic variants (x-ms-bmp, pjpeg, x-tiff) so the belt-and-braces finfo
	 * check tolerates build differences without weakening to "any image/*".
	 *
	 * @return string[]
	 */
	private static function accepted_finfo_mimes( array $mimes ): array {
		$variants = array(
			'image/png'  => array( 'image/png' ),
			'image/jpeg' => array( 'image/jpeg', 'image/pjpeg' ),
			'image/gif'  => array( 'image/gif' ),
			'image/bmp'  => array( 'image/bmp', 'image/x-ms-bmp', 'image/x-bmp' ),
			'image/tiff' => array( 'image/tiff', 'image/x-tiff' ),
		);
		$out = array();
		foreach ( $mimes as $mime ) {
			if ( isset( $variants[ $mime ] ) ) {
				$out = array_merge( $out, $variants[ $mime ] );
			}
		}
		return array_values( array_unique( $out ) );
	}

	/** A failed-guard record with the byte/mtime fields zeroed. */
	private static function guard_fail( string $reason ): array {
		return array(
			'ok'       => false,
			'reason'   => $reason,
			'filesize' => 0,
			'mtime'    => 0,
			'width'    => 0,
			'height'   => 0,
		);
	}
}
