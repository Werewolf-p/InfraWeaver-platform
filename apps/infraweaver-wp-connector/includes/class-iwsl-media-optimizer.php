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

	/** Hard batch cap per run — bounded work for a single admin request. */
	const MAX_BATCH = 10;
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
	 * is server-side only (no attachment ids ever cross a request boundary): the
	 * engine queries its own attachments by the converter's accepted MIMEs.
	 *
	 * @return array Immutable run summary.
	 */
	public function run( string $converter_id = 'webp_lossless' ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
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

		if ( ! $this->acquire_lock() ) {
			return self::refusal( 'busy' );
		}

		$started = ( $this->now_ms )();
		$summary = array(
			'ok'          => true,
			'converter'   => $converter->id(),
			'engine'      => (string) $avail['engine'],
			'converted'   => 0,
			'skipped'     => 0,
			'refused'     => 0,
			'bytes_in'    => 0,
			'bytes_out'   => 0,
			'saved_bytes' => 0,
			'items'       => array(),
			'partial'     => false,
			'elapsed_ms'  => 0,
		);

		try {
			foreach ( $this->select_batch( $converter ) as $attachment_id ) {
				if ( ( ( $this->now_ms )() - $started ) >= self::TIME_BUDGET_MS ) {
					$summary['partial'] = true;
					break;
				}
				$result  = $this->convert_one( (int) $attachment_id, $converter );
				$summary = self::fold_result( $summary, $result );
			}
		} finally {
			$this->release_lock();
		}

		$summary['elapsed_ms'] = max( 0, ( $this->now_ms )() - $started );
		return $summary;
	}

	/**
	 * Server-side batch selection: this site's own attachments whose MIME is on
	 * the converter's allow-list, oldest id first, capped at MAX_BATCH. Returns
	 * an empty list outside WordPress.
	 *
	 * @return int[]
	 */
	private function select_batch( IWSL_Media_Converter $converter ): array {
		if ( ! function_exists( 'get_posts' ) ) {
			return array();
		}
		$ids = get_posts(
			array(
				'post_type'        => 'attachment',
				'post_status'      => 'inherit',
				'post_mime_type'   => $converter->accepts(),
				'fields'           => 'ids',
				'posts_per_page'   => self::MAX_BATCH,
				'orderby'          => 'ID',
				'order'            => 'ASC',
				'suppress_filters' => true,
			)
		);
		return is_array( $ids ) ? array_map( 'intval', $ids ) : array();
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
	private function convert_one( int $attachment_id, IWSL_Media_Converter $converter ): array {
		$source = $this->resolve_source_path( $attachment_id );
		$basename = '' === $source ? '' : basename( $source );
		if ( '' === $source ) {
			return self::item( $attachment_id, $basename, 'refused', 'no-source-path' );
		}

		$guard = $this->guard_source( $source );
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

		// Idempotency: an up-to-date derivative already exists for this exact
		// source (same size + mtime) — skip without re-decoding.
		if ( $this->is_current( $attachment_id, $converter, $src_size, $src_mtime, $dest ) ) {
			return self::item( $attachment_id, basename( $source ), 'skipped', 'already-current' );
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
		return $item;
	}

	/**
	 * The full pre-decode security gauntlet (§C). Engine-independent caps are
	 * authoritative — they refuse before any codec (Imagick/GD) touches the file.
	 * Returns { ok, reason, filesize, mtime, width, height }.
	 *
	 * @return array{ ok:bool, reason:string, filesize:int, mtime:int, width:int, height:int }
	 */
	private function guard_source( string $path ): array {
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
		if ( IMAGETYPE_PNG !== (int) $info[2] ) {
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
				if ( 'image/png' !== $mime ) {
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
	 * The contained sibling derivative path for a source, foo.png → foo.webp.
	 * Returns '' when the destination directory is not inside the base dir.
	 */
	private function derivative_path( string $source ): string {
		$dir  = dirname( $source );
		$name = pathinfo( $source, PATHINFO_FILENAME );
		$dest = $dir . '/' . $name . '.webp';

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
		if ( count( $next['items'] ) < self::MAX_BATCH ) {
			$next['items'] = array_merge( $next['items'], array( $item ) );
		}
		return $next;
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
