<?php
/**
 * Paid-feature entitlements: the signed `entitlements.set` method (validator +
 * runner + registration + the heartbeat bump on a real verified command) and the
 * client-side feature gate across every linked/heartbeat/plus permutation.
 */

// ── validate_params: the verifier's allow-list gate for entitlements.set ──────

iwsl_assert_same(
	true,
	IWSL_Entitlements::validate_params( json_decode( '{"entitlements":{"plus":true}}' ) ),
	'validate_params accepts { entitlements: { plus: true } }'
);
iwsl_assert_same(
	true,
	IWSL_Entitlements::validate_params( json_decode( '{"entitlements":{}}' ) ),
	'validate_params accepts an empty map (revoke-all)'
);
iwsl_assert_same(
	true,
	IWSL_Entitlements::validate_params( json_decode( '{"entitlements":{"plus":true,"pro_tier":false}}' ) ),
	'validate_params accepts multiple boolean flags (future-proof)'
);
iwsl_assert_same(
	false,
	IWSL_Entitlements::validate_params( json_decode( '{}' ) ),
	'validate_params rejects a missing entitlements key'
);
iwsl_assert_same(
	false,
	IWSL_Entitlements::validate_params( json_decode( '{"entitlements":{"plus":true},"x":1}' ) ),
	'validate_params rejects a stray top-level key (signed padding)'
);
iwsl_assert_same(
	false,
	IWSL_Entitlements::validate_params( json_decode( '{"entitlements":true}' ) ),
	'validate_params rejects a non-object entitlements'
);
iwsl_assert_same(
	false,
	IWSL_Entitlements::validate_params( json_decode( '{"entitlements":{"plus":1}}' ) ),
	'validate_params rejects a non-boolean flag value'
);
iwsl_assert_same(
	false,
	IWSL_Entitlements::validate_params( json_decode( '{"entitlements":{"bad-key":true}}' ) ),
	'validate_params rejects a malformed flag name'
);
$too_many = new stdClass();
$flags    = new stdClass();
for ( $i = 0; $i < IWSL_Entitlements::MAX_FLAGS + 1; $i++ ) {
	$flags->{"flag_$i"} = true;
}
$too_many->entitlements = $flags;
iwsl_assert_same( false, IWSL_Entitlements::validate_params( $too_many ), 'validate_params rejects more than MAX_FLAGS flags' );

// ── apply / all / has: console-authoritative wholesale replace ────────────────

$ent_store = new IWSL_Memory_Store();
$ent       = new IWSL_Entitlements( $ent_store, static function (): int {
	return 1000;
} );

$stored = $ent->apply( json_decode( '{"plus":true}' ) );
iwsl_assert_same( array( 'plus' => true ), $stored, 'apply returns the normalized flag map' );
iwsl_assert( $ent->has( 'plus' ), 'has(plus) is true after grant' );
iwsl_assert_same( 1000, $ent_store->get( 'entitlements_updated_at' ), 'apply stamps entitlements_updated_at' );

$ent->apply( json_decode( '{"plus":false}' ) );
iwsl_assert( ! $ent->has( 'plus' ), 'has(plus) is false after an explicit false' );

$ent->apply( json_decode( '{}' ) );
iwsl_assert_same( array(), $ent->all(), 'apply {} wholesale-clears every flag (console is authoritative)' );

// A stray non-boolean survives validation nowhere, but apply also drops it defensively.
$normalized = $ent->apply( json_decode( '{"plus":true,"junk":5,"Bad":true}' ) );
iwsl_assert_same( array( 'plus' => true ), $normalized, 'apply drops non-boolean / malformed keys defensively' );

// ── registration: entitlements.set is an allow-listed method ──────────────────

$methods = IWSL_Plugin::allowed_methods();
iwsl_assert( array_key_exists( 'entitlements.set', $methods ), 'entitlements.set is allow-listed (verifier + dispatch)' );
$validator = $methods['entitlements.set'];
iwsl_assert( is_callable( $validator ), 'entitlements.set carries a params validator' );
iwsl_assert_same(
	true,
	(bool) call_user_func( $validator, json_decode( '{"entitlements":{"plus":true}}' ) ),
	'registry validator accepts good params'
);
iwsl_assert_same(
	false,
	(bool) call_user_func( $validator, json_decode( '{"entitlements":{"plus":1}}' ) ),
	'registry validator rejects bad params'
);

// ── gate permutations: linked × heartbeat × plus ──────────────────────────────

/** Build a gate evaluation from explicit store state at a fixed `now`. */
function iwsl_eval_gate( array $opts ): array {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $opts['state'] ?? 'unenrolled' );
	if ( array_key_exists( 'last_verified_at', $opts ) ) {
		$store->set( 'last_verified_at', $opts['last_verified_at'] );
	}
	if ( array_key_exists( 'plus', $opts ) ) {
		$store->set( 'entitlements', array( 'plus' => $opts['plus'] ) );
	}
	$now = $opts['now'] ?? 10000000;
	$ent = new IWSL_Entitlements( $store, static function () use ( $now ): int {
		return $now;
	} );
	return $ent->evaluate( 'plus' );
}

