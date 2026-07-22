<?php
/**
 * 301 Redirect Manager (gate flag `redirect_manager`): the generic engine
 * (IWSL_Redirects) + the exact-path matcher.
 *
 * Runs under the zero-dependency harness: IWSL_Redirects takes an in-memory
 * IWSL_Store, a fixed injected clock, an injected matcher registry (default),
 * an injected is_404 probe, an injected external allow-list, and a RECORDING
 * REDIRECTOR fake that appends (location,status) and does NOT exit. The gate
 * fixtures reuse the entitlement store so a single flip re-locks instantly.
 *
 * No WordPress url helpers are defined here, so the engine's LOCAL strict checks
 * (scheme / host / userinfo / CRLF / backslash / scheme-relative / external
 * allow-list) are authoritative — exactly as they are outside a full WP context.
 */

// ── recording redirector fake (records, never exits) ──────────────────────────

final class IWSL_Recording_Redirector {

	/** @var array<int, array{0:string,1:int}> */
	public $calls = array();

	public function __invoke( string $location, int $status ): void {
		$this->calls[] = array( $location, $status );
	}
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Seed a shared store as unlocked (active + fresh heartbeat + redirect_manager) and return the gate. */
function iwsl_rd_unlocked( IWSL_Store $store, int $now ): IWSL_Entitlements {
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 1000 ); // fresh
	$store->set( 'entitlements', array( 'redirect_manager' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** A valid-shaped stored rule (id derived exactly like the engine does). */
function iwsl_rd_make_rule( string $source, string $target, int $type = 301, int $hits = 0 ): array {
	$norm = IWSL_Redirects::normalize_path( $source );
	return array(
		'id'         => 'r' . substr( sha1( $norm ), 0, 12 ),
		'source'     => $norm,
		'target'     => $target,
		'type'       => $type,
		'hits'       => $hits,
		'external'   => false,
		'created_at' => 0,
	);
}

/** Build a redirects engine over $store with a recorder + injected is_404 / allow-list. */
function iwsl_rd_engine( IWSL_Store $store, int $now, IWSL_Recording_Redirector $rec, bool $is_404 = false, array $allow = array() ): IWSL_Redirects {
	return new IWSL_Redirects(
		iwsl_rd_unlocked( $store, $now ),
		$store,
		static function () use ( $now ): int {
			return $now;
		},
		null,
		null,
		$rec,
		static function () use ( $is_404 ): bool {
			return $is_404;
		},
		$allow
	);
}

$RD_NOW = 20000000;

// ── 1. Locked: flag missing → no redirect, apply() reports entitlement-locked ──

$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $RD_NOW - 1000 );
$store->set( 'entitlements', array( 'plus' => true ) ); // redirect_manager ABSENT
$store->set( 'redirect_rules', array( iwsl_rd_make_rule( '/old-page', '/new-page', 301 ) ) );
$rec = new IWSL_Recording_Redirector();
$ent = new IWSL_Entitlements( $store, static function () use ( $RD_NOW ): int {
	return $RD_NOW; } );
$rd = new IWSL_Redirects( $ent, $store, static function () use ( $RD_NOW ): int {
	return $RD_NOW; }, null, null, $rec, static function (): bool {
		return false; } );
$_SERVER['REQUEST_URI'] = '/old-page';
$rd->maybe_redirect();
iwsl_assert_same( 0, count( $rec->calls ), 'locked (flag missing): maybe_redirect issues NO redirect' );
$r = $rd->apply( '/old-page' );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'locked (flag missing): apply() → entitlement-locked' );
iwsl_assert_same( false, $r['matched'], 'locked (flag missing): apply() matched=false' );

// ── 2. Locked: not linked (state != active) → no redirect ─────────────────────

$store = new IWSL_Memory_Store();
$store->set( 'state', 'pending' );
$store->set( 'last_verified_at', $RD_NOW - 1000 );
$store->set( 'entitlements', array( 'redirect_manager' => true ) );
$store->set( 'redirect_rules', array( iwsl_rd_make_rule( '/old-page', '/new-page', 301 ) ) );
$rec = new IWSL_Recording_Redirector();
$ent = new IWSL_Entitlements( $store, static function () use ( $RD_NOW ): int {
	return $RD_NOW; } );
$rd = new IWSL_Redirects( $ent, $store, static function () use ( $RD_NOW ): int {
	return $RD_NOW; }, null, null, $rec );
$_SERVER['REQUEST_URI'] = '/old-page';
$rd->maybe_redirect();
iwsl_assert_same( 0, count( $rec->calls ), 'locked (not linked): no redirect despite the flag' );

// ── 3. Locked: stale heartbeat → no redirect ──────────────────────────────────

$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $RD_NOW - 10800000 ); // 3h — stale
$store->set( 'entitlements', array( 'redirect_manager' => true ) );
$store->set( 'redirect_rules', array( iwsl_rd_make_rule( '/old-page', '/new-page', 301 ) ) );
$rec = new IWSL_Recording_Redirector();
$ent = new IWSL_Entitlements( $store, static function () use ( $RD_NOW ): int {
	return $RD_NOW; } );
