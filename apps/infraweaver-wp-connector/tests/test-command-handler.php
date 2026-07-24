<?php
/**
 * IWSL_Command_Handler::run() — the signed-envelope RPC dispatch step (§7/§8).
 *
 * GAP: run() had no executed test — only its registration map was reflected in
 * test-purge. This suite drives it end-to-end through IWSL_Plugin::handle_command
 * (verify → route → run → sign) with the fixtures, and also calls run() directly
 * to pin its [ok, result] contract, covering:
 *   (a) a validly-signed envelope routes to the correct handler and returns its result;
 *   (b) a tampered/invalid-signature envelope is rejected with no handler side effect;
 *   (c) an unknown/unregistered command errors cleanly;
 *   (d) an entitlement-gated command runner refuses when the entitlement is absent.
 */

$f = iwsl_fixtures();

// Reach the private registry the plugin builds its run() closures into (§7 single
// source of truth). Static → returns a fresh map on each call; the runners are
// stateless and take the plugin as an argument, so one map drives any plugin.
$handlers_ref = new ReflectionMethod( 'IWSL_Plugin', 'command_handlers' );
$handlers_ref->setAccessible( true );
$registry = $handlers_ref->invoke( null );

/** A freshly enrolled (pending) plugin, ready to dispatch its first command. */
$fresh_plugin = static function () use ( $f ): array {
	$store  = new IWSL_Memory_Store();
	$plugin = new IWSL_Plugin( $store, iwsl_now_t0( 5000 ) );
	$plugin->enrollment()->handle_bundle( iwsl_clone( $f->enrollment->signed ) );
	return array( $store, $plugin );
};

// (a) VALID: a dual-signed command routes to its handler and its result comes back.
list( $store, $plugin ) = $fresh_plugin();
$handled = $plugin->handle_command( iwsl_clone( $f->commands->valid ) );
iwsl_assert_same( 200, $handled['status'], '(a) valid signed command dispatched (200)' );
$result = $handled['body']['envelope']['result'];
iwsl_assert_same( 'ok', $result['status'], '(a) routed to health.check — its status result returned' );
iwsl_assert( isset( $result['php'] ) && isset( $result['kid'] ), '(a) result is health.check-shaped (correct handler, not another)' );
iwsl_assert_same( 'active', $store->get( 'state' ), '(a) dispatching the first command activated the link' );

// (a') run() directly: the same handler returns the [ok=true, result] tuple.
list( $ok, $direct ) = $registry['health.check']->run( $plugin, iwsl_clone( $f->commands->valid )->envelope );
iwsl_assert_same( true, $ok, '(a) run(): health.check returns ok=true' );
iwsl_assert_same( 'ok', $direct['status'], '(a) run(): health.check returns its status result' );

// (b) TAMPERED: signature broken → verify-before-act rejects; the handler never
//     runs and no replay state is committed (the run() closure is not reached).
list( $store, $plugin ) = $fresh_plugin();
$tampered = iwsl_clone( $f->commands->valid );
$tampered->envelope->params->x = 1; // breaks both signatures
$rejected = $plugin->handle_command( $tampered );
iwsl_assert_same( 403, $rejected['status'], '(b) tampered command rejected (403)' );
iwsl_assert_same( 'pending', $store->get( 'state' ), '(b) no handler ran — link still pending (not activated)' );
iwsl_assert_same( 0, (int) $store->get( 'last_seq', 0 ), '(b) no seq committed (run() never reached)' );

// (c) UNKNOWN: a method outside the allow-list errors cleanly at the verifier —
//     dispatch never reaches a runner, and the registry has no such handler.
list( $store, $plugin ) = $fresh_plugin();
$plugin->handle_command( iwsl_clone( $f->commands->valid ) ); // activate first
$unknown = $plugin->handle_command( iwsl_clone( $f->commands->unknownMethod ) );
iwsl_assert_same( 403, $unknown['status'], '(c) unknown command rejected cleanly (403)' );
iwsl_assert_same( 'unknown-method', $unknown['body']['reason'], '(c) reason: unknown-method' );
iwsl_assert( ! isset( $registry['no.such.method'] ), '(c) the unregistered method is absent from the registry' );

