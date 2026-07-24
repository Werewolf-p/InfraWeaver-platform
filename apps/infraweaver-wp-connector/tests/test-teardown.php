<?php
/**
 * IWSL_Teardown — the per-feature footprint-purge dispatcher.
 *
 * Runs WP-less: a tiny in-memory options table stands in for the WordPress
 * options API so a real IWSL_WP_Store (and the engines it drives) work under the
 * harness. Every WP function is function_exists-guarded so this suite never
 * fatals when run in isolation.
 *
 * Under test:
 *   - flush_page_cache() is a safe no-op with no plugin/cache present.
 *   - engine_for() maps a flag to the right engine class, and null for unknown.
 *   - purge() returns [] for an unknown flag and an array via method_exists.
 *   - clean_at_init() purges ONLY features the operator explicitly switched OFF —
 *     never on a lapsed entitlement (that would risk data-loss on a transient hiccup).
 */

declare(strict_types=1);

// IWSL_WP_Store is not loaded by the harness bootstrap (it needs the WP options
// API); the dispatcher and the engines it builds do. Load it + a fake options
// table so a real IWSL_WP_Store round-trips in-memory.
require_once __DIR__ . '/../includes/class-iwsl-wp-store.php';
// Self-require the dispatcher: it is deliberately NOT in the harness preload list,
// so that sibling suites can define a lightweight IWSL_Teardown test-double to
// verify their flush_page_cache() call sites without colliding with the real class.
require_once __DIR__ . '/../includes/class-iwsl-teardown.php';

$GLOBALS['iwsl_td_opts']    = array();
$GLOBALS['iwsl_td_deleted'] = array();

if ( ! function_exists( 'get_option' ) ) {
	function get_option( string $name, $default = false ) {
		return array_key_exists( $name, $GLOBALS['iwsl_td_opts'] ) ? $GLOBALS['iwsl_td_opts'][ $name ] : $default;
	}
}
if ( ! function_exists( 'update_option' ) ) {
	function update_option( string $name, $value, $autoload = null ): bool {
		$GLOBALS['iwsl_td_opts'][ $name ] = $value;
		return true;
	}
}
if ( ! function_exists( 'add_option' ) ) {
	function add_option( string $name, $value = '', $deprecated = '', $autoload = null ): bool {
		if ( array_key_exists( $name, $GLOBALS['iwsl_td_opts'] ) ) {
			return false;
		}
		$GLOBALS['iwsl_td_opts'][ $name ] = $value;
		return true;
	}
}
if ( ! function_exists( 'delete_option' ) ) {
	function delete_option( string $name ): bool {
		$GLOBALS['iwsl_td_deleted'][] = $name;
		unset( $GLOBALS['iwsl_td_opts'][ $name ] );
		return true;
	}
}