$rd = new IWSL_Redirects( $ent, $store, static function () use ( $RD_NOW ): int {
	return $RD_NOW; }, null, null, $rec );
$_SERVER['REQUEST_URI'] = '/old-page';
$rd->maybe_redirect();
iwsl_assert_same( 0, count( $rec->calls ), 'locked (stale heartbeat): no redirect despite the flag' );

// ── 4. Locked: add_rule refused, store untouched ──────────────────────────────

$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $RD_NOW - 1000 );
$store->set( 'entitlements', array() ); // no flags
$ent = new IWSL_Entitlements( $store, static function () use ( $RD_NOW ): int {
	return $RD_NOW; } );
$rec = new IWSL_Recording_Redirector();
$rd  = new IWSL_Redirects( $ent, $store, static function () use ( $RD_NOW ): int {
	return $RD_NOW; }, null, null, $rec );
$r = $rd->add_rule( '/old', '/new', 301 );
iwsl_assert_same( false, $r['ok'], 'locked add_rule: ok=false' );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'locked add_rule: entitlement-locked' );
iwsl_assert_same( null, $store->get( 'redirect_rules' ), 'locked add_rule: store unchanged (no rules written)' );

// ── 5. Matching rule redirects 301 (query ignored); hits increment ────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$add   = $rd->add_rule( '/old-page', '/new-page', 301 );
iwsl_assert_same( true, $add['ok'], '301: rule saved' );
$_SERVER['REQUEST_URI'] = '/old-page?utm=x';
$rd->maybe_redirect();
iwsl_assert_same( 1, count( $rec->calls ), '301: exactly one redirect issued' );
iwsl_assert_same( array( '/new-page', 301 ), $rec->calls[0], '301: redirect to /new-page with status 301 (query stripped)' );
$rules = $rd->rules();
iwsl_assert_same( 1, (int) $rules[0]['hits'], '301: hit counter incremented to 1' );

// ── 6. Matching rule redirects 302 ────────────────────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$rd->add_rule( '/temp', '/elsewhere', 302 );
$_SERVER['REQUEST_URI'] = '/temp';
$rd->maybe_redirect();
iwsl_assert_same( array( '/elsewhere', 302 ), $rec->calls[0], '302: status 302 propagates' );

// ── 7. Trailing-slash-insensitive match + normalize_path('/') stays '/' ───────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$rd->add_rule( '/old-page/', '/new-page', 301 ); // stored source normalizes to /old-page
$_SERVER['REQUEST_URI'] = '/old-page/';
$rd->maybe_redirect();
iwsl_assert_same( 1, count( $rec->calls ), 'trailing slash: /old-page/ matches the /old-page/ rule' );
iwsl_assert_same( '/', IWSL_Redirects::normalize_path( '/' ), 'trailing slash: normalize_path("/") stays "/"' );
iwsl_assert_same( '/old-page', IWSL_Redirects::normalize_path( '/old-page/' ), 'trailing slash: normalize trims trailing slash' );

// ── 8. Non-matching path → no redirect ────────────────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$rd->add_rule( '/old-page', '/new-page', 301 );
$_SERVER['REQUEST_URI'] = '/something-else';
$rd->maybe_redirect();
iwsl_assert_same( 0, count( $rec->calls ), 'non-matching path: no redirect' );
$r = $rd->apply( '/something-else' );
iwsl_assert_same( false, $r['matched'], 'non-matching path: apply() matched=false' );

