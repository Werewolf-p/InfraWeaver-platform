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