/** Build entitlements that grant every switchable flag at a fresh, active link. */
function iwsl_td_ent_all(): IWSL_Entitlements {
	$now   = 10000000;
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 1000 ); // fresh (< 2h)
	$store->set( 'entitlements', array_fill_keys( array_keys( IWSL_Feature_Switches::switchable() ), true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

$ent      = iwsl_td_ent_all();
$wp_store = new IWSL_WP_Store();

// ── flush_page_cache(): safe no-op with no plugin/cache present ─────────────────
// The harness never loads infraweaver-connector.php, so iwsl_plugin() is
// undefined; flush must short-circuit on that guard and NOT fatal.
iwsl_assert( ! function_exists( 'iwsl_plugin' ), 'harness has no iwsl_plugin() — flush must early-return' );
IWSL_Teardown::flush_page_cache(); // must not fatal
iwsl_assert( true, 'flush_page_cache() returned safely with no plugin/cache present' );

// ── flags(): the switchable set plus the FREE perf audit ───────────────────────
$flags = IWSL_Teardown::flags();
iwsl_assert_same( 26, count( $flags ), 'flags() = 25 switchable + perf_audit' );
iwsl_assert( in_array( 'response_scan', $flags, true ), 'flags() includes response_scan' );
iwsl_assert( in_array( 'media_protection', $flags, true ), 'flags() includes media_protection' );
iwsl_assert( in_array( IWSL_Teardown::FLAG_PERF_AUDIT, $flags, true ), 'flags() includes the FREE perf_audit' );

// ── engine_for(): right class for a sample of flags, null for unknown ──────────
iwsl_assert( IWSL_Teardown::engine_for( 'lazy_load', $ent, $wp_store ) instanceof IWSL_Lazy_Load, 'lazy_load → IWSL_Lazy_Load' );
iwsl_assert( IWSL_Teardown::engine_for( 'page_cache', $ent, $wp_store ) instanceof IWSL_Page_Cache, 'page_cache → IWSL_Page_Cache (ctor takes $ent only)' );
iwsl_assert( IWSL_Teardown::engine_for( 'media_protection', $ent, $wp_store ) instanceof IWSL_Media_Protection, 'media_protection → IWSL_Media_Protection' );
iwsl_assert( IWSL_Teardown::engine_for( 'elementor_blocks', $ent, $wp_store ) instanceof IWSL_Elementor_Blocks, 'elementor_blocks → IWSL_Elementor_Blocks' );
iwsl_assert( IWSL_Teardown::engine_for( IWSL_Teardown::FLAG_PERF_AUDIT, $ent, $wp_store ) instanceof IWSL_Perf_Audit, 'perf_audit → IWSL_Perf_Audit (ctor takes $store only)' );
iwsl_assert_same( null, IWSL_Teardown::engine_for( 'not_a_feature', $ent, $wp_store ), 'unknown flag → null' );
iwsl_assert_same( null, IWSL_Teardown::engine_for( '', $ent, $wp_store ), 'empty flag → null' );

// ── purge(): [] for unknown, array for a real engine (method_exists dispatch) ──
iwsl_assert_same( array(), IWSL_Teardown::purge( 'not_a_feature', $ent, $wp_store ), 'purge(unknown flag) returns []' );
$purged = IWSL_Teardown::purge( 'lazy_load', $ent, $wp_store );
iwsl_assert( is_array( $purged ), 'purge(lazy_load) dispatches to the engine and returns an array' );

// ── clean_at_init(): purges ONLY off/un-entitled features ──────────────────────
// Scenario A: everything switched ON and entitled → clean_at_init purges nothing.
$sw_all_on                     = new IWSL_Feature_Switches( $ent, new IWSL_Memory_Store() );
$GLOBALS['iwsl_td_deleted']    = array();
IWSL_Teardown::clean_at_init( $sw_all_on, $ent, $wp_store );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_td_deleted'] ), 'all-on + entitled → clean_at_init purges nothing' );

// Scenario B: lazy_load switched OFF (all others on + entitled) → only lazy_load
// is purged. Its purge deletes option key `iwsl_lazy_load` via the WP store,
// which our fake delete_option records.
$sw_store_off = new IWSL_Memory_Store();
$sw_store_off->set( IWSL_Feature_Switches::OPTION, array( 'lazy_load' => false ) );
$sw_lazy_off                = new IWSL_Feature_Switches( $ent, $sw_store_off );
$GLOBALS['iwsl_td_deleted'] = array();
IWSL_Teardown::clean_at_init( $sw_lazy_off, $ent, $wp_store );
iwsl_assert( in_array( 'iwsl_lazy_load', $GLOBALS['iwsl_td_deleted'], true ), 'lazy_load OFF → its footprint option is purged at init' );
iwsl_assert( ! in_array( 'iwsl_page_cache', $GLOBALS['iwsl_td_deleted'], true ), 'a still-active feature is NOT purged at init' );

// Scenario C (CRITICAL safety guarantee): a feature whose ENTITLEMENT has lapsed
// but whose operator switch is still ON must NOT be purged. A transient, reversible
// loss of entitlement (a stale console heartbeat, a re-enroll/rotation, or a
// backward clock step) must never delete data — the feature just goes dormant.
// Here the site is unenrolled (nothing unlocked) yet no switch is off, so
// clean_at_init purges NOTHING.
$now_c      = 10000000;
$ent_none   = new IWSL_Entitlements(
	( static function () { $s = new IWSL_Memory_Store(); $s->set( 'state', 'unenrolled' ); return $s; } )(),
	static function () use ( $now_c ): int {
		return $now_c;
	}
);
$sw_none                    = new IWSL_Feature_Switches( $ent_none, new IWSL_Memory_Store() );
$GLOBALS['iwsl_td_deleted'] = array();
IWSL_Teardown::clean_at_init( $sw_none, $ent_none, $wp_store );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_td_deleted'] ), 'un-entitled but switch ON → clean_at_init purges NOTHING (no data-loss on a transient entitlement lapse)' );

// Scenario D: un-entitled AND the operator has explicitly switched a feature OFF →
// that feature (and only it) is still purged. A deliberate disable is always honoured.
$sw_off_store = new IWSL_Memory_Store();
$sw_off_store->set( IWSL_Feature_Switches::OPTION, array( 'lazy_load' => false ) );
$sw_none_off                = new IWSL_Feature_Switches( $ent_none, $sw_off_store );
$GLOBALS['iwsl_td_deleted'] = array();
IWSL_Teardown::clean_at_init( $sw_none_off, $ent_none, $wp_store );
iwsl_assert( in_array( 'iwsl_lazy_load', $GLOBALS['iwsl_td_deleted'], true ), 'explicitly switched-off feature IS purged even when un-entitled' );
