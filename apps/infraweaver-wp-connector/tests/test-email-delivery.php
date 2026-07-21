<?php
/**
 * SMTP delivery & email log (gate flag `email_delivery`): the generic engine
 * (IWSL_Email_Delivery) + the SMTP transport (IWSL_SMTP_Transport).
 *
 * Runs under the zero-dependency harness: the store is the in-memory
 * IWSL_Memory_Store, the clock + the wp-config constant reader + the transport
 * registry are injected, and a RECORDING FAKE phpmailer proves the gate blocks
 * BEFORE the mailer is touched. No WordPress and no real PHPMailer are required —
 * every gate / redaction / whitelist / validation assertion runs with no deps.
 */

// ── recording fakes + stubs (harness only) ────────────────────────────────────

/** A recording fake mailer — public props default to a pristine mailer's state. */
final class IWSL_ED_Recording_PHPMailer {

	/** @var string */
	public $Host = '';
	/** @var int */
	public $Port = 0;
	/** @var bool */
	public $SMTPAuth = false;
	/** @var string */
	public $Username = '';
	/** @var string */
	public $Password = '';
	/** @var string */
	public $SMTPSecure = '';
	/** @var int */
	public $is_smtp_called = 0;

	public function isSMTP(): void {
		$this->is_smtp_called++;
	}
}

/** A WP_Error-shaped stub — duck-typed by IWSL_Email_Delivery. */
final class IWSL_ED_WP_Error_Stub {

	/** @var string */
	private $message;

	/** @var mixed */
	private $data;

	/** @param mixed $data */
	public function __construct( string $message, $data ) {
		$this->message = $message;
		$this->data    = $data;
	}

	public function get_error_message(): string {
		return $this->message;
	}

	/** @return mixed */
	public function get_error_data() {
		return $this->data;
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Entitlements object over its own memory store — one leg per argument. */
function iwsl_ed_entitlements( string $state, int $last_verified_at, bool $flag, callable $clock ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $last_verified_at );
	$store->set( 'entitlements', array( 'email_delivery' => $flag ) );
	return new IWSL_Entitlements( $store, $clock );
}

/** A constant reader that reports IWSL_SMTP_PASS = $secret, everything else null. */
function iwsl_ed_const( string $secret ): callable {
	return static function ( string $name ) use ( $secret ) {
		return 'IWSL_SMTP_PASS' === $name ? $secret : null;
	};
}

/** A fixed 64-char salt provider so at-rest encryption is deterministic under the harness. */
function iwsl_ed_salt(): callable {
	return static function (): string {
		return 'iwsl-harness-fixed-salt-material-0123456789abcdef-ABCDEF-9876543210';
	};
}

/**
 * Engine wired to an injected transport registry (the real SMTP transport) plus a
 * salt provider. Pass $salt to exercise the fail-closed path (e.g. an empty-string
 * provider → no derivable key); defaults to the fixed harness salt.
 */
function iwsl_ed_engine( IWSL_Entitlements $ent, IWSL_Store $store, callable $clock, callable $constant, ?callable $salt = null ): IWSL_Email_Delivery {
	return new IWSL_Email_Delivery( $ent, $store, $clock, $constant, array( 'smtp' => new IWSL_SMTP_Transport() ), $salt ?? iwsl_ed_salt() );
}

/** A complete, valid stored-settings array (optionally with an opted-in password). */
function iwsl_ed_valid_settings( bool $allow_pw = false, string $password = '' ): array {
	$settings = array(
		'host'                  => 'smtp.example.test',
		'port'                  => 587,
		'auth'                  => true,
		'username'              => 'mailer@example.test',
		'secure'                => 'tls',
		'allow_option_password' => $allow_pw,
	);
	if ( '' !== $password ) {
		$settings['password'] = $password;
	}
	return $settings;
}

$ED_NOW_MS      = 1600000000000; // fixed injected clock (unix ms).
$ED_NOW_SECONDS = (int) floor( $ED_NOW_MS / 1000 );
$ed_clock       = static function () use ( $ED_NOW_MS ): int {
	return $ED_NOW_MS;
};
$ed_fresh       = $ED_NOW_MS - 60000;     // 1 min ago — heartbeat fresh.
$ed_stale       = $ED_NOW_MS - 10800000;  // 3h ago — heartbeat stale.
$ed_const_none  = static function ( string $name ) {
	return null;
};

// ── 1. Gate blocks the mailer — three locked legs; mailer NEVER touched ───────

$locked_variants = array(
	'flag-not-granted' => iwsl_ed_entitlements( 'active', $ed_fresh, false, $ed_clock ),
	'heartbeat-stale'  => iwsl_ed_entitlements( 'active', $ed_stale, true, $ed_clock ),
	'not-linked'       => iwsl_ed_entitlements( 'pending', $ed_fresh, true, $ed_clock ),
);
foreach ( $locked_variants as $variant => $ent ) {
	$store = new IWSL_Memory_Store();
	$store->set( 'email_smtp_settings', iwsl_ed_valid_settings() ); // configured, so only the gate can stop it
	$engine = iwsl_ed_engine( $ent, $store, $ed_clock, iwsl_ed_const( 'const-secret' ) );
	$fake   = new IWSL_ED_Recording_PHPMailer();
	$res    = $engine->configure_mailer( $fake );
	iwsl_assert_same( 'entitlement-locked', $res['reason'], "gate blocks mailer ({$variant}): entitlement-locked" );
	iwsl_assert_same( 0, $fake->is_smtp_called, "gate blocks mailer ({$variant}): isSMTP NEVER called" );
	iwsl_assert( $fake == new IWSL_ED_Recording_PHPMailer(), "gate blocks mailer ({$variant}): mailer identical to pristine" );
}

// ── 2. Gate blocks logging — zero writes on either hook ───────────────────────

$store2  = new IWSL_Memory_Store();
$engine2 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, false, $ed_clock ), $store2, $ed_clock, $ed_const_none );
$args2   = array( 'to' => 'x@y.test', 'subject' => 'Hi', 'message' => 'body' );
$ret2    = $engine2->capture_mail( $args2 );
iwsl_assert_same( $args2, $ret2, 'gate blocks logging: capture_mail returns the identical args' );
iwsl_assert_same( array(), $engine2->log(), 'gate blocks logging: capture_mail wrote nothing' );
$engine2->capture_failure( new IWSL_ED_WP_Error_Stub( 'boom', array( 'to' => 'x@y.test' ) ) );
iwsl_assert_same( array(), $engine2->log(), 'gate blocks logging: capture_failure wrote nothing' );

