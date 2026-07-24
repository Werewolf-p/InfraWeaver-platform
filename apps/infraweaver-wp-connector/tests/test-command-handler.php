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

// ── (e) Performance & cache signed methods (perf.*/cache.*) ────────────────────

$perf_methods = array( 'perf.status', 'perf.audit', 'cache.purge', 'cache.warm', 'cache.configure', 'perf.settings.set' );
$allowed      = IWSL_Plugin::allowed_methods();
foreach ( $perf_methods as $pm ) {
	iwsl_assert( isset( $registry[ $pm ] ), "(e) {$pm} registered in the command registry" );
	iwsl_assert( array_key_exists( $pm, $allowed ), "(e) {$pm} present in the verifier allow-list (one source of truth)" );
}

/** Build a bare envelope carrying params (the runners read $envelope->params). */
$perf_env = static function ( array $params = array() ): stdClass {
	$env         = new stdClass();
	$env->params = (object) $params;
	return $env;
};

list( , $plugin ) = $fresh_plugin();

// perf.status — one read-only composite carrying all four zones.
list( $ok, $status ) = $registry['perf.status']->run( $plugin, $perf_env() );
iwsl_assert_same( true, $ok, '(e) perf.status: ok' );
iwsl_assert( isset( $status['page_cache'], $status['speed_pack'], $status['lazy_load'], $status['audit'] ), '(e) perf.status: composite carries page_cache + speed_pack + lazy_load + audit in one round-trip' );
iwsl_assert( isset( $status['page_cache']['hit_rate'], $status['page_cache']['entries'] ), '(e) perf.status: page_cache zone carries hit-rate + counters' );
iwsl_assert( isset( $status['speed_pack']['settings'], $status['speed_pack']['status'] ), '(e) perf.status: speed_pack zone carries settings + status' );
iwsl_assert( isset( $status['audit']['avg_ms'], $status['audit']['total_samples'] ), '(e) perf.status: audit roll-up present' );

// perf.audit — FREE, read-only; row cap enforced by the validator.
list( $ok, $report ) = $registry['perf.audit']->run( $plugin, $perf_env( array( 'rows' => 5 ) ) );
iwsl_assert_same( true, $ok, '(e) perf.audit: ok' );
iwsl_assert( isset( $report['items'] ) && is_array( $report['items'] ), '(e) perf.audit: returns the build_report items array' );
iwsl_assert_same( true, (bool) $allowed['perf.audit']( (object) array( 'rows' => 25 ) ), '(e) perf.audit validator: rows=25 accepted' );
iwsl_assert_same( false, (bool) $allowed['perf.audit']( (object) array( 'rows' => 26 ) ), '(e) perf.audit validator: rows>25 rejected' );
iwsl_assert_same( true, (bool) $allowed['perf.audit']( (object) array() ), '(e) perf.audit validator: empty params accepted (rows optional)' );
iwsl_assert_same( false, (bool) $allowed['perf.audit']( (object) array( 'rows' => 5, 'x' => 1 ) ), '(e) perf.audit validator: unknown key rejected' );

// cache.purge — {scope:all} read-safe; validator strict on scope/paths.
list( $ok, $purge ) = $registry['cache.purge']->run( $plugin, $perf_env( array( 'scope' => 'all' ) ) );
iwsl_assert_same( true, $ok, '(e) cache.purge: ok' );
iwsl_assert( array_key_exists( 'purged', $purge ) && is_int( $purge['purged'] ), '(e) cache.purge: returns { purged:int }' );
iwsl_assert_same( true, (bool) $allowed['cache.purge']( (object) array( 'scope' => 'all' ) ), '(e) cache.purge validator: {scope:all} accepted' );
iwsl_assert_same( true, (bool) $allowed['cache.purge']( (object) array( 'scope' => 'paths', 'paths' => array( '/a', '/b' ) ) ), '(e) cache.purge validator: {scope:paths,paths[]} accepted' );
iwsl_assert_same( false, (bool) $allowed['cache.purge']( (object) array( 'scope' => 'all', 'paths' => array( '/a' ) ) ), '(e) cache.purge validator: stray paths with scope=all rejected' );
iwsl_assert_same( false, (bool) $allowed['cache.purge']( (object) array( 'scope' => 'paths', 'paths' => array() ) ), '(e) cache.purge validator: empty paths rejected' );
$pc_too_many = array();
for ( $pc_i = 0; $pc_i < 51; $pc_i++ ) {
	$pc_too_many[] = '/p' . $pc_i;
}
iwsl_assert_same( false, (bool) $allowed['cache.purge']( (object) array( 'scope' => 'paths', 'paths' => $pc_too_many ) ), '(e) cache.purge validator: >50 paths rejected' );