// (d) ENTITLEMENT-GATED: no command in the shipped registry gates DISPATCH on an
//     entitlement (entitlements.set WRITES the flag map; the read-side gate lives
//     in IWSL_Entitlements, consulted by client features, not by a runner). So
//     drive IWSL_Command_Handler::run() directly with a gated runner over the
//     plugin's REAL entitlement surface — the run() contract (plugin-context
//     threading + refusal semantics) under a feature gate, not a fabricated pass.
$gated = new IWSL_Command_Handler(
	'plus.only.demo',
	static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
		if ( ! $plugin->entitlements()->has( 'plus' ) ) {
			return array( false, array( 'reason' => 'requires-plus' ) );
		}
		return array( true, array( 'ran' => true ) );
	}
);

list( $store, $plugin ) = $fresh_plugin();
list( $ok_absent, $res_absent ) = $gated->run( $plugin, new stdClass() );
iwsl_assert_same( false, $ok_absent, '(d) gated command refused when the entitlement is absent' );
iwsl_assert_same( 'requires-plus', $res_absent['reason'], '(d) refusal reason surfaced' );
iwsl_assert( ! $store->get( 'entitlements' ), '(d) refusal is side-effect free (the site cannot self-grant)' );

// Grant the flag through the REAL signed entitlements.set runner (its run()
// closure) — the only path that writes the console-authoritative map — then the
// same gated command runs.
$set_env                       = new stdClass();
$set_env->params               = new stdClass();
$set_env->params->entitlements = (object) array( 'plus' => true );
list( $set_ok, $set_res ) = $registry['entitlements.set']->run( $plugin, $set_env );
iwsl_assert_same( true, $set_ok, '(d) entitlements.set run() applies the console grant' );
iwsl_assert_same( true, $set_res['entitlements']['plus'], '(d) plus flag stored by the set runner' );

list( $ok_present, $res_present ) = $gated->run( $plugin, new stdClass() );
iwsl_assert_same( true, $ok_present, '(d) same gated command runs once the entitlement is present' );
iwsl_assert_same( true, $res_present['ran'], '(d) gated runner result returned' );

// ── EMAIL signed methods (email.config.get/set, email.test, email.log.get/clear) ──
// Thin shims over IWSL_Email_Delivery, driven through run() directly (the fixtures
// carry no email envelopes). A recording wp_mail lets email.test's default mailer
// wrapper complete; this stub is subprocess-isolated to this suite.
// WP secret salts for the engine's default (non-injected) at-rest-encryption key —
// without them the fail-closed crypto refuses to persist the SMTP secret. Subprocess-
// isolated to this suite, so it never leaks into another.
defined( 'AUTH_KEY' ) || define( 'AUTH_KEY', 'iwsl-cmd-suite-auth-key-material-0123456789abcdef' );
defined( 'SECURE_AUTH_KEY' ) || define( 'SECURE_AUTH_KEY', 'iwsl-cmd-suite-secure-auth-key-material-fedcba9876543210' );
$GLOBALS['iwsl_ch_wpmail'] = array();
if ( ! function_exists( 'wp_mail' ) ) {
	function wp_mail( $to, $subject, $message, $headers = '', $attachments = array() ) {
		$GLOBALS['iwsl_ch_wpmail'][] = array( 'to' => $to, 'subject' => $subject );
		return true;
	}
}

$empty_env         = new stdClass();
$empty_env->params = new stdClass();

/** An enrolled+active plugin with a fresh heartbeat and email_delivery granted (gate UNLOCKED). */
$email_ready_plugin = static function () use ( $registry ): array {
	$store  = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$plugin = new IWSL_Plugin( $store, iwsl_now_t0( 5000 ) );
	$plugin->entitlements()->record_verified_contact(); // fresh heartbeat on the plugin clock.
	$set_env                       = new stdClass();
	$set_env->params               = new stdClass();
	$set_env->params->entitlements = (object) array( 'email_delivery' => true );
	$registry['entitlements.set']->run( $plugin, $set_env );
	return array( $store, $plugin );
};

