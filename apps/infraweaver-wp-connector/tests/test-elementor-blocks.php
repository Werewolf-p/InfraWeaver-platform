<?php
/**
 * Elementor Blocks (gate flag `elementor_blocks`, tier Pro): the engine
 * (IWSL_Elementor_Blocks) that registers a set of InfraWeaver Elementor widgets
 * under their own category — but ONLY when the entitlement is unlocked AND
 * Elementor is loaded.
 *
 * Runs under the zero-dependency harness. WordPress and Elementor are both
 * absent, so the test:
 *   1. exercises the pure static metadata (feature flag, widget class list,
 *      category args) with no dependencies,
 *   2. proves the gate BLOCKS — a locked/lower-tier site registers nothing,
 *   3. proves NO FATAL without Elementor — register() is a clean no-op when the
 *      page builder is not present,
 *   4. stubs a minimal `\Elementor\Widget_Base` + widgets/elements managers to
 *      prove the registration WIRING: the two hooks are added, the category is
 *      registered, and all four widgets are handed to the widgets manager.
 */

// ── recorder stubs (guarded; backed by globals) ───────────────────────────────

$GLOBALS['iwsl_eb_actions']       = array(); // hook names passed to add_action.
$GLOBALS['iwsl_eb_did_elementor'] = false;   // did_action('elementor/loaded') answer.

if ( ! function_exists( 'add_action' ) ) {
	function add_action( $hook, $callback, $priority = 10, $args = 1 ) {
		$GLOBALS['iwsl_eb_actions'][] = (string) $hook;
		return true;
	}
}
if ( ! function_exists( 'did_action' ) ) {
	function did_action( $hook ) {
		return ( 'elementor/loaded' === $hook && $GLOBALS['iwsl_eb_did_elementor'] ) ? 1 : 0;
	}
}

/** A recording Elementor widgets-manager (modern `register()` API). */
final class IWSL_EB_Widgets_Manager {
	/** @var object[] */
	public $registered = array();
	public function register( $widget ) {
		$this->registered[] = $widget;
	}
}

/** A recording Elementor elements-manager (category registration). */
final class IWSL_EB_Elements_Manager {
	/** @var array<string, mixed> */
	public $categories = array();
	public function add_category( $slug, $args ) {
		$this->categories[ (string) $slug ] = $args;
	}
}

// ── entitlement fixtures (mirror the lazy-load suite) ──────────────────────────