$NOW   = 10000000;
$FRESH = $NOW - 60000;            // 1 min ago — inside the 2h window
$STALE = $NOW - 10800000;         // 3 h ago — outside the window

$g = iwsl_eval_gate( array( 'state' => 'unenrolled', 'last_verified_at' => $FRESH, 'plus' => true, 'now' => $NOW ) );
iwsl_assert_same( false, $g['unlocked'], 'not-linked → locked even with fresh heartbeat + plus' );
iwsl_assert_same( false, $g['linked'], 'not-linked → linked=false' );
iwsl_assert( in_array( 'not-linked', $g['reasons'], true ), 'reason not-linked surfaced' );

$g = iwsl_eval_gate( array( 'state' => 'active', 'plus' => true, 'now' => $NOW ) );
iwsl_assert_same( false, $g['unlocked'], 'linked + plus but no heartbeat → locked' );
iwsl_assert_same( false, $g['heartbeat_fresh'], 'no heartbeat → heartbeat_fresh=false' );
iwsl_assert( in_array( 'heartbeat-stale', $g['reasons'], true ), 'reason heartbeat-stale surfaced (never verified)' );

$g = iwsl_eval_gate( array( 'state' => 'active', 'last_verified_at' => $STALE, 'plus' => true, 'now' => $NOW ) );
iwsl_assert_same( false, $g['unlocked'], 'linked + plus + STALE heartbeat → locked' );
iwsl_assert_same( false, $g['heartbeat_fresh'], 'stale heartbeat → heartbeat_fresh=false' );

$g = iwsl_eval_gate( array( 'state' => 'active', 'last_verified_at' => $NOW + 100000, 'plus' => true, 'now' => $NOW ) );
iwsl_assert_same( false, $g['heartbeat_fresh'], 'future-dated heartbeat (skew/clone) is not fresh' );

$g = iwsl_eval_gate( array( 'state' => 'active', 'last_verified_at' => $FRESH, 'now' => $NOW ) );
iwsl_assert_same( false, $g['unlocked'], 'linked + fresh but no plus → locked' );
iwsl_assert_same( false, $g['plus'], 'no entitlement → plus=false' );
iwsl_assert( in_array( 'requires-plus', $g['reasons'], true ), 'reason requires-plus surfaced' );

$g = iwsl_eval_gate( array( 'state' => 'active', 'last_verified_at' => $FRESH, 'plus' => true, 'now' => $NOW ) );
iwsl_assert_same( true, $g['unlocked'], 'linked + fresh heartbeat + plus → UNLOCKED' );
iwsl_assert_same( array(), $g['reasons'], 'unlocked gate has no reasons' );

// ── heartbeat end-to-end: a REAL verified command bumps last_verified_at ───────

$hb_store  = iwsl_seed_store();
// iwsl_seed_store pins only the IW verify keys; a full command round-trip also
// needs a WP signing key for the response. (Fresh key — this test asserts the
// heartbeat + status, not the response signature, which test-plugin.php covers.)
$hb_store->set( 'wp_keys.1', IWSL_Crypto::ed_keypair() );
$hb_store->set( 'wp_current_kid', 1 );
$hb_store->set( 'wp_epoch_floor', 1 );
$hb_plugin = new IWSL_Plugin( $hb_store, iwsl_now_t0( 5000 ) );
$expected  = iwsl_fixtures()->t0 + 5000;

iwsl_assert_same( null, $hb_store->get( 'last_verified_at' ), 'no heartbeat before any command' );
$hb = $hb_plugin->handle_command( iwsl_clone( iwsl_fixtures()->commands->valid ) );
iwsl_assert_same( 200, $hb['status'], 'a valid signed command executes' );
iwsl_assert_same( $expected, $hb_store->get( 'last_verified_at' ), 'a verified dual-signed command stamps the heartbeat' );

// With that fresh, signature-authenticated heartbeat and an active link, the gate
// is one grant away from unlocked — proving the heartbeat feeds the gate.
$gate = $hb_plugin->entitlements()->evaluate( 'plus' );
iwsl_assert_same( true, $gate['linked'], 'gate sees the active link' );
iwsl_assert_same( true, $gate['heartbeat_fresh'], 'gate sees the fresh heartbeat from the verified command' );
iwsl_assert_same( false, $gate['plus'], 'gate still locked — plus not granted yet' );

$hb_plugin->entitlements()->apply( json_decode( '{"plus":true}' ) );
$gate = $hb_plugin->entitlements()->evaluate( 'plus' );
iwsl_assert_same( true, $gate['unlocked'], 'granting plus over the (now proven) channel unlocks the feature' );

// A tampered command must NOT bump the heartbeat (verify-before-stamp).
$hb2_store  = iwsl_seed_store();
$hb2_plugin = new IWSL_Plugin( $hb2_store, iwsl_now_t0( 5000 ) );
$tampered   = iwsl_clone( iwsl_fixtures()->commands->valid );
$tampered->envelope->params->x = 1; // breaks the signature
$rejected = $hb2_plugin->handle_command( $tampered );
iwsl_assert_same( 403, $rejected['status'], 'tampered command rejected' );
iwsl_assert_same( null, $hb2_store->get( 'last_verified_at' ), 'a rejected command leaves the heartbeat unset (no forgeable freshness)' );
