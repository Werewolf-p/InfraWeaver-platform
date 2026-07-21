<?php
/**
 * Generic engine behind the gated "Speed Pack" feature (flag `speed_pack`, Pro
 * tier) — a WP-Rocket-style bundle of self-contained, on-server performance
 * optimizations. Each optimization is an INDEPENDENT, individually-toggleable
 * switch; the whole feature is gated by one entitlement flag, and every switch
 * fails safe: a broken transform can never blank the site, it returns the
 * original bytes untouched.
 *
 * WHAT IT DOES (each an independent toggle, all default-OFF so unlocking the
 * feature changes nothing until the operator opts each in):
 *   HTML/CSS/JS
 *     - minify_html          Collapse inter-tag whitespace + strip HTML comments
 *                            in the final front-end page (output-buffer on
 *                            template_redirect, anonymous only), preserving the
 *                            byte-exact contents of <pre>/<textarea>/<script>/
 *                            <style>/<code> and IE conditional comments.
 *     - defer_js             Add `defer` to non-critical LOCAL <script src> via
 *                            script_loader_tag, honouring an exclusion list.
 *     - delay_js             (advanced, warned) Swap a local script's type to a
 *                            placeholder so a tiny inline loader restores + runs
 *                            it on the first user interaction.
 *   Server
 *     - server_headers       A managed, IfModule-guarded .htaccess block:
 *                            mod_deflate/mod_brotli compression + mod_expires /
 *                            mod_headers browser-cache (Expires/Cache-Control).
 *                            Written on enable, torn down when the flag is revoked
 *                            (presence-based, like IWSL_Page_Cache), reusing the
 *                            IWSL_Config_Editor atomic/backed-up/marker-block
 *                            writer pattern with a DISTINCT marker so it coexists
 *                            with the Config block and WordPress's own.
 *   Hints
 *     - resource_hints       dns-prefetch / preconnect for a configurable list of
 *                            third-party hosts via wp_resource_hints.
 *   Cleanup
 *     - remove_query_strings Strip the `ver` cache-buster from static asset URLs
 *                            (style_loader_src / script_loader_src) for friendlier
 *                            proxy caching.
 *     - disable_emojis       Dequeue the wp-emoji detection script/styles/cruft.
 *     - disable_embeds       Dequeue the oEmbed discovery/host-js cruft.
 *     - heartbeat_control    Throttle the admin-ajax Heartbeat interval and,
 *                            optionally, disable it on the front end.
 *   Loading
 *     - instant_page         Prefetch same-origin links on hover/touchstart (the
 *                            "instant.page" technique), front-end only.
 *
 * TRUST MODEL. Console-authoritative, mirroring IWSL_Redirects / IWSL_Page_Cache /
 * IWSL_White_Label: the `speed_pack` flag is written ONLY by the dual-signed
 * `entitlements.set` runner (§7). No self-set path, REST route, AJAX endpoint,
 * cron or nopriv surface. The gate is re-checked at every layer — the admin page,
 * the admin-post handler (LAYER 2), and here as STATEMENT 1 of every hook callback
 * and every state-changing method. RESIDUAL RISK is the accepted `plus` model: a
 * direct-DB flip unlocks locally but re-locks within HEARTBEAT_FRESH_MS (2h)
 * because evaluate() requires state==active AND a fresh signed heartbeat, and
 * maybe_revoke() tears the .htaccess block down on the next admin/bootstrap
 * contact once the flag goes.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network. Every risky
 * string transform runs through self::guard(), which returns the ORIGINAL input on
 * any Throwable or non-string result, so a regex backtrack or edge case can never
 * corrupt output. The .htaccess writer is idempotent, IfModule-guarded, atomic
 * (temp + rename), backs the original up to a .iwsl.bak sibling, strips only OUR
 * marker block, and never fatals — an unwritable file surfaces a manual step
 * instead. WordPress calls are function_exists-guarded so the engine loads and its
 * pure transforms run under the zero-dependency test harness with an injected
 * store, clock, home host and .htaccess path.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Speed_Pack {

	/** The entitlement flag this whole feature gates on (Pro tier). */
	const FEATURE = 'speed_pack';

	/** IWSL_Store option key holding the settings array. */
	const OPTION_KEY = 'speed_pack';

	/** Store key for the "our .htaccess block is currently written" flag. */
	const HTACCESS_WRITTEN_KEY = 'speed_pack_htaccess_written';

	/** admin-post action + nonce for the settings save (wired by IWSL_Admin). */
	const SAVE_ACTION = 'iwsl_speed_pack_save';
	const SAVE_NONCE  = 'iwsl_speed_pack_save';

	/** Per-user PRG result transient prefix (append the user id). */
	const RESULT_PREFIX = 'iwsl_speed_pack_result_';

	/** Managed .htaccess block markers — DISTINCT from Config / WordPress markers. */
	const HTACCESS_BEGIN = '# BEGIN InfraWeaver Speed Pack';
	const HTACCESS_END   = '# END InfraWeaver Speed Pack';

	/** The managed Apache per-directory config, relative to ABSPATH. */
	const HTACCESS = '.htaccess';

	/** Bounds on the two operator-supplied lists. */
	const MAX_HOSTS      = 20;
	const MAX_EXCLUSIONS = 50;
	const MAX_HOST_LEN   = 253;
	const MAX_TOKEN_LEN  = 200;

	/** Heartbeat interval clamp (WordPress accepts 15..120 seconds). */
	const HEARTBEAT_MIN     = 15;
	const HEARTBEAT_MAX     = 120;
	const HEARTBEAT_DEFAULT = 60;

	/** Placeholder script type a delayed script is parked under. */
	const DELAY_TYPE = 'iwsl-delay';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings live here under OPTION_KEY. */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var string Lowercased home host, '' outside WordPress. */
	private $home_host;

	/** @var string Managed .htaccess path (ABSPATH.'/.htaccess'), '' outside WP. */
	private $htaccess_path;

	/**
	 * @param IWSL_Entitlements $entitlements  The gate.
	 * @param IWSL_Store|null   $store         Settings store; production injects IWSL_WP_Store.
	 * @param string|null       $home_host     Home host; defaults to parse of home_url(). Injectable.
	 * @param string|null       $htaccess_path Managed .htaccess path; defaults ABSPATH/.htaccess. Injectable.
	 * @param callable|null     $now_ms        Clock, mirrors IWSL_Entitlements. Injectable.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?IWSL_Store $store = null,
		?string $home_host = null,
		?string $htaccess_path = null,
		?callable $now_ms = null
	) {
		$this->entitlements  = $entitlements;
		$this->store         = null !== $store ? $store : new IWSL_WP_Store();
		$this->home_host     = null !== $home_host ? strtolower( $home_host ) : self::default_home_host();
		$this->htaccess_path = null !== $htaccess_path ? $htaccess_path : self::default_htaccess_path();
		$this->now_ms        = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/**
	 * Wire every front-end + admin hook. Guarded so the harness can call it
	 * harmlessly. Registered on EVERY request (front-end filters + the admin_init
	 * presence-teardown); each callback re-checks the gate as its first statement,
	 * so a locked/revoked site pays almost nothing and behaves as stock WordPress.
	 */
	public function register(): void {
		if ( ! function_exists( 'add_action' ) || ! function_exists( 'add_filter' ) ) {
			return;
		}
		// HTML/CSS/JS.
		add_action( 'template_redirect', array( $this, 'start_output_buffer' ), 0 );
		add_filter( 'script_loader_tag', array( $this, 'filter_script_loader_tag' ), 20, 3 );
		// Cleanup — query strings on static assets.
		add_filter( 'style_loader_src', array( $this, 'filter_loader_src' ), 20 );
		add_filter( 'script_loader_src', array( $this, 'filter_loader_src' ), 20 );
		// Hints.
		add_filter( 'wp_resource_hints', array( $this, 'filter_resource_hints' ), 10, 2 );
		// Cleanup — emojis / embeds / front-end heartbeat.
		add_action( 'init', array( $this, 'apply_cleanup' ), 20 );
		// Loading + throttling.
		add_filter( 'heartbeat_settings', array( $this, 'filter_heartbeat_settings' ), 20 );
		add_action( 'wp_footer', array( $this, 'print_footer_scripts' ), 100 );
		// Server-config presence teardown (mirrors IWSL_Page_Cache::maybe_revoke).
		add_action( 'admin_init', array( $this, 'maybe_revoke' ) );
	}

	// ── settings (reads safe on every render; re-validated on read) ─────────────

	/**
	 * The validated settings, defence-in-depth re-sanitized on every read so a
	 * DB-tampered option can never widen behaviour. Every optimization defaults OFF
	 * so unlocking the feature is a no-op until the operator opts each in.
	 *
	 * @return array<string,mixed>
	 */
	public function settings(): array {
		$raw = $this->store->get( self::OPTION_KEY, array() );
		return $this->sanitize_settings( is_array( $raw ) ? $raw : array() );
	}

	/**
	 * Normalize a raw input/stored map into the canonical settings shape. Immutable:
	 * builds a fresh array; never mutates the argument. Booleans coerce with
	 * !empty(); the two lists accept either a textarea string or an array; the
	 * heartbeat interval is clamped.
	 *
	 * @param array<string,mixed> $input
	 * @return array<string,mixed>
	 */
	public function sanitize_settings( array $input ): array {
		return array(
			'minify_html'                => ! empty( $input['minify_html'] ),
			'defer_js'                   => ! empty( $input['defer_js'] ),
			'delay_js'                   => ! empty( $input['delay_js'] ),
			'server_headers'             => ! empty( $input['server_headers'] ),
			'resource_hints'             => ! empty( $input['resource_hints'] ),
			'remove_query_strings'       => ! empty( $input['remove_query_strings'] ),
			'disable_emojis'             => ! empty( $input['disable_emojis'] ),
			'disable_embeds'             => ! empty( $input['disable_embeds'] ),
			'instant_page'               => ! empty( $input['instant_page'] ),
			'heartbeat_control'          => ! empty( $input['heartbeat_control'] ),
			'heartbeat_disable_frontend' => ! empty( $input['heartbeat_disable_frontend'] ),
			'heartbeat_frequency'        => self::clamp_heartbeat(
				isset( $input['heartbeat_frequency'] ) ? (int) $input['heartbeat_frequency'] : self::HEARTBEAT_DEFAULT
			),
			'prefetch_hosts'             => self::sanitize_hosts( $input['prefetch_hosts'] ?? array() ),
			'defer_exclusions'           => self::sanitize_tokens( $input['defer_exclusions'] ?? array() ),
		);
	}

	/**
	 * Persist settings from the admin-post payload. STATEMENT 1 is the authoritative
	 * entitlement gate — nothing below runs for a locked site. Then a fresh
	 * immutable sanitized copy is stored, then the .htaccess server-config block is
	 * reconciled (written when server_headers is on, stripped when off).
	 *
	 * @param array<string,mixed> $input Raw request fields.
	 * @return array{ ok:bool, reason?:string, settings?:array, server_config?:array, gate?:array }
	 */
	public function save_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$settings = $this->sanitize_settings( $input );
		$this->store->set( self::OPTION_KEY, $settings );
		$server = $this->reconcile_server_config( $settings );

		return array( 'ok' => true, 'settings' => $settings, 'server_config' => $server );
	}

	// ── HTML minify (output buffer, anonymous front-end only) ───────────────────

	/**
	 * template_redirect callback. STATEMENT 1 is the gate. Starts an output buffer
	 * that minifies the final page ONLY for an anonymous front-end HTML request —
	 * never admin, REST, AJAX, feeds, or a logged-in session (whose page may carry
	 * per-user markup we must not cache/alter). The buffer callback re-gates.
	 */
	public function start_output_buffer(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( empty( $this->settings()['minify_html'] ) ) {
			return;
		}
		if ( function_exists( 'is_admin' ) && is_admin() ) {
			return;
		}
		if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
			return;
		}
		if ( function_exists( 'wp_doing_ajax' ) && wp_doing_ajax() ) {
			return;
		}
		if ( function_exists( 'is_feed' ) && is_feed() ) {
			return;
		}
		if ( function_exists( 'is_user_logged_in' ) && is_user_logged_in() ) {
			return; // anonymous only.
		}
		ob_start( array( $this, 'filter_final_output' ) );
	}

	/**
	 * The output-buffer callback. STATEMENT 1 (after the string guard) re-checks the
	 * gate, so a revoked flag returns the page byte-identical. The minify itself runs
	 * inside self::guard(): any error yields the original page, never a blank one.
	 *
	 * @param mixed $buffer The full page HTML.
	 * @return string
	 */
	public function filter_final_output( $buffer ): string {
		if ( ! is_string( $buffer ) ) {
			return (string) $buffer;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $buffer;
		}
		if ( empty( $this->settings()['minify_html'] ) ) {
			return $buffer;
		}
		return self::guard(
			$buffer,
			static function ( string $html ): string {
				return self::minify_html( $html );
			}
		);
	}

	/**
	 * Conservatively minify an HTML document: strip non-conditional HTML comments and
	 * collapse runs of whitespace to a SINGLE space (so significant inline spacing is
	 * preserved), while keeping the byte-exact contents of <pre>/<textarea>/<script>/
	 * <style>/<code> and IE conditional comments. Pure + side-effect free. Any PCRE
	 * failure, or a placeholder that could not be restored, yields the input
	 * unchanged — output is never corrupted.
	 */
	public static function minify_html( string $html ): string {
		if ( '' === $html || false === strpos( $html, '<' ) ) {
			return $html;
		}

		// 1. Park protected regions behind opaque placeholders.
		$stash     = array();
		$protected = preg_replace_callback(
			'#<(pre|textarea|script|style|code)\b[^>]*>.*?</\1>#is',
			static function ( array $m ) use ( &$stash ): string {
				$token   = '<!--IWSL_SP_' . count( $stash ) . '-->';
				$stash[] = $m[0];
				return $token;
			},
			$html
		);
		if ( ! is_string( $protected ) ) {
			return $html;
		}

		// 2. Strip HTML comments except IE conditionals and our own placeholders.
		$decommented = preg_replace(
			'#<!--(?!\s*(?:\[if|<!\[endif|IWSL_SP_))(?:(?!-->).)*-->#s',
			'',
			$protected
		);
		if ( ! is_string( $decommented ) ) {
			$decommented = $protected;
		}

		// 3. Collapse whitespace runs to a single space, then trim the document.
		$collapsed = preg_replace( '/[ \t\r\n\f]{2,}/', ' ', $decommented );
		if ( ! is_string( $collapsed ) ) {
			$collapsed = $decommented;
		}
		$collapsed = trim( $collapsed );

		// 4. Restore the protected regions.
		$result = preg_replace_callback(
			'#<!--IWSL_SP_(\d+)-->#',
			static function ( array $m ) use ( $stash ): string {
				$i = (int) $m[1];
				return isset( $stash[ $i ] ) ? $stash[ $i ] : '';
			},
			$collapsed
		);
		if ( ! is_string( $result ) || false !== strpos( $result, '<!--IWSL_SP_' ) ) {
			return $html; // restoration incomplete → fail safe.
		}
		return $result;
	}

	// ── defer / delay JS (script_loader_tag) ────────────────────────────────────

	/**
	 * script_loader_tag callback. STATEMENT 1 is the gate. When delay_js is on it
	 * takes precedence for eligible local scripts; otherwise defer_js applies. Both
	 * transforms run through self::guard() so a malformed tag returns unchanged.
	 *
	 * @param mixed  $tag    The <script> tag markup.
	 * @param string $handle The script handle (unused; present for signature parity).
	 * @param mixed  $src    The script src.
	 * @return mixed
	 */
	public function filter_script_loader_tag( $tag, $handle = '', $src = '' ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $tag;
		}
		if ( function_exists( 'is_admin' ) && is_admin() ) {
			return $tag; // never touch wp-admin / block-editor scripts.
		}
		if ( ! is_string( $tag ) ) {
			return $tag;
		}
		$settings = $this->settings();
		$source   = is_string( $src ) ? $src : '';
		$excl     = $settings['defer_exclusions'];
		$host     = $this->home_host;

		if ( ! empty( $settings['delay_js'] ) ) {
			return self::guard(
				$tag,
				static function ( string $t ) use ( $source, $excl, $host ): string {
					return self::delay_tag( $t, $source, $excl, $host );
				}
			);
		}
		if ( ! empty( $settings['defer_js'] ) ) {
			return self::guard(
				$tag,
				static function ( string $t ) use ( $source, $excl, $host ): string {
					return self::add_defer( $t, $source, $excl, $host );
				}
			);
		}
		return $tag;
	}

	/**
	 * Append `defer` to a LOCAL, non-excluded <script src> that does not already
	 * carry `defer`/`async`. Author intent wins: an already-annotated tag or a
	 * third-party/excluded script is returned byte-identical. Pure.
	 */
	public static function add_defer( string $tag, string $src, array $exclusions, string $home_host ): string {
		if ( '' === $tag || '' === $src ) {
			return $tag;
		}
		if ( ! self::is_local_src( $src, $home_host ) || self::src_excluded( $src, $exclusions ) ) {
			return $tag;
		}
		if ( preg_match( '/\s(?:defer|async)(?=[\s=>\/])/i', $tag ) ) {
			return $tag;
		}
		if ( ! preg_match( '/<script\b/i', $tag ) ) {
			return $tag;
		}
		$out = preg_replace( '/<script\b/i', '<script defer', $tag, 1 );
		return is_string( $out ) ? $out : $tag;
	}

	/**
	 * Park a LOCAL, non-excluded <script src> under the placeholder type so the inline
	 * loader (print_footer_scripts) restores and runs it on first interaction. Already
	 * parked / excluded / third-party tags are returned unchanged. Pure.
	 */
	public static function delay_tag( string $tag, string $src, array $exclusions, string $home_host ): string {
		if ( '' === $tag || '' === $src ) {
			return $tag;
		}
		if ( ! self::is_local_src( $src, $home_host ) || self::src_excluded( $src, $exclusions ) ) {
			return $tag;
		}
		if ( false !== stripos( $tag, self::DELAY_TYPE ) ) {
			return $tag;
		}
		if ( preg_match( '/\stype\s*=\s*("|\').*?\1/i', $tag ) ) {
			$out = preg_replace( '/\stype\s*=\s*("|\').*?\1/i', ' type="' . self::DELAY_TYPE . '"', $tag, 1 );
		} else {
			$out = preg_replace( '/<script\b/i', '<script type="' . self::DELAY_TYPE . '"', $tag, 1 );
		}
		return is_string( $out ) ? $out : $tag;
	}

	/** Whether a script src is same-origin (root-relative, relative, or home-host). */
	public static function is_local_src( string $src, string $home_host ): bool {
		$src = trim( $src );
		if ( '' === $src ) {
			return false;
		}
		if ( 0 === strpos( $src, '//' ) ) {
			return '' !== $home_host && self::host_of( 'https:' . $src ) === $home_host;
		}
		if ( '/' === $src[0] ) {
			return true; // root-relative.
		}
		if ( preg_match( '#^https?://#i', $src ) ) {
			return '' !== $home_host && self::host_of( $src ) === $home_host;
		}
		return true; // scheme-less relative path.
	}

	/** Whether a src matches any exclusion substring (case-insensitive). */
	private static function src_excluded( string $src, array $exclusions ): bool {
		foreach ( $exclusions as $token ) {
			$token = is_string( $token ) ? trim( $token ) : '';
			if ( '' !== $token && false !== stripos( $src, $token ) ) {
				return true;
			}
		}
		return false;
	}

	/** Lowercased host of a URL, '' when unparseable. */
	private static function host_of( string $url ): string {
		$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
		if ( is_array( $parts ) && isset( $parts['host'] ) && is_string( $parts['host'] ) ) {
			return strtolower( $parts['host'] );
		}
		return '';
	}

	// ── remove query strings (style/script loader src) ──────────────────────────

	/**
	 * style_loader_src / script_loader_src callback. STATEMENT 1 is the gate. Strips
	 * the `ver` cache-buster (via self::guard) when remove_query_strings is on.
	 *
	 * @param mixed $src
	 * @return mixed
	 */
	public function filter_loader_src( $src ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $src;
		}
		if ( function_exists( 'is_admin' ) && is_admin() ) {
			return $src; // keep ?ver= on admin assets (cache-bust after updates).
		}
		if ( ! is_string( $src ) || '' === $src ) {
			return $src;
		}
		if ( empty( $this->settings()['remove_query_strings'] ) ) {
			return $src;
		}
		return self::guard(
			$src,
			static function ( string $s ): string {
				return self::strip_version_qs( $s );
			}
		);
	}

	/**
	 * Remove the `ver` query parameter from a URL, preserving any other params and a
	 * trailing #fragment. A URL without `ver` is returned unchanged. Pure.
	 */
	public static function strip_version_qs( string $src ): string {
		if ( '' === $src ) {
			return $src;
		}
		$hash = '';
		$hpos = strpos( $src, '#' );
		if ( false !== $hpos ) {
			$hash = substr( $src, $hpos );
			$src  = substr( $src, 0, $hpos );
		}
		$qpos = strpos( $src, '?' );
		if ( false === $qpos ) {
			return $src . $hash;
		}
		$base  = substr( $src, 0, $qpos );
		$query = substr( $src, $qpos + 1 );

		$kept = array();
		foreach ( explode( '&', $query ) as $pair ) {
			if ( '' === $pair ) {
				continue;
			}
			$eq   = strpos( $pair, '=' );
			$name = ( false === $eq ) ? $pair : substr( $pair, 0, $eq );
			if ( 'ver' === strtolower( $name ) ) {
				continue;
			}
			$kept[] = $pair;
		}
		$newq = implode( '&', $kept );
		return '' === $newq ? $base . $hash : $base . '?' . $newq . $hash;
	}

	// ── resource hints (dns-prefetch / preconnect) ──────────────────────────────

	/**
	 * wp_resource_hints callback. STATEMENT 1 is the gate. Adds the configured hosts
	 * to the dns-prefetch / preconnect relations when resource_hints is on.
	 *
	 * @param mixed  $urls
	 * @param string $relation
	 * @return mixed
	 */
	public function filter_resource_hints( $urls, $relation = '' ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $urls;
		}
		if ( ! is_array( $urls ) ) {
			return $urls;
		}
		$settings = $this->settings();
		if ( empty( $settings['resource_hints'] ) ) {
			return $urls;
		}
		return self::build_hints( $urls, (string) $relation, $settings['prefetch_hosts'] );
	}

	/**
	 * Append hosts to a resource-hints relation immutably: `//host` for dns-prefetch,
	 * `https://host` for preconnect; other relations pass through untouched and no
	 * duplicate is ever added. Pure.
	 */
	public static function build_hints( array $existing, string $relation, array $hosts ): array {
		if ( 'dns-prefetch' !== $relation && 'preconnect' !== $relation ) {
			return $existing;
		}
		$out = $existing;
		foreach ( $hosts as $host ) {
			$host = strtolower( trim( (string) $host ) );
			if ( '' === $host ) {
				continue;
			}
			$entry = ( 'preconnect' === $relation ) ? 'https://' . $host : '//' . $host;
			if ( ! in_array( $entry, $out, true ) ) {
				$out[] = $entry;
			}
		}
		return $out;
	}

	// ── cleanup: emojis / embeds / front-end heartbeat ──────────────────────────

	/**
	 * init callback. STATEMENT 1 is the gate. Applies the enabled cleanup toggles:
	 * dequeue emojis / embeds and (optionally) disable the front-end heartbeat.
	 */
	public function apply_cleanup(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		$settings = $this->settings();
		if ( ! empty( $settings['disable_emojis'] ) ) {
			$this->disable_emojis();
		}
		if ( ! empty( $settings['disable_embeds'] ) ) {
			$this->disable_embeds();
		}
		if ( ! empty( $settings['heartbeat_control'] ) && ! empty( $settings['heartbeat_disable_frontend'] ) ) {
			$this->disable_frontend_heartbeat();
		}
	}

	/** The wp-emoji hooks this feature dequeues (type, hook, callback, priority). */
	public static function emoji_removals(): array {
		return array(
			array( 'action', 'wp_head', 'print_emoji_detection_script', 7 ),
			array( 'action', 'admin_print_scripts', 'print_emoji_detection_script', 10 ),
			array( 'action', 'wp_print_styles', 'print_emoji_styles', 10 ),
			array( 'action', 'admin_print_styles', 'print_emoji_styles', 10 ),
			array( 'filter', 'the_content_feed', 'wp_staticize_emoji', 10 ),
			array( 'filter', 'comment_text_rss', 'wp_staticize_emoji', 10 ),
			array( 'filter', 'wp_mail', 'wp_staticize_emoji_for_email', 10 ),
		);
	}

	/** The oEmbed hooks this feature dequeues (type, hook, callback, priority). */
	public static function embed_removals(): array {
		return array(
			array( 'action', 'rest_api_init', 'wp_oembed_register_route', 10 ),
			array( 'filter', 'oembed_dataparse', 'wp_filter_oembed_result', 10 ),
			array( 'action', 'wp_head', 'wp_oembed_add_discovery_links', 10 ),
			array( 'action', 'wp_head', 'wp_oembed_add_host_js', 10 ),
		);
	}

	/** Dequeue the emoji detection script/styles/cruft + the SVG DNS-prefetch. */
	public function disable_emojis(): void {
		self::apply_removals( self::emoji_removals() );
		if ( function_exists( 'add_filter' ) ) {
			add_filter( 'tiny_mce_plugins', array( $this, 'strip_emoji_tinymce' ) );
			add_filter( 'wp_resource_hints', array( $this, 'strip_emoji_prefetch' ), 10, 2 );
		}
	}

	/** Dequeue the oEmbed discovery/host-js cruft. */
	public function disable_embeds(): void {
		self::apply_removals( self::embed_removals() );
		if ( function_exists( 'add_filter' ) ) {
			add_filter( 'tiny_mce_plugins', array( $this, 'strip_embed_tinymce' ) );
		}
	}

	/** Deregister the front-end Heartbeat script (leaves wp-admin untouched). */
	public function disable_frontend_heartbeat(): void {
		if ( function_exists( 'is_admin' ) && is_admin() ) {
			return;
		}
		if ( function_exists( 'wp_deregister_script' ) ) {
			wp_deregister_script( 'heartbeat' );
		}
	}

	/** Run a removal table through remove_action/remove_filter (guarded). */
	private static function apply_removals( array $removals ): void {
		foreach ( $removals as $r ) {
			if ( ! is_array( $r ) || count( $r ) < 4 ) {
				continue;
			}
			list( $type, $hook, $cb, $prio ) = $r;
			if ( 'action' === $type && function_exists( 'remove_action' ) ) {
				remove_action( $hook, $cb, (int) $prio );
			} elseif ( 'filter' === $type && function_exists( 'remove_filter' ) ) {
				remove_filter( $hook, $cb, (int) $prio );
			}
		}
	}

	/** tiny_mce_plugins filter: drop the emoji plugin. @param mixed $plugins */
	public function strip_emoji_tinymce( $plugins ) {
		return is_array( $plugins ) ? array_values( array_diff( $plugins, array( 'wpemoji' ) ) ) : $plugins;
	}

	/** tiny_mce_plugins filter: drop the embed plugin. @param mixed $plugins */
	public function strip_embed_tinymce( $plugins ) {
		return is_array( $plugins ) ? array_values( array_diff( $plugins, array( 'wpembed' ) ) ) : $plugins;
	}

	/**
	 * wp_resource_hints filter: drop the emoji SVG dns-prefetch entry.
	 *
	 * @param mixed  $urls
	 * @param string $relation
	 * @return mixed
	 */
	public function strip_emoji_prefetch( $urls, $relation = '' ) {
		if ( 'dns-prefetch' !== $relation || ! is_array( $urls ) ) {
			return $urls;
		}
		return array_values(
			array_filter(
				$urls,
				static function ( $url ): bool {
					return ! ( is_string( $url ) && false !== strpos( $url, 's.w.org' ) );
				}
			)
		);
	}

	// ── heartbeat throttle ──────────────────────────────────────────────────────

	/**
	 * heartbeat_settings filter. STATEMENT 1 is the gate. Clamps the interval to the
	 * configured frequency when heartbeat_control is on. Immutable.
	 *
	 * @param mixed $settings
	 * @return mixed
	 */
	public function filter_heartbeat_settings( $settings ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $settings;
		}
		$own = $this->settings();
		if ( empty( $own['heartbeat_control'] ) ) {
			return $settings;
		}
		$out             = is_array( $settings ) ? $settings : array();
		$out['interval'] = self::clamp_heartbeat( (int) $own['heartbeat_frequency'] );
		return $out;
	}

	// ── footer scripts: delay-JS loader + instant.page ──────────────────────────

	/**
	 * wp_footer callback. STATEMENT 1 is the gate. Prints (front-end only) the tiny
	 * self-contained inline loaders for delay_js and instant_page when each is on.
	 * The scripts are static, trusted, self-authored strings.
	 */
	public function print_footer_scripts(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( function_exists( 'is_admin' ) && is_admin() ) {
			return;
		}
		$settings = $this->settings();
		if ( ! empty( $settings['delay_js'] ) ) {
			echo "<script id=\"iwsl-speed-delay\">" . self::delay_loader_js() . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		}
		if ( ! empty( $settings['instant_page'] ) ) {
			echo "<script id=\"iwsl-speed-instant\">" . self::instant_page_js() . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		}
	}

	/** The delay-JS loader: restore + execute parked scripts on first interaction. */
	public static function delay_loader_js(): string {
		return "(function(){var d=false,e=['keydown','mousemove','mousedown','touchstart','scroll','wheel'];"
			. "function load(){if(d){return;}d=true;e.forEach(function(n){window.removeEventListener(n,load,{passive:true});});"
			. "var s=document.querySelectorAll('script[type=\"" . self::DELAY_TYPE . "\"]');"
			. "s.forEach(function(o){var n=document.createElement('script');"
			. "for(var i=0;i<o.attributes.length;i++){var a=o.attributes[i];if('type'===a.name){continue;}n.setAttribute(a.name,a.value);}"
			. "n.type='text/javascript';if(o.src){n.src=o.src;}else{n.text=o.text;}o.parentNode.replaceChild(n,o);});}"
			. "e.forEach(function(n){window.addEventListener(n,load,{passive:true});});})();";
	}

	/** The instant.page loader: prefetch same-origin links on hover / touchstart. */
	public static function instant_page_js(): string {
		return "(function(){var seen={};function pf(h){if(seen[h]){return;}seen[h]=1;"
			. "var l=document.createElement('link');l.rel='prefetch';l.href=h;document.head.appendChild(l);}"
			. "function ok(a){if(!a||!a.href||a.origin!==location.origin){return false;}"
			. "if(a.hasAttribute('download')){return false;}"
			. "if(a.pathname===location.pathname&&a.search===location.search){return false;}return true;}"
			. "function on(e){var a=e.target&&e.target.closest?e.target.closest('a'):null;if(a&&ok(a)){pf(a.href);}}"
			. "document.addEventListener('mouseover',on,{passive:true,capture:true});"
			. "document.addEventListener('touchstart',on,{passive:true,capture:true});})();";
	}

	// ── server config: managed, IfModule-guarded .htaccess block ────────────────

	/**
	 * The presence-gate enforcer, mirroring IWSL_Page_Cache::maybe_revoke(). Cheap in
	 * the common case: a single store read short-circuits when no block was written.
	 * If OUR block is written but the feature is now locked or server_headers is off,
	 * strip it.
	 */
	public function maybe_revoke(): void {
		if ( true !== $this->store->get( self::HTACCESS_WRITTEN_KEY, false ) ) {
			return;
		}
		$gate     = $this->entitlements->evaluate( self::FEATURE );
		$settings = $this->settings();
		if ( ! empty( $gate['unlocked'] ) && ! empty( $settings['server_headers'] ) ) {
			return; // still wanted.
		}
		$this->remove_server_config();
	}

	/**
	 * Operator kill-switch teardown: strip the managed .htaccess block regardless
	 * of entitlement, mirroring IWSL_Page_Cache::disable(). Called when the feature
	 * is switched OFF locally while the tier still grants it.
	 *
	 * @return array{ written:bool, effective?:bool, note?:string, manual_step?:string }
	 */
	public function disable(): array {
		return $this->remove_server_config();
	}

	/** Write when server_headers is on, strip when off. Returns the write result. */
	private function reconcile_server_config( array $settings ): array {
		return ! empty( $settings['server_headers'] )
			? $this->write_server_config()
			: $this->remove_server_config();
	}

	/**
	 * Replace the managed .htaccess block with the compression + browser-cache
	 * directives. Strips any existing InfraWeaver Speed Pack block, PREPENDS the fresh
	 * one (so it sits ABOVE WordPress's own markers), writes atomically with a
	 * .iwsl.bak backup. Non-fatal: an unwritable file surfaces a manual step.
	 *
	 * @return array{ written:bool, effective?:bool, note?:string, manual_step?:string }
	 */
	private function write_server_config(): array {
		$path = $this->htaccess_path;
		if ( '' === $path ) {
			return array( 'written' => false, 'manual_step' => $this->htaccess_manual_step() );
		}
		if ( ! $this->htaccess_writable() ) {
			return array( 'written' => false, 'manual_step' => $this->htaccess_manual_step() );
		}
		$existing = '';
		$had_file = is_file( $path );
		if ( $had_file ) {
			if ( ! is_readable( $path ) ) {
				return array( 'written' => false, 'manual_step' => $this->htaccess_manual_step() );
			}
			$raw = @file_get_contents( $path );
			if ( false === $raw ) {
				return array( 'written' => false, 'manual_step' => $this->htaccess_manual_step() );
			}
			$existing = $raw;
		}
		$stripped = self::strip_block( $existing, self::HTACCESS_BEGIN, self::HTACCESS_END );
		$block    = self::build_htaccess_block();
		$sep      = ( '' !== $stripped ) ? "\n" : '';
		if ( ! $this->write_atomic( $path, $existing, $block . $sep . $stripped, $had_file ) ) {
			return array( 'written' => false, 'manual_step' => $this->htaccess_manual_step() );
		}
		$this->store->set( self::HTACCESS_WRITTEN_KEY, true );
		return array(
			'written'   => true,
			'effective' => true,
			'note'      => 'Compression + browser-cache headers were written to .htaccess and take effect on the NEXT request. They need the server to permit these directives (AllowOverride) and the mod_deflate / mod_expires / mod_headers modules; each is IfModule-guarded so a missing module is skipped harmlessly.',
		);
	}

	/**
	 * Strip OUR managed block from .htaccess (idempotent), atomically, and clear the
	 * written flag. Never touches a foreign block; non-fatal on any failure.
	 *
	 * @return array{ written:bool, removed:bool }
	 */
	private function remove_server_config(): array {
		$path = $this->htaccess_path;
		if ( '' === $path || ! is_file( $path ) ) {
			$this->store->set( self::HTACCESS_WRITTEN_KEY, false );
			return array( 'written' => false, 'removed' => false );
		}
		if ( ! is_readable( $path ) ) {
			return array( 'written' => false, 'removed' => false );
		}
		$existing = @file_get_contents( $path );
		if ( false === $existing || false === strpos( $existing, self::HTACCESS_BEGIN ) ) {
			$this->store->set( self::HTACCESS_WRITTEN_KEY, false );
			return array( 'written' => false, 'removed' => false );
		}
		if ( ! $this->htaccess_writable() ) {
			return array( 'written' => false, 'removed' => false );
		}
		$stripped = self::strip_block( $existing, self::HTACCESS_BEGIN, self::HTACCESS_END );
		$removed  = $this->write_atomic( $path, $existing, $stripped, true );
		if ( $removed ) {
			$this->store->set( self::HTACCESS_WRITTEN_KEY, false );
		}
		return array( 'written' => false, 'removed' => $removed );
	}

	/**
	 * Build the managed .htaccess block: BEGIN, then IfModule-guarded mod_deflate /
	 * mod_brotli compression, mod_expires TTLs, and a mod_headers Cache-Control for
	 * static assets, then END. Every directive is guarded so a server missing a
	 * module never chokes. Pure — inspectable in tests.
	 */
	public static function build_htaccess_block(): string {
		$compress = 'text/html text/plain text/xml text/css text/javascript '
			. 'application/javascript application/json application/xml application/rss+xml '
			. 'image/svg+xml font/ttf font/otf font/woff font/woff2';

		$lines = array(
			self::HTACCESS_BEGIN,
			'<IfModule mod_deflate.c>',
			'  AddOutputFilterByType DEFLATE ' . $compress,
			'</IfModule>',
			'<IfModule mod_brotli.c>',
			'  AddOutputFilterByType BROTLI_COMPRESS ' . $compress,
			'</IfModule>',
			'<IfModule mod_expires.c>',
			'  ExpiresActive On',
			'  ExpiresByType text/css "access plus 1 year"',
			'  ExpiresByType application/javascript "access plus 1 year"',
			'  ExpiresByType text/javascript "access plus 1 year"',
			'  ExpiresByType image/gif "access plus 1 year"',
			'  ExpiresByType image/png "access plus 1 year"',
			'  ExpiresByType image/jpeg "access plus 1 year"',
			'  ExpiresByType image/webp "access plus 1 year"',
			'  ExpiresByType image/svg+xml "access plus 1 year"',
			'  ExpiresByType image/x-icon "access plus 1 year"',
			'  ExpiresByType font/woff "access plus 1 year"',
			'  ExpiresByType font/woff2 "access plus 1 year"',
			'  ExpiresByType application/vnd.ms-fontobject "access plus 1 year"',
			'  ExpiresByType text/html "access plus 0 seconds"',
			'  ExpiresDefault "access plus 1 month"',
			'</IfModule>',
			'<IfModule mod_headers.c>',
			'  <FilesMatch "\\.(css|js|gif|png|jpe?g|webp|svg|ico|woff2?|ttf|otf|eot)$">',
			'    Header set Cache-Control "public, max-age=31536000, immutable"',
			'  </FilesMatch>',
			'</IfModule>',
			self::HTACCESS_END,
		);
		return implode( "\n", $lines ) . "\n";
	}

	/**
	 * A read-only snapshot of the server-config state for the admin panel. Side-effect
	 * free.
	 *
	 * @return array{ htaccess_written:bool, htaccess_writable:bool, block_present:bool }
	 */
	public function status(): array {
		$present = false;
		$path    = $this->htaccess_path;
		if ( '' !== $path && is_file( $path ) && is_readable( $path ) ) {
			$raw     = @file_get_contents( $path );
			$present = is_string( $raw ) && false !== strpos( $raw, self::HTACCESS_BEGIN );
		}
		return array(
			'htaccess_written'  => true === $this->store->get( self::HTACCESS_WRITTEN_KEY, false ),
			'htaccess_writable' => $this->htaccess_writable(),
			'block_present'     => $present,
		);
	}

	/** Whether the managed .htaccess (or ABSPATH, if the file is absent) is writable. */
	private function htaccess_writable(): bool {
		$path = $this->htaccess_path;
		if ( '' === $path ) {
			return false;
		}
		if ( is_file( $path ) ) {
			return is_writable( $path );
		}
		$dir = dirname( $path );
		return is_dir( $dir ) && is_writable( $dir );
	}

	private function htaccess_manual_step(): string {
		return 'The .htaccess in the WordPress root is not writable — add the InfraWeaver Speed Pack block (mod_deflate + mod_expires + mod_headers) there by hand to apply compression and browser-cache headers.';
	}

	// ── shared block + write helpers (mirrors IWSL_Config_Editor) ───────────────

	/** Remove the managed block (BEGIN…END + its own trailing newline). Idempotent. */
	private static function strip_block( string $contents, string $begin, string $end ): string {
		$pattern = '/' . preg_quote( $begin, '/' ) . '.*?' . preg_quote( $end, '/' ) . '\n?/s';
		$out     = preg_replace( $pattern, '', $contents );
		return null === $out ? $contents : $out;
	}

	/** Back up the original to .iwsl.bak (when requested), then write via temp + rename. */
	private function write_atomic( string $path, string $original, string $new, bool $backup ): bool {
		if ( $backup ) {
			$bak = $path . '.iwsl.bak';
			if ( false === @file_put_contents( $bak, $original ) ) {
				return false;
			}
		}
		$tmp = $path . '.' . getmypid() . '.iwsltmp';
		if ( false === @file_put_contents( $tmp, $new ) ) {
			$this->safe_unlink( $tmp );
			return false;
		}
		if ( ! @rename( $tmp, $path ) ) {
			$this->safe_unlink( $tmp );
			return false;
		}
		return true;
	}

	/** Unlink a path only if it is a real (non-symlink) file. */
	private function safe_unlink( string $path ): bool {
		if ( is_link( $path ) || is_file( $path ) ) {
			return @unlink( $path );
		}
		return false;
	}

	// ── the fail-safe guard (public so tests hit it directly) ───────────────────

	/**
	 * Run a string transform fail-safe: return the transform's result only when it is
	 * a string; on ANY Throwable or a non-string result, return the ORIGINAL input
	 * untouched. This is the invariant that guarantees a broken optimization can
	 * never blank or corrupt the site.
	 */
	public static function guard( string $original, callable $transform ): string {
		try {
			$out = $transform( $original );
			return is_string( $out ) ? $out : $original;
		} catch ( \Throwable $e ) {
			return $original;
		}
	}

	// ── list + number validators ────────────────────────────────────────────────

	/** Clamp a heartbeat interval into [HEARTBEAT_MIN, HEARTBEAT_MAX]. */
	public static function clamp_heartbeat( int $seconds ): int {
		if ( $seconds < self::HEARTBEAT_MIN ) {
			return self::HEARTBEAT_MIN;
		}
		if ( $seconds > self::HEARTBEAT_MAX ) {
			return self::HEARTBEAT_MAX;
		}
		return $seconds;
	}

	/**
	 * Sanitize a host list from a textarea string or array: split on newlines/commas,
	 * validate each as a bare hostname, lowercase, dedupe, cap at MAX_HOSTS. Immutable.
	 *
	 * @param mixed $raw
	 * @return string[]
	 */
	public static function sanitize_hosts( $raw ): array {
		$out = array();
		foreach ( self::to_lines( $raw ) as $line ) {
			$host = strtolower( trim( $line ) );
			if ( '' === $host || strlen( $host ) > self::MAX_HOST_LEN ) {
				continue;
			}
			if ( ! preg_match( '/^[a-z0-9]([a-z0-9\-.]{0,251}[a-z0-9])?$/', $host ) ) {
				continue;
			}
			if ( ! in_array( $host, $out, true ) ) {
				$out[] = $host;
			}
			if ( count( $out ) >= self::MAX_HOSTS ) {
				break;
			}
		}
		return $out;
	}

	/**
	 * Sanitize an exclusion-token list from a textarea string or array: split, strip
	 * control chars, trim, length-cap each, dedupe, cap at MAX_EXCLUSIONS. Immutable.
	 *
	 * @param mixed $raw
	 * @return string[]
	 */
	public static function sanitize_tokens( $raw ): array {
		$out = array();
		foreach ( self::to_lines( $raw ) as $line ) {
			$token = preg_replace( '/[\x00-\x1F\x7F]/', '', $line );
			$token = null === $token ? '' : trim( $token );
			if ( '' === $token ) {
				continue;
			}
			if ( strlen( $token ) > self::MAX_TOKEN_LEN ) {
				$token = substr( $token, 0, self::MAX_TOKEN_LEN );
			}
			if ( ! in_array( $token, $out, true ) ) {
				$out[] = $token;
			}
			if ( count( $out ) >= self::MAX_EXCLUSIONS ) {
				break;
			}
		}
		return $out;
	}

	/** Normalize a textarea string or array into a flat list of trimmed lines. @param mixed $raw @return string[] */
	private static function to_lines( $raw ): array {
		if ( is_array( $raw ) ) {
			$lines = array();
			foreach ( $raw as $item ) {
				if ( is_scalar( $item ) ) {
					$lines[] = (string) $item;
				}
			}
			return $lines;
		}
		if ( ! is_scalar( $raw ) ) {
			return array();
		}
		$parts = preg_split( '/[\r\n,]+/', (string) $raw );
		return is_array( $parts ) ? $parts : array();
	}

	// ── admin-post handler ───────────────────────────────────────────────────────

	/**
	 * admin-post handler for the settings save. LAYER 2 of the gate: capability +
	 * nonce, then re-check the entitlement before touching any stored setting, then
	 * save_settings() (whose STATEMENT 1 is the authoritative LAYER 3 gate). POST-
	 * redirect-GET back to the Plus page with a per-user result transient.
	 */
	public function handle_save(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::SAVE_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_speed_locked', '1', $redirect ) );
			exit;
		}

		$input = array(
			'minify_html'                => isset( $_POST['iwsl_sp_minify_html'] ),
			'defer_js'                   => isset( $_POST['iwsl_sp_defer_js'] ),
			'delay_js'                   => isset( $_POST['iwsl_sp_delay_js'] ),
			'server_headers'             => isset( $_POST['iwsl_sp_server_headers'] ),
			'resource_hints'             => isset( $_POST['iwsl_sp_resource_hints'] ),
			'remove_query_strings'       => isset( $_POST['iwsl_sp_remove_query_strings'] ),
			'disable_emojis'             => isset( $_POST['iwsl_sp_disable_emojis'] ),
			'disable_embeds'             => isset( $_POST['iwsl_sp_disable_embeds'] ),
			'instant_page'               => isset( $_POST['iwsl_sp_instant_page'] ),
			'heartbeat_control'          => isset( $_POST['iwsl_sp_heartbeat_control'] ),
			'heartbeat_disable_frontend' => isset( $_POST['iwsl_sp_heartbeat_disable_frontend'] ),
			'heartbeat_frequency'        => isset( $_POST['iwsl_sp_heartbeat_frequency'] ) ? (int) $_POST['iwsl_sp_heartbeat_frequency'] : self::HEARTBEAT_DEFAULT,
			'prefetch_hosts'             => isset( $_POST['iwsl_sp_prefetch_hosts'] ) ? sanitize_textarea_field( wp_unslash( $_POST['iwsl_sp_prefetch_hosts'] ) ) : '',
			'defer_exclusions'           => isset( $_POST['iwsl_sp_defer_exclusions'] ) ? sanitize_textarea_field( wp_unslash( $_POST['iwsl_sp_defer_exclusions'] ) ) : '',
		);

		$result = $this->save_settings( $input );

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::RESULT_PREFIX . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── admin UI ─────────────────────────────────────────────────────────────────

	/**
	 * Render the admin section: a locked notice listing the gate reasons when the
	 * feature is locked, otherwise the grouped settings form. All WordPress output
	 * helpers are function_exists-guarded so the class stays loadable under the
	 * no-WP harness.
	 */
	public function render_section(): void {
		if ( ! function_exists( 'esc_html' ) || ! function_exists( 'esc_attr' ) ) {
			return;
		}

		echo '<h2>' . esc_html__( 'Speed Pack', 'infraweaver-connector' ) . '</h2>';

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$this->render_result_notice();

		$settings = $this->settings();
		$action   = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : '';

		echo '<p class="description" style="max-width:720px;">'
			. esc_html__( 'A bundle of independent, on-server speed optimizations. Each is off by default — turn on only the ones you want, and any risky transform fails safe (a broken optimization returns the original output, never a blank page).', 'infraweaver-connector' )
			. '</p>';

		// Count enabled optimizations for the primary status meta.
		$toggle_keys = array( 'minify_html', 'defer_js', 'delay_js', 'server_headers', 'resource_hints', 'remove_query_strings', 'disable_emojis', 'disable_embeds', 'instant_page', 'heartbeat_control' );
		$on          = 0;
		foreach ( $toggle_keys as $tk ) {
			if ( ! empty( $settings[ $tk ] ) ) {
				$on++;
			}
		}

		echo '<form method="post" action="' . esc_url( $action ) . '" style="margin-top:12px;max-width:720px;">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::SAVE_NONCE );
		}
		echo '<input type="hidden" name="action" value="' . esc_attr( self::SAVE_ACTION ) . '">';

		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html(
			sprintf(
				/* translators: %d: number of enabled optimizations. */
				_n( '%d optimization enabled', '%d optimizations enabled', $on, 'infraweaver-connector' ),
				$on
			)
		) . '</span>';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'Save Speed Pack settings', 'infraweaver-connector' ) . '</button>';
		echo '</div>';

		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		$this->render_group_html_css_js( $settings );
		$this->render_group_server( $settings );
		$this->render_group_hints( $settings );
		$this->render_group_cleanup( $settings );
		$this->render_group_loading( $settings );
		echo '</div></details>';

		echo '</form>';
	}

	/** HTML / CSS / JS group. */
	private function render_group_html_css_js( array $s ): void {
		echo '<h3>' . esc_html__( 'HTML, CSS & JavaScript', 'infraweaver-connector' ) . '</h3>';
		echo '<table class="form-table widefat" role="presentation"><tbody>';
		$this->toggle_row( 'iwsl_sp_minify_html', __( 'Minify HTML', 'infraweaver-connector' ), ! empty( $s['minify_html'] ), __( 'Collapse whitespace and strip comments in the final front-end page (anonymous visitors only). The contents of pre, textarea, script, style and code are preserved byte-for-byte.', 'infraweaver-connector' ) );
		$this->toggle_row( 'iwsl_sp_defer_js', __( 'Defer JavaScript', 'infraweaver-connector' ), ! empty( $s['defer_js'] ), __( 'Add defer to non-critical local scripts so they no longer block rendering. Use the exclusion list below for scripts that must run early (e.g. jQuery on legacy themes).', 'infraweaver-connector' ) );
		$this->toggle_row( 'iwsl_sp_delay_js', __( 'Delay JavaScript until interaction', 'infraweaver-connector' ), ! empty( $s['delay_js'] ), __( 'Advanced: hold local scripts until the first scroll, tap or keypress. Big speed win, but can break scripts that must run on load — test carefully and exclude anything above the fold. Takes precedence over Defer.', 'infraweaver-connector' ) );
		echo '<tr><th scope="row"><label for="iwsl-sp-excl">' . esc_html__( 'JS exclusions', 'infraweaver-connector' ) . '</label></th><td>';
		echo '<textarea id="iwsl-sp-excl" name="iwsl_sp_defer_exclusions" class="large-text code" rows="3" placeholder="jquery&#10;/wp-includes/js/jquery/">' . esc_textarea( implode( "\n", (array) $s['defer_exclusions'] ) ) . '</textarea>';
		echo '<p class="description">' . esc_html__( 'One match per line; a script whose URL contains any of these is never deferred or delayed.', 'infraweaver-connector' ) . '</p></td></tr>';
		echo '</tbody></table>';
	}

	/** Server (gzip / expires) group. */
	private function render_group_server( array $s ): void {
		$status = $this->status();
		echo '<h3>' . esc_html__( 'Server (compression & browser cache)', 'infraweaver-connector' ) . '</h3>';
		echo '<table class="form-table widefat" role="presentation"><tbody>';
		$this->toggle_row( 'iwsl_sp_server_headers', __( 'GZIP/Brotli + Expires headers', 'infraweaver-connector' ), ! empty( $s['server_headers'] ), __( 'Write an Apache .htaccess block that turns on mod_deflate/mod_brotli compression and long browser-cache (Expires + Cache-Control) headers for static assets. Every directive is IfModule-guarded, so a missing module is skipped harmlessly. Removed automatically if the feature is revoked.', 'infraweaver-connector' ) );
		echo '<tr><th scope="row">' . esc_html__( 'Status', 'infraweaver-connector' ) . '</th><td>';
		if ( ! empty( $status['block_present'] ) ) {
			echo '<span class="description">' . esc_html__( 'Managed .htaccess block is written and active.', 'infraweaver-connector' ) . '</span>';
		} elseif ( empty( $status['htaccess_writable'] ) ) {
			echo '<span class="description">' . esc_html__( '.htaccess is not writable — turning this on will show a manual step instead of writing the block.', 'infraweaver-connector' ) . '</span>';
		} else {
			echo '<span class="description">' . esc_html__( 'No managed block written yet.', 'infraweaver-connector' ) . '</span>';
		}
		echo '</td></tr>';
		echo '</tbody></table>';
	}

	/** Hints group. */
	private function render_group_hints( array $s ): void {
		echo '<h3>' . esc_html__( 'Resource hints', 'infraweaver-connector' ) . '</h3>';
		echo '<table class="form-table widefat" role="presentation"><tbody>';
		$this->toggle_row( 'iwsl_sp_resource_hints', __( 'DNS-prefetch / preconnect', 'infraweaver-connector' ), ! empty( $s['resource_hints'] ), __( 'Warm up the connection to third-party hosts (fonts, analytics, CDNs) so their assets load sooner.', 'infraweaver-connector' ) );
		echo '<tr><th scope="row"><label for="iwsl-sp-hosts">' . esc_html__( 'Hosts', 'infraweaver-connector' ) . '</label></th><td>';
		echo '<textarea id="iwsl-sp-hosts" name="iwsl_sp_prefetch_hosts" class="large-text code" rows="3" placeholder="fonts.gstatic.com&#10;cdn.example.com">' . esc_textarea( implode( "\n", (array) $s['prefetch_hosts'] ) ) . '</textarea>';
		echo '<p class="description">' . esc_html__( 'One hostname per line (no scheme). Added to both dns-prefetch and preconnect.', 'infraweaver-connector' ) . '</p></td></tr>';
		echo '</tbody></table>';
	}

	/** Cleanup group. */
	private function render_group_cleanup( array $s ): void {
		echo '<h3>' . esc_html__( 'Cleanup', 'infraweaver-connector' ) . '</h3>';
		echo '<table class="form-table widefat" role="presentation"><tbody>';
		$this->toggle_row( 'iwsl_sp_remove_query_strings', __( 'Remove query strings from static assets', 'infraweaver-connector' ), ! empty( $s['remove_query_strings'] ), __( 'Strip the ?ver= cache-buster from CSS/JS URLs so more proxies and CDNs will cache them.', 'infraweaver-connector' ) );
		$this->toggle_row( 'iwsl_sp_disable_emojis', __( 'Disable emojis', 'infraweaver-connector' ), ! empty( $s['disable_emojis'] ), __( 'Remove the wp-emoji detection script and styles that load on every page.', 'infraweaver-connector' ) );
		$this->toggle_row( 'iwsl_sp_disable_embeds', __( 'Disable embeds', 'infraweaver-connector' ), ! empty( $s['disable_embeds'] ), __( 'Remove the oEmbed discovery links and host JavaScript. Existing embeds still render.', 'infraweaver-connector' ) );
		$this->toggle_row( 'iwsl_sp_heartbeat_control', __( 'Throttle Heartbeat', 'infraweaver-connector' ), ! empty( $s['heartbeat_control'] ), __( 'Slow down the admin-ajax Heartbeat that polls in the background, reducing server load.', 'infraweaver-connector' ) );
		echo '<tr><th scope="row"><label for="iwsl-sp-hb">' . esc_html__( 'Heartbeat interval', 'infraweaver-connector' ) . '</label></th><td>';
		echo '<input type="number" id="iwsl-sp-hb" name="iwsl_sp_heartbeat_frequency" min="' . esc_attr( (string) self::HEARTBEAT_MIN ) . '" max="' . esc_attr( (string) self::HEARTBEAT_MAX ) . '" value="' . esc_attr( (string) $s['heartbeat_frequency'] ) . '" class="small-text"> ' . esc_html__( 'seconds', 'infraweaver-connector' );
		echo '<label style="display:block;margin-top:6px;"><input type="checkbox" name="iwsl_sp_heartbeat_disable_frontend" value="1"' . ( ! empty( $s['heartbeat_disable_frontend'] ) ? ' checked' : '' ) . '> ' . esc_html__( 'Also disable Heartbeat entirely on the front end', 'infraweaver-connector' ) . '</label>';
		echo '</td></tr>';
		echo '</tbody></table>';
	}

	/** Loading group. */
	private function render_group_loading( array $s ): void {
		echo '<h3>' . esc_html__( 'Loading', 'infraweaver-connector' ) . '</h3>';
		echo '<table class="form-table widefat" role="presentation"><tbody>';
		$this->toggle_row( 'iwsl_sp_instant_page', __( 'Instant-load links on hover', 'infraweaver-connector' ), ! empty( $s['instant_page'] ), __( 'Prefetch same-origin pages when a visitor hovers or starts to tap a link, so the next page feels instant. Front-end only.', 'infraweaver-connector' ) );
		echo '</tbody></table>';
	}

	/** One checkbox row with a description. */
	private function toggle_row( string $name, string $label, bool $checked, string $description ): void {
		echo '<tr><th scope="row">' . esc_html( $label ) . '</th><td>';
		echo '<label><input type="checkbox" name="' . esc_attr( $name ) . '" value="1"' . ( $checked ? ' checked' : '' ) . '> ' . esc_html__( 'Enable', 'infraweaver-connector' ) . '</label>';
		echo '<p class="description">' . esc_html( $description ) . '</p>';
		echo '</td></tr>';
	}

	/** The locked-state notice, listing each gate reason in friendly language. */
	private function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => __( 'This site is not linked to the console.', 'infraweaver-connector' ),
			'heartbeat-stale' => __( 'The console has not verified this site recently.', 'infraweaver-connector' ),
			'requires-plus'   => __( 'Speed Pack requires a Pro plan.', 'infraweaver-connector' ),
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>'
			. esc_html__( '🔒 Speed Pack is locked.', 'infraweaver-connector' )
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
			$msg = __( 'Speed Pack settings saved.', 'infraweaver-connector' );
			if ( isset( $result['server_config']['manual_step'] ) ) {
				$msg .= ' ' . (string) $result['server_config']['manual_step'];
			}
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>' . esc_html( $msg ) . '</p></div>';
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>'
				. esc_html( sprintf( 'Could not save: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p></div>';
		}
	}

	// ── defaults (WordPress-derived, guarded for the harness) ───────────────────

	/** Lowercased home host from home_url(), '' outside WordPress. */
	private static function default_home_host(): string {
		if ( function_exists( 'home_url' ) ) {
			$home = home_url();
			if ( is_string( $home ) && '' !== $home ) {
				$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $home ) : parse_url( $home );
				if ( is_array( $parts ) && isset( $parts['host'] ) && is_string( $parts['host'] ) ) {
					return strtolower( $parts['host'] );
				}
			}
		}
		return '';
	}

	/** ABSPATH/.htaccess under WordPress, '' outside it. */
	private static function default_htaccess_path(): string {
		if ( defined( 'ABSPATH' ) ) {
			return rtrim( (string) ABSPATH, '/\\' ) . '/' . self::HTACCESS;
		}
		return '';
	}
}
