<?php
/**
 * Controller for the gated "SVG Uploads (sanitized)" feature — the payload behind
 * the `svg_upload` entitlement (Pro). Kept separate from the gate
 * (IWSL_Entitlements) and from the settings store so each can be reasoned about —
 * and tested — in isolation, mirroring IWSL_Media_Optimizer and IWSL_Redirects.
 *
 * WHY THIS IS SECURITY-CRITICAL. An SVG is XML that a browser executes: an
 * un-sanitized `<script>`, an `onload=` handler, a `javascript:` href, an
 * `<foreignObject>` HTML island, or a `<!ENTITY>` (XXE / billion-laughs) turns a
 * "harmless icon" into stored XSS or a parser-DoS. WordPress refuses SVG by
 * default precisely because it cannot vouch for the bytes. This feature only ever
 * ALLOWS SVG once every uploaded file has passed an ALLOW-LIST sanitizer that
 * strips everything not on a conservative safe set and REFUSES anything it cannot
 * prove clean — mirroring the pre-decode gauntlet rigor of IWSL_Media_Optimizer.
 *
 * TRUST MODEL. Console-authoritative: the `svg_upload` flag is written ONLY by the
 * dual-signed `entitlements.set` runner (§7). There is no self-set path, REST
 * route, AJAX endpoint, cron, or nopriv surface here — this is a purely-local
 * admin toggle plus three self-gated upload filters. The gate is re-checked as the
 * FIRST statement of every filter callback and the admin-post handler; a locked or
 * heartbeat-stale site never allows SVG and never sanitizes. RESIDUAL RISK: the
 * accepted `plus` threat model, bounded by heartbeat staleness (evaluate() needs
 * state==active AND a signed contact within HEARTBEAT_FRESH_MS).
 *
 * DEFENCE IN DEPTH. Even when the entitlement is live, the feature is OFF until an
 * administrator opts in (the toggle, default off) — SVG upload should be trusted
 * only to administrators. And even then, NO raw SVG is ever stored: the prefilter
 * sanitizes the file in place (temp-then-rename, atomic) before WordPress moves it
 * into uploads, and REFUSES the upload outright if the bytes are not provably a
 * clean SVG. No exec/eval, no network — DOMDocument parsing only, entity loading
 * disabled, bounded node walk. WordPress calls are function_exists-guarded so the
 * sanitizer core runs under the zero-dependency test harness.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_SVG_Upload {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'svg_upload';

	/** admin-post action + nonce for the enable/disable toggle. */
	const ACTION = 'iwsl_svg_toggle';
	const NONCE  = 'iwsl_svg_toggle';

	/** Store key for the administrator opt-in toggle (default off). */
	const ENABLED_KEY = 'svg_upload_enabled';

	/** Per-user PRG result transient prefix (see house rules). */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_svg_result_';

	/** Query flag a locked layer-2 POST redirects back with. */
	const LOCKED_QUERY = 'iwsl_svg_locked';

	/** The single MIME this feature ever allows. */
	const SVG_MIME = 'image/svg+xml';

	/** Refuse any SVG larger than 2 MB before parsing — bounds parser cost. */
	const MAX_SVG_BYTES = 2097152;

	/** Hard ceiling on element count walked in one sanitize pass. */
	const MAX_NODES = 10000;

	/**
	 * Conservative element allow-list (exact SVG local-names, case-sensitive as
	 * XML requires). Deliberately EXCLUDES script, style, image, a, foreignObject,
	 * and the animation elements (scriptable / external-load surface). Anything
	 * not on this list is removed wholesale, so script/foreignObject never survive.
	 */
	const ALLOWED_ELEMENTS = array(
		'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline',
		'polygon', 'text', 'tspan', 'textPath', 'tref', 'title', 'desc',
		'metadata', 'defs', 'use', 'symbol', 'marker', 'clipPath', 'mask',
		'pattern', 'linearGradient', 'radialGradient', 'stop', 'switch',
	);

	/**
	 * Conservative attribute allow-list (exact SVG names, case-sensitive). `href`
	 * / `xlink:href` are handled separately (fragment / safe-image only), `xmlns*`
	 * declarations are always kept, and `on*` handlers are always dropped. `style`
	 * is intentionally absent — CSS in SVG is a load/exfil surface, so it is
	 * dropped entirely.
	 */
	const ALLOWED_ATTRS = array(
		'id', 'class', 'transform', 'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
		'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'dx', 'dy',
		'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
		'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
		'stroke-opacity', 'stroke-miterlimit', 'opacity', 'color', 'display',
		'visibility', 'overflow', 'clip-path', 'clip-rule', 'mask', 'paint-order',
		'stop-color', 'stop-opacity', 'offset', 'vector-effect', 'shape-rendering',
		'color-interpolation', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
		'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
		'viewBox', 'preserveAspectRatio', 'version', 'enable-background',
		'gradientUnits', 'gradientTransform', 'spreadMethod', 'patternUnits',
		'patternContentUnits', 'patternTransform', 'clipPathUnits', 'maskUnits',
		'maskContentUnits', 'markerWidth', 'markerHeight', 'markerUnits', 'refX',
		'refY', 'orient', 'xml:space', 'xml:lang',
	);

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store toggle persistence (WP options in prod, memory in tests). */
	private $store;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Toggle persistence; defaults to the
	 *                                        WP store in prod, a memory store in
	 *                                        the no-WP harness. Injectable in tests.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : self::default_store();
	}

	/** The WP store under WordPress, else an in-memory fallback (never fatals the harness). */
	private static function default_store(): IWSL_Store {
		if ( function_exists( 'get_option' ) && class_exists( 'IWSL_WP_Store' ) ) {
			return new IWSL_WP_Store();
		}
		return new IWSL_Memory_Store();
	}

	/**
	 * Register the three self-gated upload filters + the toggle admin-post handler.
	 * Each filter re-checks the gate as its first statement, so a locked/disabled
	 * site is untouched even though the hooks are attached.
	 */
	public function register(): void {
		if ( function_exists( 'add_filter' ) ) {
			add_filter( 'upload_mimes', array( $this, 'filter_upload_mimes' ) );
			add_filter( 'wp_check_filetype_and_ext', array( $this, 'filter_check_filetype_and_ext' ), 10, 5 );
			add_filter( 'wp_handle_upload_prefilter', array( $this, 'prefilter_sanitize' ) );
		}
		if ( function_exists( 'add_action' ) ) {
			add_action( 'admin_post_' . self::ACTION, array( $this, 'handle_toggle' ) );
		}
	}

	/** Whether the feature is live: entitlement unlocked AND the admin opted in. */
	public function is_active(): bool {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return false;
		}
		return $this->is_enabled();
	}

	/** The administrator opt-in toggle (default off). */
	public function is_enabled(): bool {
		return true === $this->store->get( self::ENABLED_KEY, false );
	}

	// ── the three upload filters (each self-gated as STATEMENT 1) ────────────────

	/**
	 * `upload_mimes`: allow image/svg+xml ONLY while the feature is active. A
	 * locked/disabled site never sees SVG added, so core keeps rejecting it.
	 *
	 * @param array $mimes ext => mime map.
	 * @return array
	 */
	public function filter_upload_mimes( $mimes ) {
		$mimes = is_array( $mimes ) ? $mimes : array();
		if ( ! $this->is_active() ) {
			return $mimes;
		}
		$mimes['svg'] = self::SVG_MIME;
		return $mimes;
	}

	/**
	 * `wp_check_filetype_and_ext`: WordPress' real-MIME sniff frequently mislabels
	 * SVG (text/plain / text/html), which then fails the ext↔type consistency
	 * check and rejects the upload. When the feature is active AND the file is a
	 * .svg whose bytes actually look like SVG, assert the correct ext/type. Never
	 * trusts the extension alone — the content must contain an `<svg` root.
	 *
	 * @param array  $data      { ext, type, proper_filename }.
	 * @param string $file      Absolute path to the uploaded temp file.
	 * @param string $filename  Original filename.
	 * @param array  $mimes     Allowed mimes.
	 * @param string $real_mime Sniffed MIME (WP 5.1+).
	 * @return array
	 */
	public function filter_check_filetype_and_ext( $data, $file, $filename, $mimes = null, $real_mime = '' ) {
		$data = is_array( $data ) ? $data : array();
		if ( ! $this->is_active() ) {
			return $data;
		}
		if ( ! is_string( $filename ) || ! self::has_svg_extension( $filename ) ) {
			return $data;
		}
		if ( ! is_string( $file ) || '' === $file || ! is_file( $file ) ) {
			return $data;
		}
		if ( ! self::looks_like_svg( (string) @file_get_contents( $file ) ) ) {
			return $data;
		}
		$data['ext']  = 'svg';
		$data['type'] = self::SVG_MIME;
		return $data;
	}

	/**
	 * `wp_handle_upload_prefilter`: the security core of the upload path. When the
	 * feature is active and the incoming file is an SVG, sanitize its bytes in
	 * place BEFORE WordPress moves it into uploads. On success the cleaned SVG is
	 * written back atomically (temp sibling + rename). On any failure the upload is
	 * REFUSED via $file['error'] — no unsanitized SVG is ever stored.
	 *
	 * @param array $file { name, type, tmp_name, error, size }.
	 * @return array
	 */
	public function prefilter_sanitize( $file ) {
		if ( ! is_array( $file ) ) {
			return $file;
		}
		if ( ! $this->is_active() ) {
			return $file; // Locked/disabled: SVG isn't allowed anyway; leave untouched.
		}
		if ( ! empty( $file['error'] ) ) {
			return $file; // A prior handler already failed it.
		}

		$name = isset( $file['name'] ) ? (string) $file['name'] : '';
		$type = isset( $file['type'] ) ? (string) $file['type'] : '';
		$is_svg = self::SVG_MIME === $type || self::has_svg_extension( $name );
		if ( ! $is_svg ) {
			return $file; // Not an SVG — not our concern.
		}

		$tmp = isset( $file['tmp_name'] ) ? (string) $file['tmp_name'] : '';
		if ( '' === $tmp || ! is_file( $tmp ) ) {
			$file['error'] = self::refusal_message( 'unreadable' );
			return $file;
		}

		$raw = @file_get_contents( $tmp );
		if ( false === $raw ) {
			$file['error'] = self::refusal_message( 'unreadable' );
			return $file;
		}

		$clean = self::sanitize_svg_string( (string) $raw );
		if ( empty( $clean['ok'] ) ) {
			$file['error'] = self::refusal_message( (string) $clean['reason'] );
			return $file;
		}

		if ( ! self::write_atomic( $tmp, (string) $clean['svg'] ) ) {
			$file['error'] = self::refusal_message( 'write-failed' );
			return $file;
		}
		return $file;
	}

	// ── the sanitizer (pure, allow-list, refuse-or-neutralize) ──────────────────

	/**
	 * Allow-list SVG sanitizer. Immutable: never touches the input, returns a fresh
	 * result. REFUSES (ok=false) when the bytes cannot be proven a clean SVG —
	 * empty, oversize, DOCTYPE/ENTITY present (XXE / billion-laughs), unparseable,
	 * non-`<svg>` root, or too many nodes. Otherwise NEUTRALIZES: drops every
	 * element not on ALLOWED_ELEMENTS (so `<script>` / `<foreignObject>` vanish),
	 * every attribute not on ALLOWED_ATTRS, all `on*` handlers, and any unsafe
	 * `href` (only `#fragment` or safe base64 image data survive), then re-
	 * serializes without any DOCTYPE/prolog.
	 *
	 * @return array{ ok:bool, reason:string, svg:string, removed:int }
	 */
	public static function sanitize_svg_string( string $svg ): array {
		if ( '' === trim( $svg ) ) {
			return self::sanitize_fail( 'empty' );
		}
		if ( strlen( $svg ) > self::MAX_SVG_BYTES ) {
			return self::sanitize_fail( 'too-large' );
		}
		// Hard refuse XXE / entity-expansion vectors before the parser sees them.
		if ( self::contains_ci( $svg, '<!ENTITY' ) || self::contains_ci( $svg, '<!DOCTYPE' ) ) {
			return self::sanitize_fail( 'doctype-or-entity' );
		}
		if ( false === stripos( $svg, '<svg' ) ) {
			return self::sanitize_fail( 'not-svg' );
		}
		if ( ! class_exists( 'DOMDocument' ) ) {
			return self::sanitize_fail( 'no-dom' ); // Cannot sanitize safely → refuse.
		}

		$dom = self::parse( $svg );
		if ( null === $dom ) {
			return self::sanitize_fail( 'parse-error' );
		}
		if ( null !== $dom->doctype ) {
			return self::sanitize_fail( 'doctype-or-entity' );
		}
		$root = $dom->documentElement;
		if ( ! $root instanceof DOMElement || 'svg' !== strtolower( (string) $root->localName ) ) {
			return self::sanitize_fail( 'not-svg' );
		}

		// Snapshot every element first (mutating a live NodeList mid-walk is unsafe).
		$elements = iterator_to_array( $dom->getElementsByTagName( '*' ) );
		if ( count( $elements ) > self::MAX_NODES ) {
			return self::sanitize_fail( 'too-many-nodes' );
		}

		$removed = 0;
		foreach ( $elements as $el ) {
			if ( ! $el instanceof DOMElement ) {
				continue;
			}
			if ( ! in_array( (string) $el->localName, self::ALLOWED_ELEMENTS, true ) ) {
				if ( $el->parentNode ) {
					$el->parentNode->removeChild( $el );
					$removed++;
				}
				continue;
			}
			$removed += self::scrub_attributes( $el );
		}

		$out = $dom->saveXML( $dom->documentElement );
		if ( ! is_string( $out ) || '' === $out ) {
			return self::sanitize_fail( 'serialize-failed' );
		}
		return array( 'ok' => true, 'reason' => '', 'svg' => $out, 'removed' => $removed );
	}

	/**
	 * Remove every attribute on $el that is not provably safe: `on*` handlers,
	 * unsafe `href`/`xlink:href`, and anything not on ALLOWED_ATTRS (xmlns
	 * declarations are always kept). Returns how many attributes were removed.
	 */
	private static function scrub_attributes( DOMElement $el ): int {
		if ( ! $el->hasAttributes() ) {
			return 0;
		}
		// Snapshot the attribute nodes before removing (live map mutation is unsafe).
		$attrs = array();
		foreach ( $el->attributes as $attr ) {
			$attrs[] = $attr;
		}

		$removed = 0;
		foreach ( $attrs as $attr ) {
			$name  = (string) $attr->nodeName;      // e.g. "xlink:href", "viewBox".
			$local = (string) $attr->localName;     // e.g. "href", "viewBox".

			// (1) Always drop event handlers — on load / onclick / onmouseover / …
			if ( 0 === strncasecmp( $name, 'on', 2 ) ) {
				self::drop_attr( $el, $attr );
				$removed++;
				continue;
			}
			// (2) Namespace declarations are safe and structurally required.
			if ( 0 === strncasecmp( $name, 'xmlns', 5 ) ) {
				continue;
			}
			// (3) href / xlink:href — only a same-doc #fragment or safe base64 image.
			if ( 0 === strcasecmp( $local, 'href' ) ) {
				if ( ! self::is_safe_href( (string) $attr->nodeValue ) ) {
					self::drop_attr( $el, $attr );
					$removed++;
				}
				continue;
			}
			// (4) Conservative allow-list for everything else (exact SVG casing).
			if ( ! in_array( $name, self::ALLOWED_ATTRS, true ) ) {
				self::drop_attr( $el, $attr );
				$removed++;
			}
		}
		return $removed;
	}

	/** Remove one attribute node, honouring its namespace when present. */
	private static function drop_attr( DOMElement $el, DOMAttr $attr ): void {
		if ( '' !== (string) $attr->namespaceURI ) {
			$el->removeAttributeNS( (string) $attr->namespaceURI, (string) $attr->localName );
			return;
		}
		$el->removeAttribute( (string) $attr->nodeName );
	}

	/**
	 * A href value is safe only if it is a same-document fragment (`#id`) or a
	 * base64-encoded raster image data URI. Everything else — javascript:, data:
	 * text/html, external http(s), scheme-relative, protocol tricks — is unsafe.
	 */
	private static function is_safe_href( string $value ): bool {
		$v = trim( $value );
		if ( '' === $v ) {
			return false;
		}
		if ( '#' === $v[0] ) {
			return true;
		}
		return (bool) preg_match( '#^data:image/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$#i', $v );
	}

	// ── parsing (entity-loading disabled, network off) ──────────────────────────

	/** Parse SVG bytes with XXE/network defences; null on any parse failure. */
	private static function parse( string $svg ): ?DOMDocument {
		$use_errors = libxml_use_internal_errors( true );
		libxml_clear_errors();

		// PHP < 8.0: explicitly disable the external entity loader. PHP >= 8.0
		// disables it by default and the function is deprecated, so skip it there.
		$restore_loader = false;
		$prev_loader    = false;
		if ( \PHP_VERSION_ID < 80000 && function_exists( 'libxml_disable_entity_loader' ) ) {
			$prev_loader    = libxml_disable_entity_loader( true );
			$restore_loader = true;
		}

		$dom = new DOMDocument();
		// LIBXML_NONET blocks network access; NOENT is deliberately NOT set, so
		// entities are never expanded (billion-laughs defence — we also refuse
		// DOCTYPE/ENTITY upstream). NONET|NOERROR|NOWARNING keep it quiet.
		$flags  = LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING;
		$loaded = @$dom->loadXML( $svg, $flags );

		if ( $restore_loader ) {
			libxml_disable_entity_loader( $prev_loader );
		}
		libxml_clear_errors();
		libxml_use_internal_errors( $use_errors );

		return $loaded ? $dom : null;
	}

	// ── small helpers ───────────────────────────────────────────────────────────

	/** Case-insensitive substring test (no PHP 8 str_contains dependency). */
	private static function contains_ci( string $haystack, string $needle ): bool {
		return false !== stripos( $haystack, $needle );
	}

	/** Whether a filename ends in .svg (case-insensitive). Rejects .svgz (gzipped). */
	private static function has_svg_extension( string $name ): bool {
		return (bool) preg_match( '/\.svg$/i', $name );
	}

	/** A cheap "does this even look like SVG" content probe. */
	private static function looks_like_svg( string $raw ): bool {
		return '' !== $raw && false !== stripos( $raw, '<svg' );
	}

	/** Write $contents to $path via a temp sibling + rename (atomic). Guarded. */
	private static function write_atomic( string $path, string $contents ): bool {
		$tmp = $path . '.' . getmypid() . '.iwsltmp';
		$fp  = @fopen( $tmp, 'wb' );
		if ( false === $fp ) {
			return false;
		}
		$written = @fwrite( $fp, $contents );
		@fclose( $fp );
		if ( false === $written ) {
			@unlink( $tmp );
			return false;
		}
		if ( ! @rename( $tmp, $path ) ) {
			@unlink( $tmp );
			return false;
		}
		return true;
	}

	/** A fresh sanitizer-failure record. */
	private static function sanitize_fail( string $reason ): array {
		return array( 'ok' => false, 'reason' => $reason, 'svg' => '', 'removed' => 0 );
	}

	/** The operator-facing upload refusal message for a sanitizer reason. */
	private static function refusal_message( string $reason ): string {
		$map = array(
			'empty'             => 'The SVG file is empty.',
			'too-large'         => 'The SVG file is too large to sanitize safely.',
			'doctype-or-entity' => 'The SVG contains a DOCTYPE or entity declaration and was refused.',
			'not-svg'           => 'The file is not a valid SVG image.',
			'parse-error'       => 'The SVG could not be parsed and was refused.',
			'too-many-nodes'    => 'The SVG is too complex to sanitize safely.',
			'no-dom'            => 'This server cannot sanitize SVG (no XML support); upload refused.',
			'serialize-failed'  => 'The sanitized SVG could not be written.',
			'write-failed'      => 'The sanitized SVG could not be saved.',
			'unreadable'        => 'The uploaded file could not be read.',
		);
		$detail = isset( $map[ $reason ] ) ? $map[ $reason ] : 'The SVG was refused.';
		return 'InfraWeaver blocked this SVG upload: ' . $detail;
	}

	// ── admin-post handler (toggle) — LAYER 2 gate ──────────────────────────────

	/**
	 * admin-post handler: flip the administrator opt-in. manage_options + nonce +
	 * gate re-check, then persist, then POST-redirect-GET with a per-user result
	 * transient. Never enables the toggle for a locked site.
	 */
	public function handle_toggle(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			if ( function_exists( 'wp_die' ) ) {
				wp_die( 'You do not have permission to run this action.' );
			}
			return;
		}
		if ( function_exists( 'check_admin_referer' ) ) {
			check_admin_referer( self::NONCE );
		}

		$redirect = iwsl_plus_redirect_base();

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->redirect( function_exists( 'add_query_arg' ) ? add_query_arg( self::LOCKED_QUERY, '1', $redirect ) : $redirect );
			return;
		}

		$enabled = isset( $_POST['enabled'] ) && '1' === (string) $_POST['enabled']; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$this->store->set( self::ENABLED_KEY, $enabled );

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient(
				self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id(),
				array( 'ok' => true, 'enabled' => $enabled ),
				60
			);
		}
		$this->redirect( $redirect );
	}

	/** wp_safe_redirect + exit, guarded for the harness. */
	private function redirect( string $location ): void {
		if ( function_exists( 'wp_safe_redirect' ) ) {
			wp_safe_redirect( $location );
			exit;
		}
	}

	// ── render (LAYER 1 gate) ───────────────────────────────────────────────────

	/**
	 * Render the SVG-uploads section. Locked → gate reasons only, no toggle.
	 * Unlocked → the PRG result notice, the security explanation, and the opt-in
	 * toggle (default off) with the administrators-only warning.
	 */
	public function render_section(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . self::esc_html_s( 'SVG Uploads (sanitized)' ) . '</h2>';
		echo '<p>' . self::esc_html_s( 'Allow SVG image uploads — every file is sanitized against a strict allow-list on this server before it is stored.' ) . '</p>';

		if ( isset( $_GET[ self::LOCKED_QUERY ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . self::esc_html_s( 'The SVG Uploads entitlement is not granted.' ) . '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_locked_notice( $gate );
			return;
		}

		$this->render_result_notice();

		$enabled = $this->is_enabled();
		echo '<form method="post" action="' . self::esc_attr_s( self::admin_post_url() ) . '" style="margin-top:12px;">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::NONCE );
		}
		echo '<input type="hidden" name="action" value="' . self::esc_attr_s( self::ACTION ) . '">';
		echo '<input type="hidden" name="enabled" value="' . self::esc_attr_s( $enabled ? '0' : '1' ) . '">';

		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . self::esc_html_s( $enabled ? 'SVG uploads are ON (sanitized).' : 'SVG uploads are OFF.' ) . '</span>';
		$label = $enabled ? 'Disable SVG uploads' : 'Enable SVG uploads';
		echo '<button type="submit" class="button button-primary">' . self::esc_html_s( $label ) . '</button>';
		echo '</div>';

		echo '<details class="iwsl-adv"><summary>' . self::esc_html_s( 'Advanced settings' ) . '</summary><div class="iwsl-adv__body">';
		echo '<div class="notice notice-warning inline" style="margin-top:12px;padding:12px;"><p><strong>🔒 ' . self::esc_html_s( 'Security note' ) . '</strong><br>';
		echo self::esc_html_s( 'SVG is executable XML. Uploaded files are stripped of scripts, event handlers, external references, foreignObject islands, and DOCTYPE/entity declarations; anything that cannot be proven clean is refused. Even so, only administrators you trust should be allowed to upload SVG.' );
		echo '</p></div>';
		echo '</div></details>';

		echo '</form>';
	}

	/** Reason lines for a locked gate (no toggle rendered). */
	private static function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The SVG Uploads entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 SVG Uploads is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) ( $gate['reasons'] ?? array() ) as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . self::esc_html_s( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) || empty( $result['ok'] ) ) {
			return;
		}
		$msg = ! empty( $result['enabled'] ) ? 'SVG uploads enabled.' : 'SVG uploads disabled.';
		echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>' . self::esc_html_s( $msg ) . '</p></div>';
	}

	/** admin-post.php URL, guarded. */
	private static function admin_post_url(): string {
		return function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : 'admin-post.php';
	}

	/** esc_html with a harness-safe fallback. */
	private static function esc_html_s( string $s ): string {
		return function_exists( 'esc_html' ) ? esc_html( $s ) : htmlspecialchars( $s, ENT_QUOTES );
	}

	/** esc_attr with a harness-safe fallback. */
	private static function esc_attr_s( string $s ): string {
		return function_exists( 'esc_attr' ) ? esc_attr( $s ) : htmlspecialchars( $s, ENT_QUOTES );
	}
}
