<?php
/**
 * Generic engine behind the gated "SMTP delivery & email log" feature.
 *
 * This is the payload behind the `email_delivery` entitlement, kept separate from
 * the gate (IWSL_Entitlements) and from the transports (IWSL_Mail_Transport
 * implementations) so each can be reasoned about — and tested — in isolation.
 *
 * TRUST MODEL. The feature is console-authoritative: the `email_delivery` flag is
 * written ONLY by the dual-signed `entitlements.set` runner (§7). There is
 * deliberately no self-set path, REST route, AJAX endpoint, cron, or nopriv
 * surface here — this class is a purely-local admin/mail-hook payload, mirroring
 * the IWSL_Plus_Feature / IWSL_Media_Optimizer pattern. The gate is re-checked at
 * three layers (admin page, admin-post handler, and here as STATEMENT 1 of every
 * engine method AND every passive mail-hook callback). The in-engine check is the
 * authoritative one: it survives any future caller that forgets the other two, and
 * because each mail-hook callback re-checks it, revoking the flag from the console
 * instantly restores default WordPress mail behavior on the very next request.
 *
 * RESIDUAL RISK (honest statement). A site owner with direct database write access
 * can flip the local entitlement option and unlock this without the console —
 * exactly the accepted threat model of the existing `plus` gate. That is bounded
 * by heartbeat staleness: if the console stops managing the site, the signed
 * heartbeat goes stale and the gate re-locks within HEARTBEAT_FRESH_MS (2h),
 * because evaluate() requires state==active AND a fresh signed contact, not merely
 * the flag.
 *
 * CREDENTIAL-STORAGE RISK (the sharp edge). SMTP requires a password, and a
 * password at rest is the most dangerous thing this feature touches. The mitigation
 * is layered: (1) the PREFERRED source is a wp-config constant IWSL_SMTP_PASS, which
 * keeps the secret out of the database entirely — effective_password() reads it
 * FIRST; (2) database storage happens ONLY when the operator explicitly opts in
 * ("store password in the database, I understand the risk"), and save_settings()
 * refuses to persist a password otherwise (reason `password-storage-not-allowed`);
 * (3) the secret is NEVER echoed — settings_for_render() strips it wholesale and
 * the admin form always renders an empty value; (4) the secret is NEVER logged —
 * every log entry is a strict whitelist and capture_failure() runs the error string
 * through redact() so a PHPMailer error that quotes the password stores `****`;
 * (5) when the constant is defined it always wins and any submitted DB password is
 * discarded.
 *
 * SAFETY. No message body, headers, or attachments are ever stored — capture_mail()
 * reads ONLY `to` + `subject`, and capture_failure() extracts ONLY `to`/`subject`
 * from the WP_Error data (WordPress core packs the FULL mail array, body included,
 * into `wp_mail_failed`; everything but to/subject is dropped). The log is a bounded
 * ring buffer (MAX_LOG) built by immutable array_slice, with per-field truncation,
 * so it can never grow unbounded. No exec/shell_exec/proc_open — in-process only.
 * capture_mail() ALWAYS returns its input unchanged and wraps its own body so a
 * logging failure can never abort wp_mail(). Every WordPress-touching call is
 * function_exists-guarded, and the store/clock/constant-reader/transport registry
 * are injectable, so the engine runs under the zero-dependency test harness.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Email_Delivery {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'email_delivery';

	/** Ring-buffer cap on stored log entries. */
	const MAX_LOG = 100;
	/** Store key for the SMTP settings map. */
	const SETTINGS_KEY = 'email_smtp_settings';
	/** Store key for the email-activity ring buffer. */
	const LOG_KEY = 'email_log';
	/** Preferred password source — a wp-config constant keeps the secret out of the DB. */
	const PASS_CONSTANT = 'IWSL_SMTP_PASS';

	/** Per-entry subject cap (chars). */
	const MAX_SUBJECT_CHARS = 200;
	/** Per-entry error cap (chars). */
	const MAX_ERROR_CHARS = 300;
	/** Max recipients recorded per entry. */
	const MAX_RECIPIENTS = 10;
	/** Host / username / recipient char cap. */
	const MAX_FIELD_CHARS = 254;
	/** Allowed SMTPSecure values. */
	const SECURE_MODES = array( '', 'ssl', 'tls' );

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings + log live here (memory store in tests). */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var callable(string):?string constant reader — defaults to defined()/constant(). */
	private $constant;

	/** @var array<string, IWSL_Mail_Transport> id-keyed transport registry. */
	private $transports;

	/**
	 * @param IWSL_Entitlements                        $entitlements The gate.
	 * @param IWSL_Store                               $store        Settings + log store.
	 * @param callable|null                            $now_ms       Clock, mirrors IWSL_Media_Optimizer.
	 * @param callable|null                            $constant     fn(string $name): ?string — the secret
	 *                                                                source; defaults to defined()/constant().
	 * @param array<string, IWSL_Mail_Transport>|null  $transports   Registry override (tests inject);
	 *                                                                defaults to self::transports().
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		IWSL_Store $store,
		?callable $now_ms = null,
		?callable $constant = null,
		?array $transports = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = $store;
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		$this->constant = $constant ?? static function ( string $name ) {
			return defined( $name ) ? (string) constant( $name ) : null;
		};
		$this->transports = null !== $transports ? $transports : self::transports();
	}

	/**
	 * The id-keyed transport registry. Adding a transport is one class + one line
	 * here — this is the "generic solution" the interface exists to enable.
	 *
	 * @return array<string, IWSL_Mail_Transport>
	 */
	public static function transports(): array {
		return array(
			'smtp' => new IWSL_SMTP_Transport(),
		);
	}

	/** Transport ids (registry keys). */
	public function transport_ids(): array {
		return array_keys( $this->transports );
	}

	// ── engine methods: the gate is STATEMENT 1 of every one of these ─────────────

	/**
	 * Configure a mailer (the `phpmailer_init` payload). STATEMENT 1 is the
	 * authoritative entitlement gate; a locked site NEVER touches $phpmailer.
	 * Statement 2 short-circuits an unconfigured (or half-configured) site, so a
	 * missing host also leaves the mailer untouched. Only when gate + config +
	 * transport availability all pass is the transport allowed to configure it.
	 *
	 * @return array Immutable outcome.
	 */
	public function configure_mailer( $phpmailer ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		if ( ! $this->is_configured() ) {
			return array( 'ok' => false, 'reason' => 'not-configured' );
		}

		$transport = $this->default_transport();
		if ( ! $transport instanceof IWSL_Mail_Transport ) {
			return array( 'ok' => false, 'reason' => 'no-transport' );
		}

		$avail = $transport->availability();
		if ( empty( $avail['ok'] ) ) {
			return array(
				'ok'               => false,
				'reason'           => 'transport-unavailable',
				'transport_reason' => (string) ( $avail['reason'] ?? '' ),
			);
		}

		$settings = $this->settings();
		$result   = $transport->configure(
			$phpmailer,
			$this->strip_password( $settings ),
			$this->effective_password( $settings )
		);
		return is_array( $result ) ? $result : array( 'ok' => false, 'reason' => 'configure-failed' );
	}

	/**
	 * Persist validated SMTP settings (the settings admin-post payload). STATEMENT 1
	 * is the gate; a locked site writes nothing. Every field is validated (CRLF /
	 * parameter injection rejected). Password handling enforces the credential
	 * policy: constant wins and discards submissions; DB storage requires the opt-in
	 * (else `password-storage-not-allowed`); a blank submit keeps the prior secret.
	 *
	 * @return array Immutable outcome.
	 */
	public function save_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$validated = self::validate_settings_input( $input );
		if ( empty( $validated['ok'] ) ) {
			return array( 'ok' => false, 'reason' => (string) $validated['reason'] );
		}
		$next = $validated['settings'];

		$submitted = isset( $input['password'] ) ? (string) $input['password'] : '';
		if ( self::has_crlf( $submitted ) ) {
			return array( 'ok' => false, 'reason' => 'bad-password' );
		}

		$previous      = $this->settings();
		$prev_password = isset( $previous['password'] ) ? (string) $previous['password'] : '';
		$constant_wins = null !== $this->constant_password();

		if ( $constant_wins ) {
			// wp-config constant is authoritative: never write a DB password and
			// discard whatever was submitted. Preserve any prior stored secret.
			if ( '' !== $prev_password ) {
				$next['password'] = $prev_password;
			}
		} elseif ( ! $next['allow_option_password'] ) {
			// DB storage not opted in: refuse an attempt to store a password. A blank
			// submit is fine and drops any previously stored secret.
			if ( '' !== $submitted ) {
				return array( 'ok' => false, 'reason' => 'password-storage-not-allowed' );
			}
		} elseif ( '' !== $submitted ) {
			// Opted in with a new secret — set/replace it.
			$next['password'] = $submitted;
		} elseif ( '' !== $prev_password ) {
			// Opted in, blank submit — keep the previous secret (masked-placeholder).
			$next['password'] = $prev_password;
		}

		$this->store->set( self::SETTINGS_KEY, $next );
		return array( 'ok' => true, 'reason' => '', 'settings' => $this->strip_password( $next ) );
	}

	/**
	 * Clear the email log (the clear-log admin-post payload). STATEMENT 1 is the
	 * gate; a locked site writes nothing.
	 *
	 * @return array Immutable outcome.
	 */
	public function clear_log(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$this->store->set( self::LOG_KEY, array() );
		return array( 'ok' => true, 'reason' => '', 'cleared' => true );
	}

	// ── passive mail-hook capture (gate is statement 1; locked = zero writes) ─────

	/**
	 * `wp_mail` filter callback. STATEMENT 1 is the gate; a locked site records
	 * NOTHING. On every path — locked, malformed, success — it returns $args
	 * UNCHANGED, and its own body is wrapped so a log-store failure can never abort
	 * wp_mail(). Records ONLY `to` + `subject`; never the message/headers/attachments.
	 *
	 * @param mixed $args The wp_mail argument array.
	 * @return mixed The identical $args.
	 */
	public function capture_mail( $args ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $args;
		}

		try {
			if ( is_array( $args ) ) {
				$this->append_entry(
					array(
						'at'      => $this->now_seconds(),
						'type'    => 'sent',
						'to'      => self::normalize_recipients( $args['to'] ?? array() ),
						'subject' => self::truncate( self::strip_crlf( (string) ( $args['subject'] ?? '' ) ), self::MAX_SUBJECT_CHARS ),
					)
				);
			}
		} catch ( \Throwable $e ) {
			// Logging must never break mail delivery — swallow.
		}

		return $args;
	}

	/**
	 * `wp_mail_failed` action callback. STATEMENT 1 is the gate; a locked site
	 * records NOTHING. Extracts ONLY `to`/`subject` from the WP_Error data (dropping
	 * the body WordPress packs alongside), redacts the effective secret out of the
	 * error message, and appends a bounded `failed` entry.
	 *
	 * @param mixed $error A WP_Error (duck-typed) or string.
	 */
	public function capture_failure( $error ): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}

		try {
			$data    = self::error_data( $error );
			$to      = self::normalize_recipients( is_array( $data ) && isset( $data['to'] ) ? $data['to'] : array() );
			$subject = is_array( $data ) && isset( $data['subject'] ) ? (string) $data['subject'] : '';
			$secret  = $this->effective_password( $this->settings() );
			$message = self::truncate( self::redact( self::error_message( $error ), $secret ), self::MAX_ERROR_CHARS );

			$this->append_entry(
				array(
					'at'      => $this->now_seconds(),
					'type'    => 'failed',
					'to'      => $to,
					'subject' => self::truncate( self::strip_crlf( $subject ), self::MAX_SUBJECT_CHARS ),
					'error'   => $message,
				)
			);
		} catch ( \Throwable $e ) {
			// Never let logging escape into the mail path — swallow.
		}
	}

	// ── read-only, secret-free ────────────────────────────────────────────────────

	/**
	 * A copy of the log ring buffer, oldest first / newest last. Never exposes a
	 * secret (entries are a strict whitelist, redacted on write).
	 *
	 * @return array<int, array>
	 */
	public function log(): array {
		$log = $this->store->get( self::LOG_KEY, array() );
		if ( ! is_array( $log ) ) {
			return array();
		}
		return array_slice( array_values( $log ), -self::MAX_LOG );
	}

	/**
	 * Settings for the admin form: password STRIPPED entirely, plus `has_password`
	 * (bool) and `password_source` ('constant' | 'option' | 'none'). The rendered
	 * page source can therefore never contain the secret.
	 *
	 * @return array
	 */
	public function settings_for_render(): array {
		$settings = $this->settings();
		$stripped = $this->strip_password( $settings );

		$has_stored       = isset( $settings['password'] ) && '' !== (string) $settings['password'];
		$constant_defined = null !== $this->constant_password();

		if ( $constant_defined ) {
			$source = 'constant';
		} elseif ( $has_stored ) {
			$source = 'option';
		} else {
			$source = 'none';
		}

		$stripped['has_password']    = $constant_defined || $has_stored;
		$stripped['password_source'] = $source;
		return $stripped;
	}

	/** True when host + a valid port are set — mail can actually be routed. */
	public function is_configured( ?array $settings = null ): bool {
		$settings = null === $settings ? $this->settings() : $settings;
		$host     = isset( $settings['host'] ) ? (string) $settings['host'] : '';
		$port     = isset( $settings['port'] ) ? (int) $settings['port'] : 0;
		return '' !== $host && $port >= 1 && $port <= 65535;
	}

	// ── internals ─────────────────────────────────────────────────────────────────

	/** The stored settings merged with defaults; keeps a stored password if present. */
	private function settings(): array {
		$stored = $this->store->get( self::SETTINGS_KEY, array() );
		if ( ! is_array( $stored ) ) {
			$stored = array();
		}

		$merged = array(
			'host'                  => isset( $stored['host'] ) ? (string) $stored['host'] : '',
			'port'                  => isset( $stored['port'] ) ? (int) $stored['port'] : 0,
			'auth'                  => isset( $stored['auth'] ) ? (bool) $stored['auth'] : false,
			'username'              => isset( $stored['username'] ) ? (string) $stored['username'] : '',
			'secure'                => ( isset( $stored['secure'] ) && in_array( $stored['secure'], self::SECURE_MODES, true ) )
				? (string) $stored['secure'] : '',
			'allow_option_password' => isset( $stored['allow_option_password'] ) ? (bool) $stored['allow_option_password'] : false,
		);
		if ( isset( $stored['password'] ) && is_string( $stored['password'] ) && '' !== $stored['password'] ) {
			$merged['password'] = $stored['password'];
		}
		return $merged;
	}

	/** The effective password: constant first, opted-in option second, '' otherwise. */
	private function effective_password( array $settings ): string {
		$const = $this->constant_password();
		if ( null !== $const ) {
			return $const;
		}
		if ( ! empty( $settings['allow_option_password'] ) && isset( $settings['password'] ) && is_string( $settings['password'] ) ) {
			return $settings['password'];
		}
		return '';
	}

	/** The wp-config constant password, or null when undefined/empty. */
	private function constant_password(): ?string {
		$value = ( $this->constant )( self::PASS_CONSTANT );
		if ( is_string( $value ) && '' !== $value ) {
			return $value;
		}
		return null;
	}

	/** The transport to configure with — the 'smtp' registry entry, else the first. */
	private function default_transport(): ?IWSL_Mail_Transport {
		$transport = $this->transports['smtp'] ?? null;
		if ( ! $transport instanceof IWSL_Mail_Transport ) {
			$first     = reset( $this->transports );
			$transport = $first instanceof IWSL_Mail_Transport ? $first : null;
		}
		return $transport;
	}

	/**
	 * Append a whitelist entry immutably: build a NEW capped array via
	 * array_slice(-MAX_LOG) — the stored log is never mutated in place. Every string
	 * field is scrubbed of CR/LF and of the live secret before storage, so no code
	 * path can leak a password (or inject an SMTP header) into the log.
	 */
	private function append_entry( array $entry ): void {
		$secret   = $this->effective_password( $this->settings() );
		$scrubbed = self::scrub_entry( $entry, $secret );

		$appended = array_merge( $this->log(), array( $scrubbed ) );
		$this->store->set( self::LOG_KEY, array_slice( $appended, -self::MAX_LOG ) );
	}

	/** Redact + CR/LF-strip every string in an entry, returning a NEW entry. */
	private static function scrub_entry( array $entry, string $secret ): array {
		$out = array();
		foreach ( $entry as $key => $value ) {
			if ( is_string( $value ) ) {
				$out[ $key ] = self::redact( $value, $secret );
			} elseif ( is_array( $value ) ) {
				$clean = array();
				foreach ( $value as $item ) {
					$clean[] = is_string( $item ) ? self::redact( $item, $secret ) : $item;
				}
				$out[ $key ] = $clean;
			} else {
				$out[ $key ] = $value;
			}
		}
		return $out;
	}

	/** Replace the secret with `****` and strip CR/LF (SMTP header-injection guard). */
	private static function redact( string $text, string $secret ): string {
		$clean = self::strip_crlf( $text );
		if ( '' !== $secret ) {
			$clean = str_replace( $secret, '****', $clean );
		}
		return $clean;
	}

	/** Drop a stored password from a settings array (immutably). */
	private function strip_password( array $settings ): array {
		$copy = $settings;
		unset( $copy['password'] );
		return $copy;
	}

	/** Validate raw settings input; returns { ok, reason } or { ok, settings }. */
	private static function validate_settings_input( array $input ): array {
		$host = isset( $input['host'] ) ? trim( (string) $input['host'] ) : '';
		if ( self::has_crlf( $host ) || 1 !== preg_match( '/^[A-Za-z0-9.\-]{1,254}$/', $host ) ) {
			return array( 'ok' => false, 'reason' => 'bad-host' );
		}

		$port = isset( $input['port'] ) ? (int) $input['port'] : 0;
		if ( $port < 1 || $port > 65535 ) {
			return array( 'ok' => false, 'reason' => 'bad-port' );
		}

		$secure = isset( $input['secure'] ) ? (string) $input['secure'] : '';
		if ( ! in_array( $secure, self::SECURE_MODES, true ) ) {
			return array( 'ok' => false, 'reason' => 'bad-secure' );
		}

		$username = isset( $input['username'] ) ? (string) $input['username'] : '';
		if ( self::has_crlf( $username ) ) {
			return array( 'ok' => false, 'reason' => 'bad-username' );
		}
		$username = self::truncate( trim( $username ), self::MAX_FIELD_CHARS );

		return array(
			'ok'       => true,
			'reason'   => '',
			'settings' => array(
				'host'                  => $host,
				'port'                  => $port,
				'auth'                  => ! empty( $input['auth'] ),
				'username'              => $username,
				'secure'                => $secure,
				'allow_option_password' => ! empty( $input['allow_option_password'] ),
			),
		);
	}

	/** Normalize a recipient list (string or array) to a bounded, capped string[]. */
	private static function normalize_recipients( $to ): array {
		if ( is_string( $to ) ) {
			$to = explode( ',', $to );
		}
		if ( ! is_array( $to ) ) {
			return array();
		}
		$out = array();
		foreach ( $to as $addr ) {
			if ( ! is_string( $addr ) ) {
				continue;
			}
			$addr = self::strip_crlf( trim( $addr ) );
			if ( '' === $addr ) {
				continue;
			}
			$out[] = self::truncate( $addr, self::MAX_FIELD_CHARS );
			if ( count( $out ) >= self::MAX_RECIPIENTS ) {
				break;
			}
		}
		return $out;
	}

	/** Message string from a WP_Error (duck-typed) or a raw string. */
	private static function error_message( $error ): string {
		if ( is_object( $error ) && method_exists( $error, 'get_error_message' ) ) {
			$msg = $error->get_error_message();
			return is_string( $msg ) ? $msg : '';
		}
		return is_string( $error ) ? $error : '';
	}

	/** Error data from a WP_Error (duck-typed); WP core packs the full mail array here. */
	private static function error_data( $error ) {
		if ( is_object( $error ) && method_exists( $error, 'get_error_data' ) ) {
			return $error->get_error_data();
		}
		return null;
	}

	/** Truncate to $max chars (multibyte-aware when available). */
	private static function truncate( string $text, int $max ): string {
		if ( function_exists( 'mb_substr' ) ) {
			return mb_substr( $text, 0, $max );
		}
		return substr( $text, 0, $max );
	}

	/** Replace CR/LF with a space — anti-injection + single-line log fields. */
	private static function strip_crlf( string $text ): string {
		return str_replace( array( "\r", "\n" ), array( ' ', ' ' ), $text );
	}

	/** True when the string carries a CR or LF. */
	private static function has_crlf( string $text ): bool {
		return false !== strpos( $text, "\r" ) || false !== strpos( $text, "\n" );
	}

	/** Current time in whole unix seconds. */
	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}
}
