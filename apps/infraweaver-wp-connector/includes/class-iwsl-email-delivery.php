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
 * (2b) any DB-stored secret is ENCRYPTED AT REST with AES-256-GCM (authenticated
 * encryption) under a per-site key derived via HKDF from WordPress's own secret
 * salts (wp_salt()/AUTH_KEY+SECURE_AUTH_KEY) — the key is never invented, hardcoded,
 * or stored; encrypt_secret()/decrypt_secret() round-trip it, a marker prefix
 * distinguishes ciphertext from a legacy plaintext value (which is re-encrypted on
 * the next save), and if no authenticated cipher/key material exists the save FAILS
 * CLOSED (reason `password-encryption-unavailable`) rather than write plaintext;
 * (3) the secret is NEVER echoed — settings_for_render() strips it wholesale and
 * the admin form always renders an empty value; (4) the secret is NEVER logged —
 * every log entry is a strict whitelist and capture_failure() runs the error string
 * through redact() so a PHPMailer error that quotes the password stores `****`;
 * (5) when the constant is defined it always wins and any submitted DB password is
 * discarded.
 *
 * LOG ACCURACY. The `wp_mail` filter fires BEFORE the send, so capture_mail() records
 * an OPTIMISTIC "sent" and remembers it for the request; if that same send then fails
 * (WordPress emits no success hook on this path), capture_failure() RETRACTS the
 * phantom "sent" and stores a single accurate "failed" — never a confusing sent+failed
 * pair. When SMTP is not configured, the send falls back to PHP mail() (absent in the
 * container → "Could not instantiate mail function."); the failed entry then leads with
 * an honest, actionable reason instead of that opaque PHPMailer string.
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

	/** Ciphertext marker prefixing an at-rest-encrypted stored secret (distinguishes it from legacy plaintext). */
	const ENC_MARKER = 'IWSLENCv1:';
	/** Authenticated cipher for at-rest secret encryption — AEAD, never unauthenticated CBC. */
	const ENC_CIPHER = 'aes-256-gcm';
	/** GCM IV length (bytes). */
	const ENC_IV_LEN = 12;
	/** GCM auth-tag length (bytes). */
	const ENC_TAG_LEN = 16;
	/** HKDF domain-separation label for the per-site key derived from WP secret salts. */
	const ENC_HKDF_INFO = 'IWSL-email-smtp-secret-v1';
	/** Honest log detail when a send fell back to PHP mail() because SMTP is unconfigured. */
	const UNCONFIGURED_HINT = 'SMTP is not configured, so WordPress used PHP mail() (unavailable in this environment). Save SMTP host and port to route mail through SMTP.';

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

	/** Minimum seconds between console-triggered test sends — rate-limits the signed channel so it can't be scripted into a spam cannon. */
	const TEST_MIN_INTERVAL_S = 30;
	/** Store key for the last test-send timestamp (unix seconds). */
	const LAST_TEST_KEY = 'email_last_test_at';
	/** Subject of a connector SMTP test send (console/admin share it). */
	const TEST_SUBJECT = 'InfraWeaver SMTP test';
	/** Body of a connector SMTP test send. */
	const TEST_BODY = "This is a test email from the InfraWeaver Connector, sent to verify your SMTP settings.\n\nIf you received it, outgoing mail is working.";

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

	/** @var callable():string WP secret-salt material — the encryption-key IKM; NEVER stored. */
	private $salt;

	/** @var callable(string,string,string):bool the mailer used by send_test(); defaults to a wp_mail() wrapper. Injected by tests. */
	private $send_mail;

	/**
	 * @var array|null The optimistic "sent" entry recorded for the in-flight wp_mail()
	 * (at the `wp_mail` filter, before the actual send), kept in memory for THIS request
	 * so `capture_failure()` can retract it if the very same send then fails.
	 */
	private $pending_sent = null;

	/**
	 * @param IWSL_Entitlements                        $entitlements The gate.
	 * @param IWSL_Store                               $store        Settings + log store.
	 * @param callable|null                            $now_ms       Clock, mirrors IWSL_Media_Optimizer.
	 * @param callable|null                            $constant     fn(string $name): ?string — the secret
	 *                                                                source; defaults to defined()/constant().
	 * @param array<string, IWSL_Mail_Transport>|null  $transports   Registry override (tests inject);
	 *                                                                defaults to self::transports().
	 * @param callable|null                            $salt         fn(): string — WP secret-salt material
	 *                                                                (the encryption-key IKM); defaults to a
	 *                                                                wp_salt()/AUTH_KEY reader. Injected by tests.
	 * @param callable|null                            $send_mail    fn(string $to, string $subject, string $body): bool
	 *                                                                — the send_test() mailer; defaults to a
	 *                                                                wp_mail() wrapper. Injected by tests.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		IWSL_Store $store,
		?callable $now_ms = null,
		?callable $constant = null,
		?array $transports = null,
		?callable $salt = null,
		?callable $send_mail = null
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
		$this->salt       = $salt ?? static function (): string {
			// Derive the key-material IKM from WordPress's own per-site secret salts.
			// wp_salt() concatenates the KEY + SALT constants; combining the auth and
			// secure_auth realms binds the IKM to two independent secrets. We NEVER
			// store this — the key is re-derived on demand and lives only in memory.
			$ikm = '';
			if ( function_exists( 'wp_salt' ) ) {
				$ikm = (string) wp_salt( 'auth' ) . (string) wp_salt( 'secure_auth' );
			}
			if ( '' === $ikm ) {
				foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT' ) as $const ) {
					if ( defined( $const ) ) {
						$ikm .= (string) constant( $const );
					}
				}
			}
			return $ikm;
		};
		$this->send_mail = $send_mail ?? static function ( string $to, string $subject, string $body ): bool {
			// Route through wp_mail so the registered phpmailer_init hook applies the
			// configured SMTP transport; false when WordPress is absent (test/CLI).
			return function_exists( 'wp_mail' ) ? (bool) wp_mail( $to, $subject, $body ) : false;
		};
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

		// Force the From to an address the SMTP account is allowed to send AS.
		// WordPress otherwise defaults to wordpress@<site-domain>, which strict
		// providers (Office 365 / Gmail) reject ("not authenticated to send as" /
		// 5.7.57). Prefer the operator-set From; fall back to the auth username
		// (the authenticated mailbox — the address O365 expects). setFrom overrides
		// the header From for THIS send; Sender sets the envelope MAIL FROM /
		// Return-Path so it matches too. Applies to every wp_mail on the site.
		$from_email = '' !== (string) $settings['from_email'] ? (string) $settings['from_email'] : (string) $settings['username'];
		$valid_from = '' !== $from_email && ( function_exists( 'is_email' ) ? (bool) is_email( $from_email ) : 1 === preg_match( '/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $from_email ) );
		if ( $valid_from && is_object( $phpmailer ) && method_exists( $phpmailer, 'setFrom' ) ) {
			$from_name = '' !== (string) $settings['from_name']
				? (string) $settings['from_name']
				: ( function_exists( 'get_bloginfo' ) ? (string) get_bloginfo( 'name' ) : '' );
			try {
				$phpmailer->setFrom( $from_email, $from_name, false );
			} catch ( \Exception $e ) {
				$phpmailer->From = $from_email; // best-effort fallback.
			}
			$phpmailer->Sender = $from_email;
		}

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

		// $this->settings() decrypts any at-rest secret, so $prev_password is plaintext.
		$previous      = $this->settings();
		$prev_password = isset( $previous['password'] ) ? (string) $previous['password'] : '';
		$constant_wins = null !== $this->constant_password();

		// Resolve the PLAINTEXT secret to persist ('' = store none), then encrypt it
		// below. Nothing is written to the store in plaintext.
		$plain = '';
		if ( $constant_wins ) {
			// wp-config constant is authoritative: never write a submitted DB password
			// and discard whatever was submitted. Preserve any prior stored secret.
			$plain = $prev_password;
		} elseif ( ! $next['allow_option_password'] ) {
			// DB storage not opted in: refuse an attempt to store a password. A blank
			// submit is fine and drops any previously stored secret.
			if ( '' !== $submitted ) {
				return array( 'ok' => false, 'reason' => 'password-storage-not-allowed' );
			}
		} elseif ( '' !== $submitted ) {
			// Opted in with a new secret — set/replace it.
			$plain = $submitted;
		} elseif ( '' !== $prev_password ) {
			// Opted in, blank submit — keep the previous secret (masked-placeholder).
			$plain = $prev_password;
		}

		if ( '' !== $plain ) {
			// Encrypt at rest (AES-256-GCM, key derived from WP salts). FAIL CLOSED:
			// if no authenticated cipher / key material is available we refuse to
			// persist rather than silently store the secret in plaintext.
			$ciphertext = $this->encrypt_secret( $plain );
			if ( ! is_string( $ciphertext ) || '' === $ciphertext ) {
				return array( 'ok' => false, 'reason' => 'password-encryption-unavailable' );
			}
			$next['password'] = $ciphertext;
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

	/**
	 * Send a test email to a validated recipient (mirrors the wp-admin test-send).
	 * STATEMENT 1 is the gate; a locked site sends NOTHING. The recipient is
	 * validated (CRLF/parameter injection rejected) and the send is RATE-LIMITED on
	 * this side (TEST_MIN_INTERVAL_S) — the clamp lives here, not in the caller, so
	 * even a hostile signed-channel session cannot script a spam cannon. The mailer
	 * is the injected wp_mail wrapper, so the real send routes through the configured
	 * SMTP transport via the phpmailer_init hook (and is recorded by capture_mail /
	 * capture_failure as any other send). The secret is never touched here.
	 *
	 * @return array{ ok:bool, sent:bool, reason:string, retry_after_s?:int, gate?:array }
	 */
	public function send_test( string $to ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'sent' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$to = trim( $to );
		if ( '' === $to || self::has_crlf( $to ) || ! self::valid_email( $to ) ) {
			return array( 'ok' => false, 'sent' => false, 'reason' => 'invalid-recipient' );
		}
		$to = self::truncate( $to, self::MAX_FIELD_CHARS );

		$now  = $this->now_seconds();
		$last = (int) $this->store->get( self::LAST_TEST_KEY, 0 );
		if ( $last > 0 && $now - $last < self::TEST_MIN_INTERVAL_S ) {
			return array(
				'ok'            => false,
				'sent'          => false,
				'reason'        => 'rate-limited',
				'retry_after_s' => self::TEST_MIN_INTERVAL_S - ( $now - $last ),
			);
		}
		// Stamp the window BEFORE the send so a failing/hammered send is throttled too.
		// A recipient typo (rejected above) never consumes the window.
		$this->store->set( self::LAST_TEST_KEY, $now );

		$sent = (bool) ( $this->send_mail )( $to, self::TEST_SUBJECT, self::TEST_BODY );
		return array( 'ok' => $sent, 'sent' => $sent, 'reason' => $sent ? '' : 'send-failed' );
	}

	/**
	 * Teardown for an uninstall/unlink sweep: delete BOTH option keys this feature
	 * owns — the SMTP settings map (SETTINGS_KEY, which holds the AES-256-GCM encrypted
	 * SMTP password) and the email-activity log (LOG_KEY). Removing the stored
	 * (encrypted) credential on disable is the correct, safe default: teardown leaves
	 * no secret at rest. Deliberately UNGATED — teardown must succeed even AFTER the
	 * entitlement is revoked and the gate has re-locked. NEVER touches the wp-config
	 * IWSL_SMTP_PASS constant (not ours to remove) or any core WordPress option.
	 * Idempotent + cheap-when-clean: deleting an absent key is a single no-op store
	 * call.
	 *
	 * @return array{ ok:bool, settings_deleted:bool, log_deleted:bool }
	 */
	public function purge(): array {
		$had_settings = null !== $this->store->get( self::SETTINGS_KEY, null );
		$had_log      = null !== $this->store->get( self::LOG_KEY, null );
		$this->store->delete( self::SETTINGS_KEY );
		$this->store->delete( self::LOG_KEY );
		return array(
			'ok'               => true,
			'settings_deleted' => $had_settings,
			'log_deleted'      => $had_log,
		);
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
				// The `wp_mail` filter fires BEFORE the send, so this is an OPTIMISTIC
				// "sent": remember it in memory so capture_failure() can retract it if
				// this very send then fails (WordPress emits no `wp_mail_succeeded` hook
				// here, so a delivered mail must be recorded now and un-recorded on error).
				$this->pending_sent = $this->append_entry(
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

		// Consume the in-flight optimistic "sent" (set by capture_mail for THIS send).
		$pending            = $this->pending_sent;
		$this->pending_sent = null;

		try {
			$data    = self::error_data( $error );
			$to      = self::normalize_recipients( is_array( $data ) && isset( $data['to'] ) ? $data['to'] : array() );
			$subject = is_array( $data ) && isset( $data['subject'] ) ? (string) $data['subject'] : '';
			$secret  = $this->effective_password( $this->settings() );

			// If SMTP is not configured the send could not have used SMTP — it fell back
			// to PHP mail(). Lead with an honest, actionable reason instead of leaving the
			// operator with PHPMailer's cryptic "Could not instantiate mail function.".
			$raw = self::error_message( $error );
			if ( ! $this->is_configured() ) {
				$raw = self::UNCONFIGURED_HINT . ( '' !== $raw ? ' (' . $raw . ')' : '' );
			}
			$message = self::truncate( self::redact( $raw, $secret ), self::MAX_ERROR_CHARS );

			$failed = array(
				'at'      => $this->now_seconds(),
				'type'    => 'failed',
				'to'      => $to,
				'subject' => self::truncate( self::strip_crlf( $subject ), self::MAX_SUBJECT_CHARS ),
				'error'   => $message,
			);

			// A failed send must be ONE accurate row, never a confusing "sent"+"failed"
			// pair: retract the phantom "sent" this send recorded, then store the failure.
			if ( is_array( $pending ) ) {
				$this->replace_last_entry( $pending, $failed );
			} else {
				$this->append_entry( $failed );
			}
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

	/**
	 * Gate-aware config read for the signed `email.config.get` channel. "Locked" is a
	 * renderable state, so a locked site returns the gate ONLY (no settings, no
	 * password metadata) rather than erroring — the console renders the upgrade path.
	 * When unlocked it returns the STRIPPED settings (password removed entirely by
	 * settings_for_render — ciphertext can never appear) plus has_password /
	 * password_source / configured / transports. It never returns a secret.
	 *
	 * @return array{ gate:array, locked:bool, settings?:array, has_password?:bool, password_source?:string, configured?:bool, transports?:array }
	 */
	public function config_snapshot(): array {
		$gate     = $this->entitlements->evaluate( self::FEATURE );
		$locked   = empty( $gate['unlocked'] );
		$snapshot = array( 'gate' => $gate, 'locked' => $locked );
		if ( $locked ) {
			return $snapshot;
		}

		$render       = $this->settings_for_render();
		$has_password = ! empty( $render['has_password'] );
		$source       = isset( $render['password_source'] ) ? (string) $render['password_source'] : 'none';
		unset( $render['has_password'], $render['password_source'] );

		$snapshot['settings']        = $render;
		$snapshot['has_password']    = $has_password;
		$snapshot['password_source'] = $source;
		$snapshot['configured']      = $this->is_configured();
		$snapshot['transports']      = $this->transport_ids();
		return $snapshot;
	}

	/**
	 * `wp_mail` filter callback that PREPENDS the white-label email brand header
	 * (logo + brand name) to HTML mail. The header is supplied by the caller — it is
	 * the resolved output of IWSL_White_Label::email_brand_header(), which gates on
	 * the `white_label` entitlement and the `apply_to_email` toggle — so a locked or
	 * opted-out site passes '' and this returns the mail untouched. Deliberately does
	 * NOT consult the `email_delivery` gate: email branding is a white-label concern
	 * and must apply on white-label ALONE (Ultimate), regardless of whether SMTP
	 * delivery is configured. Only HTML mail is touched — never inject markup into a
	 * plain-text message. Immutable: builds a fresh args map, never mutates the input,
	 * and always returns a valid $args so a branding hiccup can never break wp_mail().
	 *
	 * @param mixed  $args   The wp_mail argument array.
	 * @param string $header The already-escaped brand header ('' = nothing to add).
	 * @return mixed The (possibly header-prepended) $args.
	 */
	public function brand_mail( $args, string $header ) {
		if ( '' === $header || ! is_array( $args ) || ! self::is_html_mail( $args ) ) {
			return $args;
		}
		$copy            = $args;
		$body            = isset( $copy['message'] ) ? (string) $copy['message'] : '';
		$copy['message'] = $header . $body;
		return $copy;
	}

	/**
	 * Whether a wp_mail() arg array is HTML mail, judged from an explicit
	 * `Content-Type: text/html` header (the only reliable signal available inside the
	 * `wp_mail` filter). Headers may arrive as a string or an array of strings. Fails
	 * closed to "not HTML" so plain-text mail is never corrupted with markup.
	 */
	private static function is_html_mail( array $args ): bool {
		$headers = $args['headers'] ?? array();
		if ( is_string( $headers ) ) {
			$headers = array( $headers );
		}
		if ( ! is_array( $headers ) ) {
			return false;
		}
		foreach ( $headers as $header ) {
			if ( is_string( $header )
				&& false !== stripos( $header, 'content-type' )
				&& false !== stripos( $header, 'text/html' ) ) {
				return true;
			}
		}
		return false;
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
			'from_email'            => isset( $stored['from_email'] ) ? (string) $stored['from_email'] : '',
			'from_name'             => isset( $stored['from_name'] ) ? (string) $stored['from_name'] : '',
			'secure'                => ( isset( $stored['secure'] ) && in_array( $stored['secure'], self::SECURE_MODES, true ) )
				? (string) $stored['secure'] : '',
			'allow_option_password' => isset( $stored['allow_option_password'] ) ? (bool) $stored['allow_option_password'] : false,
		);
		if ( isset( $stored['password'] ) && is_string( $stored['password'] ) && '' !== $stored['password'] ) {
			// Decrypt transparently. A legacy plaintext value (no ciphertext marker) is
			// returned as-is and re-encrypted on the next save (migration). A value that
			// carries our marker but fails authenticated decryption (tampered / rotated
			// salts / crypto removed) is dropped — the site has no usable secret rather
			// than a wrong one (fail closed).
			$plain = $this->decrypt_secret( $stored['password'] );
			if ( is_string( $plain ) && '' !== $plain ) {
				$merged['password'] = $plain;
			}
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

	// ── at-rest secret encryption (AES-256-GCM; key derived from WP salts) ─────────

	/** True when an authenticated cipher we can use is actually available in this runtime. */
	private static function crypto_available(): bool {
		return function_exists( 'openssl_encrypt' )
			&& function_exists( 'openssl_decrypt' )
			&& function_exists( 'random_bytes' )
			&& function_exists( 'openssl_get_cipher_methods' )
			&& in_array( self::ENC_CIPHER, openssl_get_cipher_methods(), true );
	}

	/**
	 * Derive the 32-byte per-site AES key from the WP secret-salt IKM. HKDF-SHA-256
	 * when available (domain-separated by ENC_HKDF_INFO), else a hashed fallback. The
	 * key is NEVER stored — re-derived on demand, in memory only. Returns null when
	 * there is no salt material to derive from (→ callers fail closed).
	 */
	private function encryption_key(): ?string {
		$ikm = ( $this->salt )();
		if ( ! is_string( $ikm ) || '' === $ikm ) {
			return null;
		}
		if ( function_exists( 'hash_hkdf' ) ) {
			return hash_hkdf( 'sha256', $ikm, 32, self::ENC_HKDF_INFO, '' );
		}
		return substr( hash( 'sha256', self::ENC_HKDF_INFO . "\x00" . $ikm, true ), 0, 32 );
	}

	/**
	 * Encrypt a plaintext secret to `MARKER || base64(iv || tag || ciphertext)` with
	 * AES-256-GCM and a random IV. Returns '' for '' input, and null when encryption
	 * is not possible (no cipher or no key material) so the caller can FAIL CLOSED
	 * rather than persist plaintext.
	 */
	private function encrypt_secret( string $plaintext ): ?string {
		if ( '' === $plaintext ) {
			return '';
		}
		if ( ! self::crypto_available() ) {
			return null;
		}
		$key = $this->encryption_key();
		if ( null === $key ) {
			return null;
		}
		try {
			$iv  = random_bytes( self::ENC_IV_LEN );
			$tag = '';
			$ct  = openssl_encrypt( $plaintext, self::ENC_CIPHER, $key, OPENSSL_RAW_DATA, $iv, $tag, '', self::ENC_TAG_LEN );
		} catch ( \Throwable $e ) {
			return null;
		}
		if ( ! is_string( $ct ) || '' === $ct || ! is_string( $tag ) || self::ENC_TAG_LEN !== strlen( $tag ) ) {
			return null;
		}
		return self::ENC_MARKER . base64_encode( $iv . $tag . $ct );
	}

	/**
	 * Decrypt a stored secret. A value WITHOUT the ciphertext marker is legacy
	 * plaintext and returned unchanged (migration — it is re-encrypted on next save).
	 * A marked value is authenticated-decrypted; null on any failure (bad crypto,
	 * corrupt blob, wrong key, tamper) so the caller treats it as "no usable secret".
	 */
	private function decrypt_secret( string $stored ): ?string {
		if ( 0 !== strpos( $stored, self::ENC_MARKER ) ) {
			return $stored; // legacy plaintext.
		}
		if ( ! self::crypto_available() ) {
			return null;
		}
		$key = $this->encryption_key();
		if ( null === $key ) {
			return null;
		}
		$blob = base64_decode( substr( $stored, strlen( self::ENC_MARKER ) ), true );
		if ( false === $blob || strlen( $blob ) <= self::ENC_IV_LEN + self::ENC_TAG_LEN ) {
			return null;
		}
		$iv  = substr( $blob, 0, self::ENC_IV_LEN );
		$tag = substr( $blob, self::ENC_IV_LEN, self::ENC_TAG_LEN );
		$ct  = substr( $blob, self::ENC_IV_LEN + self::ENC_TAG_LEN );
		try {
			$pt = openssl_decrypt( $ct, self::ENC_CIPHER, $key, OPENSSL_RAW_DATA, $iv, $tag );
		} catch ( \Throwable $e ) {
			return null;
		}
		return is_string( $pt ) ? $pt : null;
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
	private function append_entry( array $entry ): array {
		$secret   = $this->effective_password( $this->settings() );
		$scrubbed = self::scrub_entry( $entry, $secret );

		$appended = array_merge( $this->log(), array( $scrubbed ) );
		$this->store->set( self::LOG_KEY, array_slice( $appended, -self::MAX_LOG ) );
		return $scrubbed;
	}

	/**
	 * Retract the phantom "sent" recorded for THIS wp_mail() (if it is still the last
	 * log entry) and store a single accurate replacement, immutably. Guarded by an
	 * exact-equality check against the remembered "sent" entry so an unrelated log
	 * write is never clobbered; if the phantom is gone, the replacement is just
	 * appended. Never mutates the stored log in place.
	 */
	private function replace_last_entry( array $expected_last, array $replacement ): void {
		$secret = $this->effective_password( $this->settings() );
		$repl   = self::scrub_entry( $replacement, $secret );

		$log  = $this->log();
		$last = end( $log );
		if ( false !== $last && $last === $expected_last ) {
			array_pop( $log );
		}
		$log[] = $repl;
		$this->store->set( self::LOG_KEY, array_slice( $log, -self::MAX_LOG ) );
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

		// From address: what the message is sent AS. Strict providers (Office 365,
		// Gmail) refuse WordPress's default wordpress@<domain> — the From must be an
		// address the authenticated mailbox may send as. Empty is allowed (falls back
		// to the auth username at send time). CRLF is rejected (header injection).
		$from_email = isset( $input['from_email'] ) ? trim( (string) $input['from_email'] ) : '';
		if ( '' !== $from_email ) {
			if ( self::has_crlf( $from_email ) || ( function_exists( 'is_email' ) ? ! is_email( $from_email ) : 1 !== preg_match( '/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $from_email ) ) ) {
				return array( 'ok' => false, 'reason' => 'bad-from-email' );
			}
			$from_email = self::truncate( $from_email, self::MAX_FIELD_CHARS );
		}
		$from_name = isset( $input['from_name'] ) ? (string) $input['from_name'] : '';
		if ( self::has_crlf( $from_name ) ) {
			return array( 'ok' => false, 'reason' => 'bad-from-name' );
		}
		$from_name = self::truncate( trim( $from_name ), self::MAX_FIELD_CHARS );

		return array(
			'ok'       => true,
			'reason'   => '',
			'settings' => array(
				'host'                  => $host,
				'port'                  => $port,
				'auth'                  => ! empty( $input['auth'] ),
				'username'              => $username,
				'from_email'            => $from_email,
				'from_name'             => $from_name,
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

	/** True when the string is a valid email address (same rule the From validation uses). */
	private static function valid_email( string $email ): bool {
		return function_exists( 'is_email' )
			? (bool) is_email( $email )
			: 1 === preg_match( '/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $email );
	}

	/** Current time in whole unix seconds. */
	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}
}