// ── 9. Save refuses javascript: scheme ────────────────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$r     = $rd->add_rule( '/a', 'javascript:alert(1)', 301 );
iwsl_assert_same( 'bad-target', $r['reason'], 'javascript: scheme refused (bad-target)' );
iwsl_assert_same( 0, count( $rd->rules() ), 'javascript: nothing stored (rules count 0)' );

// ── 10. Save refuses data: scheme ─────────────────────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$r     = $rd->add_rule( '/a', 'data:text/html,x', 301 );
iwsl_assert_same( 'bad-target', $r['reason'], 'data: scheme refused (bad-target)' );

// ── 11. Save refuses scheme-relative target ───────────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$r     = $rd->add_rule( '/a', '//evil.com/x', 301 );
iwsl_assert_same( 'scheme-relative', $r['reason'], 'scheme-relative // target refused' );

// ── 12. Save refuses external, not allow-listed ───────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec ); // empty allow-list
$r     = $rd->add_rule( '/a', 'https://evil.com/x', 301 );
iwsl_assert_same( 'external-not-allowed', $r['reason'], 'external host with empty allow-list refused' );

// ── 13. Save allows an allow-listed external, and it redirects ────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec, false, array( 'partner.example' ) );
$r     = $rd->add_rule( '/go', 'https://partner.example/x', 301 );
iwsl_assert_same( true, $r['ok'], 'allow-listed external: saved (ok=true)' );
$_SERVER['REQUEST_URI'] = '/go';
$rd->maybe_redirect();
iwsl_assert_same( array( 'https://partner.example/x', 301 ), $rec->calls[0], 'allow-listed external: redirects to the external URL' );

// ── 14. Save refuses backslash (source) and CRLF (target) ─────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$r1    = $rd->add_rule( "/\\evil.com", '/ok', 301 );
iwsl_assert_same( 'bad-source', $r1['reason'], 'backslash in source refused (bad-source)' );
$r2 = $rd->add_rule( '/ok', "/a\r\nSet-Cookie:x", 301 );
iwsl_assert_same( 'bad-target', $r2['reason'], 'CRLF in target refused (bad-target)' );
iwsl_assert_same( 0, count( $rd->rules() ), 'backslash/CRLF: nothing stored' );

// ── 15. Save refuses an obvious self-loop ─────────────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$r     = $rd->add_rule( '/a', '/a/', 301 ); // /a/ normalizes to /a == source
iwsl_assert_same( 'self-redirect', $r['reason'], 'self-loop refused (target normalizes to source)' );

// ── 16. Save refuses a duplicate normalized source ────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
iwsl_assert_same( true, $rd->add_rule( '/dup', '/one', 301 )['ok'], 'duplicate: first rule saved' );
$r = $rd->add_rule( '/dup/', '/two', 301 ); // normalizes to /dup
iwsl_assert_same( 'duplicate-source', $r['reason'], 'duplicate normalized source refused' );
iwsl_assert_same( 1, count( $rd->rules() ), 'duplicate: count stays 1' );

// ── 17. Save refuses bad type + bad/reserved sources ──────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
iwsl_assert_same( 'bad-type', $rd->add_rule( '/x', '/y', 307 )['reason'], 'type 307 refused (bad-type)' );
iwsl_assert_same( 'bad-source', $rd->add_rule( 'old-page', '/y', 301 )['reason'], 'source without leading / refused' );
iwsl_assert_same( 'bad-source', $rd->add_rule( 'https://site/x', '/y', 301 )['reason'], 'absolute-URL source refused' );
iwsl_assert_same( 'reserved-path', $rd->add_rule( '/wp-admin/x', '/y', 301 )['reason'], '/wp-admin/x refused (reserved-path)' );

// ── 18. MAX_RULES enforced ────────────────────────────────────────────────────

