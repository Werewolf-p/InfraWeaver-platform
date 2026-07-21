<?php
/**
 * Generic engine behind the gated "Custom login + admin white-label" feature.
 *
 * This is the payload behind the `white_label` entitlement (tier Ultimate), kept
 * separate from the gate (IWSL_Entitlements) and from the branding surfaces
 * (IWSL_Brand_Surface implementations) so each can be reasoned about — and tested
 * — in isolation.
 *
 * TRUST MODEL. The feature is console-authoritative: the `white_label` flag is
 * written ONLY by the dual-signed `entitlements.set` runner (§7). There is
 * deliberately no self-set path, REST route, AJAX endpoint, cron, or nopriv
 * surface here — this class is a purely-local admin settings action plus a handful
 * of passive login/admin presentation hooks, mirroring the IWSL_Redirects pattern.
 * The gate is re-checked at three layers (admin page, admin-post handler, and here
 * as STATEMENT 1 of save_settings() and apply()). Every behavior-applying hook
 * callback ALSO re-checks the gate (via apply(), whose first statement is the
 * gate), so revoking the flag from the console instantly restores default
 * WordPress login and admin chrome — no cache to bust, no option to unset.
 *
 * RESIDUAL RISK (honest statement). A site owner with direct database write access
 * can flip the local entitlement option and unlock this without the console —
 * exactly the accepted threat model of the existing `plus` gate. That is bounded
 * by heartbeat staleness: if the console stops managing the site, the signed
 * heartbeat goes stale and the gate re-locks within HEARTBEAT_FRESH_MS (2h),
 * because evaluate() requires state==active AND a fresh signed contact, not merely
 * the flag.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network. Nothing is
 * ever rendered from raw settings: every stored value passes the full save-time
 * gauntlet (URLs: scheme/host/userinfo/CRLF/backslash/scheme-relative/CSS-break
 * checks; text: control-strip + length cap) before storage, AND is re-validated on
 * every read so a DB-tampered value that no longer validates is silently dropped
 * to its default rather than reaching output. Surfaces escape every dynamic
 * fragment they emit. WordPress calls are function_exists-guarded so the engine
 * runs under the zero-dependency test harness with an injected store, clock and
 * surface registry.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_White_Label {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'white_label';

	/** Store key for the sanitized settings map. */
	const SETTINGS_KEY = 'white_label_settings';

	/** Byte ceiling on a stored URL. */
	const MAX_URL_LEN = 2048;
	/** Byte ceiling on a single-line text field (header text). */
	const MAX_TEXT_LEN = 200;
	/** Byte ceiling on a longer text field (login message / admin footer). */
	const MAX_MESSAGE_LEN = 500;

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings live here. */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var array<string, IWSL_Brand_Surface> id-keyed surface registry. */
	private $surfaces;

	/**
	 * @param IWSL_Entitlements                        $entitlements The gate.
	 * @param IWSL_Store                               $store        Settings persistence.
	 * @param callable|null                            $now_ms       Clock, mirrors IWSL_Entitlements.
	 * @param array<string, IWSL_Brand_Surface>|null   $surfaces     Registry override (tests inject fakes);
	 *                                                                defaults to self::surfaces().
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		IWSL_Store $store,
		?callable $now_ms = null,
		?array $surfaces = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = $store;
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		$this->surfaces = null !== $surfaces ? $surfaces : self::surfaces();
	}

	/**
	 * The id-keyed surface registry. Adding a white-label area is one class + one
	 * line here — this is the "generic solution" the interface exists to enable.
	 *
	 * @return array<string, IWSL_Brand_Surface>
	 */
	public static function surfaces(): array {
		return array(
			'login' => new IWSL_Login_Brand_Surface(),
			'admin' => new IWSL_Admin_Brand_Surface(),
		);
	}

	/** Surface ids, for the admin capability table. @return string[] */
	public function surface_ids(): array {
		return array_keys( $this->surfaces );
	}

	/**
	 * Per-surface metadata for the admin capability table. Side-effect free — safe
	 * on every render.
	 *
	 * @return array<string, array{ id:string, label:string, hooks:string[] }>
	 */
	public function capabilities(): array {
		$out = array();
		foreach ( $this->surfaces as $id => $surface ) {
			$out[ $id ] = array(
				'id'    => $surface->id(),
				'label' => $surface->label(),
				'hooks' => $surface->hooks(),
			);
		}
		return $out;
	}

	/**
	 * Register the passive presentation hooks. Guarded so the harness can call it
	 * harmlessly. Registered on EVERY request (the login hooks fire on wp-login.php,
	 * which is not an admin context), because every callback re-checks the gate as
	 * its first act — a locked or revoked site gets default chrome instantly.
	 */
	public function register(): void {
		if ( ! function_exists( 'add_filter' ) || ! function_exists( 'add_action' ) ) {
			return;
		}
		add_filter( 'login_headerurl', array( $this, 'filter_login_header_url' ), 20 );
		add_filter( 'login_headertext', array( $this, 'filter_login_header_text' ), 20 );
		add_filter( 'login_message', array( $this, 'filter_login_message' ), 20 );
		add_action( 'login_enqueue_scripts', array( $this, 'print_login_styles' ) );
		add_filter( 'admin_footer_text', array( $this, 'filter_admin_footer_text' ), 20 );
		add_action( 'wp_before_admin_bar_render', array( $this, 'remove_admin_bar_wp_logo' ) );
	}

	// ── reads (safe on every render) ───────────────────────────────────────────

	/**
	 * The sanitized settings map, RE-VALIDATED on every read (defence-in-depth): a
	 * DB-tampered URL that no longer passes the gauntlet is dropped to '' here, never
	 * mutated in place, so nothing unsafe can reach output even if the option is
	 * edited directly. `saved_at` is preserved from the stored record.
	 *
	 * @return array{ login_logo_url:string, login_header_url:string, login_header_text:string, login_message:string, admin_footer_text:string, hide_wp_logo:bool, saved_at:int }
	 */
	public function settings(): array {
		$stored = $this->store->get( self::SETTINGS_KEY, array() );
		$stored = is_array( $stored ) ? $stored : array();
		$clean  = $this->sanitize_settings( $stored );
		$clean['saved_at'] = isset( $stored['saved_at'] ) ? (int) $stored['saved_at'] : 0;
		return $clean;
	}

	/** Alias used by the admin form for clarity. @return array */
	public function settings_for_render(): array {
		return $this->settings();
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

		return array( 'ok' => true, 'settings' => $clean );
	}

	// ── the engine (pure decision) ─────────────────────────────────────────────

	/**
	 * The pure branding decision. STATEMENT 1 is the authoritative gate, returning a
	 * locked result with ZERO side effects. Otherwise it resolves each registered
	 * surface against the (re-validated) settings and returns the immutable per-
	 * surface fragment map. Never echoes and never touches a hook: separating the
	 * decision from the effect is what lets the hook callbacks and the harness share
	 * one gated code path.
	 *
	 * @return array{ ok:bool, reason?:string, applied:bool, surfaces?:array, settings?:array, gate?:array }
	 */
	public function apply(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'applied' => false, 'gate' => $gate );
		}

		$settings = $this->settings();
		$resolved = array();
		foreach ( $this->surfaces as $id => $surface ) {
			$resolved[ $id ] = $surface->resolve( $settings );
		}

		return array(
			'ok'       => true,
			'applied'  => true,
			'surfaces' => $resolved,
			'settings' => $settings,
		);
	}

	// ── the effects (each callback re-checks the gate via apply()) ─────────────

	/**
	 * `login_headerurl` filter. First statement re-checks the gate (via apply());
	 * a locked/revoked site returns the default URL untouched.
	 *
	 * @param mixed $default_url
	 * @return mixed
	 */
	public function filter_login_header_url( $default_url ) {
		$login = $this->unlocked_surface( 'login' );
		if ( null === $login || '' === (string) $login['header_url'] ) {
			return $default_url;
		}
		return (string) $login['header_url'];
	}

	/**
	 * `login_headertext` filter. Gate-checked first; returns the escaped custom
	 * text, or the default when locked / unset.
	 *
	 * @param mixed $default_text
	 * @return mixed
	 */
	public function filter_login_header_text( $default_text ) {
		$login = $this->unlocked_surface( 'login' );
		if ( null === $login || '' === (string) $login['header_text'] ) {
			return $default_text;
		}
		return (string) $login['header_text'];
	}

	/**
	 * `login_message` filter. Gate-checked first; PREPENDS the escaped custom
	 * message to whatever WordPress was already going to show.
	 *
	 * @param mixed $message
	 * @return mixed
	 */
	public function filter_login_message( $message ) {
		$login = $this->unlocked_surface( 'login' );
		if ( null === $login || '' === (string) $login['message_html'] ) {
			return $message;
		}
		return (string) $login['message_html'] . (string) $message;
	}

	/**
	 * `login_enqueue_scripts` action. Gate-checked first; prints the login logo
	 * <style> block. The CSS carries only a rigorously validated, CSS-safe,
	 * esc_url()'d background-image URL — the one place esc_html cannot apply (it
	 * would break the CSS), so the URL gauntlet is the boundary.
	 */
	public function print_login_styles(): void {
		$login = $this->unlocked_surface( 'login' );
		if ( null === $login || '' === (string) $login['logo_css'] ) {
			return;
		}
		echo '<style id="iwsl-white-label-login">' . $login['logo_css'] . '</style>' . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	}

	/**
	 * `admin_footer_text` filter. Gate-checked first; returns the escaped custom
	 * footer credit, or the default when locked / unset.
	 *
	 * @param mixed $text
	 * @return mixed
	 */
	public function filter_admin_footer_text( $text ) {
		$admin = $this->unlocked_surface( 'admin' );
		if ( null === $admin || '' === (string) $admin['footer_html'] ) {
			return $text;
		}
		return (string) $admin['footer_html'];
	}

	/**
	 * `wp_before_admin_bar_render` action. Gate-checked first; removes the WordPress
	 * logo node from the admin bar when configured. No-op if the flag is off or the
	 * admin bar object is unavailable.
	 */
	public function remove_admin_bar_wp_logo(): void {
		$admin = $this->unlocked_surface( 'admin' );
		if ( null === $admin || empty( $admin['hide_wp_logo'] ) ) {
			return;
		}
		if ( isset( $GLOBALS['wp_admin_bar'] )
			&& is_object( $GLOBALS['wp_admin_bar'] )
			&& method_exists( $GLOBALS['wp_admin_bar'], 'remove_node' ) ) {
			$GLOBALS['wp_admin_bar']->remove_node( 'wp-logo' );
		}
	}

	/**
	 * The resolved fragments for one surface, but ONLY when the gate is unlocked;
	 * null otherwise. apply()'s first statement is the authoritative gate, so every
	 * caller of this method re-checks the entitlement before it can apply anything.
	 *
	 * @return array<string, mixed>|null
	 */
	private function unlocked_surface( string $id ): ?array {
		$decision = $this->apply();
		if ( empty( $decision['applied'] ) || ! isset( $decision['surfaces'][ $id ] ) ) {
			return null;
		}
		return $decision['surfaces'][ $id ];
	}

	// ── the save-time validation gauntlet ──────────────────────────────────────

	/**
	 * Normalize a raw input map into the stored settings shape. Immutable: builds a
	 * fresh array; never mutates $input. URLs go through the URL gauntlet, text
	 * through control-strip + length cap, the logo checkbox through a boolean cast.
	 *
	 * @param array<string, mixed> $input
	 * @return array{ login_logo_url:string, login_header_url:string, login_header_text:string, login_message:string, admin_footer_text:string, hide_wp_logo:bool, saved_at:int }
	 */
	public function sanitize_settings( array $input ): array {
		return array(
			// Logo URL is CSS-context bound → the stricter css_safe gauntlet.
			'login_logo_url'    => $this->clean_url( self::pluck( $input, 'login_logo_url' ), true ),
			'login_header_url'  => $this->clean_url( self::pluck( $input, 'login_header_url' ), false ),
			'login_header_text' => self::clean_text( self::pluck( $input, 'login_header_text' ), self::MAX_TEXT_LEN ),
			'login_message'     => self::clean_text( self::pluck( $input, 'login_message' ), self::MAX_MESSAGE_LEN ),
			'admin_footer_text' => self::clean_text( self::pluck( $input, 'admin_footer_text' ), self::MAX_MESSAGE_LEN ),
			'hide_wp_logo'      => ! empty( $input['hide_wp_logo'] ),
			'saved_at'          => 0,
		);
	}

	/** Read a string field defensively from a mixed input map. */
	private static function pluck( array $input, string $key ): string {
		return isset( $input[ $key ] ) && is_string( $input[ $key ] ) ? $input[ $key ] : '';
	}

	/** Validate a URL and return it, or '' when it fails the gauntlet. */
	private function clean_url( string $url, bool $css_safe ): string {
		$result = $this->validate_url( $url, $css_safe );
		return empty( $result['ok'] ) ? '' : (string) $result['value'];
	}

	/**
	 * The URL gauntlet. An empty URL is valid (it simply means "don't override this
	 * piece"). A non-empty URL must be either a rooted internal path (`/…`, no
	 * scheme, no `//`) or a strict absolute http(s) URL (scheme, host, no userinfo,
	 * wp_http_validate_url + esc_url_raw round-trip when WordPress is present).
	 * CSS-context URLs additionally forbid quote/paren bytes.
	 *
	 * @return array{ ok:bool, value:string }
	 */
	private function validate_url( string $url, bool $css_safe ): array {
		$url = trim( $url );
		if ( '' === $url ) {
			return array( 'ok' => true, 'value' => '' );
		}
		if ( strlen( $url ) > self::MAX_URL_LEN ) {
			return self::bad_url();
		}
		if ( false !== strpos( $url, '\\' ) || preg_match( '/[\x00-\x1F\x7F\s]/', $url ) ) {
			return self::bad_url();
		}
		if ( 0 === strpos( $url, '//' ) ) {
			return self::bad_url(); // scheme-relative → host confusion.
		}
		if ( $css_safe && preg_match( '/["\'()]/', $url ) ) {
			return self::bad_url(); // would break out of the CSS url("…") token.
		}

		// Rooted internal path.
		if ( '/' === $url[0] ) {
			if ( false !== strpos( $url, '://' ) ) {
				return self::bad_url();
			}
			return array( 'ok' => true, 'value' => $url );
		}

		// Absolute http(s) URL.
		$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
		if ( ! is_array( $parts ) ) {
			return self::bad_url();
		}
		$scheme = isset( $parts['scheme'] ) ? strtolower( (string) $parts['scheme'] ) : '';
		if ( 'http' !== $scheme && 'https' !== $scheme ) {
			return self::bad_url();
		}
		if ( empty( $parts['host'] ) ) {
			return self::bad_url();
		}
		if ( isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			return self::bad_url(); // https://trusted@evil.com userinfo confusion.
		}
		if ( function_exists( 'wp_http_validate_url' ) && ! wp_http_validate_url( $url ) ) {
			return self::bad_url();
		}
		if ( function_exists( 'esc_url_raw' ) ) {
			$clean = esc_url_raw( $url, array( 'http', 'https' ) );
			if ( $clean !== $url ) {
				return self::bad_url();
			}
		}
		return array( 'ok' => true, 'value' => $url );
	}

	/** A fresh URL-validation failure. */
	private static function bad_url(): array {
		return array( 'ok' => false, 'value' => '' );
	}

	/**
	 * Normalize a free-text field: strip control characters (including CR/LF), trim,
	 * and hard-truncate to $max bytes. Kept plain — every consumer escapes at
	 * render, so no markup is stored.
	 */
	private static function clean_text( string $value, int $max ): string {
		$stripped = preg_replace( '/[\x00-\x1F\x7F]/', '', $value );
		$stripped = null === $stripped ? '' : trim( $stripped );
		if ( strlen( $stripped ) > $max ) {
			$stripped = substr( $stripped, 0, $max );
		}
		return $stripped;
	}

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}
}