// ── 3. Unlocked + configured — the transport configures the mailer ────────────

$store3  = new IWSL_Memory_Store();
$engine3 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store3, $ed_clock, iwsl_ed_const( 'const-secret' ) );
$save3   = $engine3->save_settings(
	array(
		'host'                  => 'smtp.example.test',
		'port'                  => 587,
		'secure'                => 'tls',
		'auth'                  => true,
		'username'              => 'mailer@example.test',
		'password'              => '',
		'allow_option_password' => false,
	)
);
iwsl_assert_same( true, $save3['ok'], 'unlocked: valid settings saved' );
$fake3 = new IWSL_ED_Recording_PHPMailer();
$res3  = $engine3->configure_mailer( $fake3 );
iwsl_assert_same( true, $res3['ok'], 'unlocked+configured: configure ok' );
iwsl_assert_same( 1, $fake3->is_smtp_called, 'unlocked+configured: isSMTP called exactly once' );
iwsl_assert_same( 'smtp.example.test', $fake3->Host, 'unlocked+configured: Host applied' );
iwsl_assert_same( 587, $fake3->Port, 'unlocked+configured: Port applied as int' );
iwsl_assert_same( true, $fake3->SMTPAuth, 'unlocked+configured: SMTPAuth applied as bool' );
iwsl_assert_same( 'mailer@example.test', $fake3->Username, 'unlocked+configured: Username applied' );
iwsl_assert_same( 'const-secret', $fake3->Password, 'unlocked+configured: Password sourced from the wp-config constant' );
iwsl_assert_same( 'tls', $fake3->SMTPSecure, 'unlocked+configured: SMTPSecure applied' );

// ── 4. Unlocked but NOT configured (empty host) — mailer untouched ────────────

$store4  = new IWSL_Memory_Store();
$engine4 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store4, $ed_clock, $ed_const_none );
$fake4   = new IWSL_ED_Recording_PHPMailer();
$res4    = $engine4->configure_mailer( $fake4 );
iwsl_assert_same( 'not-configured', $res4['reason'], 'unlocked, empty host: reason not-configured' );
iwsl_assert_same( 0, $fake4->is_smtp_called, 'unlocked, empty host: mailer never touched' );
iwsl_assert( $fake4 == new IWSL_ED_Recording_PHPMailer(), 'unlocked, empty host: mailer identical to pristine' );

