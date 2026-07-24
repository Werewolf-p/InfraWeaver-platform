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

// ── (e) Site Health signed methods: allow-list, validators, gate, refusal tokens ─
//
// The runners bypass the wire (like (d)) and are driven directly against a plugin
// over a store seeded active + fresh + granted. Authorization is proven to live in
// the ENGINE: a locked flag surfaces the engine's own refusal / locked marker, and
// the redirect gauntlet's tokens pass through verbatim.

$SH_METHODS = array(
	'sitehealth.snapshot',
	'links.scan',
	'redirects.list',
	'redirects.create',
	'redirects.delete',
	'redirects.import',
	'redirects.set_toggles',
	'maintenance.set',
);
$allowed = IWSL_Plugin::allowed_methods();
foreach ( $SH_METHODS as $m ) {
	iwsl_assert( array_key_exists( $m, $allowed ), "(e) allow-list contains {$m}" );
}
// Empty-params methods use a null validator (verifier requires empty params).
iwsl_assert_same( null, $allowed['sitehealth.snapshot'], '(e) sitehealth.snapshot requires empty params (null validator)' );
iwsl_assert_same( null, $allowed['redirects.list'], '(e) redirects.list requires empty params (null validator)' );

// Validator shape checks (called directly off the registry).
$create_v = $registry['redirects.create']->validator;
iwsl_assert( (bool) $create_v( (object) array( 'source' => '/a', 'target' => '/b', 'type' => 301 ) ), '(e) create validator: accepts a valid shape' );
iwsl_assert( (bool) $create_v( (object) array( 'source' => '/a', 'target' => '/b', 'type' => 301, 'match' => 'prefix' ) ), '(e) create validator: accepts an optional match' );
iwsl_assert( ! (bool) $create_v( (object) array( 'source' => '/a', 'target' => '/b', 'type' => 301, 'x' => 1 ) ), '(e) create validator: rejects a stray field' );
iwsl_assert( ! (bool) $create_v( (object) array( 'source' => '/a', 'target' => '/b' ) ), '(e) create validator: rejects a missing type' );
iwsl_assert( ! (bool) $create_v( (object) array( 'source' => '/a', 'target' => '/b', 'type' => '301' ) ), '(e) create validator: rejects a non-int type' );

$scan_v = $registry['links.scan']->validator;
iwsl_assert( (bool) $scan_v( new stdClass() ), '(e) scan validator: accepts empty params' );
iwsl_assert( (bool) $scan_v( (object) array( 'budget_ms' => 8000 ) ), '(e) scan validator: accepts an int budget_ms' );
iwsl_assert( ! (bool) $scan_v( (object) array( 'budget_ms' => '8000' ) ), '(e) scan validator: rejects a non-int budget_ms' );
iwsl_assert( ! (bool) $scan_v( (object) array( 'nope' => 1 ) ), '(e) scan validator: rejects a stray field' );

$del_v = $registry['redirects.delete']->validator;
iwsl_assert( (bool) $del_v( (object) array( 'id' => 'r' . substr( sha1( '/x' ), 0, 12 ) ) ), '(e) delete validator: accepts a well-formed id' );
iwsl_assert( ! (bool) $del_v( (object) array( 'id' => 'bogus' ) ), '(e) delete validator: rejects a malformed id' );

$imp_v = $registry['redirects.import']->validator;
$big   = array();
for ( $i = 0; $i < 51; $i++ ) {
	$big[] = (object) array( 'source' => '/s' . $i, 'target' => '/t' . $i, 'type' => 301 );
}
iwsl_assert( ! (bool) $imp_v( (object) array( 'rules' => $big ) ), '(e) import validator: rejects > 50 rows' );
iwsl_assert( (bool) $imp_v( (object) array( 'rules' => array( (object) array( 'source' => '/s', 'target' => '/t', 'type' => 301 ) ) ) ), '(e) import validator: accepts a valid row' );

$mnt_v = $registry['maintenance.set']->validator;
iwsl_assert( (bool) $mnt_v( (object) array( 'enabled' => true, 'allow_ips' => array( '1.2.3.4' ), 'until' => 5 ) ), '(e) maintenance validator: accepts a full shape' );
iwsl_assert( ! (bool) $mnt_v( (object) array( 'enabled' => 'yes' ) ), '(e) maintenance validator: rejects a non-bool enabled' );
iwsl_assert( ! (bool) $mnt_v( (object) array( 'enabled' => true, 'allow_ips' => array( 5 ) ) ), '(e) maintenance validator: rejects a non-string IP' );

/** A plugin over a store seeded active + fresh + a given entitlement set. */
$sh_plugin = static function ( array $flags ) : array {
	$now   = 60000000;
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 1000 ); // fresh
	$store->set( 'entitlements', $flags );
	$plugin = new IWSL_Plugin(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
	return array( $store, $plugin );
};
$env = static function ( array $params = array() ): stdClass {
	$e         = new stdClass();
	$e->params = (object) $params;
	return $e;
};