// cache.warm — entitlement-gated: an un-entitled site cannot warm (refused connector-side).
list( $ok, $warm ) = $registry['cache.warm']->run( $plugin, $perf_env() );
iwsl_assert_same( true, $ok, '(e) cache.warm: rpc ok (result carries the gate verdict)' );
iwsl_assert_same( 'entitlement-locked', $warm['reason'], '(e) cache.warm: an un-entitled site is refused (page_cache-gated)' );
iwsl_assert_same( true, $warm['locked'], '(e) cache.warm: locked flag set for the console' );
iwsl_assert_same( true, (bool) $allowed['cache.warm']( (object) array() ), '(e) cache.warm validator: empty params accepted (audit-fed default set)' );
iwsl_assert_same( false, (bool) $allowed['cache.warm']( (object) array( 'limit' => 99 ) ), '(e) cache.warm validator: limit>25 rejected' );
iwsl_assert_same( false, (bool) $allowed['cache.warm']( (object) array( 'foo' => 1 ) ), '(e) cache.warm validator: unknown key rejected' );

// cache.configure — enable is refused connector-side on a Basic store regardless of input.
list( $ok, $conf ) = $registry['cache.configure']->run( $plugin, $perf_env( array( 'enabled' => true, 'ttl' => 1800 ) ) );
iwsl_assert_same( true, $ok, '(e) cache.configure: rpc ok' );
iwsl_assert_same( false, $conf['ok'], '(e) cache.configure: enable refused for an un-entitled site' );
iwsl_assert_same( 'entitlement-locked', $conf['reason'], '(e) cache.configure: entitlement-locked (STATEMENT 1 inside enable)' );
iwsl_assert_same( true, $conf['locked'], '(e) cache.configure: locked flag set' );
iwsl_assert_same( false, (bool) $allowed['cache.configure']( (object) array( 'ttl' => 59 ) ), '(e) cache.configure validator: ttl below range rejected' );
iwsl_assert_same( false, (bool) $allowed['cache.configure']( (object) array() ), '(e) cache.configure validator: empty params rejected (must set something)' );
iwsl_assert_same( false, (bool) $allowed['cache.configure']( (object) array( 'nope' => 1 ) ), '(e) cache.configure validator: unknown key rejected' );

// perf.settings.set — the signed channel may not switch ON an un-granted tier feature.
list( $ok, $set ) = $registry['perf.settings.set']->run( $plugin, $perf_env( array( 'lazy_load' => (object) array( 'enabled' => true ) ) ) );
iwsl_assert_same( true, $ok, '(e) perf.settings.set: rpc ok' );
iwsl_assert_same( 'entitlement-locked', $set['lazy_load']['reason'], '(e) perf.settings.set: lazy-load save refused for an un-entitled site (no tier widening)' );
iwsl_assert_same( true, $set['lazy_load']['locked'], '(e) perf.settings.set: locked flag set' );
iwsl_assert_same( false, (bool) $allowed['perf.settings.set']( (object) array( 'lazy_load' => (object) array( 'bogus' => 1 ) ) ), '(e) perf.settings.set validator: unknown lazy_load key rejected' );
iwsl_assert_same( false, (bool) $allowed['perf.settings.set']( (object) array( 'speed_pack' => (object) array( 'evil' => 1 ) ) ), '(e) perf.settings.set validator: unknown speed_pack key rejected' );
iwsl_assert_same( true, (bool) $allowed['perf.settings.set']( (object) array( 'speed_pack' => (object) array( 'minify_html' => true ) ) ), '(e) perf.settings.set validator: known speed_pack key accepted' );