// ── 5. Password source precedence ─────────────────────────────────────────────

// (a) constant defined + a DIFFERENT option password → constant wins.
$store5a  = new IWSL_Memory_Store();
$store5a->set( 'email_smtp_settings', iwsl_ed_valid_settings( true, 'option-secret' ) );
$engine5a = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store5a, $ed_clock, iwsl_ed_const( 'const-secret' ) );
$fake5a   = new IWSL_ED_Recording_PHPMailer();
$engine5a->configure_mailer( $fake5a );
iwsl_assert_same( 'const-secret', $fake5a->Password, 'precedence: constant wins over the stored option password' );

// (b) no constant + opt-in FALSE + a submitted password → refused, nothing stored.
$store5b  = new IWSL_Memory_Store();
$engine5b = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store5b, $ed_clock, $ed_const_none );
$res5b    = $engine5b->save_settings(
	array(
		'host'                  => 'smtp.example.test',
		'port'                  => 587,
		'secure'                => 'tls',
		'auth'                  => true,
		'username'              => 'u',
		'password'              => 'attempted',
		'allow_option_password' => false,
	)
);
iwsl_assert_same( 'password-storage-not-allowed', $res5b['reason'], 'precedence: DB password refused without opt-in' );
$stored5b = $store5b->get( 'email_smtp_settings' );
iwsl_assert( ! is_array( $stored5b ) || ! isset( $stored5b['password'] ), 'precedence: no password persisted without opt-in' );

// ── 6. Log capture records to/subject ONLY — never body/headers ───────────────

$store6  = new IWSL_Memory_Store();
$engine6 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store6, $ed_clock, $ed_const_none );
$args6   = array(
	'to'      => 'a@x.test',
	'subject' => 'Hi',
	'message' => 'SECRET-BODY',
	'headers' => array( 'X-Token: abc' ),
);
$ret6 = $engine6->capture_mail( $args6 );
iwsl_assert_same( $args6, $ret6, 'log capture: capture_mail returns its input unchanged' );
$log6 = $engine6->log();
iwsl_assert_same( 1, count( $log6 ), 'log capture: exactly one entry recorded' );
$entry6 = $log6[0];
iwsl_assert_same( array( 'a@x.test' ), $entry6['to'], 'log capture: string recipient normalized to string[]' );
iwsl_assert_same( 'Hi', $entry6['subject'], 'log capture: subject recorded' );
iwsl_assert_same( $ED_NOW_SECONDS, $entry6['at'], 'log capture: at is unix seconds from the injected clock' );
$json6 = (string) json_encode( $log6 );
iwsl_assert( false === strpos( $json6, 'SECRET-BODY' ), 'log capture: message body NEVER stored' );
iwsl_assert( false === strpos( $json6, 'X-Token' ), 'log capture: headers NEVER stored' );
$keys6 = array_keys( $entry6 );
sort( $keys6 );
iwsl_assert_same( array( 'at', 'subject', 'to', 'type' ), $keys6, 'log capture: entry keys are exactly the whitelist' );

// ── 7. Failure capture — redaction + no body ──────────────────────────────────

$secret7   = 'super-secret-pw';
$store7    = new IWSL_Memory_Store();
$engine7   = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store7, $ed_clock, iwsl_ed_const( $secret7 ) );
$err_data7 = array(
	'to'      => array( 'dest@x.test' ),
	'subject' => 'Reset',
	'message' => 'BODY-SHOULD-NOT-BE-STORED',
	'headers' => 'X-H: v',
);
$engine7->capture_failure( new IWSL_ED_WP_Error_Stub( 'SMTP auth failed for user with password ' . $secret7 . ' (rejected)', $err_data7 ) );
$log7   = $engine7->log();
$entry7 = $log7[0];
iwsl_assert_same( 'failed', $entry7['type'], 'failure capture: type=failed' );
iwsl_assert( false !== strpos( $entry7['error'], '****' ), 'failure capture: secret replaced with ****' );
iwsl_assert( false === strpos( $entry7['error'], $secret7 ), 'failure capture: raw secret NEVER stored' );
iwsl_assert_same( array( 'dest@x.test' ), $entry7['to'], 'failure capture: to extracted from error data' );
$json7 = (string) json_encode( $log7 );
iwsl_assert( false === strpos( $json7, 'BODY-SHOULD-NOT-BE-STORED' ), 'failure capture: error-data mail body NEVER stored' );