$store = new IWSL_Memory_Store();
$seed  = array();
for ( $i = 0; $i < IWSL_Redirects::MAX_RULES; $i++ ) {
	$seed[] = iwsl_rd_make_rule( '/p' . $i, '/t' . $i, 301 );
}
$store->set( 'redirect_rules', $seed );
$rec = new IWSL_Recording_Redirector();
$rd  = iwsl_rd_engine( $store, $RD_NOW, $rec );
iwsl_assert_same( IWSL_Redirects::MAX_RULES, count( $rd->rules() ), 'max-rules: 500 seeded rules read back' );
$r = $rd->add_rule( '/one-more', '/nope', 301 );
iwsl_assert_same( 'max-rules', $r['reason'], 'max-rules: 501st rule refused' );
iwsl_assert_same( IWSL_Redirects::MAX_RULES, count( $rd->rules() ), 'max-rules: count stays 500' );

// ── 19. delete_rule removes, and is gated ─────────────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$add   = $rd->add_rule( '/gone', '/here', 301 );
$id    = $add['rule']['id'];
$del   = $rd->delete_rule( $id );
iwsl_assert_same( true, $del['ok'], 'delete: reported ok' );
iwsl_assert_same( 0, count( $rd->rules() ), 'delete: rule removed' );

// locked delete leaves the rule in place.
$store2 = new IWSL_Memory_Store();
$store2->set( 'state', 'active' );
$store2->set( 'last_verified_at', $RD_NOW - 1000 );
$store2->set( 'entitlements', array( 'redirect_manager' => true ) );
$seed_rule = iwsl_rd_make_rule( '/keep', '/there', 301 );
$store2->set( 'redirect_rules', array( $seed_rule ) );
$ent2 = new IWSL_Entitlements( $store2, static function () use ( $RD_NOW ): int {
	return $RD_NOW; } );
$rd2 = new IWSL_Redirects( $ent2, $store2, static function () use ( $RD_NOW ): int {
	return $RD_NOW; } );
$store2->set( 'entitlements', array( 'redirect_manager' => false ) ); // revoke → lock
$del2 = $rd2->delete_rule( $seed_rule['id'] );
iwsl_assert_same( 'entitlement-locked', $del2['reason'], 'locked delete: entitlement-locked' );
iwsl_assert_same( 1, count( $store2->get( 'redirect_rules' ) ), 'locked delete: rule survives' );

// ── 20. DB-tampered stored target is skipped at request time ──────────────────

$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $RD_NOW - 1000 );
$store->set( 'entitlements', array( 'redirect_manager' => true ) );
$store->set( 'redirect_rules', array( iwsl_rd_make_rule( '/old', 'javascript:x', 301 ) ) ); // tampered target
$rec = new IWSL_Recording_Redirector();
$ent = new IWSL_Entitlements( $store, static function () use ( $RD_NOW ): int {
	return $RD_NOW; } );
$rd = new IWSL_Redirects( $ent, $store, static function () use ( $RD_NOW ): int {
	return $RD_NOW; }, null, null, $rec );
$_SERVER['REQUEST_URI'] = '/old';
$rd->maybe_redirect();
iwsl_assert_same( 0, count( $rec->calls ), 'tampered target: request-time re-validation skips it (no redirect)' );
iwsl_assert_same( false, $rd->apply( '/old' )['matched'], 'tampered target: apply() matched=false' );

// ── 21. 404 log: capped at 100 + deduped ──────────────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec, true ); // is_404 → true
$rd->set_404_logging( true );
for ( $i = 0; $i <= IWSL_Redirects::MAX_404_LOG; $i++ ) { // 101 distinct paths
	$_SERVER['REQUEST_URI'] = '/missing-' . $i;
	$rd->maybe_redirect();
}
iwsl_assert_same( IWSL_Redirects::MAX_404_LOG, count( $rd->log_entries() ), '404 log: capped at 100 entries' );

$store_b = new IWSL_Memory_Store();
$rec_b   = new IWSL_Recording_Redirector();
$rd_b    = iwsl_rd_engine( $store_b, $RD_NOW, $rec_b, true );
$rd_b->set_404_logging( true );
$_SERVER['REQUEST_URI'] = '/missing-xyz';
$rd_b->maybe_redirect();
$rd_b->maybe_redirect();
$log_b = $rd_b->log_entries();
iwsl_assert_same( 1, count( $log_b ), '404 log: same path twice → a single entry' );
iwsl_assert_same( 2, (int) $log_b[0]['count'], '404 log: deduped entry count === 2' );