// LOCKED: the redirect gauntlet's gate surfaces over the wire runner.
list( $ls_store, $ls_plugin ) = $sh_plugin( array() );
list( , $locked_create ) = $registry['redirects.create']->run( $ls_plugin, $env( array( 'source' => '/old', 'target' => '/new', 'type' => 301 ) ) );
iwsl_assert_same( 'entitlement-locked', $locked_create['reason'], '(e) redirects.create refuses when the flag is locked (engine gate)' );
list( , $locked_list ) = $registry['redirects.list']->run( $ls_plugin, $env() );
iwsl_assert_same( true, $locked_list['locked'], '(e) redirects.list returns a locked marker when locked' );
list( , $locked_scan ) = $registry['links.scan']->run( $ls_plugin, $env() );
iwsl_assert_same( 'entitlement-locked', $locked_scan['reason'], '(e) links.scan refuses when locked' );
list( , $snap_locked ) = $registry['sitehealth.snapshot']->run( $ls_plugin, $env() );
iwsl_assert_same( false, $snap_locked['switches']['redirect_manager'], '(e) snapshot switches reflect the locked flag' );
iwsl_assert_same( true, $snap_locked['redirects']['locked'], '(e) snapshot redirects sub-section locked' );
iwsl_assert_same( true, $snap_locked['maintenance']['locked'], '(e) snapshot maintenance sub-section locked' );

// UNLOCKED: create succeeds; the gauntlet's refusal tokens pass through verbatim.
list( $u_store, $u_plugin ) = $sh_plugin( array( 'redirect_manager' => true ) );
list( , $created ) = $registry['redirects.create']->run( $u_plugin, $env( array( 'source' => '/old', 'target' => '/new', 'type' => 301 ) ) );
iwsl_assert_same( true, $created['ok'], '(e) redirects.create succeeds when unlocked' );
list( , $dup ) = $registry['redirects.create']->run( $u_plugin, $env( array( 'source' => '/old', 'target' => '/other', 'type' => 301 ) ) );
iwsl_assert_same( 'duplicate-source', $dup['reason'], '(e) redirects.create surfaces duplicate-source verbatim' );
$registry['redirects.create']->run( $u_plugin, $env( array( 'source' => '/b', 'target' => '/a', 'type' => 301 ) ) );
list( , $loop ) = $registry['redirects.create']->run( $u_plugin, $env( array( 'source' => '/a', 'target' => '/b', 'type' => 301 ) ) );
iwsl_assert_same( 'creates-redirect-loop', $loop['reason'], '(e) redirects.create surfaces creates-redirect-loop verbatim' );
list( , $badm ) = $registry['redirects.create']->run( $u_plugin, $env( array( 'source' => '/x', 'target' => '/y', 'type' => 301, 'match' => 'regex' ) ) );
iwsl_assert_same( 'bad-match', $badm['reason'], '(e) redirects.create refuses an unregistered match strategy' );
list( , $pfx ) = $registry['redirects.create']->run( $u_plugin, $env( array( 'source' => '/old-blog/*', 'target' => '/blog', 'type' => 301, 'match' => 'prefix' ) ) );
iwsl_assert_same( true, $pfx['ok'], '(e) redirects.create stores a prefix rule' );
iwsl_assert_same( 'prefix', $pfx['rule']['match'], '(e) prefix rule carries match=prefix' );

// redirects.list now reflects the created rules.
list( , $listing ) = $registry['redirects.list']->run( $u_plugin, $env() );
iwsl_assert_same( false, $listing['locked'], '(e) redirects.list unlocked' );
// Stored: /old, /b→/a, /old-blog/* — the /a→/b rule was refused (loop), never stored.
iwsl_assert_same( 3, count( $listing['rules'] ), '(e) redirects.list returns the three stored rules' );

// import: per-row through the gated add_rule; results carry per-row ok/reason.
list( , $imp ) = $registry['redirects.import']->run(
	$u_plugin,
	$env(
		array(
			'rules' => array(
				(object) array( 'source' => '/imp-ok', 'target' => '/dest', 'type' => 301 ),
				(object) array( 'source' => '/old', 'target' => '/z', 'type' => 301 ), // duplicate of an existing rule
			),
		)
	)
);
iwsl_assert_same( true, $imp['results'][0]['ok'], '(e) import: first row created' );
iwsl_assert_same( false, $imp['results'][1]['ok'], '(e) import: duplicate row refused' );
iwsl_assert_same( 'duplicate-source', $imp['results'][1]['reason'], '(e) import: refusal token per row' );

// set_toggles: reads back the toggled state.
list( , $tog ) = $registry['redirects.set_toggles']->run( $u_plugin, $env( array( 'log_404' => true, 'auto_slug' => false ) ) );
iwsl_assert_same( true, $tog['log_enabled'], '(e) set_toggles: 404 logging on' );
iwsl_assert_same( false, $tog['auto_slug'], '(e) set_toggles: auto-slug off' );

// maintenance.set: gated save stores the sanitized settings.
list( $m_store, $m_plugin ) = $sh_plugin( array( 'maintenance_mode' => true ) );
list( , $mnt ) = $registry['maintenance.set']->run( $m_plugin, $env( array( 'enabled' => true, 'headline' => 'Back soon', 'allow_ips' => array( '203.0.113.7', 'garbage' ) ) ) );
iwsl_assert_same( true, $mnt['ok'], '(e) maintenance.set saves when unlocked' );
iwsl_assert_same( true, $mnt['settings']['enabled'], '(e) maintenance.set stored enabled' );
iwsl_assert_same( array( '203.0.113.7' ), $mnt['settings']['allow_ips'], '(e) maintenance.set sanitized the allow-list (garbage dropped)' );
list( $ml_store, $ml_plugin ) = $sh_plugin( array() );
list( , $mnt_locked ) = $registry['maintenance.set']->run( $ml_plugin, $env( array( 'enabled' => true ) ) );
iwsl_assert_same( 'entitlement-locked', $mnt_locked['reason'], '(e) maintenance.set refuses when locked' );