// Truncation: a very long error is capped at MAX_ERROR_CHARS.
$store7b  = new IWSL_Memory_Store();
$engine7b = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store7b, $ed_clock, $ed_const_none );
$engine7b->capture_failure( new IWSL_ED_WP_Error_Stub( str_repeat( 'E', 500 ), array( 'to' => 'z@x.test', 'subject' => 'S' ) ) );
$entry7b = $engine7b->log()[0];
iwsl_assert_same( IWSL_Email_Delivery::MAX_ERROR_CHARS, strlen( $entry7b['error'] ), 'failure capture: long error truncated to MAX_ERROR_CHARS' );

// ── 8. Ring buffer capped at MAX_LOG (oldest dropped) ─────────────────────────

$store8  = new IWSL_Memory_Store();
$engine8 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store8, $ed_clock, $ed_const_none );
$total8  = IWSL_Email_Delivery::MAX_LOG + 5;
for ( $i = 0; $i < $total8; $i++ ) {
	$engine8->capture_mail( array( 'to' => 'x@x.test', 'subject' => 'S-' . $i ) );
}
$log8      = $engine8->log();
$subjects8 = array_map(
	static function ( $entry ) {
		return $entry['subject'];
	},
	$log8
);
iwsl_assert_same( IWSL_Email_Delivery::MAX_LOG, count( $log8 ), 'ring buffer: capped at MAX_LOG' );
iwsl_assert( ! in_array( 'S-0', $subjects8, true ), 'ring buffer: oldest entry dropped' );
iwsl_assert( in_array( 'S-' . ( $total8 - 1 ), $subjects8, true ), 'ring buffer: newest entry kept (newest last)' );

// ── 9. Masked placeholder / empty-submit keeps prior secret ───────────────────

$store9  = new IWSL_Memory_Store();
$engine9 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store9, $ed_clock, $ed_const_none );
$base9   = array(
	'host'                  => 'smtp.example.test',
	'port'                  => 587,
	'secure'                => 'tls',
	'auth'                  => true,
	'username'              => 'u',
	'allow_option_password' => true,
);

// The stored value is now ENCRYPTED at rest (ciphertext marker, never plaintext); the
// EFFECTIVE (decrypted) secret is verified by what configure_mailer applies to a mailer.
$engine9->save_settings( $base9 + array( 'password' => 'first' ) );
$stored9a = $store9->get( 'email_smtp_settings' )['password'];
iwsl_assert( 0 === strpos( $stored9a, IWSL_Email_Delivery::ENC_MARKER ), 'empty-submit: stored secret is ciphertext (marker prefix)' );
iwsl_assert( false === strpos( $stored9a, 'first' ), 'empty-submit: plaintext never appears in the stored option' );
$m9 = new IWSL_ED_Recording_PHPMailer();
$engine9->configure_mailer( $m9 );
iwsl_assert_same( 'first', $m9->Password, 'empty-submit: initial secret decrypts back to plaintext' );

$engine9->save_settings( $base9 + array( 'password' => '' ) );
$m9b = new IWSL_ED_Recording_PHPMailer();
$engine9->configure_mailer( $m9b );
iwsl_assert_same( 'first', $m9b->Password, 'empty-submit: blank submit keeps the prior secret' );

$engine9->save_settings( $base9 + array( 'password' => 'second' ) );
$m9c = new IWSL_ED_Recording_PHPMailer();
$engine9->configure_mailer( $m9c );
iwsl_assert_same( 'second', $m9c->Password, 'empty-submit: a non-blank submit replaces the secret' );

$render9 = $engine9->settings_for_render();
iwsl_assert( ! array_key_exists( 'password', $render9 ), 'render: settings_for_render has NO password key' );
iwsl_assert_same( true, $render9['has_password'], 'render: has_password is true when a secret is stored' );
iwsl_assert_same( 'option', $render9['password_source'], 'render: password_source is option' );
iwsl_assert( false === strpos( (string) json_encode( $render9 ), 'first' ), 'render: the replaced secret never appears' );
iwsl_assert( false === strpos( (string) json_encode( $render9 ), 'second' ), 'render: the current secret never appears' );

// ── 10. Save validation + locked save leaves the store byte-identical ─────────

