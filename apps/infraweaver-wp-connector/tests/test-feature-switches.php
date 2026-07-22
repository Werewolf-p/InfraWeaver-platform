<?php
/**
 * IWSL_Feature_Switches — the tier-aware operator kill-switch.
 *
 * Invariant under test: the switch can turn a feature OFF freely, but can only
 * turn it ON when the live entitlement already grants it — it never out-runs
 * the signed console grant. Default (unset) is ON.
 */

declare(strict_types=1);

/** Build an Entitlements that grants exactly $granted at a fresh, active link. */
function iwsl_fs_ent( array $granted ): array {
	$store = new IWSL_Memory_Store();
	$now   = 10000000;
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 1000 ); // fresh (< 2h)
	$flags = array();
	foreach ( $granted as $flag ) {
		$flags[ $flag ] = true;
	}
	$store->set( 'entitlements', $flags );
	$ent = new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
	return array( $ent, $store );
}

// A shared switch store, independent of the entitlement store, so persistence is
// observable across fresh IWSL_Feature_Switches instances.
list( $ent, ) = iwsl_fs_ent( array( 'speed_pack', 'page_cache', 'lazy_load' ) );
$sw_store     = new IWSL_Memory_Store();
$sw           = new IWSL_Feature_Switches( $ent, $sw_store );

// ── defaults: everything on until explicitly flipped ───────────────────────────
iwsl_assert_same( true, $sw->is_on( 'speed_pack' ), 'default on: granted feature reads on' );
iwsl_assert_same( true, $sw->is_on( 'white_label' ), 'default on: even an ungranted feature defaults on (engine self-gates)' );
iwsl_assert_same( array(), $sw_store->get( IWSL_Feature_Switches::OPTION, array() ), 'no option written until first set()' );

// ── switchable registry ────────────────────────────────────────────────────────
iwsl_assert_same( true, IWSL_Feature_Switches::is_switchable( 'speed_pack' ), 'speed_pack is switchable' );
iwsl_assert_same( true, IWSL_Feature_Switches::is_switchable( 'white_label' ), 'white_label is switchable' );
iwsl_assert_same( false, IWSL_Feature_Switches::is_switchable( 'wp_config_editor' ), 'config editor (no tier gate) is NOT switchable' );
iwsl_assert_same( false, IWSL_Feature_Switches::is_switchable( 'nonsense' ), 'unknown flag not switchable' );
iwsl_assert_same( 22, count( IWSL_Feature_Switches::switchable() ), 'exactly 22 switchable features' );

// ── turning OFF is always allowed (even the ungranted) ─────────────────────────
$r = $sw->set( 'speed_pack', false );
iwsl_assert_same( true, $r['ok'], 'turn granted feature off → ok' );
iwsl_assert_same( false, $sw->is_on( 'speed_pack' ), 'speed_pack now off' );
iwsl_assert_same( true, $sw->is_on( 'page_cache' ), 'sibling switch untouched' );

$r = $sw->set( 'white_label', false );
iwsl_assert_same( true, $r['ok'], 'turning an UNGRANTED feature off is allowed' );
iwsl_assert_same( false, $sw->is_on( 'white_label' ), 'white_label now off' );

// ── turning ON requires a live grant ───────────────────────────────────────────
$r = $sw->set( 'speed_pack', true );
iwsl_assert_same( true, $r['ok'], 'granted feature can be re-enabled' );
iwsl_assert_same( true, $sw->is_on( 'speed_pack' ), 'speed_pack back on' );

$r = $sw->set( 'white_label', true );
iwsl_assert_same( false, $r['ok'], 'CANNOT enable a feature the tier does not grant' );
iwsl_assert_same( 'not-entitled', $r['reason'], 'refusal reason is not-entitled' );
iwsl_assert_same( false, $sw->is_on( 'white_label' ), 'white_label stays off after refused enable' );

// ── unknown feature rejected ───────────────────────────────────────────────────
$r = $sw->set( 'nonsense', true );
iwsl_assert_same( false, $r['ok'], 'unknown feature rejected' );
iwsl_assert_same( 'unknown-feature', $r['reason'], 'reason unknown-feature' );

// ── persistence across a fresh instance on the same store ──────────────────────
$sw2 = new IWSL_Feature_Switches( $ent, $sw_store );
iwsl_assert_same( true, $sw2->is_on( 'speed_pack' ), 'persisted on survives new instance' );
iwsl_assert_same( false, $sw2->is_on( 'white_label' ), 'persisted off survives new instance' );

// ── map hardening: junk keys/values in the stored option are ignored ───────────
$sw_store->set(
	IWSL_Feature_Switches::OPTION,
	array( 'page_cache' => 0, 'not_a_feature' => true, 7 => true, 'lazy_load' => '1' )
);
$sw3 = new IWSL_Feature_Switches( $ent, $sw_store );
iwsl_assert_same( false, $sw3->is_on( 'page_cache' ), 'stored 0 coerces to off' );
iwsl_assert_same( true, $sw3->is_on( 'lazy_load' ), 'stored "1" coerces to on' );
iwsl_assert_same( true, $sw3->is_on( 'cdn_rewrite' ), 'unknown-to-map feature defaults on' );

// A non-array option must not fatal.
$sw_store->set( IWSL_Feature_Switches::OPTION, 'corrupt' );
$sw4 = new IWSL_Feature_Switches( $ent, $sw_store );
iwsl_assert_same( true, $sw4->is_on( 'speed_pack' ), 'corrupt (non-array) option degrades to all-on' );

// ── drift guard: the admin card map ↔ the switchable registry ───────────────────
// Every tier-gated tab in the admin UI must map to a switchable FEATURE flag, or a
// card would render a toggle the switch layer refuses to honor. Loads the admin
// class (all engine deps are already required by the harness bootstrap) and reads
// its private static map by reflection.
require_once __DIR__ . '/../includes/class-iwsl-wp-store.php';
require_once __DIR__ . '/../includes/class-iwsl-admin.php';
$flag_map_m = new ReflectionMethod( 'IWSL_Admin', 'feature_flag_map' );
$flag_map_m->setAccessible( true );
$flag_map    = $flag_map_m->invoke( null );
$switchable  = IWSL_Feature_Switches::switchable();
$all_covered = true;
foreach ( $flag_map as $tab_id => $flag ) {
	if ( ! isset( $switchable[ $flag ] ) ) {
		$all_covered = false;
	}
}
iwsl_assert_same( true, $all_covered, 'every admin card FEATURE flag is switchable (no toggle without a switch)' );
iwsl_assert_same( 22, count( $flag_map ), 'admin exposes all 22 tier-gated features' );
iwsl_assert_same( count( array_unique( array_values( $flag_map ) ) ), count( $flag_map ), 'admin card map has no duplicate FEATURE flags' );