// ── 22. 404 log disabled by default ───────────────────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec, true ); // is_404 true, but logging never enabled
iwsl_assert_same( false, $rd->is_404_logging_enabled(), '404 log: disabled by default' );
$_SERVER['REQUEST_URI'] = '/missing';
$rd->maybe_redirect();
iwsl_assert_same( 0, count( $rd->log_entries() ), '404 log: nothing recorded while disabled' );

// ── 23. Revocation is instant ─────────────────────────────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$rd->add_rule( '/live', '/target', 301 );
$_SERVER['REQUEST_URI'] = '/live';
$rd->maybe_redirect();
iwsl_assert_same( 1, count( $rec->calls ), 'revocation: unlocked request redirects once' );
$store->set( 'entitlements', array( 'redirect_manager' => false ) ); // console revokes the flag
$rd->maybe_redirect();
iwsl_assert_same( 1, count( $rec->calls ), 'revocation: identical request after revoke adds NO redirect' );

// ── 24. build_auto_source_target(): pure old→new diff + no-op cases ────────────

$auto = IWSL_Redirects::build_auto_source_target( 'https://fixture-site.test/old-slug/', 'https://fixture-site.test/new-slug/' );
iwsl_assert_same( '/old-slug', $auto['source'], 'auto build: source is the old normalized path' );
iwsl_assert_same( 'https://fixture-site.test/new-slug/', $auto['target'], 'auto build: target is the new permalink verbatim' );
iwsl_assert_same( null, IWSL_Redirects::build_auto_source_target( 'https://fixture-site.test/x/', 'https://fixture-site.test/x' ), 'auto build: same normalized path → null (no-op)' );
iwsl_assert_same( null, IWSL_Redirects::build_auto_source_target( '', 'https://fixture-site.test/x' ), 'auto build: empty old permalink → null' );
iwsl_assert_same( null, IWSL_Redirects::build_auto_source_target( 'https://fixture-site.test/x', '' ), 'auto build: empty new permalink → null' );

// ── 25. detect_cycle(): simple loop, long chain, no-cycle ─────────────────────

iwsl_assert_same( true, IWSL_Redirects::detect_cycle( array( iwsl_rd_make_rule( '/b', '/a', 301 ) ), '/a', '/b' ), 'detect_cycle: A→B with existing B→A is a loop' );
$chain = array( iwsl_rd_make_rule( '/b', '/c', 301 ), iwsl_rd_make_rule( '/c', '/d', 301 ), iwsl_rd_make_rule( '/d', '/a', 301 ) );
iwsl_assert_same( true, IWSL_Redirects::detect_cycle( $chain, '/a', '/b' ), 'detect_cycle: long chain A→B→C→D→A loops back' );
iwsl_assert_same( false, IWSL_Redirects::detect_cycle( array( iwsl_rd_make_rule( '/b', '/c', 301 ) ), '/a', '/b' ), 'detect_cycle: A→B→C is not a loop' );
iwsl_assert_same( false, IWSL_Redirects::detect_cycle( array(), '/a', '/z', ), 'detect_cycle: a single unmatched edge is not a loop' );

// ── 26. add_rule refuses a rule that completes a loop ─────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$rd->add_rule( '/b', '/a', 301 ); // existing B→A
$loop = $rd->add_rule( '/a', '/b', 301 ); // A→B would close the loop
iwsl_assert_same( 'creates-redirect-loop', $loop['reason'], 'add_rule: rejects a loop-closing rule' );
iwsl_assert_same( 1, count( $rd->rules() ), 'add_rule: the loop rule was not stored' );

// ── 27. auto-redirect toggle: default ON + gated set ──────────────────────────

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
iwsl_assert_same( true, $rd->is_auto_redirect_enabled(), 'auto-redirect: enabled by default (default ON)' );
$rd->set_auto_redirect( false );
iwsl_assert_same( false, $rd->is_auto_redirect_enabled(), 'auto-redirect: can be switched off' );
$rd->set_auto_redirect( true );
iwsl_assert_same( true, $rd->is_auto_redirect_enabled(), 'auto-redirect: can be switched back on' );