$store10  = new IWSL_Memory_Store();
$engine10 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store10, $ed_clock, $ed_const_none );
$good10   = array(
	'host'                  => 'smtp.example.test',
	'port'                  => 587,
	'secure'                => 'tls',
	'auth'                  => false,
	'username'              => 'u',
	'allow_option_password' => false,
);
iwsl_assert_same( 'bad-host', $engine10->save_settings( array_merge( $good10, array( 'host' => "smtp.example.test\r\nEVIL" ) ) )['reason'], 'validation: CRLF host → bad-host' );
iwsl_assert_same( 'bad-port', $engine10->save_settings( array_merge( $good10, array( 'port' => 0 ) ) )['reason'], 'validation: port 0 → bad-port' );
iwsl_assert_same( 'bad-port', $engine10->save_settings( array_merge( $good10, array( 'port' => 70000 ) ) )['reason'], 'validation: port 70000 → bad-port' );
iwsl_assert_same( 'bad-secure', $engine10->save_settings( array_merge( $good10, array( 'secure' => 'starttls' ) ) )['reason'], 'validation: bogus secure → bad-secure' );

$store10b = new IWSL_Memory_Store();
$store10b->set( 'email_smtp_settings', iwsl_ed_valid_settings() );
$store10b->set( 'email_log', array( array( 'at' => 1, 'type' => 'sent', 'to' => array( 'k@x.test' ), 'subject' => 'S' ) ) );
$engine10b = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_stale, true, $ed_clock ), $store10b, $ed_clock, $ed_const_none );
$before_s  = $store10b->get( 'email_smtp_settings' );
$before_l  = $store10b->get( 'email_log' );
iwsl_assert_same( 'entitlement-locked', $engine10b->save_settings( array_merge( $good10, array( 'host' => 'evil.test' ) ) )['reason'], 'locked save: entitlement-locked' );
iwsl_assert_same( 'entitlement-locked', $engine10b->clear_log()['reason'], 'locked clear: entitlement-locked' );
iwsl_assert_same( $before_s, $store10b->get( 'email_smtp_settings' ), 'locked save: settings byte-identical before/after' );
iwsl_assert_same( $before_l, $store10b->get( 'email_log' ), 'locked clear: log byte-identical before/after' );

// ── 11. The secret appears nowhere — full flow with an opted-in DB password ───

$secret11 = 'db-stored-pw-xyz';
$store11  = new IWSL_Memory_Store();
$engine11 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store11, $ed_clock, $ed_const_none );
$engine11->save_settings(
	array(
		'host'                  => 'smtp.example.test',
		'port'                  => 465,
		'secure'                => 'ssl',
		'auth'                  => true,
		'username'              => 'u',
		'password'              => $secret11,
		'allow_option_password' => true,
	)
);
// Even if a caller leaks the secret into a subject or a failure message, the
// append-time scrub redacts it out of the stored log.
$engine11->capture_mail( array( 'to' => 'a@x.test', 'subject' => 'Hi ' . $secret11 ) );
$engine11->capture_failure( new IWSL_ED_WP_Error_Stub( 'auth failed pw=' . $secret11, array( 'to' => 'a@x.test', 'subject' => 'S' ) ) );
iwsl_assert( false === strpos( (string) json_encode( $store11->get( 'email_log' ) ), $secret11 ), 'secret never anywhere: absent from the entire log store' );
iwsl_assert( false === strpos( (string) json_encode( $engine11->settings_for_render() ), $secret11 ), 'secret never anywhere: absent from settings_for_render output' );
iwsl_assert_same( 'option', $engine11->settings_for_render()['password_source'], 'secret never anywhere: password_source reported as option' );

// ── 12. Transport registry sanity ─────────────────────────────────────────────

$transports = IWSL_Email_Delivery::transports();
iwsl_assert( array_key_exists( 'smtp', $transports ), 'registry: smtp transport is registered' );
iwsl_assert( $transports['smtp'] instanceof IWSL_Mail_Transport, 'registry: entry implements IWSL_Mail_Transport' );
iwsl_assert_same( 'smtp', $transports['smtp']->id(), 'registry: smtp id is stable' );
$avail12 = $transports['smtp']->availability();
iwsl_assert_same( true, $avail12['ok'], 'registry: smtp availability ok (in-process)' );

// ── 13. At-rest encryption round-trip — ciphertext in the store, plaintext in use ─