// Presence: all five email methods are in the derived verifier allow-list.
$allowed_email = IWSL_Plugin::allowed_methods();
foreach ( array( 'email.config.get', 'email.config.set', 'email.test', 'email.log.get', 'email.log.clear' ) as $m ) {
	iwsl_assert( array_key_exists( $m, $allowed_email ), "email registry: {$m} is an allowed signed method" );
}

// ── validators ────────────────────────────────────────────────────────────────
$cfg_set_validator  = $registry['email.config.set']->validator;
$test_validator     = $registry['email.test']->validator;
$valid_settings_obj = (object) array(
	'host'                  => 'smtp.example.test',
	'port'                  => 587,
	'auth'                  => true,
	'username'              => 'u@example.test',
	'from_email'            => 'from@example.test',
	'from_name'             => 'Sender',
	'secure'                => 'tls',
	'allow_option_password' => false,
);

iwsl_assert_same( true, $cfg_set_validator( (object) array( 'settings' => $valid_settings_obj, 'password' => 's3cr3t' ) ), 'config.set validator: well-formed params accepted' );
iwsl_assert_same( true, $cfg_set_validator( (object) array( 'settings' => $valid_settings_obj ) ), 'config.set validator: password optional' );
iwsl_assert_same( true, $cfg_set_validator( (object) array( 'settings' => $valid_settings_obj, 'clear_password' => true ) ), 'config.set validator: clear_password accepted' );
iwsl_assert_same( false, $cfg_set_validator( (object) array( 'settings' => $valid_settings_obj, 'evil' => 1 ) ), 'config.set validator: unknown top-level key rejected' );
$bad_extra = clone $valid_settings_obj;
$bad_extra->extra = 1;
iwsl_assert_same( false, $cfg_set_validator( (object) array( 'settings' => $bad_extra ) ), 'config.set validator: unknown settings key rejected' );
$bad_missing = clone $valid_settings_obj;
unset( $bad_missing->secure );
iwsl_assert_same( false, $cfg_set_validator( (object) array( 'settings' => $bad_missing ) ), 'config.set validator: missing settings key rejected' );
$bad_crlf = clone $valid_settings_obj;
$bad_crlf->host = "smtp.test\r\nEVIL";
iwsl_assert_same( false, $cfg_set_validator( (object) array( 'settings' => $bad_crlf ) ), 'config.set validator: CRLF host rejected' );
$bad_port = clone $valid_settings_obj;
$bad_port->port = '587';
iwsl_assert_same( false, $cfg_set_validator( (object) array( 'settings' => $bad_port ) ), 'config.set validator: non-int port rejected' );
$bad_auth = clone $valid_settings_obj;
$bad_auth->auth = 1;
iwsl_assert_same( false, $cfg_set_validator( (object) array( 'settings' => $bad_auth ) ), 'config.set validator: non-bool auth rejected' );
iwsl_assert_same( false, $cfg_set_validator( (object) array( 'settings' => $valid_settings_obj, 'password' => "a\r\nb" ) ), 'config.set validator: CRLF password rejected' );
iwsl_assert_same( false, $cfg_set_validator( (object) array( 'settings' => 'nope' ) ), 'config.set validator: non-object settings rejected' );

iwsl_assert_same( true, $test_validator( (object) array( 'to' => 'ops@example.test' ) ), 'test validator: { to } accepted' );
iwsl_assert_same( false, $test_validator( (object) array( 'to' => '' ) ), 'test validator: empty to rejected' );
iwsl_assert_same( false, $test_validator( (object) array( 'to' => "a@b.test\r\nx" ) ), 'test validator: CRLF to rejected' );
iwsl_assert_same( false, $test_validator( (object) array( 'to' => 'a@b.test', 'extra' => 1 ) ), 'test validator: unknown key rejected' );