$store_l = new IWSL_Memory_Store();
$store_l->set( 'state', 'active' );
$store_l->set( 'last_verified_at', $RD_NOW - 1000 );
$store_l->set( 'entitlements', array( 'plus' => true ) ); // redirect_manager ABSENT
$ent_l = new IWSL_Entitlements( $store_l, static function () use ( $RD_NOW ): int {
	return $RD_NOW; } );
$rd_l = new IWSL_Redirects( $ent_l, $store_l, static function () use ( $RD_NOW ): int {
	return $RD_NOW; } );
iwsl_assert_same( 'entitlement-locked', $rd_l->set_auto_redirect( true )['reason'], 'auto-redirect: set is gated (locked → refused)' );

// ── 28. register() wires the front-end + auto-redirect hooks ──────────────────

$GLOBALS['iwsl_rd_actions'] = array();
if ( ! function_exists( 'add_action' ) ) {
	function add_action( $hook, $cb = null, $priority = 10, $args = 1 ) {
		$GLOBALS['iwsl_rd_actions'][] = (string) $hook;
		return true;
	}
}
$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$rd->register();
iwsl_assert( in_array( 'template_redirect', $GLOBALS['iwsl_rd_actions'], true ), 'register: wires template_redirect' );
iwsl_assert( in_array( 'pre_post_update', $GLOBALS['iwsl_rd_actions'], true ), 'register: wires pre_post_update (snapshot)' );
iwsl_assert( in_array( 'post_updated', $GLOBALS['iwsl_rd_actions'], true ), 'register: wires post_updated (diff)' );

// ── 29. auto-redirect glue: a published slug change creates a 301 ─────────────
// WP stubs defined LAST so every earlier test kept the strict local behaviour.

$GLOBALS['iwsl_rd_perma']  = 'https://fixture-site.test/old-slug';
$GLOBALS['iwsl_rd_status'] = 'publish';
if ( ! function_exists( 'get_post_type' ) ) {
	function get_post_type( $id = 0 ) {
		return 'post';
	}
}
if ( ! function_exists( 'get_post_status' ) ) {
	function get_post_status( $id = 0 ) {
		return (string) $GLOBALS['iwsl_rd_status'];
	}
}
if ( ! function_exists( 'get_permalink' ) ) {
	function get_permalink( $id = 0 ) {
		return (string) $GLOBALS['iwsl_rd_perma'];
	}
}
if ( ! function_exists( 'get_post_types' ) ) {
	function get_post_types( $args = array(), $output = 'names' ) {
		return array( 'post' => 'post', 'page' => 'page' );
	}
}
$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );
$rd->snapshot_permalink( 42 ); // captures old permalink (published public post)
$GLOBALS['iwsl_rd_perma'] = 'https://fixture-site.test/new-slug'; // slug changed
$rd->maybe_auto_redirect( 42, (object) array( 'post_status' => 'publish' ), null );
$auto_rules = $rd->rules();
iwsl_assert_same( 1, count( $auto_rules ), 'auto-redirect glue: a 301 was created on slug change' );
iwsl_assert_same( '/old-slug', $auto_rules[0]['source'], 'auto-redirect glue: source is the old path' );
iwsl_assert_same( 301, (int) $auto_rules[0]['type'], 'auto-redirect glue: status is 301' );

// No-op: an unchanged permalink creates nothing.
$store2 = new IWSL_Memory_Store();
$rd2    = iwsl_rd_engine( $store2, $RD_NOW, new IWSL_Recording_Redirector() );
$GLOBALS['iwsl_rd_perma'] = 'https://fixture-site.test/stable';
$rd2->snapshot_permalink( 7 );
$rd2->maybe_auto_redirect( 7, (object) array( 'post_status' => 'publish' ), null );
iwsl_assert_same( 0, count( $rd2->rules() ), 'auto-redirect glue: unchanged permalink creates no rule' );

