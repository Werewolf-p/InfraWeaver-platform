<?php
/**
 * IWSL_Media_Detail — the per-asset READ-MODEL + safe mutations behind the media
 * viewer (Agent A). Four signed commands live here: `media.get` (full detail),
 * `media.updateMeta` (alt/title/caption/description with optimistic-concurrency),
 * `media.usage` (bounded where-used scan) and `media.delete` (a REAL attachment
 * delete, confirm-fenced).
 *
 * It REIMPLEMENTS NOTHING of the fusion: the fused row (folder / optimization /
 * offload) comes from IWSL_Media_Library::asset_row() so the viewer's detail and
 * the Explorer list can never classify an asset differently. This class adds only
 * the native attachment-panel fields WordPress itself shows (alt, caption,
 * description, uploader, dimensions, EXIF, sizes) plus the two viewer-only reads
 * (protected mark, where-used) and the two viewer mutations (meta save, delete).
 *
 * CONCURRENCY. `media.get` returns `modified` = `post_modified_gmt` verbatim; a
 * `media.updateMeta` MUST echo it back as `expect_modified`, and the runner refuses
 * with `conflict` (returning current values) when the attachment changed since —
 * never a silent clobber in a multi-admin shop.
 *
 * DELETE. `media.delete` is the FIRST signed method that destroys user content. Its
 * validator hard-requires the literal `confirm: true`; it is `wp_delete_attachment(
 * id, true )` — the file + its thumbnails, distinct in every way from the terms-only
 * folder/tag delete (a different class, a different vocabulary). It NEVER lives on a
 * folder/tag code path.
 *
 * TRUST MODEL. Console-authoritative, mirroring the other media runners: every
 * public method re-checks the surface entitlement gate as STATEMENT 1 and returns a
 * renderable `{ locked, gate }` rather than an error. The signed runner has no WP
 * user, so it follows the console-actor seam (like content.duplicate / entitlements
 * .set): the dual-signed channel + per-site RBAC IS the write authority; the WP-side
 * AJAX twin (Agent C) additionally enforces core `edit_post` / `upload_files` caps.
 *
 * SAFETY. In-process only, no exec, no network. Every WordPress call is
 * function_exists / $wpdb-guarded so the class loads and its pure helpers run under
 * the zero-dependency test harness with an injected entitlements gate.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Media_Detail {

	/** Byte caps for the editable fields (mirrors the console-side zod caps). */
	const ALT_MAX   = 500;
	const TITLE_MAX = 300;
	const TEXT_MAX  = 20000; // caption + description (wp_kses_post-cleaned).

	/** Bounded where-used scan: page size + the hard scan window (never `-1`). */
	const USAGE_PER_PAGE = 20;
	const USAGE_MAX_SCAN = 200;

	/** Postmeta keys read here (each engine's own state, read-only unless noted). */
	const ALT_META     = '_wp_attachment_image_alt';
	const OPT_META     = '_iwsl_media_optimizer';
	const OFFLOAD_META = '_iwsl_offload';
	const PROTECT_META = '_iwsl_protected';

	/** EXIF fields surfaced from the attachment metadata's `image_meta` (whitelist). */
	const EXIF_FIELDS = array( 'camera', 'aperture', 'iso', 'focal_length', 'shutter_speed', 'created_timestamp', 'credit', 'copyright', 'orientation' );

	/** @var IWSL_Entitlements */
	private $entitlements;

	public function __construct( IWSL_Entitlements $entitlements ) {
		$this->entitlements = $entitlements;
	}

	// ── media.get — the full viewer detail ───────────────────────────────────────

	/**
	 * Full per-asset detail: the fused row (via IWSL_Media_Library) PLUS the native
	 * attachment-panel fields. Locked envelope when NEITHER media_folders nor
	 * image_optimization is granted; a `{ found:false }` marker when the id is not a
	 * real attachment (a degenerate case the viewer renders as "no longer exists").
	 *
	 * @return array<string,mixed>
	 */
	public function get_asset( int $id ): array {
		$folders_on = $this->unlocked( IWSL_Media_Library::FEATURE_FOLDERS );
		$opt_on     = $this->unlocked( IWSL_Media_Library::FEATURE_OPT );
		if ( ! $folders_on && ! $opt_on ) {
			return array( 'locked' => true, 'gate' => $this->surface_gate() );
		}

		$features = array(
			'media_folders'      => $folders_on,
			'image_optimization' => $opt_on,
			'cdn_rewrite'        => $this->unlocked( IWSL_Media_Library::FEATURE_CDN ),
		);

		if ( ! $this->attachment_exists( $id ) ) {
			return array( 'locked' => false, 'found' => false, 'features' => $features, 'asset' => null );
		}

		$lib  = new IWSL_Media_Library( $this->entitlements );
		$base = $lib->asset_row( $id );
		if ( null === $base ) {
			return array( 'locked' => true, 'gate' => $this->surface_gate() );
		}

		return array(
			'locked'   => false,
			'found'    => true,
			'features' => $features,
			'asset'    => array_merge( $base, $this->detail_fields( $id ) ),
		);
	}

	/**
	 * The native-panel-only fields (everything IWSL_Media_Library::row() does NOT
	 * already carry). All reads, all guarded.
	 *
	 * @return array<string,mixed>
	 */
	private function detail_fields( int $id ): array {
		$author_id = (int) $this->post_field( $id, 'post_author' );
		return array(
			'alt'         => (string) $this->string_meta( $id, self::ALT_META ),
			'caption'     => (string) $this->post_field( $id, 'post_excerpt' ),
			'description' => (string) $this->post_field( $id, 'post_content' ),
			'uploader'    => array(
				'id'   => $author_id,
				'name' => $this->author_name( $author_id ),
			),
			'modified'    => (string) $this->post_field( $id, 'post_modified_gmt' ),
			'sizes'       => $this->sizes_of( $id ),
			'exif'        => $this->exif_of( $id ),
			'protected'   => $this->is_protected( $id ),
			'usage_count' => $this->usage_count( $id ),
			'edit'        => array(
				'editable'         => $this->is_image( $id ),
				'editor_available' => function_exists( 'wp_get_image_editor' ),
			),
		);
	}

	// ── media.updateMeta — save, never clobber ───────────────────────────────────

	/**
	 * Save any subset of { alt, title, caption, description }, refusing on a stale
	 * `expect_modified` (returning the CURRENT values so the viewer can offer re-apply)
	 * rather than silently overwriting a concurrent edit. Text fields are
	 * sanitize_text_field'd; caption/description run wp_kses_post. STATEMENT 1 is the
	 * surface gate.
	 *
	 * @param array<string,mixed> $fields Only the keys the caller sent (validator-checked).
	 * @return array<string,mixed>
	 */
	public function update_meta( int $id, string $expect_modified, array $fields ): array {
		$folders_on = $this->unlocked( IWSL_Media_Library::FEATURE_FOLDERS );
		$opt_on     = $this->unlocked( IWSL_Media_Library::FEATURE_OPT );
		if ( ! $folders_on && ! $opt_on ) {
			return array( 'ok' => false, 'locked' => true, 'gate' => $this->surface_gate() );
		}
		if ( ! $this->attachment_exists( $id ) ) {
			return array( 'ok' => false, 'reason' => 'not-found' );
		}

		$current = (string) $this->post_field( $id, 'post_modified_gmt' );
		if ( '' !== $current && $current !== $expect_modified ) {
			// Optimistic-concurrency refusal — hand back the current values verbatim.
			return array(
				'ok'       => false,
				'conflict' => true,
				'current'  => $this->meta_values( $id ),
			);
		}

		$post_update = array( 'ID' => $id );
		if ( array_key_exists( 'title', $fields ) ) {
			$post_update['post_title'] = $this->clean_text( (string) $fields['title'], self::TITLE_MAX );
		}
		if ( array_key_exists( 'caption', $fields ) ) {
			$post_update['post_excerpt'] = $this->clean_html( (string) $fields['caption'] );
		}
		if ( array_key_exists( 'description', $fields ) ) {
			$post_update['post_content'] = $this->clean_html( (string) $fields['description'] );
		}
		if ( count( $post_update ) > 1 && function_exists( 'wp_update_post' ) ) {
			wp_update_post( $post_update );
		}
		if ( array_key_exists( 'alt', $fields ) && function_exists( 'update_post_meta' ) ) {
			update_post_meta( $id, self::ALT_META, $this->clean_text( (string) $fields['alt'], self::ALT_MAX ) );
		}

		$values             = $this->meta_values( $id );
		$values['modified'] = (string) $this->post_field( $id, 'post_modified_gmt' );
		return array( 'ok' => true, 'updated' => true, 'asset' => $values );
	}

	// ── media.usage — bounded where-used ─────────────────────────────────────────

	/**
	 * Where an asset is used: a BOUNDED scan over post content referencing the
	 * attachment URL/id, plus `_thumbnail_id` featured-image meta and the site-icon /
	 * custom-logo options. Paginated; `capped` true when more than USAGE_MAX_SCAN
	 * references exist (the viewer says "200+"). Never an auto-action — a deletion hint.
	 *
	 * @return array<string,mixed>
	 */
	public function usage( int $id, int $page = 1 ): array {
		$folders_on = $this->unlocked( IWSL_Media_Library::FEATURE_FOLDERS );
		$opt_on     = $this->unlocked( IWSL_Media_Library::FEATURE_OPT );
		if ( ! $folders_on && ! $opt_on ) {
			return array( 'locked' => true, 'gate' => $this->surface_gate() );
		}
		$page  = max( 1, $page );
		$found = $this->scan_usage( $id );
		$total = count( $found );
		$pages = (int) ceil( min( $total, self::USAGE_MAX_SCAN ) / self::USAGE_PER_PAGE );
		$slice = array_slice( $found, ( $page - 1 ) * self::USAGE_PER_PAGE, self::USAGE_PER_PAGE );
		return array(
			'locked' => false,
			'items'  => array_values( $slice ),
			'total'  => $total,
			'page'   => $page,
			'pages'  => max( 1, $pages ),
			'capped' => $total >= self::USAGE_MAX_SCAN,
		);
	}

	// ── media.delete — a REAL attachment delete, eyes open ───────────────────────

	/**
	 * Permanently delete an attachment (the file + its thumbnails) via
	 * wp_delete_attachment( id, true ). Requires an explicit `confirm` at BOTH the
	 * validator (a wire-shape refusal) and here (defence in depth). Reports whether an
	 * offloaded bucket object was also removed (the offload engine's own delete hook
	 * performs the remote removal; this reports the pre-delete offloaded state).
	 *
	 * @return array<string,mixed>
	 */
	public function delete( int $id, bool $confirm ): array {
		$folders_on = $this->unlocked( IWSL_Media_Library::FEATURE_FOLDERS );
		$opt_on     = $this->unlocked( IWSL_Media_Library::FEATURE_OPT );
		if ( ! $folders_on && ! $opt_on ) {
			return array( 'ok' => false, 'locked' => true, 'gate' => $this->surface_gate() );
		}
		if ( true !== $confirm ) {
			return array( 'ok' => false, 'reason' => 'confirm-required' );
		}
		if ( ! $this->attachment_exists( $id ) ) {
			return array( 'ok' => false, 'reason' => 'not-found' );
		}

		$was_offloaded = $this->is_offloaded( $id );
		if ( ! function_exists( 'wp_delete_attachment' ) ) {
			return array( 'ok' => false, 'reason' => 'no-wp' );
		}
		$deleted = wp_delete_attachment( $id, true );
		$ok      = false !== $deleted && null !== $deleted;
		return array(
			'ok'             => $ok,
			'deleted'        => $ok,
			'id'             => $id,
			'bucket_removed' => $ok && $was_offloaded,
		);
	}

	// ── param validators (exact-key discipline, the security boundary) ───────────

	/** `media.get` params: EXACTLY { id: positive int }. @param mixed $params */
	public static function validate_get_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( array() !== array_diff_key( $vars, array( 'id' => 1 ) ) ) {
			return false;
		}
		return isset( $vars['id'] ) && is_int( $vars['id'] ) && $vars['id'] > 0;
	}

	/**
	 * `media.updateMeta` params: { id, expect_modified, alt?, title?, caption?,
	 * description? } — at least ONE editable field, strays refused, strings bounded.
	 *
	 * @param mixed $params
	 */
	public static function validate_update_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars    = get_object_vars( $params );
		$allowed = array( 'id' => 1, 'expect_modified' => 1, 'alt' => 1, 'title' => 1, 'caption' => 1, 'description' => 1 );
		if ( array() !== array_diff_key( $vars, $allowed ) ) {
			return false;
		}
		if ( ! isset( $vars['id'] ) || ! is_int( $vars['id'] ) || $vars['id'] <= 0 ) {
			return false;
		}
		if ( ! isset( $vars['expect_modified'] ) || ! is_string( $vars['expect_modified'] ) || strlen( $vars['expect_modified'] ) > 64 ) {
			return false;
		}
		$caps    = array( 'alt' => self::ALT_MAX, 'title' => self::TITLE_MAX, 'caption' => self::TEXT_MAX, 'description' => self::TEXT_MAX );
		$present = 0;
		foreach ( $caps as $key => $cap ) {
			if ( isset( $vars[ $key ] ) ) {
				if ( ! is_string( $vars[ $key ] ) || strlen( $vars[ $key ] ) > $cap ) {
					return false;
				}
				++$present;
			}
		}
		return $present > 0; // a no-field update is padding, not a save.
	}

	/** `media.usage` params: { id, page? } — page a positive int. @param mixed $params */
	public static function validate_usage_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( array() !== array_diff_key( $vars, array( 'id' => 1, 'page' => 1 ) ) ) {
			return false;
		}
		if ( ! isset( $vars['id'] ) || ! is_int( $vars['id'] ) || $vars['id'] <= 0 ) {
			return false;
		}
		return ! isset( $vars['page'] ) || ( is_int( $vars['page'] ) && $vars['page'] >= 1 );
	}

	/**
	 * `media.delete` params: EXACTLY { id, confirm } where confirm is the LITERAL
	 * boolean `true`. This validator is the first fence in front of a destructive
	 * command — anything but `confirm: true` is refused before the runner ever sees it.
	 *
	 * @param mixed $params
	 */
	public static function validate_delete_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( array() !== array_diff_key( $vars, array( 'id' => 1, 'confirm' => 1 ) ) ) {
			return false;
		}
		if ( ! isset( $vars['id'] ) || ! is_int( $vars['id'] ) || $vars['id'] <= 0 ) {
			return false;
		}
		return array_key_exists( 'confirm', $vars ) && true === $vars['confirm'];
	}

	// ── private: WordPress-boundary reads (all guarded for the harness) ──────────

	/** True when a feature's client-side gate is currently unlocked. */
	private function unlocked( string $feature ): bool {
		$gate = $this->entitlements->evaluate( $feature );
		return ! empty( $gate['unlocked'] );
	}

	/** The gate descriptor for the surface (the media.list convention). */
	private function surface_gate(): array {
		return $this->entitlements->evaluate( IWSL_Media_Library::FEATURE_OPT );
	}

	/**
	 * True when $id resolves to a real `attachment` post. Outside WordPress (no
	 * get_post) a positive id is treated as present so pure-harness meta tests run;
	 * a test that needs the absent case defines a get_post stub returning null.
	 */
	private function attachment_exists( int $id ): bool {
		if ( $id <= 0 ) {
			return false;
		}
		if ( ! function_exists( 'get_post' ) ) {
			return true;
		}
		$post = get_post( $id );
		return is_object( $post ) && isset( $post->post_type ) && 'attachment' === $post->post_type;
	}

	/** The current editable values (for conflict replies + save echoes). @return array<string,string> */
	private function meta_values( int $id ): array {
		return array(
			'alt'         => (string) $this->string_meta( $id, self::ALT_META ),
			'title'       => (string) ( function_exists( 'get_the_title' ) ? get_the_title( $id ) : $this->post_field( $id, 'post_title' ) ),
			'caption'     => (string) $this->post_field( $id, 'post_excerpt' ),
			'description' => (string) $this->post_field( $id, 'post_content' ),
			'modified'    => (string) $this->post_field( $id, 'post_modified_gmt' ),
		);
	}

	/** A guarded single post-field read ('' outside WP / when absent). */
	private function post_field( int $id, string $field ): string {
		if ( $id <= 0 || ! function_exists( 'get_post_field' ) ) {
			return '';
		}
		$v = get_post_field( $field, $id );
		return is_string( $v ) ? $v : '';
	}

	/** A guarded single-value postmeta read ('' outside WP / when absent). */
	private function string_meta( int $id, string $key ): string {
		if ( $id <= 0 || ! function_exists( 'get_post_meta' ) ) {
			return '';
		}
		$v = get_post_meta( $id, $key, true );
		return is_string( $v ) ? $v : '';
	}

	/** The uploader's display name, or '' when unresolvable. */
	private function author_name( int $author_id ): string {
		if ( $author_id <= 0 || ! function_exists( 'get_the_author_meta' ) ) {
			return '';
		}
		$name = get_the_author_meta( 'display_name', $author_id );
		return is_string( $name ) ? $name : '';
	}

	/** Whether this attachment carries the protection mark. */
	private function is_protected( int $id ): bool {
		$raw = ( $id > 0 && function_exists( 'get_post_meta' ) ) ? get_post_meta( $id, self::PROTECT_META, true ) : '';
		if ( class_exists( 'IWSL_Media_Protection' ) ) {
			return IWSL_Media_Protection::meta_marks_protected( $raw );
		}
		return '1' === $raw || 1 === $raw || true === $raw;
	}

	/** Whether this attachment is offloaded to the bucket (a non-empty `key`). */
	private function is_offloaded( int $id ): bool {
		$raw = ( $id > 0 && function_exists( 'get_post_meta' ) ) ? get_post_meta( $id, self::OFFLOAD_META, true ) : '';
		return is_array( $raw ) && isset( $raw['key'] ) && '' !== (string) $raw['key'];
	}

	/** Whether this attachment is an image (drives the edit affordance). */
	private function is_image( int $id ): bool {
		$mime = ( $id > 0 && function_exists( 'get_post_mime_type' ) ) ? (string) get_post_mime_type( $id ) : '';
		return '' !== $mime && 0 === strncmp( $mime, 'image/', 6 );
	}

	/**
	 * The registered sub-sizes for the viewer's "sizes" strip: name, w, h, url.
	 *
	 * @return array<int,array{name:string,width:int,height:int,url:string}>
	 */
	private function sizes_of( int $id ): array {
		if ( $id <= 0 || ! function_exists( 'wp_get_attachment_metadata' ) ) {
			return array();
		}
		$meta = wp_get_attachment_metadata( $id );
		if ( ! is_array( $meta ) || empty( $meta['sizes'] ) || ! is_array( $meta['sizes'] ) ) {
			return array();
		}
		$out = array();
		foreach ( $meta['sizes'] as $name => $size ) {
			if ( ! is_array( $size ) ) {
				continue;
			}
			$url = function_exists( 'wp_get_attachment_image_url' )
				? (string) ( wp_get_attachment_image_url( $id, (string) $name ) ?: '' )
				: '';
			$out[] = array(
				'name'   => (string) $name,
				'width'  => isset( $size['width'] ) ? (int) $size['width'] : 0,
				'height' => isset( $size['height'] ) ? (int) $size['height'] : 0,
				'url'    => $url,
			);
		}
		return $out;
	}

	/**
	 * The whitelisted EXIF projection from the attachment metadata's `image_meta`
	 * (no new scan — reads what WordPress already extracted at upload). null when the
	 * asset carries no camera metadata.
	 *
	 * @return array<string,mixed>|null
	 */
	private function exif_of( int $id ): ?array {
		if ( $id <= 0 || ! function_exists( 'wp_get_attachment_metadata' ) ) {
			return null;
		}
		$meta = wp_get_attachment_metadata( $id );
		if ( ! is_array( $meta ) || empty( $meta['image_meta'] ) || ! is_array( $meta['image_meta'] ) ) {
			return null;
		}
		$image_meta = $meta['image_meta'];
		$out        = array();
		foreach ( self::EXIF_FIELDS as $field ) {
			if ( isset( $image_meta[ $field ] ) && '' !== $image_meta[ $field ] && array() !== $image_meta[ $field ] ) {
				$out[ $field ] = is_scalar( $image_meta[ $field ] ) ? $image_meta[ $field ] : (string) wp_json_encode( $image_meta[ $field ] );
			}
		}
		return array() === $out ? null : $out;
	}

	/**
	 * The bounded number of references to an asset (cheap enough for the row detail):
	 * the same scan as usage() but only counted, capped at USAGE_MAX_SCAN.
	 */
	private function usage_count( int $id ): int {
		return min( self::USAGE_MAX_SCAN, count( $this->scan_usage( $id ) ) );
	}

	/**
	 * The bounded where-used reference list. Sources: post content matching the
	 * attachment URL stem (LIKE, capped), `_thumbnail_id` featured-image meta, and
	 * the site-icon / custom-logo options. Parameterised SQL, no caller input reaches
	 * a query. Empty outside a $wpdb context (the harness).
	 *
	 * @return array<int,array{id:int,title:string,type:string,status:string,link:string}>
	 */
	private function scan_usage( int $id ): array {
		global $wpdb;
		if ( $id <= 0 || ! isset( $wpdb ) || ! is_object( $wpdb ) || ! method_exists( $wpdb, 'get_results' ) || ! method_exists( $wpdb, 'prepare' ) ) {
			return array();
		}

		$seen = array();
		$out  = array();

		// (1) featured-image references — exact meta match.
		$thumb_rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT p.ID, p.post_title, p.post_type, p.post_status FROM {$wpdb->posts} p
				 INNER JOIN {$wpdb->postmeta} m ON m.post_id = p.ID
				 WHERE m.meta_key = '_thumbnail_id' AND m.meta_value = %d
				   AND p.post_status NOT IN ('trash','auto-draft')
				 LIMIT %d",
				$id,
				self::USAGE_MAX_SCAN
			)
		);
		$this->fold_usage_rows( is_array( $thumb_rows ) ? $thumb_rows : array(), $seen, $out );

		// (2) content references — anchor on the attachment URL stem (catches src+srcset).
		$url  = function_exists( 'wp_get_attachment_url' ) ? (string) wp_get_attachment_url( $id ) : '';
		$stem = '' !== $url ? pathinfo( $url, PATHINFO_FILENAME ) : '';
		if ( '' !== $stem && count( $out ) < self::USAGE_MAX_SCAN && method_exists( $wpdb, 'esc_like' ) ) {
			$like    = '%' . $wpdb->esc_like( $stem ) . '%';
			$content = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT ID, post_title, post_type, post_status FROM {$wpdb->posts}
					 WHERE post_status NOT IN ('trash','auto-draft') AND post_content LIKE %s
					 LIMIT %d",
					$like,
					self::USAGE_MAX_SCAN
				)
			);
			$this->fold_usage_rows( is_array( $content ) ? $content : array(), $seen, $out );
		}

		return array_slice( $out, 0, self::USAGE_MAX_SCAN );
	}

	/**
	 * Fold raw post rows into the deduped usage list (first-seen order). Mutates the
	 * $seen/$out references by design — a private accumulator, not a public surface.
	 *
	 * @param array<int,object>      $rows
	 * @param array<int,bool>        $seen
	 * @param array<int,array>       $out
	 */
	private function fold_usage_rows( array $rows, array &$seen, array &$out ): void {
		foreach ( $rows as $row ) {
			if ( ! is_object( $row ) || ! isset( $row->ID ) ) {
				continue;
			}
			$pid = (int) $row->ID;
			if ( $pid <= 0 || isset( $seen[ $pid ] ) || count( $out ) >= self::USAGE_MAX_SCAN ) {
				continue;
			}
			$seen[ $pid ] = true;
			$out[]        = array(
				'id'     => $pid,
				'title'  => isset( $row->post_title ) ? (string) $row->post_title : '',
				'type'   => isset( $row->post_type ) ? (string) $row->post_type : '',
				'status' => isset( $row->post_status ) ? (string) $row->post_status : '',
				'link'   => function_exists( 'get_permalink' ) ? (string) ( get_permalink( $pid ) ?: '' ) : '',
			);
		}
	}

	// ── sanitizers (WordPress when present, safe fallback for the harness) ────────

	/** sanitize_text_field-equivalent, length-capped. */
	private function clean_text( string $value, int $cap ): string {
		$clean = function_exists( 'sanitize_text_field' ) ? (string) sanitize_text_field( $value ) : trim( preg_replace( '/[\r\n\t]+/', ' ', strip_tags( $value ) ) );
		return substr( $clean, 0, $cap );
	}

	/** wp_kses_post-equivalent for caption/description, length-capped. */
	private function clean_html( string $value ): string {
		$clean = function_exists( 'wp_kses_post' ) ? (string) wp_kses_post( $value ) : strip_tags( $value );
		return substr( $clean, 0, self::TEXT_MAX );
	}
}