$secret13 = 'pla1n-smtp-secret-!@#';
$store13  = new IWSL_Memory_Store();
$engine13 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store13, $ed_clock, $ed_const_none );
$save13   = $engine13->save_settings( iwsl_ed_valid_settings( true, '' ) + array( 'password' => $secret13 ) );
iwsl_assert_same( true, $save13['ok'], 'encryption: opted-in save with a password succeeds' );

$blob13 = $store13->get( 'email_smtp_settings' )['password'];
iwsl_assert( is_string( $blob13 ) && 0 === strpos( $blob13, IWSL_Email_Delivery::ENC_MARKER ), 'encryption: stored secret carries the ciphertext marker' );
iwsl_assert( $blob13 !== $secret13, 'encryption: ciphertext differs from plaintext' );
iwsl_assert( false === strpos( (string) json_encode( $store13->get( 'email_smtp_settings' ) ), $secret13 ), 'encryption: plaintext absent from the entire stored settings option' );

// A fresh engine over the SAME store + salt decrypts it back for delivery.
$engine13b = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store13, $ed_clock, $ed_const_none );
$m13       = new IWSL_ED_Recording_PHPMailer();
$engine13b->configure_mailer( $m13 );
iwsl_assert_same( $secret13, $m13->Password, 'encryption: decrypts back to the exact plaintext for the mailer' );

// A DIFFERENT salt (wrong key) must NOT decrypt — fail closed to no usable secret.
$wrong_salt = static function (): string {
	return 'a-totally-different-salt-value-that-derives-another-key';
};
$engine13c  = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store13, $ed_clock, $ed_const_none, $wrong_salt );
$m13c       = new IWSL_ED_Recording_PHPMailer();
$engine13c->configure_mailer( $m13c );
iwsl_assert_same( '', $m13c->Password, 'encryption: wrong key fails authenticated decryption → no secret leaked' );

// ── 14. Legacy plaintext migration — read as-is, re-encrypt on next save ───────

$legacy14 = 'legacy-plaintext-pw';
$store14  = new IWSL_Memory_Store();
$store14->set( 'email_smtp_settings', iwsl_ed_valid_settings( true, $legacy14 ) ); // seeded WITHOUT marker.
$engine14 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store14, $ed_clock, $ed_const_none );

// Legacy value has no marker → used verbatim (keeps working).
$m14 = new IWSL_ED_Recording_PHPMailer();
$engine14->configure_mailer( $m14 );
iwsl_assert_same( $legacy14, $m14->Password, 'migration: legacy plaintext still delivers' );

// Re-save (blank submit keeps the secret) → it is now encrypted at rest.
$engine14->save_settings( iwsl_ed_valid_settings( true, '' ) + array( 'password' => '' ) );
$blob14 = $store14->get( 'email_smtp_settings' )['password'];
iwsl_assert( 0 === strpos( $blob14, IWSL_Email_Delivery::ENC_MARKER ), 'migration: legacy secret re-encrypted on next save' );
iwsl_assert( false === strpos( $blob14, $legacy14 ), 'migration: plaintext gone from the store after re-save' );
$m14b = new IWSL_ED_Recording_PHPMailer();
$engine14->configure_mailer( $m14b );
iwsl_assert_same( $legacy14, $m14b->Password, 'migration: re-encrypted secret still decrypts to the same plaintext' );

// ── 15. Fail closed when no key material is derivable ─────────────────────────

$empty_salt = static function (): string {
	return '';
};
$store15  = new IWSL_Memory_Store();
$engine15 = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store15, $ed_clock, $ed_const_none, $empty_salt );
$res15    = $engine15->save_settings( iwsl_ed_valid_settings( true, '' ) + array( 'password' => 'must-not-persist' ) );
iwsl_assert_same( 'password-encryption-unavailable', $res15['reason'], 'fail-closed: refuses to persist when no key can be derived' );
iwsl_assert( false === strpos( (string) json_encode( $store15->get( 'email_smtp_settings', array() ) ), 'must-not-persist' ), 'fail-closed: plaintext secret NEVER written' );

// ── 16. Log accuracy — single row per send; SMTP-vs-mail transport selection ──