// ── 29b. auto-redirect revert: the stale forward rule is superseded ───────────
// hello → hello-2 creates /hello → /hello-2. Reverting hello-2 → hello must NOT
// leave /hello (now live again) as a redirect source: the reverse rule would be
// refused as a cycle, stranding the forward rule so it 301s the live URL to a
// dead one. The fix drops any rule whose source is the new (live) permalink path
// before adding the reverse rule.
$store_rev = new IWSL_Memory_Store();
$rd_rev    = iwsl_rd_engine( $store_rev, $RD_NOW, new IWSL_Recording_Redirector() );

$GLOBALS['iwsl_rd_perma'] = 'https://fixture-site.test/hello';
$rd_rev->snapshot_permalink( 77 );
$GLOBALS['iwsl_rd_perma'] = 'https://fixture-site.test/hello-2'; // slug changed
$rd_rev->maybe_auto_redirect( 77, (object) array( 'post_status' => 'publish' ), null );
$fwd = $rd_rev->rules();
iwsl_assert_same( 1, count( $fwd ), 'revert: forward rule created on first rename' );
iwsl_assert_same( '/hello', $fwd[0]['source'], 'revert: forward rule source is /hello' );

$GLOBALS['iwsl_rd_perma'] = 'https://fixture-site.test/hello-2';
$rd_rev->snapshot_permalink( 77 );
$GLOBALS['iwsl_rd_perma'] = 'https://fixture-site.test/hello'; // slug reverted
$rd_rev->maybe_auto_redirect( 77, (object) array( 'post_status' => 'publish' ), null );

$stale = false;
foreach ( $rd_rev->rules() as $rule ) {
	if ( '/hello' === IWSL_Redirects::normalize_path( (string) $rule['source'] ) ) {
		$stale = true;
	}
}
iwsl_assert_same( false, $stale, 'revert: no rule maps /hello anywhere (stale forward rule removed)' );
iwsl_assert_same( false, $rd_rev->apply( '/hello' )['matched'], 'revert: apply(/hello) matched=false (live content)' );

$rec_live = new IWSL_Recording_Redirector();
$rd_live  = iwsl_rd_engine( $store_rev, $RD_NOW, $rec_live );
$_SERVER['REQUEST_URI'] = '/hello';
$rd_live->maybe_redirect();
iwsl_assert_same( 0, count( $rec_live->calls ), 'revert: /hello resolves live (no redirect issued)' );

// ── 29c. add_rule optimistic re-read: a concurrent rule survives the append ───
// A second engine over the same store writes a rule AFTER the first read but
// BEFORE the set; the fresh re-read must merge it in rather than clobber it.
$store_cc = new IWSL_Memory_Store();
$rd_cc    = iwsl_rd_engine( $store_cc, $RD_NOW, new IWSL_Recording_Redirector() );
$rd_cc->add_rule( '/first', '/first-target', 301 );
$store_cc->set(
	'redirect_rules',
	array_merge(
		$rd_cc->rules(),
		array( iwsl_rd_make_rule( '/concurrent', '/concurrent-target', 301 ) )
	)
);
$rd_cc->add_rule( '/second', '/second-target', 301 );
$sources_cc = array_map(
	static function ( array $rule ): string {
		return (string) $rule['source'];
	},
	$rd_cc->rules()
);
iwsl_assert( in_array( '/concurrent', $sources_cc, true ), 'add_rule re-read: the concurrently-written rule survives the append' );
iwsl_assert( in_array( '/second', $sources_cc, true ), 'add_rule re-read: the new rule is stored' );
iwsl_assert_same( 3, count( $sources_cc ), 'add_rule re-read: all three rules present (none clobbered)' );

// ── 29d. delete_rule optimistic re-read: a concurrent rule survives the delete ─
$store_dd = new IWSL_Memory_Store();
$rd_dd    = iwsl_rd_engine( $store_dd, $RD_NOW, new IWSL_Recording_Redirector() );
$add_dd   = $rd_dd->add_rule( '/doomed', '/doomed-target', 301 );
$store_dd->set(
	'redirect_rules',
	array_merge(
		$rd_dd->rules(),
		array( iwsl_rd_make_rule( '/late', '/late-target', 301 ) )
	)
);
$rd_dd->delete_rule( $add_dd['rule']['id'] );
$sources_dd = array_map(
	static function ( array $rule ): string {
		return (string) $rule['source'];
	},
	$rd_dd->rules()
);
iwsl_assert_same( array( '/late' ), $sources_dd, 'delete_rule re-read: target removed, concurrent rule preserved' );