iwsl_assert_same( null, $allowed_email['email.config.get'], 'config.get: null validator (empty params)' );
iwsl_assert_same( null, $allowed_email['email.log.get'], 'log.get: null validator (empty params)' );
iwsl_assert_same( null, $allowed_email['email.log.clear'], 'log.clear: null validator (empty params)' );

// ── config.get (unlocked): snapshot + switch_on, no secret ──────────────────────
list( $store_e, $plugin_e ) = $email_ready_plugin();
list( $ok_g, $get_res ) = $registry['email.config.get']->run( $plugin_e, $empty_env );
iwsl_assert_same( true, $ok_g, 'email.config.get: ok' );
iwsl_assert_same( false, $get_res['locked'], 'email.config.get: unlocked when entitled+fresh' );
iwsl_assert_same( true, $get_res['switch_on'], 'email.config.get: default switch reported on' );

// ── config.set + NAMED dispatch-redaction invariant ─────────────────────────────
$wire_secret           = 'WIRE-ONLY-SECRET-abc123';
$set_email_env         = new stdClass();
$set_email_env->params = (object) array(
	'settings' => (object) array(
		'host'                  => 'smtp.example.test',
		'port'                  => 587,
		'auth'                  => true,
		'username'              => 'mailer@example.test',
		'from_email'            => 'noreply@example.test',
		'from_name'             => 'Shop',
		'secure'                => 'tls',
		'allow_option_password' => true,
	),
	'password' => $wire_secret,
);
list( $ok_s, $set_res ) = $registry['email.config.set']->run( $plugin_e, $set_email_env );
iwsl_assert_same( true, $ok_s, 'email.config.set: command handled' );
iwsl_assert_same( true, $set_res['ok'], 'email.config.set: save ok' );
iwsl_assert( ! isset( $set_res['settings']['password'] ), 'email.config.set: result settings carry NO password key' );
iwsl_assert( false === strpos( (string) json_encode( $set_res ), $wire_secret ), 'email.config.set: plaintext secret NEVER in the response' );

// NAMED: the write-only secret appears NOWHERE plaintext on the connector.
$store_json = (string) json_encode(
	array(
		'settings' => $store_e->get( 'email_smtp_settings', array() ),
		'log'      => $store_e->get( 'email_log', array() ),
	)
);
iwsl_assert( false === strpos( $store_json, $wire_secret ), 'DISPATCH REDACTION: plaintext SMTP secret absent from the entire connector store (settings + log)' );
$stored_pw = $store_e->get( 'email_smtp_settings' )['password'];
iwsl_assert( is_string( $stored_pw ) && 0 === strpos( $stored_pw, IWSL_Email_Delivery::ENC_MARKER ), 'DISPATCH REDACTION: stored secret is AES-256-GCM ciphertext (marker), never plaintext' );

list( , $get_after ) = $registry['email.config.get']->run( $plugin_e, $empty_env );
iwsl_assert_same( true, $get_after['has_password'], 'email.config.get: has_password true after set' );
iwsl_assert_same( 'option', $get_after['password_source'], 'email.config.get: password_source=option after opted-in set' );
iwsl_assert( false === strpos( (string) json_encode( $get_after ), $wire_secret ), 'email.config.get: secret NEVER returned on read-back' );

// ── email.test: send + switch_on + rate limit ───────────────────────────────────
$test_env         = new stdClass();
$test_env->params = (object) array( 'to' => 'ops@example.test' );
$GLOBALS['iwsl_ch_wpmail'] = array();
list( $ok_t, $test_res ) = $registry['email.test']->run( $plugin_e, $test_env );
iwsl_assert_same( true, $ok_t, 'email.test: command handled' );
iwsl_assert_same( true, $test_res['sent'], 'email.test: sent via wp_mail' );
iwsl_assert_same( true, $test_res['switch_on'], 'email.test: switch_on true' );
iwsl_assert_same( 1, count( $GLOBALS['iwsl_ch_wpmail'] ), 'email.test: exactly one wp_mail send' );
list( , $test_res2 ) = $registry['email.test']->run( $plugin_e, $test_env );
iwsl_assert_same( false, $test_res2['sent'], 'email.test: second immediate call throttled' );
iwsl_assert_same( 'rate-limited', $test_res2['reason'], 'email.test: rate-limited reason' );
iwsl_assert_same( 1, count( $GLOBALS['iwsl_ch_wpmail'] ), 'email.test: throttled call did not send again' );