// (a) NOT configured: capture_mail's optimistic "sent" is RETRACTED by the failure,
// leaving one honest "failed" (no confusing sent+failed pair, no opaque error).
$store16a  = new IWSL_Memory_Store(); // empty → not configured.
$engine16a = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store16a, $ed_clock, $ed_const_none );
$engine16a->capture_mail( array( 'to' => 'a@x.test', 'subject' => 'InfraWeaver SMTP test' ) );
$engine16a->capture_failure( new IWSL_ED_WP_Error_Stub( 'Could not instantiate mail function.', array( 'to' => 'a@x.test', 'subject' => 'InfraWeaver SMTP test' ) ) );
$log16a = $engine16a->log();
iwsl_assert_same( 1, count( $log16a ), 'log accuracy (unconfigured): exactly ONE entry, no phantom sent+failed pair' );
iwsl_assert_same( 'failed', $log16a[0]['type'], 'log accuracy (unconfigured): the single entry is the failure' );
iwsl_assert( false !== strpos( $log16a[0]['error'], 'not configured' ), 'log accuracy (unconfigured): honest actionable reason, not just the opaque PHPMailer string' );

// (b) CONFIGURED but the send fails: phantom "sent" still retracted; the REAL SMTP
// error is preserved (not overwritten by the unconfigured hint).
$store16b  = new IWSL_Memory_Store();
$engine16b = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store16b, $ed_clock, $ed_const_none );
$engine16b->save_settings( iwsl_ed_valid_settings() );
$engine16b->capture_mail( array( 'to' => 'b@x.test', 'subject' => 'Hi' ) );
$engine16b->capture_failure( new IWSL_ED_WP_Error_Stub( 'SMTP connect() failed.', array( 'to' => 'b@x.test', 'subject' => 'Hi' ) ) );
$log16b = $engine16b->log();
iwsl_assert_same( 1, count( $log16b ), 'log accuracy (configured-fail): one entry, phantom sent retracted' );
iwsl_assert( false !== strpos( $log16b[0]['error'], 'SMTP connect' ), 'log accuracy (configured-fail): real SMTP error preserved' );
iwsl_assert( false === strpos( $log16b[0]['error'], 'not configured' ), 'log accuracy (configured-fail): unconfigured hint NOT applied when configured' );

// (c) Configured + successful send: capture_mail alone → a single accurate "sent";
// and configure_mailer routes through SMTP (isSMTP set) so mail() is never reached.
$store16c  = new IWSL_Memory_Store();
$engine16c = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store16c, $ed_clock, $ed_const_none );
$engine16c->save_settings( iwsl_ed_valid_settings() );
$m16c = new IWSL_ED_Recording_PHPMailer();
$engine16c->configure_mailer( $m16c );
iwsl_assert_same( 1, $m16c->is_smtp_called, 'transport selection: enabled+configured → isSMTP (never PHP mail())' );
$engine16c->capture_mail( array( 'to' => 'c@x.test', 'subject' => 'Delivered' ) );
$log16c = $engine16c->log();
iwsl_assert_same( 1, count( $log16c ), 'log accuracy (success): a delivered send is a single "sent" row' );
iwsl_assert_same( 'sent', $log16c[0]['type'], 'log accuracy (success): recorded as sent' );

// (d) Ordering robustness: a prior SUCCESS is not clobbered by a LATER unrelated
// failure — capture_mail always re-arms the retraction target.
$store16d  = new IWSL_Memory_Store();
$engine16d = iwsl_ed_engine( iwsl_ed_entitlements( 'active', $ed_fresh, true, $ed_clock ), $store16d, $ed_clock, $ed_const_none );
$engine16d->save_settings( iwsl_ed_valid_settings() );
$engine16d->capture_mail( array( 'to' => 'ok@x.test', 'subject' => 'Success' ) );          // success, no failure.
$engine16d->capture_mail( array( 'to' => 'bad@x.test', 'subject' => 'Fails' ) );            // next send…
$engine16d->capture_failure( new IWSL_ED_WP_Error_Stub( 'SMTP error', array( 'to' => 'bad@x.test', 'subject' => 'Fails' ) ) ); // …fails.
$log16d = $engine16d->log();
iwsl_assert_same( 2, count( $log16d ), 'ordering: success kept + failure recorded = two rows' );
iwsl_assert_same( 'sent', $log16d[0]['type'], 'ordering: the earlier success survives' );
iwsl_assert_same( 'Success', $log16d[0]['subject'], 'ordering: earlier success is the right row' );
iwsl_assert_same( 'failed', $log16d[1]['type'], 'ordering: the later send is the failure' );
iwsl_assert_same( 'Fails', $log16d[1]['subject'], 'ordering: failure is the right row' );
