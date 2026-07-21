<?php
/**
 * Generic engine behind the gated "CDN URL Rewrite" feature (flag `cdn_rewrite`,
 * Ultimate tier). When an operator points a pull-CDN at their origin, this
 * rewrites the HOST of same-origin STATIC-ASSET URLs (images, CSS, JS, fonts) in
 * the page output to the configured CDN host, so browsers fetch heavy assets from
 * the edge. HTML/PHP/dynamic routes, admin and login URLs, and any cross-origin
 * URL are left untouched — only URLs whose host matches this site's origin AND
 * whose path ends in an allow-listed asset extension are ever rewritten.
 *
 * TRUST MODEL. Console-authoritative, mirroring IWSL_Redirects / IWSL_Page_Cache:
 * the `cdn_rewrite` flag is written ONLY by the dual-signed `entitlements.set`
 * runner (§7). No self-set path, REST route, AJAX endpoint, cron or nopriv
 * surface. The gate is re-checked at every layer — the admin page, the admin-post
 * settings handler (LAYER 2), register() (skips wiring when locked), and here as
 * STATEMENT 1 of every hook callback and every state-changing method. RESIDUAL
 * RISK is the accepted `plus` model: a direct-DB flip unlocks locally but
 * re-locks within HEARTBEAT_FRESH_MS (2h) because evaluate() requires
 * state==active AND a fresh signed heartbeat.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network. The rewrite
 * is host-swap only: scheme, path, query and fragment are preserved verbatim; a
 * ported or userinfo-bearing origin URL is left alone (non-canonical); a regex
 * error yields the untouched input. The configured CDN host is validated as a
 * bare FQDN at the save boundary (no scheme, no path, no whitespace, no port).
 * WordPress calls are function_exists-guarded so the engine loads and its pure
 * rewrite runs under the zero-dependency harness with an injected store + host.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_CDN_Rewrite {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'cdn_rewrite';

	/** IWSL_Store option key holding the settings array. */
	const OPTION_KEY = 'cdn_rewrite';

	/** admin-post action + nonce for the settings save (wired by IWSL_Admin). */
	const SETTINGS_ACTION = 'iwsl_cdn_rewrite_settings';
	const SETTINGS_NONCE  = 'iwsl_cdn_rewrite_settings';

	/** Per-user PRG result transient prefix (append the user id). */
	const RESULT_PREFIX = 'iwsl_cdnrewrite_result_';

	/** The only path extensions a CDN pull-zone will serve — never HTML/PHP. */
	const ASSET_EXTENSIONS = array( 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'css', 'js', 'woff2', 'ico' );

	/**
	 * Bare-hostname shape: labels of alnum/hyphen (no leading/trailing hyphen),
	 * at least one dot (a real FQDN), <=253 chars. Forbids scheme, path, port,
	 * userinfo and whitespace by construction.
	 */
	const HOSTNAME_RE = '/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings live here under OPTION_KEY. */
	private $store;

	/** @var string Lowercased origin host to rewrite from; '' disables rewriting. */
	private $site_host;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Settings store; production injects IWSL_WP_Store.
	 * @param string|null       $site_host    Origin host; defaults to a parse of home_url(). Injectable.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?IWSL_Store $store = null,
		?string $site_host = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
		$this->site_host    = null !== $site_host ? strtolower( $site_host ) : self::default_site_host();
	}

	/**
	 * Wire the rewrite filters. STATEMENT 1 is the gate — a locked site attaches
	 * NOTHING, so origin URLs are served unchanged. Also short-circuits when the
	 * feature is disabled or no CDN host is configured. Every callback re-checks
	 * the gate (defence in depth).
	 */
	public function register(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( ! function_exists( 'add_filter' ) ) {
			return;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) || '' === $settings['host'] || '' === $this->site_host ) {
			return;
		}
		add_filter( 'the_content', array( $this, 'rewrite_content' ), 20 );
		add_filter( 'script_loader_src', array( $this, 'filter_asset_url' ), 20 );
		add_filter( 'style_loader_src', array( $this, 'filter_asset_url' ), 20 );
		add_filter( 'wp_get_attachment_url', array( $this, 'filter_asset_url' ), 20 );
	}

	// ── settings (reads safe on every render) ──────────────────────────────────

	/**
	 * The validated settings. `host` is re-validated on read so a DB-tampered value
	 * that no longer parses as a bare FQDN is treated as empty (fail-closed).
	 *
	 * @return array{ enabled:bool, host:string }
	 */
	public function settings(): array {
		$raw = $this->store->get( self::OPTION_KEY, array() );
		if ( ! is_array( $raw ) ) {
			$raw = array();
		}
		$host = isset( $raw['host'] ) && is_string( $raw['host'] ) ? strtolower( $raw['host'] ) : '';
		if ( ! self::is_valid_host( $host ) ) {
			$host = '';
		}
		return array(
			'enabled' => array_key_exists( 'enabled', $raw ) ? (bool) $raw['enabled'] : false,
			'host'    => $host,
		);
	}

	/**
	 * Persist settings from the admin-post payload. STATEMENT 1 is the authoritative
	 * entitlement gate. The CDN host is validated as a bare FQDN — a value bearing a
	 * scheme, path, port or whitespace is REFUSED, not silently trimmed. An empty
	 * host clears the setting (and forces `enabled` off, since there is nothing to
	 * rewrite to).
	 *
	 * @param array $input Raw request fields (host, enabled).
	 * @return array{ ok:bool, reason?:string, settings?:array, gate?:array }
	 */
	public function update_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$host_raw = isset( $input['host'] ) ? trim( (string) $input['host'] ) : '';
		if ( '' !== $host_raw && ! self::is_valid_host( $host_raw ) ) {
			return array( 'ok' => false, 'reason' => 'invalid-host' );
		}
		$host = '' === $host_raw ? '' : strtolower( $host_raw );

		$settings = array(
			'enabled' => ! empty( $input['enabled'] ) && '' !== $host,
			'host'    => $host,
		);
		$this->store->set( self::OPTION_KEY, $settings );

		return array( 'ok' => true, 'settings' => $settings );
	}

	// ── the rewrite filters (STATEMENT 1 is the authoritative gate) ────────────

	/**
	 * `script_loader_src` / `style_loader_src` / `wp_get_attachment_url` callback.
	 * STATEMENT 1 is the gate. Rewrites a single asset URL when the feature is on
	 * and a host is configured; otherwise returns the URL untouched.
	 *
	 * @param mixed $url
	 * @return mixed
	 */
	public function filter_asset_url( $url ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $url;
		}
		if ( ! is_string( $url ) || '' === $url ) {
			return $url;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) || '' === $settings['host'] || '' === $this->site_host ) {
			return $url;
		}
		return self::rewrite_url( $url, $this->site_host, $settings['host'], self::ASSET_EXTENSIONS );
	}

	/**
	 * `the_content` callback. STATEMENT 1 is the gate. Rewrites every same-origin
	 * asset URL embedded in the HTML (src, srcset, href, inline url()). A regex
	 * error yields the untouched content.
	 *
	 * @param mixed $content
	 * @return mixed
	 */
	public function rewrite_content( $content ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $content;
		}
		if ( ! is_string( $content ) || '' === $content ) {
			return $content;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) || '' === $settings['host'] || '' === $this->site_host ) {
			return $content;
		}

		$site_host = $this->site_host;
		$cdn_host  = $settings['host'];
		$pattern   = '#https?://' . preg_quote( $site_host, '#' ) . '/[^\s"\'()<>]+#i';

		$out = preg_replace_callback(
			$pattern,
			static function ( array $m ) use ( $site_host, $cdn_host ): string {
				return self::rewrite_url( $m[0], $site_host, $cdn_host, self::ASSET_EXTENSIONS );
			},
			$content
		);
		return is_string( $out ) ? $out : $content;
	}

	// ── the pure rewrite (public static so tests hit it directly) ──────────────

	/**
	 * Host-swap one URL to the CDN, or return it unchanged. Rewrites ONLY when the
	 * URL is an absolute http(s) URL whose host equals the origin, whose origin is
	 * canonical (no port, no userinfo), whose path is NOT under /wp-admin/, and
	 * whose last path segment ends in an allow-listed asset extension. Scheme, path,
	 * query and fragment are preserved verbatim.
	 */
	public static function rewrite_url( string $url, string $site_host, string $cdn_host, array $extensions ): string {
		if ( '' === $url || '' === $site_host || '' === $cdn_host ) {
			return $url;
		}
		$parts = self::parse( $url );
		if ( null === $parts ) {
			return $url;
		}

		$scheme = isset( $parts['scheme'] ) ? strtolower( (string) $parts['scheme'] ) : '';
		if ( 'http' !== $scheme && 'https' !== $scheme ) {
			return $url; // relative / non-http(s) — never rewritten.
		}
		$host = isset( $parts['host'] ) ? strtolower( (string) $parts['host'] ) : '';
		if ( '' === $host || $host !== strtolower( $site_host ) ) {
			return $url; // cross-origin — never rewritten.
		}
		if ( isset( $parts['port'] ) || isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			return $url; // non-canonical origin — leave it alone.
		}
		$path = isset( $parts['path'] ) ? (string) $parts['path'] : '';
		if ( '' === $path || false !== stripos( $path, '/wp-admin/' ) ) {
			return $url; // never rewrite admin.
		}
		if ( ! self::has_asset_ext( $path, $extensions ) ) {
			return $url; // only static assets.
		}

		$rebuilt = $scheme . '://' . strtolower( $cdn_host ) . $path;
		if ( isset( $parts['query'] ) && '' !== (string) $parts['query'] ) {
			$rebuilt .= '?' . (string) $parts['query'];
		}
		if ( isset( $parts['fragment'] ) && '' !== (string) $parts['fragment'] ) {
			$rebuilt .= '#' . (string) $parts['fragment'];
		}
		return $rebuilt;
	}

	/** Whether the last path segment ends in an allow-listed extension. */
	private static function has_asset_ext( string $path, array $extensions ): bool {
		$slash   = strrpos( $path, '/' );
		$segment = false === $slash ? $path : substr( $path, $slash + 1 );
		$dot     = strrpos( $segment, '.' );
		if ( false === $dot ) {
			return false;
		}
		$ext = strtolower( substr( $segment, $dot + 1 ) );
		return '' !== $ext && in_array( $ext, $extensions, true );
	}

	// ── host validation ────────────────────────────────────────────────────────

	/** Whether a value is a bare FQDN (no scheme/path/port/whitespace). */
	public static function is_valid_host( string $host ): bool {
		return '' !== $host && (bool) preg_match( self::HOSTNAME_RE, $host );
	}

	/** Parse a URL into parts, wp_parse_url when available, else parse_url. @return array|null */
	private static function parse( string $url ): ?array {
		$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
		return is_array( $parts ) ? $parts : null;
	}

	/** Lowercased origin host from home_url(), '' outside WordPress. */
	private static function default_site_host(): string {
		if ( function_exists( 'home_url' ) ) {
			$home = home_url();
			if ( is_string( $home ) && '' !== $home ) {
				$parts = self::parse( $home );
				if ( null !== $parts && isset( $parts['host'] ) && is_string( $parts['host'] ) ) {
					return strtolower( $parts['host'] );
				}
			}
		}
		return '';
	}

	// ── admin UI ───────────────────────────────────────────────────────────────

	/**
	 * Render the admin section: a locked notice listing the gate reasons when
	 * locked, otherwise the CDN-host form + enable toggle + explanation + the
	 * pull-CDN caveat. All output helpers are function_exists-guarded.
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
			. esc_html__( 'Serves static assets (images, CSS, JS, fonts) from your CDN host instead of this origin. Only same-origin asset URLs are rewritten — HTML, admin, login and dynamic pages always stay on the origin.', 'infraweaver-connector' )
			. '</p>';

		echo '<form method="post" action="' . esc_url( $action ) . '" style="margin-top:12px;max-width:640px;">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::SETTINGS_NONCE );
		}
		echo '<input type="hidden" name="action" value="' . esc_attr( self::SETTINGS_ACTION ) . '">';

		// CONFIG-needed: the CDN host stays visible — the feature cannot work without it.
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th scope="row"><label for="iwsl-cdn-host">' . esc_html__( 'CDN host', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'The address of your CDN (from your CDN provider) that will serve files.' ) . '</th><td>';
		echo '<input type="text" id="iwsl-cdn-host" name="host" class="regular-text" placeholder="cdn.example.com" value="' . esc_attr( $settings['host'] ) . '">';
		echo '<p class="description">' . esc_html__( 'Hostname only — no https://, no trailing path. Leave blank to disable.', 'infraweaver-connector' ) . '</p>';
		echo '</td></tr>';
		echo '</tbody></table>';

		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html( ( ! empty( $settings['enabled'] ) && '' !== $settings['host'] )
			? __( 'Serving static assets from the CDN host.', 'infraweaver-connector' )
			: __( 'CDN rewriting is off.', 'infraweaver-connector' ) ) . '</span>';
		echo '<label><input type="checkbox" name="enabled" value="1"' . ( ! empty( $settings['enabled'] ) ? ' checked' : '' ) . '> '
			. esc_html__( 'Serve static assets from the CDN host', 'infraweaver-connector' ) . iwsl_field_help( 'Turn on serving your images, CSS and scripts from the CDN.' ) . '</label> ';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'Save changes', 'infraweaver-connector' ) . '</button>';
		echo '</div>';

		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<p class="description">' . esc_html(
			sprintf(
				/* translators: %s: comma-separated list of file extensions. */
				__( 'Only same-origin asset URLs ending in these extensions are rewritten: %s. HTML, admin, login and dynamic pages always stay on the origin.', 'infraweaver-connector' ),
				implode( ', ', self::ASSET_EXTENSIONS )
			)
		) . '</p>';
		echo '<div class="notice notice-info inline" style="margin:8px 0;padding:10px;max-width:640px;"><p>'
			. esc_html__( 'Caveat: your CDN must be configured as a pull zone whose origin is this site. If the CDN cannot reach the origin, assets will 404.', 'infraweaver-connector' )
			. '</p></div>';
		echo '</div></details>';

		echo '</form>';
	}

	/** The locked-state notice, listing each gate reason in friendly language. */
	private function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => __( 'This site is not linked to the console.', 'infraweaver-connector' ),
			'heartbeat-stale' => __( 'The console has not verified this site recently.', 'infraweaver-connector' ),
			'requires-plus'   => __( 'CDN URL Rewrite requires an Ultimate plan.', 'infraweaver-connector' ),
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>'
			. esc_html__( '🔒 CDN URL Rewrite is locked.', 'infraweaver-connector' )
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
			$reason = (string) ( $result['reason'] ?? 'unknown' );
			$msg    = 'invalid-host' === $reason
				? esc_html__( 'That is not a valid hostname. Enter a bare host like cdn.example.com.', 'infraweaver-connector' )
				: esc_html( sprintf( 'Could not save: %s', $reason ) );
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>' . $msg . '</p></div>';
		}
	}
}