/** Unlocked gate: active + fresh heartbeat + elementor_blocks flag. */
function iwsl_eb_unlocked( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh.
	$store->set( 'entitlements', array( 'plus' => true, 'elementor_blocks' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** A gate seeded with an explicit state + flag map (for the blocked cases). */
function iwsl_eb_entitlements( int $now, string $state, array $flags, int $last_offset = 60000 ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $now - $last_offset );
	$store->set( 'entitlements', $flags );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

$EB_NOW = 20000000;

// ── 1. pure metadata (no dependencies) ────────────────────────────────────────

iwsl_assert_same( 'elementor_blocks', IWSL_Elementor_Blocks::FEATURE, 'FEATURE constant is elementor_blocks' );
iwsl_assert_same( 'infraweaver', IWSL_Elementor_Blocks::CATEGORY_SLUG, 'category slug is infraweaver' );

$classes = IWSL_Elementor_Blocks::widget_classes();
iwsl_assert_same( 4, count( $classes ), 'widget_classes(): exactly four widgets' );
iwsl_assert( in_array( 'IWSL_Widget_Callout', $classes, true ), 'widget_classes(): includes the Callout widget' );
iwsl_assert( in_array( 'IWSL_Widget_Feature_Grid', $classes, true ), 'widget_classes(): includes the Feature Grid widget' );
iwsl_assert( in_array( 'IWSL_Widget_Pricing_Table', $classes, true ), 'widget_classes(): includes the Pricing Table widget' );
iwsl_assert( in_array( 'IWSL_Widget_Notice', $classes, true ), 'widget_classes(): includes the Notice widget' );

$cat = IWSL_Elementor_Blocks::category_args();
iwsl_assert_same( 'InfraWeaver', $cat['title'], 'category_args(): title is InfraWeaver' );
iwsl_assert( isset( $cat['icon'] ) && '' !== $cat['icon'], 'category_args(): carries an icon' );

// ── 2. gate BLOCKS: a locked/lower-tier site registers nothing ────────────────

// (a) flag absent — register() returns at statement 1, no hooks attached.
$GLOBALS['iwsl_eb_actions']       = array();
$GLOBALS['iwsl_eb_did_elementor'] = true; // even with Elementor "present"…
$eb = new IWSL_Elementor_Blocks( iwsl_eb_entitlements( $EB_NOW, 'active', array( 'plus' => true ) ), new IWSL_Memory_Store() );
$eb->register();
iwsl_assert_same( array(), $GLOBALS['iwsl_eb_actions'], 'gate (flag absent): register() attaches no hooks' );

// (b) not active, even WITH the flag true.
$GLOBALS['iwsl_eb_actions'] = array();
$eb = new IWSL_Elementor_Blocks( iwsl_eb_entitlements( $EB_NOW, 'pending', array( 'plus' => true, 'elementor_blocks' => true ) ), new IWSL_Memory_Store() );
$eb->register();
iwsl_assert_same( array(), $GLOBALS['iwsl_eb_actions'], 'gate (not active): register() attaches no hooks despite the flag' );

// (c) stale heartbeat (3h), even WITH the flag true.
$GLOBALS['iwsl_eb_actions'] = array();
$eb = new IWSL_Elementor_Blocks( iwsl_eb_entitlements( $EB_NOW, 'active', array( 'plus' => true, 'elementor_blocks' => true ), 10800000 ), new IWSL_Memory_Store() );
$eb->register();
iwsl_assert_same( array(), $GLOBALS['iwsl_eb_actions'], 'gate (stale heartbeat): register() attaches no hooks despite the flag' );

// ── 3. NO FATAL without Elementor: unlocked but the page builder is absent ────
// Runs BEFORE the stub \Elementor\Widget_Base is defined, so class_exists is
// genuinely false and elementor_active() must answer false.

iwsl_assert_same( false, class_exists( '\\Elementor\\Widget_Base' ), 'precondition: Elementor base class not defined yet' );
$GLOBALS['iwsl_eb_did_elementor'] = false; // did_action('elementor/loaded') === 0.
iwsl_assert_same( false, IWSL_Elementor_Blocks::elementor_active(), 'elementor_active(): false when neither the action nor the class is present' );

$GLOBALS['iwsl_eb_actions'] = array();
$eb = new IWSL_Elementor_Blocks( iwsl_eb_unlocked( $EB_NOW ), new IWSL_Memory_Store() );
$eb->register(); // unlocked, but no Elementor → clean no-op, no fatal.
iwsl_assert_same( array(), $GLOBALS['iwsl_eb_actions'], 'unlocked + no Elementor: register() attaches no hooks (no fatal)' );

// register_widgets called directly with no Elementor base class also no-ops safely.
$mgr_none = new IWSL_EB_Widgets_Manager();
$eb->register_widgets( $mgr_none );
iwsl_assert_same( 0, count( $mgr_none->registered ), 'unlocked + no Elementor: register_widgets() registers nothing (guarded)' );

// ── 4. registration WIRING: unlocked + Elementor present ──────────────────────
// Define a minimal Elementor base so the widget subclasses can be declared and
// instantiated. Only the constructor runs on instantiation (control/render
// method bodies are never executed here), so a no-op base is sufficient.

if ( ! class_exists( '\\Elementor\\Widget_Base' ) ) {
	eval( 'namespace Elementor; class Widget_Base { public function __construct( $data = array(), $args = null ) {} }' );
}
$GLOBALS['iwsl_eb_did_elementor'] = true;
iwsl_assert_same( true, IWSL_Elementor_Blocks::elementor_active(), 'elementor_active(): true once Elementor is present' );

// register() now attaches exactly the two Elementor hooks.
$GLOBALS['iwsl_eb_actions'] = array();
$eb = new IWSL_Elementor_Blocks( iwsl_eb_unlocked( $EB_NOW ), new IWSL_Memory_Store() );
$eb->register();
iwsl_assert( in_array( 'elementor/widgets/register', $GLOBALS['iwsl_eb_actions'], true ), 'unlocked + Elementor: hooks widgets/register' );
iwsl_assert( in_array( 'elementor/elements/categories_registered', $GLOBALS['iwsl_eb_actions'], true ), 'unlocked + Elementor: hooks categories_registered' );
iwsl_assert_same( 2, count( $GLOBALS['iwsl_eb_actions'] ), 'unlocked + Elementor: exactly two hooks attached' );

// register_widgets() hands all four widgets to the manager.
$mgr = new IWSL_EB_Widgets_Manager();
$eb->register_widgets( $mgr );
iwsl_assert_same( 4, count( $mgr->registered ), 'register_widgets(): all four widgets registered' );
iwsl_assert( $mgr->registered[0] instanceof IWSL_Widget_Callout, 'register_widgets(): first widget is the Callout' );
iwsl_assert( $mgr->registered[0] instanceof \Elementor\Widget_Base, 'register_widgets(): widgets subclass \Elementor\Widget_Base' );

// each widget reports its own name/title/category correctly.
$callout = new IWSL_Widget_Callout();
iwsl_assert_same( 'iwsl-callout', $callout->get_name(), 'Callout widget: get_name() is iwsl-callout' );
iwsl_assert( in_array( 'infraweaver', (array) $callout->get_categories(), true ), 'Callout widget: sits in the infraweaver category' );
iwsl_assert( in_array( 'infraweaver', (array) $callout->get_keywords(), true ), 'Callout widget: carries the infraweaver keyword' );

// register_category() registers the infraweaver category with its args.
$elements = new IWSL_EB_Elements_Manager();
$eb->register_category( $elements );
iwsl_assert( isset( $elements->categories['infraweaver'] ), 'register_category(): infraweaver category registered' );
iwsl_assert_same( 'InfraWeaver', $elements->categories['infraweaver']['title'], 'register_category(): category title is InfraWeaver' );

// ── 5. gate STILL blocks the callbacks even when Elementor is present ──────────

$mgr_locked = new IWSL_EB_Widgets_Manager();
$eb_locked  = new IWSL_Elementor_Blocks( iwsl_eb_entitlements( $EB_NOW, 'active', array( 'plus' => true ) ), new IWSL_Memory_Store() );
$eb_locked->register_widgets( $mgr_locked );
iwsl_assert_same( 0, count( $mgr_locked->registered ), 'locked callback: register_widgets() registers nothing even with Elementor present' );

$elements_locked = new IWSL_EB_Elements_Manager();
$eb_locked->register_category( $elements_locked );
iwsl_assert_same( 0, count( $elements_locked->categories ), 'locked callback: register_category() adds nothing even with Elementor present' );

// ── 6. notice widget: type→icon mapping is a bounded, known set ────────────────

$types = IWSL_Widget_Notice::notice_types();
iwsl_assert_same( 4, count( $types ), 'Notice widget: four notice types' );
iwsl_assert( isset( $types['info'], $types['success'], $types['warning'], $types['error'] ), 'Notice widget: info/success/warning/error all present' );