unset( $GLOBALS['iwsl_rd_actions'], $GLOBALS['iwsl_rd_perma'], $GLOBALS['iwsl_rd_status'] );
unset( $_SERVER['REQUEST_URI'] );

// ── 30. purge(): removes all four option keys; idempotent + cheap-when-clean ───
// A fake IWSL_Teardown (isolated to this subprocess) proves each rule mutation
// flushes the page cache; purge() then scrubs every plugin-owned option key.

if ( ! class_exists( 'IWSL_Teardown' ) ) {
	class IWSL_Teardown {
		public static $flushes = 0;
		public static function flush_page_cache(): void {
			self::$flushes++;
		}
	}
}

$store = new IWSL_Memory_Store();
$rec   = new IWSL_Recording_Redirector();
$rd    = iwsl_rd_engine( $store, $RD_NOW, $rec );

// When the harness supplies a counting fake IWSL_Teardown (peer's real class absent)
// assert each mutation flushed; when the real class is preloaded assert the wiring
// target + that the mutators succeed with the flush call in their success paths.
$iwsl_rd_can_count = property_exists( 'IWSL_Teardown', 'flushes' );
if ( $iwsl_rd_can_count ) {
	IWSL_Teardown::$flushes = 0;
}
iwsl_assert_same( true, $rd->add_rule( '/old', '/new', 301 )['ok'], 'purge/cache: add_rule succeeds (flush in success path)' );          // sets redirect_rules
iwsl_assert_same( true, $rd->set_404_logging( true )['ok'], 'purge/cache: set_404_logging succeeds (flush in success path)' );          // sets redirect_404_log_enabled
iwsl_assert_same( true, $rd->set_auto_redirect( false )['ok'], 'purge/cache: set_auto_redirect succeeds (flush in success path)' );     // sets redirect_auto_slug
if ( $iwsl_rd_can_count ) {
	iwsl_assert_same( 3, IWSL_Teardown::$flushes, 'purge/cache: add_rule + set_404_logging + set_auto_redirect each flush the page cache' );
} else {
	iwsl_assert( method_exists( 'IWSL_Teardown', 'flush_page_cache' ), 'purge/cache: flush wired to IWSL_Teardown::flush_page_cache()' );
}
$store->set( 'redirect_404_log', array( array( 'path' => '/x', 'count' => 1, 'last_seen' => 0 ) ) ); // seed the 404 log

iwsl_assert( null !== $store->get( 'redirect_rules', null ), 'purge: rules option present before purge' );
$pg = $rd->purge();
iwsl_assert_same( true, $pg['ok'], 'purge: ok=true' );
iwsl_assert_same( array(), $pg['cron'], 'purge: no cron scheduled by this engine' );
iwsl_assert_same(
	array( 'redirect_rules', 'redirect_404_log', 'redirect_404_log_enabled', 'redirect_auto_slug' ),
	$pg['options'],
	'purge: all four plugin option keys removed (in order)'
);
iwsl_assert_same( null, $store->get( 'redirect_rules', null ), 'purge: rules actually deleted' );
iwsl_assert_same( null, $store->get( 'redirect_404_log', null ), 'purge: 404 log actually deleted' );
iwsl_assert_same( null, $store->get( 'redirect_404_log_enabled', null ), 'purge: 404-log toggle actually deleted' );
iwsl_assert_same( null, $store->get( 'redirect_auto_slug', null ), 'purge: auto-redirect toggle actually deleted' );

// Idempotent + cheap-when-clean.
$pg2 = $rd->purge();
iwsl_assert_same( array(), $pg2['options'], 'purge idempotent: second purge removes nothing' );
iwsl_assert_same( true, $pg2['ok'], 'purge idempotent: still ok' );
$store_clean = new IWSL_Memory_Store();
$rd_clean    = iwsl_rd_engine( $store_clean, $RD_NOW, new IWSL_Recording_Redirector() );
iwsl_assert_same( array(), $rd_clean->purge()['options'], 'purge cheap-when-clean: a fresh engine removes nothing' );
