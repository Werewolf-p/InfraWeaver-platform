<?php
/**
 * Engine behind the gated "Media Protection" feature (flag `media_protection`,
 * Pro tier). Makes it HARDER to casually copy images the owner EXPLICITLY marks
 * as protected — and touches nothing else beyond images. Two modes cooperate:
 * a site-wide "protect every image" deterrent (ON BY DEFAULT when the feature is
 * enabled) that covers EVERY front-end `<img>` (including images rendered outside
 * `the_content`, e.g. block themes), plus a granular per-attachment opt-in — a
 * checkbox in the Media Library modal / attachment edit screen stores
 * `_iwsl_protected` postmeta — that additionally overlay-wraps those images.
 *
 * WHAT IT ACTUALLY DOES. Protected images are tagged with the `iwsl-protected`
 * class (via `wp_get_attachment_image_attributes` and a `the_content` pass that
 * resolves each `<img>`'s attachment id from the core `wp-image-<id>` class).
 * Layered, scoped deterrents then apply ONLY to those images: context menu and
 * drag suppressed (`oncontextmenu` / `draggable=false` + capture-phase JS),
 * CSS `-webkit-user-drag:none; user-select:none; -webkit-touch-callout:none;`,
 * and — for content images — a transparent 1×1 GIF overlay stretched over the
 * picture, so a naive "Save image as…" / long-press grabs a blank pixel. The
 * inline CSS/JS is tiny, self-contained (no external asset) and emitted in the
 * footer whenever the feature is enabled and either "protect every image" is on
 * or at least one marked image was rendered; otherwise the page is byte-identical
 * to stock WP.
 *
 * HONESTY. This is a DETERRENT, not DRM. The pixels are on the visitor's screen;
 * a screenshot, devtools, or a direct file fetch still captures them. The admin
 * UI says so plainly — the feature discourages casual copying, nothing more.
 *
 * TRUST MODEL. Console-authoritative, mirroring IWSL_Lazy_Load / IWSL_SVG_Upload:
 * the `media_protection` flag is written ONLY by the dual-signed
 * `entitlements.set` runner (§7). No self-set path, REST route, AJAX endpoint,
 * cron or nopriv surface. The gate is re-checked at every layer — the admin page
 * (LAYER 1), the admin-post settings handler (LAYER 2, wired in the bootstrap),
 * and here as STATEMENT 1 of every hook callback (the engine layer). RESIDUAL
 * RISK is the accepted `plus` model, bounded by heartbeat staleness.
 *
 * SAFETY. In-process only — no exec, no network. String transforms are
 * append-only (class/attribute injection + a wrapping span); a regex failure
 * falls back to the untouched input, never corrupted output. Every WordPress
 * call is function_exists-guarded so the class loads and its pure helpers run
 * under the zero-dependency test harness with an injected store.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Media_Protection {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'media_protection';

	/** IWSL_Store option key holding the settings array. */
	const OPTION_KEY = 'media_protection';

	/** Attachment postmeta key marking one image as protected ('1' or absent). */
	const META_KEY = '_iwsl_protected';

	/** The media-modal / edit-screen compat field name (attachments[<id>][…]). */
	const FIELD_KEY = 'iwsl_protected';

	/** The class every protected image carries on the front end. */
	const CSS_CLASS = 'iwsl-protected';

	/** admin-post action + nonce for the settings save (wired in the bootstrap). */
	const SETTINGS_ACTION = 'iwsl_media_protection_settings';
	const SETTINGS_NONCE  = 'iwsl_media_protection_settings';

	/** Per-user PRG result transient prefix (append the user id). */
	const RESULT_PREFIX = 'iwsl_mediaprotect_result_';

	/** 1×1 transparent GIF — what a naive "Save image as…" on the overlay gets. */
	const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings live here under OPTION_KEY. */
	private $store;

	/**
	 * Request-scoped presence flag: set the moment a protected image is rendered,
	 * read by the footer so the inline CSS/JS ships ONLY on pages that need it.
	 *
	 * @var bool
	 */
	private $protected_seen = false;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Settings store; production injects IWSL_WP_Store.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
	}

	/**
	 * Wire the attachment-field filters (opt-in UI) + the front-end output
	 * filters + the footer emitter. Guarded so the harness can call it harmlessly.
	 * Every callback re-checks the gate as STATEMENT 1, so a locked/revoked site
	 * behaves like stock WordPress even with the hooks attached.
	 */
	public function register(): void {
		if ( function_exists( 'add_filter' ) ) {
			// Opt-in UI: the checkbox in the media modal + attachment edit screen.
			add_filter( 'attachment_fields_to_edit', array( $this, 'filter_attachment_fields_to_edit' ), 10, 2 );
			add_filter( 'attachment_fields_to_save', array( $this, 'filter_attachment_fields_to_save' ), 10, 2 );
			// Front end: tag protected images wherever core builds the attributes…
			add_filter( 'wp_get_attachment_image_attributes', array( $this, 'filter_attachment_image_attributes' ), 20, 2 );
			// …and wrap protected content images. Priority 25 — after most content
			// filters (and the lazy-load pass at 20) have produced final markup.
			add_filter( 'the_content', array( $this, 'filter_the_content' ), 25 );
		}
		if ( function_exists( 'add_action' ) ) {
			// Late footer: by 90 every earlier filter has had its chance to flag
			// a protected image, so the "emit only when needed" test is accurate.
			add_action( 'wp_footer', array( $this, 'render_footer' ), 90 );
		}
	}

	// ── settings (reads safe on every render) ──────────────────────────────────

	/**
	 * The validated settings, defaulted for a fresh site. `enabled` defaults true
	 * so protection is live the moment the flag is granted. `protect_all` also
	 * defaults true: enabling the feature deters saving on EVERY front-end image,
	 * which is what owners expect from "protect my images". The global keyboard
	 * deterrent (Ctrl/Cmd+S) defaults OFF and stays strictly opt-in.
	 *
	 * @return array{ enabled:bool, protect_all:bool, global_deterrent:bool }
	 */
	public function settings(): array {
		$raw = $this->store->get( self::OPTION_KEY, array() );
		if ( ! is_array( $raw ) ) {
			$raw = array();
		}
		return array(
			'enabled'          => array_key_exists( 'enabled', $raw ) ? (bool) $raw['enabled'] : true,
			'protect_all'      => array_key_exists( 'protect_all', $raw ) ? (bool) $raw['protect_all'] : true,
			'global_deterrent' => array_key_exists( 'global_deterrent', $raw ) ? (bool) $raw['global_deterrent'] : false,
		);
	}

	/**
	 * Pure settings sanitizer for the admin-post payload — checkbox semantics
	 * (absent = false), unknown keys dropped, always a fresh immutable copy.
	 *
	 * @param array $input Raw request fields (enabled, protect_all, global_deterrent).
	 * @return array{ enabled:bool, protect_all:bool, global_deterrent:bool }
	 */
	public static function sanitize_settings( array $input ): array {
		return array(
			'enabled'          => ! empty( $input['enabled'] ),
			'protect_all'      => ! empty( $input['protect_all'] ),
			'global_deterrent' => ! empty( $input['global_deterrent'] ),
		);
	}

	/**
	 * Persist settings from the admin-post payload. STATEMENT 1 is the
	 * authoritative entitlement gate — nothing below runs for a locked site.
	 *
	 * @param array $input Raw request fields.
	 * @return array{ ok:bool, reason?:string, settings?:array, gate?:array }
	 */
	public function update_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$settings = self::sanitize_settings( $input );
		$this->store->set( self::OPTION_KEY, $settings );

		// Protection changes rendered front-end HTML (overlay markup on protected
		// images), so a page cache must be invalidated whenever the toggle changes.
		// Guarded: IWSL_Teardown is a peer class this engine does not own.
		if ( class_exists( 'IWSL_Teardown' ) ) {
			IWSL_Teardown::flush_page_cache();
		}

		return array( 'ok' => true, 'settings' => $settings );
	}

	/**
	 * Teardown: remove this feature's ENTIRE persistent footprint — its own
	 * settings option and the `_iwsl_protected` mark on every attachment.
	 * Idempotent (check-before-delete) and cheap when already clean: a second
	 * call finds nothing left and reports zeros. NEVER touches any other
	 * WordPress core postmeta or any file. Every $wpdb call is guarded so this
	 * runs cleanly under the zero-dependency test harness.
	 *
	 * @return array{ options:int, meta:int, cron:bool }
	 */
	public function purge(): array {
		$options = 0;
		if ( null !== $this->store->get( self::OPTION_KEY, null ) ) {
			$this->store->delete( self::OPTION_KEY );
			$options = 1;
		}

		$meta = 0;
		global $wpdb;
		if ( isset( $wpdb ) && is_object( $wpdb ) && method_exists( $wpdb, 'delete' ) ) {
			$deleted = $wpdb->delete( $wpdb->postmeta, array( 'meta_key' => self::META_KEY ) );
			$meta    = is_int( $deleted ) ? $deleted : 0;
		}

		return array( 'options' => $options, 'meta' => $meta, 'cron' => false );
	}

	// ── the protected-check (meta is the single source of truth) ───────────────

	/**
	 * Whether one attachment is marked protected. A raw META check — callers gate
	 * first; this deliberately carries no entitlement logic so revoking the flag
	 * never destroys the owner's per-image marks (they simply go dormant).
	 */
	public function is_protected( int $attachment_id ): bool {
		if ( $attachment_id <= 0 || ! function_exists( 'get_post_meta' ) ) {
			return false;
		}
		return self::meta_marks_protected( get_post_meta( $attachment_id, self::META_KEY, true ) );
	}

	/**
	 * Pure meta-value interpreter: only the values this feature itself writes
	 * (plus the obvious truthy checkbox forms) count as protected.
	 *
	 * @param mixed $value The stored meta value.
	 */
	public static function meta_marks_protected( $value ): bool {
		return '1' === $value || 1 === $value || true === $value;
	}

	/**
	 * Pure: does the posted compat-field array ask for protection? Checkbox
	 * semantics — only an explicit truthy value counts.
	 */
	public static function wants_protection( array $fields ): bool {
		$value = array_key_exists( self::FIELD_KEY, $fields ) ? $fields[ self::FIELD_KEY ] : null;
		return '1' === $value || 1 === $value || 'on' === $value || true === $value;
	}

	// ── opt-in UI: the attachment compat field ─────────────────────────────────

	/**
	 * Pure builder for the media-modal / edit-screen field definition. The honest
	 * deterrent note ships right on the checkbox so the owner is never oversold.
	 *
	 * @return array{ label:string, input:string, html:string, helps:string }
	 */
	public static function attachment_field( int $attachment_id, bool $checked ): array {
		$name = 'attachments[' . $attachment_id . '][' . self::FIELD_KEY . ']';
		return array(
			'label' => 'InfraWeaver protection',
			'input' => 'html',
			'html'  => '<label><input type="checkbox" name="' . $name . '" value="1"' . ( $checked ? ' checked' : '' ) . '> '
				. 'Protect this image (discourage copying)</label>',
			'helps' => 'Deterrent only — blocks casual right-click / drag saving on the site. A determined visitor can still capture pixels.',
		);
	}

	/**
	 * `attachment_fields_to_edit` callback: add the opt-in checkbox for image
	 * attachments. STATEMENT 1 is the gate; a locked site (or a disabled feature)
	 * shows a stock media modal.
	 *
	 * @param mixed $fields Existing field defs.
	 * @param mixed $post   The attachment WP_Post.
	 * @return mixed
	 */
	public function filter_attachment_fields_to_edit( $fields, $post = null ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $fields;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) ) {
			return $fields;
		}
		$id = is_object( $post ) && isset( $post->ID ) ? (int) $post->ID : 0;
		if ( $id <= 0 ) {
			return $fields;
		}
		// Images only — the deterrent is meaningless on audio/video/documents.
		$mime = is_object( $post ) && isset( $post->post_mime_type ) ? (string) $post->post_mime_type : '';
		if ( '' !== $mime && 0 !== strncmp( $mime, 'image/', 6 ) ) {
			return $fields;
		}

		$fields                     = is_array( $fields ) ? $fields : array();
		$fields[ self::FIELD_KEY ]  = self::attachment_field( $id, $this->is_protected( $id ) );
		return $fields;
	}

	/**
	 * `attachment_fields_to_save` callback: persist the checkbox. STATEMENT 1 is
	 * the gate — a locked/disabled site never touches the meta, in either
	 * direction. Checkbox semantics: present+truthy → mark, otherwise unmark
	 * (an unchecked rendered checkbox is simply absent from the POST).
	 *
	 * @param mixed $post       The attachment post-data array (carries ID).
	 * @param mixed $attachment The posted compat-field values for this attachment.
	 * @return mixed $post, always unchanged.
	 */
	public function filter_attachment_fields_to_save( $post, $attachment = null ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $post;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) ) {
			return $post;
		}
		$id = is_array( $post ) && isset( $post['ID'] ) ? (int) $post['ID'] : 0;
		if ( $id <= 0 ) {
			return $post;
		}

		if ( is_array( $attachment ) && self::wants_protection( $attachment ) ) {
			if ( function_exists( 'update_post_meta' ) ) {
				update_post_meta( $id, self::META_KEY, '1' );
			}
		} elseif ( function_exists( 'delete_post_meta' ) ) {
			delete_post_meta( $id, self::META_KEY );
		}
		return $post;
	}

	// ── front-end tagging (STATEMENT 1 is the authoritative gate) ──────────────

	/**
	 * `wp_get_attachment_image_attributes` callback: tag a protected attachment's
	 * rendered `<img>` (featured images, galleries, template calls). STATEMENT 1
	 * is the gate; an unprotected image passes through byte-identical.
	 *
	 * @param mixed $attrs      The attribute array core is about to render.
	 * @param mixed $attachment WP_Post (or id) of the attachment.
	 * @param mixed $size       Requested size (unused).
	 * @return mixed
	 */
	public function filter_attachment_image_attributes( $attrs, $attachment = null, $size = null ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $attrs;
		}
		if ( ! is_array( $attrs ) ) {
			return $attrs;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) ) {
			return $attrs;
		}

		$id = 0;
		if ( is_object( $attachment ) && isset( $attachment->ID ) ) {
			$id = (int) $attachment->ID;
		} elseif ( is_numeric( $attachment ) ) {
			$id = (int) $attachment;
		}
		if ( $id <= 0 || ! $this->is_protected( $id ) ) {
			return $attrs;
		}

		$this->protected_seen = true;
		return self::add_protected_class( $attrs );
	}

	/**
	 * `the_content` callback: resolve each `<img>`'s attachment id (core's
	 * `wp-image-<id>` class), decorate + overlay-wrap the protected ones, and
	 * flag the page so the footer ships the deterrent assets. STATEMENT 1 is the
	 * gate: a revoked flag returns the content untouched.
	 *
	 * @param mixed $content Post HTML (WordPress guarantees a string in practice).
	 * @return mixed
	 */
	public function filter_the_content( $content ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $content;
		}
		if ( ! is_string( $content ) || '' === $content ) {
			return $content;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) ) {
			return $content;
		}

		$result = self::protect_content( $content, array( $this, 'is_protected' ) );
		if ( $result['count'] > 0 ) {
			$this->protected_seen = true;
		}
		return $result['html'];
	}

	/** Whether this request rendered at least one protected image (footer input). */
	public function protected_seen(): bool {
		return $this->protected_seen;
	}

	// ── the pure transforms (public static so tests hit them directly) ─────────

	/**
	 * Pure: inject the protected class + drag/context deterrent attributes into a
	 * core attribute ARRAY. Immutable — returns a fresh copy, never duplicates
	 * the class token, never overwrites an author-set draggable/oncontextmenu.
	 */
	public static function add_protected_class( array $attrs ): array {
		$out   = $attrs;
		$class = isset( $out['class'] ) ? trim( (string) $out['class'] ) : '';
		if ( false === strpos( ' ' . $class . ' ', ' ' . self::CSS_CLASS . ' ' ) ) {
			$out['class'] = '' === $class ? self::CSS_CLASS : $class . ' ' . self::CSS_CLASS;
		}
		if ( ! isset( $out['draggable'] ) ) {
			$out['draggable'] = 'false';
		}
		if ( ! isset( $out['oncontextmenu'] ) ) {
			$out['oncontextmenu'] = 'return false';
		}
		return $out;
	}

	/**
	 * Pure: decorate one `<img>` TAG STRING with the protected class +
	 * `draggable="false"` + `oncontextmenu="return false"`. Append-only and
	 * idempotent: a tag already carrying the class is returned byte-identical,
	 * and existing draggable/oncontextmenu attributes are never overwritten.
	 */
	public static function protect_img_tag( string $tag ): string {
		// Exact class token — must NOT match the shield's `iwsl-protected-shield`.
		if ( preg_match( '/\biwsl-protected(?![\w-])/', $tag ) ) {
			return $tag;
		}
		$out = self::inject_class( $tag );
		if ( ! preg_match( '/\sdraggable\s*=/i', $out ) ) {
			$out = self::insert_before_close( $out, ' draggable="false"' );
		}
		if ( ! preg_match( '/\soncontextmenu\s*=/i', $out ) ) {
			$out = self::insert_before_close( $out, ' oncontextmenu="return false"' );
		}
		return $out;
	}

	/**
	 * Pure: wrap a (decorated) `<img>` tag with the overlay markup — a relative
	 * span plus a transparent 1×1 GIF stretched over the picture, so a naive
	 * "Save image as…" / long-press targets the blank shield, not the image.
	 * Wrapping the tag in place keeps it inside any enclosing link, so clicks
	 * still navigate.
	 */
	public static function wrap_with_overlay( string $img_tag ): string {
		return '<span class="iwsl-protected-wrap">' . $img_tag
			. '<img class="iwsl-protected-shield" src="' . self::BLANK_GIF . '" alt="" aria-hidden="true" draggable="false">'
			. '</span>';
	}

	/**
	 * Pure content pass: decorate + overlay-wrap every `<img>` whose attachment
	 * id (per the core `wp-image-<id>` class) the injected callable reports as
	 * protected. Idempotent — an already-protected tag is counted but never
	 * re-wrapped. A regex failure yields the input unchanged.
	 *
	 * @param string   $html         The content HTML.
	 * @param callable $is_protected fn(int $attachment_id): bool.
	 * @return array{ html:string, count:int } count = protected images present.
	 */
	public static function protect_content( string $html, callable $is_protected ): array {
		if ( '' === $html || false === stripos( $html, '<img' ) ) {
			return array( 'html' => $html, 'count' => 0 );
		}

		$count = 0;
		$out   = preg_replace_callback(
			'#<img\b[^>]*>#i',
			static function ( array $m ) use ( &$count, $is_protected ): string {
				$tag = $m[0];
				// Already protected (earlier pass) — count it, leave it alone.
				if ( preg_match( '/\biwsl-protected(?![\w-])/', $tag ) ) {
					$count++;
					return $tag;
				}
				$id = self::attachment_id_from_img_tag( $tag );
				if ( $id <= 0 || true !== (bool) $is_protected( $id ) ) {
					return $tag;
				}
				$count++;
				return self::wrap_with_overlay( self::protect_img_tag( $tag ) );
			},
			$html
		);
		if ( ! is_string( $out ) ) {
			return array( 'html' => $html, 'count' => 0 );
		}
		return array( 'html' => $out, 'count' => $count );
	}

	/**
	 * Pure: the attachment id a content `<img>` tag references via WordPress'
	 * own `wp-image-<id>` class convention, or 0 when it carries none.
	 */
	public static function attachment_id_from_img_tag( string $tag ): int {
		if ( preg_match( '/\bwp-image-(\d+)(?![\w-])/i', $tag, $m ) ) {
			return (int) $m[1];
		}
		return 0;
	}

	/**
	 * Pure: every distinct attachment id a content HTML string references
	 * (via `wp-image-<id>`), in first-seen order.
	 *
	 * @return int[]
	 */
	public static function extract_attachment_ids( string $html ): array {
		if ( '' === $html || ! preg_match_all( '/\bwp-image-(\d+)(?![\w-])/i', $html, $m ) ) {
			return array();
		}
		$ids = array();
		foreach ( $m[1] as $raw ) {
			$id = (int) $raw;
			if ( $id > 0 && ! in_array( $id, $ids, true ) ) {
				$ids[] = $id;
			}
		}
		return $ids;
	}

	/**
	 * Pure: does a content HTML string reference at least one protected image?
	 *
	 * @param string   $html         The content HTML.
	 * @param callable $is_protected fn(int $attachment_id): bool.
	 */
	public static function content_references_protected( string $html, callable $is_protected ): bool {
		foreach ( self::extract_attachment_ids( $html ) as $id ) {
			if ( true === (bool) $is_protected( $id ) ) {
				return true;
			}
		}
		return false;
	}

	// ── the footer assets (emitted ONLY when a protected image rendered) ───────

	/**
	 * The complete footer output for this request: '' unless the gate is open,
	 * the feature enabled AND either "protect every image" is on or at least one
	 * marked image was rendered on the page. Otherwise the tiny self-contained
	 * inline style + script.
	 */
	public function footer_markup(): string {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return '';
		}
		$settings    = $this->settings();
		$protect_all = ! empty( $settings['protect_all'] );
		if ( empty( $settings['enabled'] ) || ( ! $this->protected_seen && ! $protect_all ) ) {
			return '';
		}
		return '<style id="iwsl-media-protection-css">' . self::footer_css( $protect_all ) . '</style>'
			. '<script id="iwsl-media-protection-js">' . self::footer_js( ! empty( $settings['global_deterrent'] ), $protect_all ) . '</script>';
	}

	/** `wp_footer` callback — echoes {@see footer_markup()} (already built safe). */
	public function render_footer(): void {
		echo $this->footer_markup(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- self-built inline asset, no user input.
	}

	/**
	 * Pure: the deterrent CSS. Always scoped to the protected markers; when
	 * $protect_all, ALSO a site-wide `img` rule so every front-end image resists
	 * drag / long-press save (`-webkit-touch-callout:none` is what suppresses the
	 * iOS long-press "Save Image" menu). Returns a self-contained string.
	 */
	public static function footer_css( bool $protect_all = false ): string {
		$css = '.iwsl-protected{-webkit-user-drag:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}'
			. '.iwsl-protected-wrap{position:relative;display:inline-block;max-width:100%;}'
			. '.iwsl-protected-shield{position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;z-index:2;'
			. '-webkit-user-drag:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}';
		if ( $protect_all ) {
			$css .= 'img{-webkit-user-drag:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}';
		}
		return $css;
	}

	/**
	 * Pure: the deterrent JS — capture-phase contextmenu/dragstart suppression.
	 * Scoped to the protected markers by default; when $protect_all the selector
	 * also includes `img` and the handler fires for any IMG target (so Android
	 * Chrome's long-press contextmenu is suppressed too), plus every current and
	 * later-added `<img>` is set draggable="false" via a MutationObserver. Kept
	 * self-contained, no external asset, no eval.
	 */
	public static function footer_js( bool $global_deterrent, bool $protect_all = false ): string {
		$selector = $protect_all
			? 'img,.iwsl-protected,.iwsl-protected-wrap,.iwsl-protected-shield'
			: '.iwsl-protected,.iwsl-protected-wrap,.iwsl-protected-shield';
		$all = $protect_all ? 'true' : 'false';
		$js  = '(function(){var s="' . $selector . '";var a=' . $all . ';'
			. 'function h(e){var t=e.target;'
			. 'if(t&&((a&&t.tagName==="IMG")||(t.closest&&t.closest(s)))){e.preventDefault();}}'
			. 'document.addEventListener("contextmenu",h,true);'
			. 'document.addEventListener("dragstart",h,true);';
		if ( $protect_all ) {
			$js .= 'function d(n){var i=n.getElementsByTagName?n.getElementsByTagName("img"):[];'
				. 'for(var k=0;k<i.length;k++){i[k].setAttribute("draggable","false");}}'
				. 'function r(){d(document);try{var m=new MutationObserver(function(rs){'
				. 'for(var x=0;x<rs.length;x++){var nn=rs[x].addedNodes;for(var y=0;y<nn.length;y++){var el=nn[y];'
				. 'if(el.tagName==="IMG"){el.setAttribute("draggable","false");}else if(el.nodeType===1){d(el);}}}});'
				. 'm.observe(document.documentElement||document.body,{childList:true,subtree:true});}catch(err){}}'
				. 'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",r);}else{r();}';
		}
		if ( $global_deterrent ) {
			$js .= 'document.addEventListener("keydown",function(e){'
				. 'if((e.ctrlKey||e.metaKey)&&"s"===String(e.key).toLowerCase()){e.preventDefault();}});';
		}
		return $js . '})();';
	}

	// ── admin UI (LAYER 1 gate) ────────────────────────────────────────────────

	/**
	 * How many attachments currently carry the protected mark, or null when the
	 * count cannot be taken (no WP_Query — e.g. the harness).
	 */
	public function protected_count(): ?int {
		if ( ! class_exists( 'WP_Query' ) ) {
			return null;
		}
		$query = new WP_Query(
			array(
				'post_type'      => 'attachment',
				'post_status'    => 'inherit',
				'posts_per_page' => 1,
				'fields'         => 'ids',
				'meta_key'       => self::META_KEY, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
				'meta_value'     => '1',            // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
				'no_found_rows'  => false,
			)
		);
		return isset( $query->found_posts ) ? (int) $query->found_posts : null;
	}

	/**
	 * Render the admin section: a locked notice listing the gate reasons when the
	 * feature is locked, otherwise the global toggle, how to mark an image, the
	 * current protected count, and the honest "deterrent, not DRM" note.
	 */
	public function render_section(): void {
		if ( ! function_exists( 'esc_html' ) || ! function_exists( 'esc_attr' ) ) {
			return;
		}

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$this->render_result_notice();

		$settings = $this->settings();
		$action   = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : '';

		echo '<p class="description" style="max-width:640px;">'
			. esc_html__( 'Discourages casual copying of your images: right-click, drag-to-save and mobile long-press are blocked. With “Protect every image on the site” on (the default) this covers every image on the front end, including block-theme and lazy-loaded images. You can also mark individual images below for the stronger overlay deterrent.', 'infraweaver-connector' )
			. '</p>';

		echo '<p class="description" style="max-width:640px;">'
			. esc_html__( 'To mark an individual image: open Media → Library, click the image, tick “Protect this image (discourage copying)”, and save.', 'infraweaver-connector' )
			. '</p>';

		$count = $this->protected_count();
		if ( null !== $count ) {
			echo '<p class="description">'
				. esc_html( sprintf( __( 'Images currently marked protected: %d.', 'infraweaver-connector' ), $count ) )
				. '</p>';
		}

		echo '<div class="notice notice-info inline" style="margin-top:12px;padding:12px;max-width:640px;"><p>'
			. esc_html__( 'Honest note: this is a deterrent, not DRM. It stops the casual right-click / long-press “Save image as…”, but the image still loads in the visitor’s browser, so a determined visitor can screenshot the page or fetch the file directly. Do not rely on it for images that must stay secret.', 'infraweaver-connector' )
			. '</p></div>';

		echo '<form method="post" action="' . esc_url( $action ) . '" style="margin-top:12px;max-width:640px;">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::SETTINGS_NONCE );
		}
		echo '<input type="hidden" name="action" value="' . esc_attr( self::SETTINGS_ACTION ) . '">';

		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html( ! empty( $settings['enabled'] )
			? __( 'Media protection is on.', 'infraweaver-connector' )
			: __( 'Media protection is off.', 'infraweaver-connector' ) ) . '</span>';
		echo '<label><input type="checkbox" name="enabled" value="1"' . ( ! empty( $settings['enabled'] ) ? ' checked' : '' ) . '> '
			. esc_html__( 'Enable media protection', 'infraweaver-connector' ) . iwsl_field_help( 'Master switch for the image copy deterrent.' ) . '</label> ';
		echo '<label><input type="checkbox" name="protect_all" value="1"' . ( ! empty( $settings['protect_all'] ) ? ' checked' : '' ) . '> '
			. esc_html__( 'Protect every image on the site', 'infraweaver-connector' )
			. iwsl_field_help( 'Deters right-click and mobile long-press saving on every front-end image — including block-theme and lazy-loaded images — not only the ones you tick individually. On by default.' ) . '</label> ';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'Save changes', 'infraweaver-connector' ) . '</button>';
		echo '</div>';

		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row">' . esc_html__( 'Keyboard deterrent', 'infraweaver-connector' ) . '</th><td>';
		echo '<label><input type="checkbox" name="global_deterrent" value="1"' . ( ! empty( $settings['global_deterrent'] ) ? ' checked' : '' ) . '> '
			. esc_html__( 'Also block Ctrl/Cmd+S on pages that contain a protected image', 'infraweaver-connector' )
			. iwsl_field_help( 'Stops the “save page” shortcut, but only on pages that actually show a protected image.' ) . '</label>';
		echo '</td></tr>';

		echo '</tbody></table>';
		echo '</div></details>';
		echo '</form>';
	}

	/** The locked-state notice, listing each gate reason in friendly language. */
	private function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => __( 'This site is not linked to the console.', 'infraweaver-connector' ),
			'heartbeat-stale' => __( 'The console has not verified this site recently.', 'infraweaver-connector' ),
			'requires-plus'   => __( 'Media Protection requires a Pro plan.', 'infraweaver-connector' ),
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>'
			. esc_html__( '🔒 Media Protection is locked.', 'infraweaver-connector' )
			. '</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) ( $gate['reasons'] ?? array() ) as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = self::RESULT_PREFIX . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>'
				. esc_html__( 'Settings saved.', 'infraweaver-connector' ) . '</p></div>';
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>'
				. esc_html( sprintf( 'Could not save: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p></div>';
		}
	}

	// ── small pure helpers ─────────────────────────────────────────────────────

	/**
	 * Append the protected class inside an existing class attribute (double- or
	 * single-quoted), or add a fresh class attribute when the tag has none.
	 */
	private static function inject_class( string $tag ): string {
		$done = 0;
		$out  = preg_replace( '/\bclass\s*=\s*"([^"]*)"/i', 'class="$1 ' . self::CSS_CLASS . '"', $tag, 1, $done );
		if ( is_string( $out ) && $done > 0 ) {
			return $out;
		}
		$out = preg_replace( "/\\bclass\\s*=\\s*'([^']*)'/i", "class='\$1 " . self::CSS_CLASS . "'", $tag, 1, $done );
		if ( is_string( $out ) && $done > 0 ) {
			return $out;
		}
		return self::insert_before_close( $tag, ' class="' . self::CSS_CLASS . '"' );
	}

	/** Insert additions just before the tag's closing bracket, preserving `/>`. */
	private static function insert_before_close( string $tag, string $additions ): string {
		if ( '/>' === substr( $tag, -2 ) ) {
			return substr( $tag, 0, -2 ) . $additions . ' />';
		}
		return substr( $tag, 0, -1 ) . $additions . '>';
	}
}
