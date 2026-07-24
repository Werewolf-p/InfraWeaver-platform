<?php
/**
 * HTTP security-header grader + emitter (gate flag `security_headers`, Pro+).
 *
 * TWO responsibilities, both deliberately narrow:
 *
 *  1. GRADE (read-only, pure). `grade_headers()` takes the response-header map of
 *     a loopback fetch of the site's OWN home URL and scores the security posture
 *     A–F with a per-header verdict (good / weak / missing) and a plain-language
 *     "why this matters" line, plus a `leaks` list for information-disclosure
 *     headers (X-Powered-By / Server). Pure, unit-tested, no I/O — the fetch is
 *     done by `scan()` behind the SAME loopback SSRF anchor the response-time
 *     scanner already ships (`IWSL_Response_Scan::same_host()`), never a second
 *     implementation.
 *
 *  2. EMIT (write, closed-set). `send_headers()` applies a stored, VALUE-VALIDATED
 *     hardening config on WordPress's `send_headers` hook. The config is a CLOSED
 *     key/enum set — the operator never supplies a free-form header name or value,
 *     so header injection is foreclosed by construction. Every emitted header is
 *     a fixed token or a bounded, allow-listed value. CSP is only ever emitted
 *     `Content-Security-Policy-Report-Only` until the operator takes an explicit
 *     second `enforce` step, and `revert` clears everything.
 *
 * STATEMENT 1 of every write/emit path is the entitlement gate (LAYER 3), exactly
 * like every other engine. The emitter additionally NEVER duplicates a header
 * already present in `headers_list()` (another plugin, or an upstream ingress that
 * PHP can see), so it can never contradict a header the platform already set.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Security_Headers {

	/** Entitlement flag gating this engine (Pro+). */
	const FEATURE = 'security_headers';

	/** Store key holding the sanitized hardening config. */
	const OPTION_KEY = 'security_headers';

	/** Loopback fetch timeout (seconds). */
	const TIMEOUT_S = 10;

	/** HSTS max-age (seconds) considered strong: 6 months. Below → "weak". */
	const HSTS_STRONG_MAX_AGE = 15768000;

	/** HSTS max-age the emitter writes: 1 year + includeSubDomains. */
	const HSTS_EMIT = 'max-age=31536000; includeSubDomains';

	/** Conservative Permissions-Policy the emitter writes (fixed token, no input). */
	const PERMISSIONS_EMIT = 'geolocation=(), camera=(), microphone=(), payment=()';

	/**
	 * The baseline CSP the emitter writes. Deliberately LAX (allows inline/eval)
	 * so turning it on report-only first surfaces violations without breaking a
	 * typical WordPress theme; the operator tightens it out-of-band. Fixed string,
	 * never operator-supplied — no injection surface.
	 */
	const CSP_EMIT = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";

	/** Closed enum for the `frame` config key → X-Frame-Options value. */
	const FRAME_VALUES = array( 'deny', 'sameorigin' );

	/**
	 * Closed enum for the `referrer` config key → Referrer-Policy value. Excludes
	 * `unsafe-url` on purpose: the hardening surface never offers a leaky policy.
	 */
	const REFERRER_VALUES = array(
		'no-referrer',
		'no-referrer-when-downgrade',
		'origin',
		'origin-when-cross-origin',
		'same-origin',
		'strict-origin',
		'strict-origin-when-cross-origin',
	);

	/** Closed enum for the `csp` config key. `enforce` is the explicit second step. */
	const CSP_VALUES = array( 'off', 'report-only', 'enforce' );

	/** Truncation ceiling for any header value echoed back to the console. */
	const HINT_MAX = 120;

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store */
	private $store;

	/** @var string absolute home URL the loopback scan fetches. */
	private $home_url;

	/** @var string home host the SSRF anchor pins to. */
	private $home_host;

	/** @var callable(string,int):array HTTP fetcher → { code, headers, body, error }. */
	private $fetcher;

	/** @var callable():int unix-seconds clock (snapshot timestamps). */
	private $time_now;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Config persistence; defaults to the WP option store.
	 * @param string|null       $home_url     Absolute home URL; defaults to home_url('/'). Injectable.
	 * @param callable|null     $fetcher      fetcher(string $url,int $timeout):array; default wp_remote_get.
	 * @param callable|null     $time_now     Unix-seconds clock; default time(). Injectable for tests.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?IWSL_Store $store = null,
		?string $home_url = null,
		?callable $fetcher = null,
		?callable $time_now = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
		$this->home_url     = null !== $home_url ? $home_url : self::default_home_url();
		$this->home_host    = self::host_of( $this->home_url );
		$this->fetcher      = null !== $fetcher ? $fetcher : self::default_fetcher();
		$this->time_now     = $time_now ?? static function (): int {
			return time();
		};
	}

	/**
	 * Wire the `send_headers` emitter. Guarded so the harness can call it harmlessly.
	 * The engine self-registers (like the response-time scanner) rather than relying
	 * on IWSL_Admin. Registration is expected to be conditional on the feature switch
	 * at the bootstrap; the emitter re-checks the entitlement as STATEMENT 1 anyway.
	 */
	public function register(): void {
		if ( ! function_exists( 'add_action' ) ) {
			return;
		}
		add_action( 'send_headers', array( $this, 'send_headers' ) );
	}

	// ── the signed-method surface (STATEMENT 1 is the authoritative gate) ────────

	/**
	 * Loopback-fetch the home URL and grade its security headers + detect trackers.
	 * STATEMENT 1 is the entitlement gate. The fetch is host-pinned to the home host
	 * via the shared SSRF anchor, so this can only ever probe the site itself. Never
	 * throws — a fetch failure yields `{ ok:false, reason }` with a well-formed shape.
	 *
	 * @return array{ ok:bool, reason?:string, gate?:array, grade?:string, score?:int,
	 *                headers?:array, leaks?:array, detected_vendors?:array, scanned_at?:int }
	 */
	public function scan(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		if ( '' === $this->home_url || '' === $this->home_host ) {
			return array( 'ok' => false, 'reason' => 'no-home-url' );
		}
		if ( ! self::same_host( $this->home_url, $this->home_host ) ) {
			return array( 'ok' => false, 'reason' => 'ssrf-blocked' );
		}

		$res  = ( $this->fetcher )( $this->home_url, self::TIMEOUT_S );
		$res  = is_array( $res ) ? $res : array();
		$code = isset( $res['code'] ) ? (int) $res['code'] : 0;
		$err  = isset( $res['error'] ) ? (string) $res['error'] : '';
		if ( '' !== $err || $code <= 0 ) {
			return array( 'ok' => false, 'reason' => '' !== $err ? 'fetch-failed' : 'no-response', 'scanned_at' => ( $this->time_now )() );
		}

		$headers = self::normalize_headers( isset( $res['headers'] ) ? $res['headers'] : array() );
		$body    = isset( $res['body'] ) ? (string) $res['body'] : '';
		$graded  = self::grade_headers( $headers );

		$vendors = array();
		if ( class_exists( 'IWSL_Consent_Classifier' ) && '' !== $body ) {
			foreach ( IWSL_Consent_Classifier::detect_vendors( $body ) as $vendor => $info ) {
				$vendors[] = array(
					'vendor'   => (string) $vendor,
					'label'    => (string) ( $info['label'] ?? $vendor ),
					'category' => (string) ( $info['category'] ?? 'marketing' ),
					'count'    => (int) ( $info['count'] ?? 0 ),
				);
			}
		}

		return array(
			'ok'               => true,
			'grade'            => (string) $graded['grade'],
			'score'            => (int) $graded['score'],
			'headers'          => $graded['headers'],
			'leaks'            => $graded['leaks'],
			'detected_vendors' => $vendors,
			'scanned_at'       => ( $this->time_now )(),
		);
	}

	/**
	 * The stored, defensively-normalized hardening config.
	 *
	 * @return array{ hsts:bool, nosniff:bool, frame:string, referrer:string, permissions:bool, csp:string }
	 */
	public function config(): array {
		$raw = $this->store->get( self::OPTION_KEY, array() );
		return self::sanitize_config( is_array( $raw ) ? $raw : array() );
	}

	/**
	 * Apply a hardening config from a validated signed-command params object.
	 * STATEMENT 1 is the entitlement gate. `revert` wins and clears everything.
	 * The params shape is enforced by validate_params() BEFORE this runs, so this
	 * only re-normalizes defensively.
	 *
	 * @param stdClass $params { config?: {...}, revert?: bool }
	 * @return array{ ok:bool, reason?:string, gate?:array, applied?:array }
	 */
	public function apply_config( stdClass $params ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$vars = get_object_vars( $params );
		if ( ! empty( $vars['revert'] ) ) {
			$config = self::sanitize_config( array() );
		} else {
			$input  = isset( $vars['config'] ) && $vars['config'] instanceof stdClass
				? get_object_vars( $vars['config'] ) : array();
			$config = self::sanitize_config( $input );
		}
		$this->store->set( self::OPTION_KEY, $config );
		return array( 'ok' => true, 'applied' => $config );
	}

	/**
	 * Teardown: remove this feature's only persistent footprint — the hardening
	 * config option. NOT gated: a teardown runs precisely when the flag may already
	 * be revoked. Idempotent + cheap (deleting an absent key is a no-op). Mirrors
	 * every peer engine's purge() so IWSL_Teardown can drive it uniformly.
	 *
	 * @return array{ ok:bool, options_removed:string[] }
	 */
	public function purge(): array {
		$this->store->delete( self::OPTION_KEY );
		return array( 'ok' => true, 'options_removed' => array( self::OPTION_KEY ) );
	}

	/**
	 * `send_headers` hook: emit the stored config's headers. STATEMENT 1 gate; a
	 * locked/revoked site emits NOTHING. Never duplicates a header already present
	 * in headers_list() (another plugin or a PHP-visible upstream), so it cannot
	 * contradict a header the platform already set.
	 */
	public function send_headers(): void {
		if ( ! function_exists( 'header' ) ) {
			return;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		$present  = self::present_header_names();
		$computed = self::computed_headers( $this->config() );
		foreach ( self::filter_new_headers( $computed, $present ) as $pair ) {
			header( $pair[0] . ': ' . $pair[1] );
		}
	}

	// ── pure grading core (no WordPress, no I/O — unit-tested) ───────────────────

	/**
	 * Grade a lowercased response-header map A–F. Pure. Returns the letter grade,
	 * a 0–100 score, a per-header verdict list (good / weak / missing with a
	 * plain-language reason), and a `leaks` list for information-disclosure headers.
	 *
	 * @param array<string,string> $headers name(lowercased) => value.
	 * @return array{ grade:string, score:int, headers:array, leaks:array }
	 */
	public static function grade_headers( array $headers ): array {
		$get = static function ( string $name ) use ( $headers ): string {
			return isset( $headers[ $name ] ) ? (string) $headers[ $name ] : '';
		};

		$rows  = array();
		$score = 0;

		// HSTS (max weight 25).
		$hsts = $get( 'strict-transport-security' );
		if ( '' === $hsts ) {
			$rows[] = self::row( 'Strict-Transport-Security', 'missing', '', 'Forces HTTPS for every future visit; without it a visitor can be downgraded to plaintext.' );
		} elseif ( self::hsts_max_age( $hsts ) >= self::HSTS_STRONG_MAX_AGE ) {
			$rows[]  = self::row( 'Strict-Transport-Security', 'good', $hsts, 'HTTPS is pinned for a long window.' );
			$score  += 25;
		} else {
			$rows[]  = self::row( 'Strict-Transport-Security', 'weak', $hsts, 'Present but the max-age is short (< 6 months); a brief window still allows downgrade.' );
			$score  += 12;
		}

		// CSP (max weight 25).
		$csp   = $get( 'content-security-policy' );
		$cspro = $get( 'content-security-policy-report-only' );
		if ( '' !== $csp ) {
			$rows[]  = self::row( 'Content-Security-Policy', 'good', $csp, 'Restricts where scripts, styles and frames may load from — the strongest defence against injected content.' );
			$score  += 25;
		} elseif ( '' !== $cspro ) {
			$rows[]  = self::row( 'Content-Security-Policy', 'weak', $cspro, 'Only report-only is set — violations are logged but nothing is blocked. Enforce it once the report is clean.' );
			$score  += 12;
		} else {
			$rows[] = self::row( 'Content-Security-Policy', 'missing', '', 'No policy restricting script/style/frame sources; injected content is unconstrained.' );
		}

		// X-Content-Type-Options (max weight 15).
		$nosniff = strtolower( trim( $get( 'x-content-type-options' ) ) );
		if ( 'nosniff' === $nosniff ) {
			$rows[]  = self::row( 'X-Content-Type-Options', 'good', 'nosniff', 'Stops the browser from MIME-sniffing a response into an executable type.' );
			$score  += 15;
		} elseif ( '' !== $nosniff ) {
			$rows[]  = self::row( 'X-Content-Type-Options', 'weak', $get( 'x-content-type-options' ), 'Present but not the expected "nosniff" token.' );
			$score  += 7;
		} else {
			$rows[] = self::row( 'X-Content-Type-Options', 'missing', '', 'Without "nosniff" a browser may execute a mistyped response.' );
		}

		// Frame protection: X-Frame-Options OR an ENFORCED CSP frame-ancestors (max
		// weight 15). A report-only CSP blocks nothing, so its frame-ancestors is
		// logged-but-not-enforced — it grades "weak", never "good".
		$xfo                        = strtolower( trim( $get( 'x-frame-options' ) ) );
		$enforced_frame_ancestors   = '' !== $csp && false !== stripos( $csp, 'frame-ancestors' );
		$reportonly_frame_ancestors = '' !== $cspro && false !== stripos( $cspro, 'frame-ancestors' );
		if ( 'deny' === $xfo || 'sameorigin' === $xfo || $enforced_frame_ancestors ) {
			$hint    = '' !== $xfo ? $get( 'x-frame-options' ) : 'CSP frame-ancestors';
			$rows[]  = self::row( 'X-Frame-Options', 'good', $hint, 'Prevents the site being framed by another origin (clickjacking).' );
			$score  += 15;
		} elseif ( $reportonly_frame_ancestors ) {
			$rows[]  = self::row( 'X-Frame-Options', 'weak', 'CSP frame-ancestors (report-only)', 'Only a report-only CSP declares frame-ancestors — framing is logged but not blocked. Enforce the policy or add X-Frame-Options to stop clickjacking.' );
			$score  += 7;
		} else {
			$rows[] = self::row( 'X-Frame-Options', 'missing', '', 'The page can be embedded in a hostile frame (clickjacking).' );
		}

		// Referrer-Policy (max weight 10).
		$ref = strtolower( trim( $get( 'referrer-policy' ) ) );
		if ( '' === $ref ) {
			$rows[] = self::row( 'Referrer-Policy', 'missing', '', 'Full URLs may leak to third parties via the Referer header.' );
		} elseif ( 'unsafe-url' === $ref || 'no-referrer-when-downgrade' === $ref ) {
			$rows[]  = self::row( 'Referrer-Policy', 'weak', $get( 'referrer-policy' ), 'Present but leaks more of the URL than necessary.' );
			$score  += 5;
		} else {
			$rows[]  = self::row( 'Referrer-Policy', 'good', $get( 'referrer-policy' ), 'Limits how much of the URL is shared with other origins.' );
			$score  += 10;
		}

		// Permissions-Policy (max weight 10).
		$perms = $get( 'permissions-policy' );
		if ( '' !== $perms ) {
			$rows[]  = self::row( 'Permissions-Policy', 'good', $perms, 'Restricts powerful browser features (camera, geolocation, …).' );
			$score  += 10;
		} else {
			$rows[] = self::row( 'Permissions-Policy', 'missing', '', 'Powerful browser features are not explicitly restricted.' );
		}

		// Information-disclosure leaks (reported; small score penalty, never below 0).
		$leaks = array();
		$xpb   = $get( 'x-powered-by' );
		if ( '' !== $xpb ) {
			$leaks[] = self::leak( 'X-Powered-By', $xpb, 'Advertises the server stack/version, helping an attacker target known CVEs. Remove it.' );
			$score  -= 5;
		}
		$server = $get( 'server' );
		if ( '' !== $server && preg_match( '/\d/', $server ) ) {
			$leaks[] = self::leak( 'Server', $server, 'Reveals server software and version; suppress the version.' );
			$score  -= 3;
		}

		$score = max( 0, min( 100, $score ) );

		return array(
			'grade'   => self::letter( $score ),
			'score'   => $score,
			'headers' => $rows,
			'leaks'   => $leaks,
		);
	}

	/** Map a 0–100 score to a letter grade. Pure. */
	public static function letter( int $score ): string {
		if ( $score >= 90 ) {
			return 'A';
		}
		if ( $score >= 80 ) {
			return 'B';
		}
		if ( $score >= 70 ) {
			return 'C';
		}
		if ( $score >= 55 ) {
			return 'D';
		}
		return 'F';
	}

	/** Extract the numeric max-age (seconds) from an HSTS header value; 0 if absent. Pure. */
	public static function hsts_max_age( string $hsts ): int {
		if ( preg_match( '/max-age\s*=\s*"?(\d+)"?/i', $hsts, $m ) ) {
			return (int) $m[1];
		}
		return 0;
	}

	// ── pure hardening-config core (CLOSED key/enum set) ─────────────────────────

	/**
	 * The STRICT params validator for `security.harden`. A CLOSED key/enum set:
	 * every top-level and nested key must be recognized and every value must match
	 * its type/enum EXACTLY. There is NEVER a free-form header name or value, so a
	 * header-injection attempt (`{config:{"X-Evil":"..."}}`, or an enum value like
	 * `"deny\r\nSet-Cookie: ..."`) is refused at the verifier before dispatch.
	 *
	 * @param mixed $params
	 */
	public static function validate_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( array() === $vars ) {
			return false; // no-op params are not a valid command.
		}
		if ( array() !== array_diff_key( $vars, array( 'config' => 1, 'revert' => 1 ) ) ) {
			return false; // stray top-level key.
		}
		if ( array_key_exists( 'revert', $vars ) && ! is_bool( $vars['revert'] ) ) {
			return false;
		}
		if ( ! array_key_exists( 'config', $vars ) ) {
			return true; // { revert: true } is valid on its own.
		}
		if ( ! $vars['config'] instanceof stdClass ) {
			return false;
		}
		$cfg     = get_object_vars( $vars['config'] );
		$allowed = array( 'hsts' => 1, 'nosniff' => 1, 'frame' => 1, 'referrer' => 1, 'permissions' => 1, 'csp' => 1 );
		if ( array() !== array_diff_key( $cfg, $allowed ) ) {
			return false; // unknown config key — forecloses arbitrary header names.
		}
		foreach ( array( 'hsts', 'nosniff', 'permissions' ) as $bool_key ) {
			if ( array_key_exists( $bool_key, $cfg ) && ! is_bool( $cfg[ $bool_key ] ) ) {
				return false;
			}
		}
		if ( array_key_exists( 'frame', $cfg )
			&& ! ( is_string( $cfg['frame'] ) && in_array( $cfg['frame'], self::FRAME_VALUES, true ) ) ) {
			return false;
		}
		if ( array_key_exists( 'referrer', $cfg )
			&& ! ( is_string( $cfg['referrer'] ) && in_array( $cfg['referrer'], self::REFERRER_VALUES, true ) ) ) {
			return false;
		}
		if ( array_key_exists( 'csp', $cfg )
			&& ! ( is_string( $cfg['csp'] ) && in_array( $cfg['csp'], self::CSP_VALUES, true ) ) ) {
			return false;
		}
		return true;
	}

	/**
	 * Normalize a config input map into the canonical stored shape. Immutable and
	 * pure; every value is forced onto its closed enum/type with a safe default, so
	 * even a DB-tampered option can never yield a free-form header.
	 *
	 * @param array<string,mixed> $input
	 * @return array{ hsts:bool, nosniff:bool, frame:string, referrer:string, permissions:bool, csp:string }
	 */
	public static function sanitize_config( array $input ): array {
		$frame = isset( $input['frame'] ) && is_string( $input['frame'] ) && in_array( $input['frame'], self::FRAME_VALUES, true )
			? $input['frame'] : '';
		$ref   = isset( $input['referrer'] ) && is_string( $input['referrer'] ) && in_array( $input['referrer'], self::REFERRER_VALUES, true )
			? $input['referrer'] : '';
		$csp   = isset( $input['csp'] ) && is_string( $input['csp'] ) && in_array( $input['csp'], self::CSP_VALUES, true )
			? $input['csp'] : 'off';
		return array(
			'hsts'        => ! empty( $input['hsts'] ),
			'nosniff'     => ! empty( $input['nosniff'] ),
			'frame'       => $frame,
			'referrer'    => $ref,
			'permissions' => ! empty( $input['permissions'] ),
			'csp'         => $csp,
		);
	}

	/**
	 * The concrete [name, value] header pairs a config would emit. Pure — every
	 * value is a fixed token or a bounded allow-listed enum, NEVER operator text.
	 * CSP is emitted report-only unless the config explicitly says `enforce`, and
	 * the two CSP variants are mutually exclusive.
	 *
	 * @param array<string,mixed> $config
	 * @return array<int, array{0:string,1:string}>
	 */
	public static function computed_headers( array $config ): array {
		$config = self::sanitize_config( $config );
		$out    = array();
		if ( $config['hsts'] ) {
			$out[] = array( 'Strict-Transport-Security', self::HSTS_EMIT );
		}
		if ( $config['nosniff'] ) {
			$out[] = array( 'X-Content-Type-Options', 'nosniff' );
		}
		if ( 'deny' === $config['frame'] ) {
			$out[] = array( 'X-Frame-Options', 'DENY' );
		} elseif ( 'sameorigin' === $config['frame'] ) {
			$out[] = array( 'X-Frame-Options', 'SAMEORIGIN' );
		}
		if ( '' !== $config['referrer'] ) {
			$out[] = array( 'Referrer-Policy', $config['referrer'] );
		}
		if ( $config['permissions'] ) {
			$out[] = array( 'Permissions-Policy', self::PERMISSIONS_EMIT );
		}
		if ( 'report-only' === $config['csp'] ) {
			$out[] = array( 'Content-Security-Policy-Report-Only', self::CSP_EMIT );
		} elseif ( 'enforce' === $config['csp'] ) {
			$out[] = array( 'Content-Security-Policy', self::CSP_EMIT );
		}
		return $out;
	}

	/**
	 * Keep only the computed headers whose name is NOT already present. Pure — the
	 * testable heart of "never duplicate/contradict an upstream or peer header."
	 *
	 * @param array<int, array{0:string,1:string}> $computed
	 * @param array<string,true>                   $present_lower lowercased names already set.
	 * @return array<int, array{0:string,1:string}>
	 */
	public static function filter_new_headers( array $computed, array $present_lower ): array {
		$out = array();
		foreach ( $computed as $pair ) {
			if ( ! is_array( $pair ) || ! isset( $pair[0], $pair[1] ) ) {
				continue;
			}
			if ( ! isset( $present_lower[ strtolower( (string) $pair[0] ) ] ) ) {
				$out[] = array( (string) $pair[0], (string) $pair[1] );
			}
		}
		return $out;
	}

	/**
	 * Normalize a raw fetched header collection into a lowercased name => string
	 * map. Tolerates array-valued headers (joined) and case-insensitive dictionaries
	 * (WordPress `Requests`), so the grader always sees a flat scalar map. Pure.
	 *
	 * @param mixed $raw
	 * @return array<string,string>
	 */
	public static function normalize_headers( $raw ): array {
		$pairs = array();
		if ( is_array( $raw ) ) {
			$pairs = $raw;
		} elseif ( is_object( $raw ) ) {
			if ( method_exists( $raw, 'getAll' ) ) {
				$pairs = (array) $raw->getAll();
			} else {
				$pairs = get_object_vars( $raw );
			}
		}
		$out = array();
		foreach ( $pairs as $name => $value ) {
			if ( ! is_string( $name ) ) {
				continue;
			}
			if ( is_array( $value ) ) {
				$value = implode( ', ', array_map( 'strval', $value ) );
			}
			$out[ strtolower( trim( $name ) ) ] = is_scalar( $value ) ? (string) $value : '';
		}
		return $out;
	}

	// ── small helpers ────────────────────────────────────────────────────────────

	/** One graded header row with a length-capped value hint. Pure. */
	private static function row( string $name, string $state, string $value, string $why ): array {
		return array(
			'name'       => $name,
			'state'      => $state,
			'value_hint' => self::hint( $value ),
			'why'        => $why,
		);
	}

	/** One information-disclosure leak row. Pure. */
	private static function leak( string $name, string $value, string $why ): array {
		return array(
			'name'       => $name,
			'value_hint' => self::hint( $value ),
			'why'        => $why,
		);
	}

	/** Control-strip + length-cap a header value for display. Pure. */
	private static function hint( string $value ): string {
		$value = preg_replace( '/[\x00-\x1F\x7F]+/', ' ', $value );
		$value = null === $value ? '' : trim( $value );
		if ( strlen( $value ) > self::HINT_MAX ) {
			$value = substr( $value, 0, self::HINT_MAX );
		}
		return $value;
	}

	/** The set of already-sent header names (lowercased), from headers_list(). */
	private static function present_header_names(): array {
		$out = array();
		if ( ! function_exists( 'headers_list' ) ) {
			return $out;
		}
		foreach ( headers_list() as $line ) {
			$pos = strpos( (string) $line, ':' );
			if ( false !== $pos ) {
				$out[ strtolower( trim( substr( (string) $line, 0, $pos ) ) ) ] = true;
			}
		}
		return $out;
	}

	/**
	 * The shared loopback SSRF anchor. Reuses IWSL_Response_Scan::same_host()
	 * verbatim (scheme allow-list, credential-URL refusal, host==home_host) so
	 * there is one audited boundary, not two. Fails CLOSED if the peer class is
	 * somehow absent.
	 */
	private static function same_host( string $url, string $home_host ): bool {
		if ( class_exists( 'IWSL_Response_Scan' ) ) {
			return IWSL_Response_Scan::same_host( $url, $home_host );
		}
		return false;
	}

	/** The site's own home URL, read live from WordPress; '' when unresolvable. */
	private static function default_home_url(): string {
		if ( function_exists( 'home_url' ) ) {
			$home = home_url( '/' );
			if ( is_string( $home ) && '' !== $home ) {
				return $home;
			}
		}
		return '';
	}

	/** The host component of a URL, lowercased; '' when none. */
	private static function host_of( string $url ): string {
		$host = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url, PHP_URL_HOST ) : parse_url( $url, PHP_URL_HOST );
		return is_string( $host ) ? strtolower( $host ) : '';
	}

	/**
	 * The default HTTP fetcher: a blocking wp_remote_get normalized to
	 * { code, headers, body, error }. Returns code 0 with an error outside a WP
	 * HTTP context so a scan there records "no response" rather than inventing one.
	 *
	 * @return callable(string,int):array
	 */
	private static function default_fetcher(): callable {
		return static function ( string $url, int $timeout_s ): array {
			if ( ! function_exists( 'wp_remote_get' ) ) {
				return array( 'code' => 0, 'headers' => array(), 'body' => '', 'error' => 'no-http-api' );
			}
			$response = wp_remote_get(
				$url,
				array(
					'timeout'     => max( 1, (int) $timeout_s ),
					'redirection' => 0, // grade THIS URL's headers, not a redirect target.
					'sslverify'   => true,
					'blocking'    => true,
					'headers'     => array( 'Accept' => 'text/html,application/xhtml+xml,*/*' ),
				)
			);
			if ( function_exists( 'is_wp_error' ) && is_wp_error( $response ) ) {
				$msg = ( is_object( $response ) && method_exists( $response, 'get_error_message' ) ) ? (string) $response->get_error_message() : 'request-failed';
				return array( 'code' => 0, 'headers' => array(), 'body' => '', 'error' => '' !== $msg ? $msg : 'request-failed' );
			}
			$code    = function_exists( 'wp_remote_retrieve_response_code' ) ? (int) wp_remote_retrieve_response_code( $response ) : 0;
			$headers = function_exists( 'wp_remote_retrieve_headers' ) ? wp_remote_retrieve_headers( $response ) : array();
			$body    = function_exists( 'wp_remote_retrieve_body' ) ? (string) wp_remote_retrieve_body( $response ) : '';
			return array(
				'code'    => $code,
				'headers' => $headers,
				'body'    => $body,
				'error'   => '',
			);
		};
	}
}
