<?php
/**
 * Generic engine behind the gated "Maintenance Mode" feature.
 *
 * This is the payload behind the `maintenance_mode` entitlement (tier Pro), kept
 * separate from the gate (IWSL_Entitlements) so each can be reasoned about — and
 * tested — in isolation. It mirrors IWSL_Redirects exactly: a purely-local admin
 * settings action plus ONE passive front-end hook (template_redirect), with the
 * "should I block this request" decision split out as a pure function so the
 * effect (send 503 + exit) can be swapped for a recording fake under the harness.
 *
 * TRUST MODEL. Console-authoritative, like every other Plus feature: the
 * `maintenance_mode` flag is written ONLY by the dual-signed `entitlements.set`
 * runner (§7). There is deliberately NO self-set path, REST route, AJAX endpoint,
 * cron, or nopriv surface — this class is a purely-local admin action plus one
 * template_redirect callback. The gate is re-checked at three layers (admin page,
 * admin-post handler, and here as STATEMENT 1 of save_settings() and
 * maybe_block()). maybe_block()'s check is the authoritative one: it survives any
 * future caller that forgets the other two. If the console revokes the flag the
 * gate re-locks and the site is instantly public again — no option to unset, no
 * cache to bust.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network. The holding
 * page is fully self-contained (inline CSS, no external assets) and every dynamic
 * fragment (headline, message) is escaped before it reaches output. Logged-in
 * admins (manage_options) always bypass, and the admin area, wp-login.php,
 * REST and cron are never blocked — the request-type probe fails closed for
 * anything that is not a front-end template render. WordPress calls are
 * function_exists-guarded so the engine runs under the zero-dependency test
 * harness with an injected store, clock, responder and request-type probes.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Maintenance_Mode {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'maintenance_mode';

	/** admin-post action + nonce for the settings save. */
	const ACTION = 'iwsl_maintenance_mode_save';
	const NONCE  = 'iwsl_maintenance_mode_save';

	/** Store key for the sanitized settings map (option `iwsl_maintenance_mode`). */
	const SETTINGS_KEY = 'maintenance_mode';

	/** Per-user PRG result transient prefix (append the user id). */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_mm_result_';

	/** Byte ceiling on the headline field. */
	const MAX_HEADLINE_LEN = 200;
	/** Byte ceiling on the message field. */
	const MAX_MESSAGE_LEN = 1000;

	/** Seconds advertised in the Retry-After header when that flag is on. */
	const RETRY_AFTER_SECONDS = 3600;

	/** Furthest ahead an auto-off window may be scheduled (7 days). */
	const MAX_UNTIL_AHEAD_S = 604800;

	/** Cap on allow-listed literal IPs (no CIDR in v1). */
	const MAX_ALLOW_IPS = 10;

	/** HTTP status a blocked request receives. */
	const HTTP_STATUS = 503;

	/** Fallbacks used when the operator leaves a field blank. */
	const DEFAULT_HEADLINE = 'We’ll be right back';
	const DEFAULT_MESSAGE  = 'The site is undergoing scheduled maintenance. Please check back shortly.';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings live here. */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var callable fn(int $status, array $headers, string $body): void */
	private $responder;

	/** @var callable():bool whether the current user may bypass (manage_options). */
	private $is_admin;

	/** @var callable():bool whether this is a front-end template render. */
	private $is_front;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Settings persistence; defaults to the WP option store.
	 * @param callable|null     $now_ms       Clock, mirrors IWSL_Entitlements.
	 * @param callable|null     $responder    fn(status,headers,body):void; default sends the 503 + exits.
	 * @param callable|null     $is_admin     fn():bool; default is current_user_can('manage_options').
	 * @param callable|null     $is_front     fn():bool; default is the front-end request probe.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?IWSL_Store $store = null,
		?callable $now_ms = null,
		?callable $responder = null,
		?callable $is_admin = null,
		?callable $is_front = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		$this->responder = $responder ?? self::default_responder();
		$this->is_admin  = $is_admin ?? self::default_is_admin();
		$this->is_front  = $is_front ?? self::default_is_front();
	}

	/**
	 * Register the sole front-end hook. Guarded so the harness can call it
	 * harmlessly. Priority 0 — ahead of the redirect manager (1) and
	 * redirect_canonical (10) so an enabled maintenance mode wins for non-admins.
	 * The callback re-checks the gate as its first act, so a locked/revoked site
	 * serves the site normally.
	 */
	public function register(): void {
		if ( function_exists( 'add_action' ) ) {
			add_action( 'template_redirect', array( $this, 'maybe_block' ), 0 );
		}
	}

	// ── reads (safe on every render) ───────────────────────────────────────────

	/**
	 * The sanitized settings map, re-validated on every read (defence-in-depth): a
	 * DB-tampered value is normalized here, never mutated in place. `saved_at` is
	 * preserved from the stored record.
	 *
	 * @return array{ enabled:bool, headline:string, message:string, retry_after:bool, until:int, allow_ips:string[], saved_at:int }
	 */
	public function settings(): array {
		$stored = $this->store->get( self::SETTINGS_KEY, array() );
		$stored = is_array( $stored ) ? $stored : array();
		$clean  = $this->sanitize_settings( $stored );
		$clean['saved_at'] = isset( $stored['saved_at'] ) ? (int) $stored['saved_at'] : 0;
		return $clean;
	}

	/** Whether maintenance mode is switched on in the stored settings. */
	public function is_enabled(): bool {
		return ! empty( $this->settings()['enabled'] );
	}

	// ── mutator (STATEMENT 1 is the authoritative gate) ────────────────────────

	/**
	 * Persist a new settings map. STATEMENT 1 is the authoritative entitlement gate
	 * — nothing below it runs for a locked site, so a bypassed admin layer still
	 * cannot write settings. The whole input is run through the sanitizer (an
	 * immutable fresh map) before storage.
	 *
	 * @param array<string, mixed> $input Raw form input (unslashed by the caller).
	 * @return array{ ok:bool, reason?:string, settings?:array, gate?:array }
	 */
	public function save_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$clean             = $this->sanitize_settings( $input );
		$clean['saved_at'] = $this->now_seconds();
		$this->store->set( self::SETTINGS_KEY, $clean );
		// The holding page's own copy (headline/message) — and, more importantly,
		// its ON/OFF state — is front-end HTML that a page cache may have baked in
		// from before this save. Flush it so the change is visible immediately.
		// IWSL_Teardown is a peer engine; guarded so this class has no hard
		// dependency on it and stays harmless if it is not yet loaded.
		if ( class_exists( 'IWSL_Teardown' ) ) {
			IWSL_Teardown::flush_page_cache();
		}

		return array( 'ok' => true, 'settings' => $clean );
	}

	/**
	 * Teardown: permanently remove this feature's footprint — delete the stored
	 * settings option key. NOT gated by the entitlement: a full teardown must
	 * succeed even after `maintenance_mode` has already been revoked (that is
	 * precisely when a teardown is invoked). Idempotent + cheap: deleting an
	 * already-absent option key is a no-op.
	 *
	 * @return array{ ok:bool, options_removed:string[] }
	 */
	public function purge(): array {
		$this->store->delete( self::SETTINGS_KEY );
		return array(
			'ok'              => true,
			'options_removed' => array( self::SETTINGS_KEY ),
		);
	}

	// ── the engine (pure decision) + the effect ────────────────────────────────

	/**
	 * The pure blocking decision. NO gate, NO side effects — the caller owns the
	 * entitlement check; this only answers "given these three facts, block?".
	 * Block only when maintenance is enabled, the visitor is NOT an admin, and the
	 * request is a front-end render. Separating this out is what lets the harness
	 * assert the decision table directly.
	 */
	public function should_block( bool $enabled, bool $is_admin, bool $is_front ): bool {
		return $enabled && ! $is_admin && $is_front;
	}

	/**
	 * Build the 503 response WITHOUT sending it: an immutable
	 * { status, headers, body } record. Pure and side-effect-free so the harness
	 * can assert the status, the Retry-After header and the escaped body. Blank
	 * headline/message fall back to the built-in copy.
	 *
	 * @param array{ headline?:string, message?:string, retry_after?:bool } $settings
	 * @return array{ status:int, headers:array<string,string>, body:string }
	 */
	public function build_response( array $settings ): array {
		$headline = isset( $settings['headline'] ) && '' !== (string) $settings['headline']
			? (string) $settings['headline'] : self::DEFAULT_HEADLINE;
		$message = isset( $settings['message'] ) && '' !== (string) $settings['message']
			? (string) $settings['message'] : self::DEFAULT_MESSAGE;

		$headers = array(
			'Content-Type'  => 'text/html; charset=utf-8',
			'Cache-Control' => 'no-store, no-cache, must-revalidate, max-age=0',
		);
		if ( ! empty( $settings['retry_after'] ) ) {
			// When an auto-off window is set, advertise the REAL remaining seconds so
			// crawlers come back right after it lifts; otherwise the flat default.
			$secs  = self::RETRY_AFTER_SECONDS;
			$until = isset( $settings['until'] ) ? (int) $settings['until'] : 0;
			if ( $until > 0 ) {
				$remaining = $until - $this->now_seconds();
				if ( $remaining > 0 ) {
					$secs = $remaining;
				}
			}
			$headers['Retry-After'] = (string) $secs;
		}

		return array(
			'status'  => self::HTTP_STATUS,
			'headers' => $headers,
			'body'    => self::holding_page_html( $headline, $message ),
		);
	}

	/**
	 * The template_redirect callback. STATEMENT 1 is the authoritative gate — a
	 * locked/revoked flag returns immediately and the site renders normally. Then
	 * the pure decision; on a block, the injected responder sends the 503 and (in
	 * production) exits. Never blocks logged-in admins or the admin area.
	 */
	public function maybe_block(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}

		$settings   = $this->settings();
		// An auto-off window that has elapsed reads as "not enabled" (S8); an
		// allow-listed REMOTE_ADDR bypasses exactly like an admin (S7). Both facts
		// are folded into should_block's existing three so the pure decision table
		// is untouched.
		$enabled    = $this->is_active_now( $settings );
		$is_admin   = (bool) ( $this->is_admin )();
		$allowed_ip = $this->is_ip_allowed( $settings );
		$is_front   = (bool) ( $this->is_front )();

		if ( ! $this->should_block( $enabled, $is_admin || $allowed_ip, $is_front ) ) {
			return;
		}

		$response = $this->build_response( $settings );
		( $this->responder )( (int) $response['status'], (array) $response['headers'], (string) $response['body'] );
	}

	// ── the branded holding page (fully self-contained, everything escaped) ─────

	/**
	 * A clean, self-contained holding page. Inline CSS, no external asset, no
	 * script. The two dynamic fragments are the only untrusted values and both are
	 * escaped (headline via esc, message via nl2br(esc) to keep line breaks) — the
	 * URL-less, markup-less design keeps the attack surface at exactly those two
	 * escaped inserts.
	 */
	private static function holding_page_html( string $headline, string $message ): string {
		$h = self::esc( $headline );
		$m = nl2br( self::esc( $message ) );
		return '<!doctype html>'
			. '<html lang="en"><head><meta charset="utf-8">'
			. '<meta name="viewport" content="width=device-width, initial-scale=1">'
			. '<meta name="robots" content="noindex, nofollow">'
			. '<title>' . $h . '</title>'
			. '<style>'
			. '*{box-sizing:border-box}'
			. 'html,body{height:100%;margin:0}'
			. 'body{min-height:100%;display:flex;align-items:center;justify-content:center;'
			. 'padding:24px;background:#0b0f14;color:#e7edf3;'
			. 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
			. 'line-height:1.6;-webkit-font-smoothing:antialiased}'
			. '.card{max-width:520px;width:100%;text-align:center;'
			. 'background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.02));'
			. 'border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:44px 36px;'
			. 'box-shadow:0 24px 60px -24px rgba(0,0,0,.7)}'
			. '.dot{width:44px;height:44px;margin:0 auto 22px;border-radius:12px;'
			. 'background:radial-gradient(120% 120% at 30% 25%,#7cc4ff,#2a6df0);'
			. 'box-shadow:0 8px 26px -8px rgba(42,109,240,.8)}'
			. 'h1{margin:0 0 12px;font-size:26px;font-weight:700;letter-spacing:-.01em;color:#fff}'
			. 'p{margin:0;font-size:15px;color:#a9b6c4}'
			. '.foot{margin-top:26px;font-size:12px;color:#5f6f7e;letter-spacing:.03em}'
			. '</style></head><body>'
			. '<main class="card" role="main">'
			. '<div class="dot" aria-hidden="true"></div>'
			. '<h1>' . $h . '</h1>'
			. '<p>' . $m . '</p>'
			. '<div class="foot">HTTP 503 &middot; Service temporarily unavailable</div>'
			. '</main></body></html>';
	}

	/** esc_html when WordPress is present, htmlspecialchars otherwise (harness). */
	private static function esc( string $value ): string {
		if ( function_exists( 'esc_html' ) ) {
			return (string) esc_html( $value );
		}
		return htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	// ── the save-time validation gauntlet ──────────────────────────────────────

	/**
	 * Normalize a raw input map into the stored shape. Immutable: builds a fresh
	 * array; never mutates $input. Text fields are control-stripped and length-
	 * capped; the two booleans are cast.
	 *
	 * @param array<string, mixed> $input
	 * @return array{ enabled:bool, headline:string, message:string, retry_after:bool, until:int, allow_ips:string[], saved_at:int }
	 */
	public function sanitize_settings( array $input ): array {
		return array(
			'enabled'     => ! empty( $input['enabled'] ),
			'headline'    => self::clean_text( self::pluck( $input, 'headline' ), self::MAX_HEADLINE_LEN ),
			'message'     => self::clean_text( self::pluck( $input, 'message' ), self::MAX_MESSAGE_LEN ),
			'retry_after' => ! empty( $input['retry_after'] ),
			'until'       => $this->clean_until( $input ),
			'allow_ips'   => self::clean_ips( $input ),
			'saved_at'    => 0,
		);
	}

	/**
	 * Normalize an optional auto-off window (unix seconds). A non-positive / missing
	 * value means "no window"; a future value is clamped to MAX_UNTIL_AHEAD_S ahead
	 * of now so a fat-fingered timestamp can never leave the site dark for years. A
	 * value already in the past is preserved as-is — is_active_now() treats it as
	 * elapsed (i.e. maintenance off), which is the whole point of the window.
	 */
	private function clean_until( array $input ): int {
		$until = isset( $input['until'] ) && is_numeric( $input['until'] ) ? (int) $input['until'] : 0;
		if ( $until <= 0 ) {
			return 0;
		}
		$max = $this->now_seconds() + self::MAX_UNTIL_AHEAD_S;
		return $until > $max ? $max : $until;
	}

	/**
	 * Normalize the IP allow-list: literal IPv4/IPv6 only (a CIDR like `10.0.0.0/8`
	 * fails FILTER_VALIDATE_IP and is dropped), de-duped, capped at MAX_ALLOW_IPS.
	 * Accepts either an array of strings or a whitespace/comma-separated string so a
	 * console textarea maps cleanly. Stored verbatim; canonicalized only at compare
	 * time (is_ip_allowed) so the surface stays human-readable.
	 *
	 * @param array<string, mixed> $input
	 * @return string[]
	 */
	private static function clean_ips( array $input ): array {
		$raw = isset( $input['allow_ips'] ) ? $input['allow_ips'] : array();
		if ( is_string( $raw ) ) {
			$raw = preg_split( '/[\s,]+/', $raw, -1, PREG_SPLIT_NO_EMPTY );
			$raw = is_array( $raw ) ? $raw : array();
		}
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$out  = array();
		$seen = array();
		foreach ( $raw as $ip ) {
			if ( ! is_string( $ip ) ) {
				continue;
			}
			$ip = trim( $ip );
			if ( false === filter_var( $ip, FILTER_VALIDATE_IP ) || isset( $seen[ $ip ] ) ) {
				continue;
			}
			$seen[ $ip ] = true;
			$out[]       = $ip;
			if ( count( $out ) >= self::MAX_ALLOW_IPS ) {
				break;
			}
		}
		return $out;
	}

	/**
	 * Whether maintenance is *effectively active right now*: enabled AND, if an
	 * auto-off window is set, not yet elapsed. Pure — the caller supplies (or lets
	 * it default to) the clock so the harness can assert the expiry boundary.
	 *
	 * @param array<string, mixed> $settings A sanitized settings map.
	 */
	public function is_active_now( array $settings, ?int $now_s = null ): bool {
		if ( empty( $settings['enabled'] ) ) {
			return false;
		}
		$until = isset( $settings['until'] ) ? (int) $settings['until'] : 0;
		if ( $until > 0 ) {
			$now = null !== $now_s ? $now_s : $this->now_seconds();
			if ( $now >= $until ) {
				return false; // Window elapsed → maintenance is off.
			}
		}
		return true;
	}

	/**
	 * Whether the request's client IP is allow-listed. Compares ONLY REMOTE_ADDR —
	 * never X-Forwarded-For, which a client can spoof — canonicalizing both sides
	 * with inet_pton so `::1` and its long form compare equal. An empty allow-list,
	 * an unparseable client address, or a proxy that hides the real IP → not allowed
	 * (fail-closed). The reverse-proxy caveat is surfaced in the console UI.
	 *
	 * @param array<string, mixed> $settings    A sanitized settings map.
	 * @param string|null          $remote_addr Override for the harness; default $_SERVER['REMOTE_ADDR'].
	 */
	public function is_ip_allowed( array $settings, ?string $remote_addr = null ): bool {
		$ips = isset( $settings['allow_ips'] ) && is_array( $settings['allow_ips'] ) ? $settings['allow_ips'] : array();
		if ( array() === $ips ) {
			return false;
		}
		$addr = null !== $remote_addr
			? $remote_addr
			: ( isset( $_SERVER['REMOTE_ADDR'] ) ? (string) $_SERVER['REMOTE_ADDR'] : '' );
		$canon = self::canon_ip( $addr );
		if ( '' === $canon ) {
			return false;
		}
		foreach ( $ips as $ip ) {
			if ( is_string( $ip ) && self::canon_ip( $ip ) === $canon ) {
				return true;
			}
		}
		return false;
	}

	/** Canonical byte form (hex) of a literal IP, or '' when it is not a valid IP. */
	private static function canon_ip( string $ip ): string {
		$ip = trim( $ip );
		if ( false === filter_var( $ip, FILTER_VALIDATE_IP ) ) {
			return '';
		}
		$packed = @inet_pton( $ip );
		return false === $packed ? '' : bin2hex( $packed );
	}

	/** Read a string field defensively from a mixed input map. */
	private static function pluck( array $input, string $key ): string {
		return isset( $input[ $key ] ) && is_string( $input[ $key ] ) ? $input[ $key ] : '';
	}

	/**
	 * Normalize a free-text field: strip control characters EXCEPT newline/tab
	 * (line breaks are meaningful in the message), trim, and hard-truncate to $max
	 * bytes. Kept plain — the renderer escapes at output, so no markup is stored.
	 */
	private static function clean_text( string $value, int $max ): string {
		$stripped = preg_replace( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $value );
		$stripped = null === $stripped ? '' : trim( $stripped );
		if ( strlen( $stripped ) > $max ) {
			$stripped = substr( $stripped, 0, $max );
		}
		return $stripped;
	}

	// ── default injected dependencies (all WordPress calls guarded) ────────────

	/** The default responder: send the 503, its headers, the body, then exit. */
	private static function default_responder(): callable {
		return static function ( int $status, array $headers, string $body ): void {
			if ( function_exists( 'status_header' ) ) {
				status_header( $status );
			} elseif ( ! headers_sent() ) {
				header( 'HTTP/1.1 ' . $status . ' Service Unavailable', true, $status );
			}
			if ( function_exists( 'nocache_headers' ) ) {
				nocache_headers();
			}
			if ( ! headers_sent() ) {
				foreach ( $headers as $name => $value ) {
					header( (string) $name . ': ' . (string) $value );
				}
			}
			// $body is fully pre-escaped in holding_page_html().
			echo $body; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			exit;
		};
	}

	/** Admins (manage_options) bypass maintenance mode. */
	private static function default_is_admin(): callable {
		return static function (): bool {
			return function_exists( 'current_user_can' ) ? (bool) current_user_can( 'manage_options' ) : false;
		};
	}

	/**
	 * Whether this is a front-end template render. Fails closed for the admin area,
	 * cron, AJAX, the REST API and wp-login.php so none of those is ever blocked.
	 */
	private static function default_is_front(): callable {
		return static function (): bool {
			if ( function_exists( 'is_admin' ) && is_admin() ) {
				return false;
			}
			if ( function_exists( 'wp_doing_cron' ) && wp_doing_cron() ) {
				return false;
			}
			if ( function_exists( 'wp_doing_ajax' ) && wp_doing_ajax() ) {
				return false;
			}
			if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
				return false;
			}
			if ( isset( $GLOBALS['pagenow'] ) && 'wp-login.php' === $GLOBALS['pagenow'] ) {
				return false;
			}
			return true;
		};
	}

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}

	// ── admin surface (LAYER 1 UX + LAYER 2 handler; wired by the main thread) ──

	/**
	 * Render the maintenance-mode admin section (LAYER 1 of the gate). Locked →
	 * reasons only, no form. Unlocked → the current ON/OFF indicator + the settings
	 * form + a preview note. Only ever called inside wp-admin, but guarded so it is
	 * harmless without WordPress.
	 */
	public function render_section(): void {
		if ( ! function_exists( 'esc_html__' ) || ! function_exists( 'admin_url' ) ) {
			return;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'Maintenance Mode', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Show visitors a branded holding page and return HTTP 503 while you work — logged-in administrators always see the live site. Revoking the entitlement makes the site public again instantly.', 'infraweaver-connector' ) . '</p>';

		if ( isset( $_GET['iwsl_mm_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . esc_html__( 'The Maintenance Mode entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$this->render_result_notice();
		$this->render_status_indicator();
		$this->render_form();
	}

	/** Reason lines for a locked maintenance-mode gate (no form). */
	private function render_locked_notice( array $gate ): void {
		// NOTE: `requires-plus` is a HISTORICAL reason token that fires for ANY
		// flag; here it maps to the maintenance-mode-specific message (Pro tier).
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The Maintenance Mode entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 Maintenance Mode is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul>';
		// A real next step, not a dead end: link to the console when one is known
		// (see IWSL_Admin::console_url()); otherwise the reason lines stand alone.
		$console = class_exists( 'IWSL_Admin' ) ? IWSL_Admin::console_url() : '';
		if ( '' !== $console ) {
			echo '<p style="margin:8px 0 0;"><a class="button button-primary" href="' . esc_url( $console ) . '" target="_blank" rel="noopener">Open the InfraWeaver console <span class="dashicons dashicons-external" aria-hidden="true"></span></a></p>';
		}
		echo '</div>';
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
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>' . esc_html__( 'Maintenance settings saved.', 'infraweaver-connector' ) . '</p></div>';
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>' . esc_html( sprintf( 'Could not save: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p></div>';
		}
	}

	/** The live "currently ON / OFF" indicator. */
	private function render_status_indicator(): void {
		$on = $this->is_enabled();
		$bg = $on ? '#b3261e' : '#1a7f37';
		echo '<p style="margin-top:12px;"><span style="display:inline-block;padding:4px 12px;border-radius:999px;font-weight:650;color:#fff;background:' . esc_attr( $bg ) . ';">'
			. ( $on ? esc_html__( 'Maintenance mode is ON — visitors see the holding page (503).', 'infraweaver-connector' )
					: esc_html__( 'Maintenance mode is OFF — the site is live.', 'infraweaver-connector' ) )
			. '</span></p>';
	}

	/** The nonce-protected settings form (POST → admin-post.php). */
	private function render_form(): void {
		$s        = $this->settings();
		$enabled  = ! empty( $s['enabled'] );
		$retry    = ! empty( $s['retry_after'] );
		$headline = isset( $s['headline'] ) ? (string) $s['headline'] : '';
		$message  = isset( $s['message'] ) ? (string) $s['message'] : '';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:16px;max-width:640px;">';
		wp_nonce_field( self::NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::ACTION ) . '">';

		// Primary: the enable toggle — the one thing most operators come here to flip.
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th scope="row">' . esc_html__( 'Status', 'infraweaver-connector' ) . ' ' . iwsl_field_help( 'Turns the “be right back” page on or off for visitors.' ) . '</th><td>';
		echo '<label><input type="checkbox" name="iwsl_mm_enabled" value="1"' . checked( $enabled, true, false ) . '> ' . esc_html__( 'Enable maintenance mode', 'infraweaver-connector' ) . '</label></td></tr>';
		echo '</tbody></table>';

		// Advanced: holding-page copy + crawler Retry-After. Collapsed by default.
		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row"><label for="iwsl-mm-headline">' . esc_html__( 'Headline', 'infraweaver-connector' ) . '</label> ' . iwsl_field_help( 'The big title shown on the “be right back” page.' ) . '</th>';
		echo '<td><input type="text" id="iwsl-mm-headline" name="iwsl_mm_headline" class="regular-text" value="' . esc_attr( $headline ) . '" placeholder="' . esc_attr( self::DEFAULT_HEADLINE ) . '"></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-mm-message">' . esc_html__( 'Message', 'infraweaver-connector' ) . '</label> ' . iwsl_field_help( 'The short note telling visitors why the site is offline.' ) . '</th>';
		echo '<td><textarea id="iwsl-mm-message" name="iwsl_mm_message" class="large-text" rows="3" placeholder="' . esc_attr( self::DEFAULT_MESSAGE ) . '">' . esc_textarea( $message ) . '</textarea>';
		echo '<p class="description">' . esc_html__( 'Shown on the holding page. Plain text only; line breaks are kept.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Retry-After', 'infraweaver-connector' ) . ' ' . iwsl_field_help( 'Politely tells Google to check back later, not to drop your pages.' ) . '</th><td>';
		echo '<label><input type="checkbox" name="iwsl_mm_retry_after" value="1"' . checked( $retry, true, false ) . '> ' . esc_html( sprintf( 'Send a Retry-After header (%d seconds) so crawlers know to come back', self::RETRY_AFTER_SECONDS ) ) . '</label></td></tr>';

		echo '</tbody></table>';
		echo '</div></details>';
		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Save maintenance settings', 'infraweaver-connector' ) . '</button></p>';
		echo '</form>';
	}

	/**
	 * admin-post handler for the settings save. LAYER 2 of the gate: capability +
	 * nonce, then re-check the entitlement before touching any stored setting, then
	 * save_settings() (whose first statement is the authoritative LAYER 3 gate).
	 * POST-redirect-GET back to the Plus page.
	 */
	public function handle_save(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::NONCE );

		$redirect = iwsl_plus_redirect_base();

		// LAYER 2: re-check the gate before touching any stored setting.
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_mm_locked', '1', $redirect ) );
			exit;
		}

		// The basic wp-admin form does not surface the auto-off window or the IP
		// allow-list (the console `maintenance.set` path manages those); carry the
		// currently-stored values forward so a plain admin toggle never silently
		// clears a console-configured window or allow-list.
		$current = $this->settings();
		$input   = array(
			'enabled'     => isset( $_POST['iwsl_mm_enabled'] ),
			'headline'    => isset( $_POST['iwsl_mm_headline'] ) ? sanitize_text_field( wp_unslash( $_POST['iwsl_mm_headline'] ) ) : '',
			'message'     => isset( $_POST['iwsl_mm_message'] ) ? sanitize_textarea_field( wp_unslash( $_POST['iwsl_mm_message'] ) ) : '',
			'retry_after' => isset( $_POST['iwsl_mm_retry_after'] ),
			'until'       => $current['until'],
			'allow_ips'   => $current['allow_ips'],
		);

		$result = $this->save_settings( $input ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}
}