// ── email.test: kill-switch off → honest report, NO send ────────────────────────
list( $store_off, $plugin_off ) = $email_ready_plugin();
$plugin_off->email_switches()->set( IWSL_Email_Delivery::FEATURE, false );
$GLOBALS['iwsl_ch_wpmail'] = array();
list( , $off_res ) = $registry['email.test']->run( $plugin_off, $test_env );
iwsl_assert_same( 'delivery-switch-off', $off_res['reason'], 'email.test: switch off → delivery-switch-off (no misleading result)' );
iwsl_assert_same( false, $off_res['switch_on'], 'email.test: switch_on false reported' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_ch_wpmail'] ), 'email.test: switch off → NO send attempted' );
list( , $off_get ) = $registry['email.config.get']->run( $plugin_off, $empty_env );
iwsl_assert_same( false, $off_get['switch_on'], 'email.config.get: reflects the operator switch (off)' );

// ── log.get / log.clear round-trip ──────────────────────────────────────────────
list( $store_l, $plugin_l ) = $email_ready_plugin();
$plugin_l->email_delivery()->capture_mail( array( 'to' => 'cust@example.test', 'subject' => 'Order #1' ) );
list( , $log_res ) = $registry['email.log.get']->run( $plugin_l, $empty_env );
iwsl_assert_same( 1, $log_res['count'], 'email.log.get: count reflects the log' );
iwsl_assert_same( 'Order #1', $log_res['entries'][0]['subject'], 'email.log.get: entry returned' );
list( , $clr_res ) = $registry['email.log.clear']->run( $plugin_l, $empty_env );
iwsl_assert_same( true, $clr_res['ok'], 'email.log.clear: ok' );
iwsl_assert_same( true, $clr_res['cleared'], 'email.log.clear: cleared flag' );
list( , $log_after ) = $registry['email.log.get']->run( $plugin_l, $empty_env );
iwsl_assert_same( 0, $log_after['count'], 'email.log.clear: log empty after clear' );

// ── LOCKED state across every method (active but flag absent → gate closed) ──────
$locked_store = new IWSL_Memory_Store();
$locked_store->set( 'state', 'active' );
$locked_plugin = new IWSL_Plugin( $locked_store, iwsl_now_t0( 5000 ) );
$locked_plugin->entitlements()->record_verified_contact();

list( , $lg ) = $registry['email.config.get']->run( $locked_plugin, $empty_env );
iwsl_assert_same( true, $lg['locked'], 'locked email.config.get: locked=true' );
iwsl_assert( ! array_key_exists( 'settings', $lg ), 'locked email.config.get: no settings leaked' );

$lset         = new stdClass();
$lset->params = (object) array( 'settings' => $valid_settings_obj );
list( , $ls ) = $registry['email.config.set']->run( $locked_plugin, $lset );
iwsl_assert_same( false, $ls['ok'], 'locked email.config.set: ok=false' );
iwsl_assert_same( 'entitlement-locked', $ls['reason'], 'locked email.config.set: entitlement-locked' );

list( , $lt ) = $registry['email.test']->run( $locked_plugin, $test_env );
iwsl_assert_same( 'entitlement-locked', $lt['reason'], 'locked email.test: entitlement-locked' );
iwsl_assert_same( false, $lt['sent'], 'locked email.test: sent=false' );

list( , $llg ) = $registry['email.log.get']->run( $locked_plugin, $empty_env );
iwsl_assert_same( true, $llg['locked'], 'locked email.log.get: locked=true' );
iwsl_assert_same( 0, $llg['count'], 'locked email.log.get: no entries' );

list( , $llc ) = $registry['email.log.clear']->run( $locked_plugin, $empty_env );
iwsl_assert_same( false, $llc['ok'], 'locked email.log.clear: ok=false' );
