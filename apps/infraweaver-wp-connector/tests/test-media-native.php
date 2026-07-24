<?php
/**
 * Native-media takeover (gate flag `media_folders` + option
 * `iwsl_media_explorer.replace_native`, default OFF): the IWSL_Media_Native engine
 * plus the signed `media.config.get/set` shims.
 *
 * The four load-bearing invariants, each proven here:
 *   1. OFF = HOOK-ABSENCE. With the toggle off (default) — or the feature locked —
 *      register() attaches ZERO actions/filters, so the site is byte-for-byte stock.
 *   2. BROWSE = upload_files (read tier), never public/nopriv, never manage_options.
 *      Every MUTATION keeps manage_options on its own engine (regression fence).
 *   3. FALLBACK. The modal injector is additive (no destructive wp.media.view.*
 *      reassignment) and wraps its one seam in try/catch that restores native.
 *   4. SIGNED-CHANNEL ONLY. media.config.* are signed methods with a strict
 *      { replace_native: bool } validator — no REST/public endpoint.
 *
 * Runs under the zero-dependency harness in its OWN subprocess, so the WP-function
 * fakes it defines (add_action/add_filter recorder, a controllable current_user_can,
 * a throwing wp_send_json_error) never leak into a sibling suite.
 */

// The redirect handler must NOT exit() under the harness — this sentinel gates it.
defined( 'IWSL_TEST' ) || define( 'IWSL_TEST', true );

require_once __DIR__ . '/../includes/class-iwsl-store.php';
require_once __DIR__ . '/../includes/class-iwsl-entitlements.php';
foreach ( array(
	'class-iwsl-media-protection.php',
	'class-iwsl-media-folders.php',
	'class-iwsl-media-library.php',
	'class-iwsl-media-detail.php',
	'class-iwsl-media-native.php',
) as $iwsl_mn_inc ) {
	$iwsl_mn_path = __DIR__ . '/../includes/' . $iwsl_mn_inc;
	if ( file_exists( $iwsl_mn_path ) ) {
		require_once $iwsl_mn_path;
	}
}

// ── recorders + controllable caps ────────────────────────────────────────────────

$GLOBALS['iwsl_mn_actions'] = array(); // hook => [callbacks...]
$GLOBALS['iwsl_mn_filters'] = array();
$GLOBALS['iwsl_mn_caps']    = array( 'manage_options' => true, 'upload_files' => true );
$GLOBALS['iwsl_mn_cap_log'] = array(); // every cap current_user_can() was asked about.

function iwsl_mn_reset_hooks(): void {
	$GLOBALS['iwsl_mn_actions'] = array();
	$GLOBALS['iwsl_mn_filters'] = array();
}

// ── throwing stop signal so a guard's err() is observable without exit ────────────

if ( ! class_exists( 'IWSL_MN_Stop' ) ) {
	final class IWSL_MN_Stop extends Exception {
		/** @var string */ public $reason;
		public function __construct( string $reason ) {
			parent::__construct( $reason );
			$this->reason = $reason;
		}
	}
}

// ── WP-function fakes (guarded; this suite owns them) ─────────────────────────────

if ( ! function_exists( 'add_action' ) ) {
	function add_action( $hook, $cb = null, $priority = 10, $args = 1 ) {
		$GLOBALS['iwsl_mn_actions'][ (string) $hook ][] = $cb;
		return true;
	}
}
if ( ! function_exists( 'add_filter' ) ) {
	function add_filter( $hook, $cb = null, $priority = 10, $args = 1 ) {
		$GLOBALS['iwsl_mn_filters'][ (string) $hook ][] = $cb;
		return true;
	}
}
if ( ! function_exists( 'current_user_can' ) ) {
	function current_user_can( $cap ) {
		$GLOBALS['iwsl_mn_cap_log'][] = (string) $cap;
		return ! empty( $GLOBALS['iwsl_mn_caps'][ (string) $cap ] );
	}
}
if ( ! function_exists( 'check_ajax_referer' ) ) {
	function check_ajax_referer( $action = -1, $query_arg = false, $die = true ) {
		return 1; // nonce accepted in the harness.
	}
}
if ( ! function_exists( 'wp_send_json_error' ) ) {
	function wp_send_json_error( $data = null, $status = null ) {
		$reason = is_array( $data ) && isset( $data['reason'] ) ? (string) $data['reason'] : 'error';
		throw new IWSL_MN_Stop( $reason );
	}
}
if ( ! function_exists( 'wp_send_json_success' ) ) {
	function wp_send_json_success( $data = null, $status = null ) {
		$GLOBALS['iwsl_mn_ok'] = $data;
		throw new IWSL_MN_Stop( 'ok' ); // stop like WP would, so we can assert reach.
	}
}
if ( ! function_exists( 'wp_create_nonce' ) ) {
	function wp_create_nonce( $action = -1 ) {
		return 'nonce-' . (string) $action;
	}
}
if ( ! function_exists( 'admin_url' ) ) {
	function admin_url( $path = '' ) {
		return 'https://fixture-site.test/wp-admin/' . ltrim( (string) $path, '/' );
	}
}
if ( ! function_exists( 'add_query_arg' ) ) {
	function add_query_arg( $args, $url ) {
		$pairs = array();
		foreach ( (array) $args as $k => $v ) {
			$pairs[] = rawurlencode( (string) $k ) . '=' . rawurlencode( (string) $v );
		}
		$sep = ( false === strpos( (string) $url, '?' ) ) ? '?' : '&';
		return (string) $url . $sep . implode( '&', $pairs );
	}
}
if ( ! function_exists( 'sanitize_text_field' ) ) {
	function sanitize_text_field( $s ) {
		return trim( preg_replace( '/[\r\n\t]+/', ' ', (string) $s ) );
	}
}
if ( ! function_exists( 'wp_unslash' ) ) {
	function wp_unslash( $v ) {
		return $v;
	}
}
if ( ! function_exists( 'wp_json_encode' ) ) {
	function wp_json_encode( $data, $options = 0, $depth = 512 ) {
		return json_encode( $data, $options, $depth );
	}
}

// ── plugin builders (mirror the email suite's entitlement-grant recipe) ──────────

/** A locked plugin: fresh store, unenrolled → media_folders gate locked. */
function iwsl_mn_locked_plugin(): IWSL_Plugin {
	return new IWSL_Plugin( new IWSL_Memory_Store(), iwsl_now_t0( 5000 ) );
}

/** An enrolled+active plugin with a fresh heartbeat and media_folders GRANTED. */
function iwsl_mn_unlocked_plugin(): IWSL_Plugin {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$plugin = new IWSL_Plugin( $store, iwsl_now_t0( 5000 ) );
	$plugin->entitlements()->record_verified_contact();
	$handlers_ref = new ReflectionMethod( 'IWSL_Plugin', 'command_handlers' );
	$handlers_ref->setAccessible( true );
	$registry                      = $handlers_ref->invoke( null );
	$set_env                       = new stdClass();
	$set_env->params               = new stdClass();
	$set_env->params->entitlements = (object) array( 'media_folders' => true );
	$registry['entitlements.set']->run( $plugin, $set_env );
	return $plugin;
}

$handlers_ref = new ReflectionMethod( 'IWSL_Plugin', 'command_handlers' );
$handlers_ref->setAccessible( true );
$registry = $handlers_ref->invoke( null );

// ════════════════════════════════════════════════════════════════════════════════
echo "\n-- native: option default-off --\n";
// ════════════════════════════════════════════════════════════════════════════════

$unlocked = iwsl_mn_unlocked_plugin();
$native   = new IWSL_Media_Native( $unlocked->entitlements(), $unlocked->store() );

iwsl_assert_same( false, $native->replace_native(), 'default: replace_native is OFF on a fresh site' );
iwsl_assert_same( false, $native->is_replacing(), 'default: is_replacing false (toggle off) even when unlocked' );
iwsl_assert_same( true, $unlocked->entitlements()->evaluate( 'media_folders' )['unlocked'], 'setup: media_folders is unlocked on the granted plugin' );

// ════════════════════════════════════════════════════════════════════════════════
echo "\n-- native: HOOK-ABSENCE when off (the provable zero-change path) --\n";
// ════════════════════════════════════════════════════════════════════════════════

// (a) unlocked but toggle OFF → register attaches nothing.
iwsl_mn_reset_hooks();
$native->register();
iwsl_assert_same( 0, count( $GLOBALS['iwsl_mn_actions'] ), 'off (toggle off): register adds ZERO actions' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_mn_filters'] ), 'off (toggle off): register adds ZERO filters' );

// (b) toggle ON but feature LOCKED → still nothing (gate half of the composite).
$locked = iwsl_mn_locked_plugin();
$native_locked = new IWSL_Media_Native( $locked->entitlements(), $locked->store() );
$native_locked->set_replace_native( true ); // refused (locked) — writes nothing, stays off.
iwsl_assert_same( false, $native_locked->is_replacing(), 'off (locked): is_replacing false even with toggle attempted on' );
iwsl_mn_reset_hooks();
$native_locked->register();
iwsl_assert_same( 0, count( $GLOBALS['iwsl_mn_actions'] ), 'off (locked): register adds ZERO actions' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_mn_filters'] ), 'off (locked): register adds ZERO filters' );

// ════════════════════════════════════════════════════════════════════════════════
echo "\n-- native: ON wires EXACTLY the additive read surface (no nopriv, no mutation) --\n";
// ════════════════════════════════════════════════════════════════════════════════

$unlocked_on = iwsl_mn_unlocked_plugin();
$native_on   = new IWSL_Media_Native( $unlocked_on->entitlements(), $unlocked_on->store() );
$native_on->set_replace_native( true );
iwsl_assert_same( true, $native_on->is_replacing(), 'on: is_replacing true when unlocked + toggle on' );

iwsl_mn_reset_hooks();
$native_on->register();
$hooks = array_keys( $GLOBALS['iwsl_mn_actions'] );
sort( $hooks );
$expected = array(
	'load-upload.php',
	'wp_ajax_' . IWSL_Media_Native::AJAX_GET,
	'wp_ajax_' . IWSL_Media_Native::AJAX_LIST,
	'wp_ajax_' . IWSL_Media_Native::AJAX_TREE,
	'wp_enqueue_media',
);
sort( $expected );
iwsl_assert_same( $expected, $hooks, 'on: register wires EXACTLY the 5 expected actions' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_mn_filters'] ), 'on: register wires no filters' );

$nopriv = 0;
$mutation_hit = 0;
$mutation_actions = array( 'iwsl_mf_assign', 'iwsl_mf_tag', 'iwsl_mf_folder_create', 'iwsl_mf_folder_rename', 'iwsl_mf_folder_delete', 'iwsl_mf_folder_move' );
foreach ( $hooks as $h ) {
	if ( false !== strpos( $h, 'nopriv' ) ) {
		$nopriv++;
	}
	foreach ( $mutation_actions as $m ) {
		if ( false !== strpos( $h, $m ) ) {
			$mutation_hit++;
		}
	}
}
iwsl_assert_same( 0, $nopriv, 'on: NO nopriv (public) AJAX action is ever registered' );
iwsl_assert_same( 0, $mutation_hit, 'on: NO folder/tag MUTATION action is registered by the native engine' );

// ════════════════════════════════════════════════════════════════════════════════
echo "\n-- native: browse guard is upload_files (read tier), never manage_options --\n";
// ════════════════════════════════════════════════════════════════════════════════

// capability_reason() must ask for upload_files, not manage_options.
$GLOBALS['iwsl_mn_cap_log'] = array();
$GLOBALS['iwsl_mn_caps']    = array( 'manage_options' => false, 'upload_files' => true );
iwsl_assert_same( '', $native_on->capability_reason(), 'guard: upload_files granted → allowed (even without manage_options)' );
iwsl_assert( in_array( 'upload_files', $GLOBALS['iwsl_mn_cap_log'], true ), 'guard: the read tier CHECKS upload_files' );
iwsl_assert( ! in_array( 'manage_options', $GLOBALS['iwsl_mn_cap_log'], true ), 'guard: the read tier does NOT gate on manage_options' );

$GLOBALS['iwsl_mn_caps'] = array( 'manage_options' => true, 'upload_files' => false );
iwsl_assert_same( 'forbidden', $native_on->capability_reason(), 'guard: upload_files denied → forbidden (manage_options does NOT satisfy the read tier)' );

// ajax_guard(): denied upload_files → stops with forbidden.
$GLOBALS['iwsl_mn_caps'] = array( 'upload_files' => false );
$guard_stopped = '';
try {
	$native_on->ajax_guard();
} catch ( IWSL_MN_Stop $e ) {
	$guard_stopped = $e->reason;
}
iwsl_assert_same( 'forbidden', $guard_stopped, 'guard: ajax_guard stops (403 forbidden) when upload_files is denied' );

// ajax_guard(): granted read cap + unlocked gate → passes cleanly.
$GLOBALS['iwsl_mn_caps'] = array( 'upload_files' => true );
$passed = true;
try {
	$native_on->ajax_guard();
} catch ( IWSL_MN_Stop $e ) {
	$passed = false;
}
iwsl_assert_same( true, $passed, 'guard: ajax_guard passes when upload_files granted + gate unlocked' );

// ajax_guard(): granted read cap but LOCKED gate → stops with entitlement-locked.
$native_locked_guard = new IWSL_Media_Native( $locked->entitlements(), $locked->store() );
$GLOBALS['iwsl_mn_caps'] = array( 'upload_files' => true );
$locked_reason = '';
try {
	$native_locked_guard->ajax_guard();
} catch ( IWSL_MN_Stop $e ) {
	$locked_reason = $e->reason;
}
iwsl_assert_same( 'entitlement-locked', $locked_reason, 'guard: ajax_guard stops (entitlement-locked) on a locked site' );

// A browse ENDPOINT is guarded: handle_browse_tree with the read cap denied stops
// BEFORE it ever reaches the folder engine.
$GLOBALS['iwsl_mn_caps'] = array( 'upload_files' => false );
$browse_stopped = '';
try {
	$native_on->handle_browse_tree();
} catch ( IWSL_MN_Stop $e ) {
	$browse_stopped = $e->reason;
}
iwsl_assert_same( 'forbidden', $browse_stopped, 'browse: handle_browse_tree is guarded (stops when upload_files denied)' );
$GLOBALS['iwsl_mn_caps'] = array( 'manage_options' => true, 'upload_files' => true );

// ════════════════════════════════════════════════════════════════════════════════
echo "\n-- native: mutations keep manage_options (regression fence, source scan) --\n";
// ════════════════════════════════════════════════════════════════════════════════

$native_src = (string) file_get_contents( __DIR__ . '/../includes/class-iwsl-media-native.php' );
iwsl_assert( false === strpos( $native_src, 'wp_ajax_nopriv' ), 'fence: native engine source never registers a wp_ajax_nopriv (public) action' );
iwsl_assert( false !== strpos( $native_src, "current_user_can( self::READ_CAP )" ), 'fence: native read guard keys on READ_CAP (upload_files)' );

$folders_src = (string) file_get_contents( __DIR__ . '/../includes/class-iwsl-media-folders.php' );
iwsl_assert( false !== strpos( $folders_src, "current_user_can( 'manage_options' )" ), 'fence: the folders MUTATION engine still demands manage_options (unchanged)' );

// ════════════════════════════════════════════════════════════════════════════════
echo "\n-- native: media.config.* are SIGNED methods with a strict validator --\n";
// ════════════════════════════════════════════════════════════════════════════════

$allowed = IWSL_Plugin::allowed_methods();
iwsl_assert( array_key_exists( 'media.config.get', $allowed ), 'signed: media.config.get is an allowed signed method' );
iwsl_assert( array_key_exists( 'media.config.set', $allowed ), 'signed: media.config.set is an allowed signed method' );
iwsl_assert_same( null, $allowed['media.config.get'], 'signed: media.config.get takes empty params (null validator)' );

$set_validator = $registry['media.config.set']->validator;
iwsl_assert_same( true, $set_validator( (object) array( 'replace_native' => true ) ), 'validator: { replace_native: true } accepted' );
iwsl_assert_same( true, $set_validator( (object) array( 'replace_native' => false ) ), 'validator: { replace_native: false } accepted' );
iwsl_assert_same( false, $set_validator( (object) array() ), 'validator: missing replace_native rejected' );
iwsl_assert_same( false, $set_validator( (object) array( 'replace_native' => 1 ) ), 'validator: non-bool replace_native rejected' );
iwsl_assert_same( false, $set_validator( (object) array( 'replace_native' => 'yes' ) ), 'validator: string replace_native rejected' );
iwsl_assert_same( false, $set_validator( (object) array( 'replace_native' => true, 'evil' => 1 ) ), 'validator: unknown top-level key rejected' );
iwsl_assert_same( false, $set_validator( 'nope' ), 'validator: non-object params rejected' );

// ── signed runners: gate-first, idempotent, no public endpoint ──────────────────
$empty_env         = new stdClass();
$empty_env->params = new stdClass();

$cfg_plugin = iwsl_mn_unlocked_plugin();
list( $ok_g0, $get0 ) = $registry['media.config.get']->run( $cfg_plugin, $empty_env );
iwsl_assert_same( true, $ok_g0, 'get: command handled' );
iwsl_assert_same( false, $get0['locked'], 'get: unlocked when entitled+fresh' );
iwsl_assert_same( false, $get0['replace_native'], 'get: replace_native reads OFF by default' );

$set_env         = new stdClass();
$set_env->params = (object) array( 'replace_native' => true );
list( $ok_s, $set_res ) = $registry['media.config.set']->run( $cfg_plugin, $set_env );
iwsl_assert_same( true, $ok_s, 'set: command handled' );
iwsl_assert_same( true, $set_res['ok'], 'set: save ok' );
iwsl_assert_same( true, $set_res['replace_native'], 'set: echoes replace_native=true' );

list( , $get1 ) = $registry['media.config.get']->run( $cfg_plugin, $empty_env );
iwsl_assert_same( true, $get1['replace_native'], 'get: reflects the flip to ON' );

// LOCKED site cannot turn ON — gate-first, writes nothing.
$locked_plugin = iwsl_mn_locked_plugin();
$set_on_locked         = new stdClass();
$set_on_locked->params = (object) array( 'replace_native' => true );
list( , $set_locked ) = $registry['media.config.set']->run( $locked_plugin, $set_on_locked );
iwsl_assert_same( false, $set_locked['ok'], 'set(locked): refused (cannot enable a locked site)' );
iwsl_assert_same( true, $set_locked['locked'], 'set(locked): reports the gate as locked' );
iwsl_assert_same( false, ( new IWSL_Media_Native( $locked_plugin->entitlements(), $locked_plugin->store() ) )->replace_native(), 'set(locked): nothing was written' );

list( , $get_locked ) = $registry['media.config.get']->run( $locked_plugin, $empty_env );
iwsl_assert_same( true, $get_locked['locked'], 'get(locked): reports locked, not state' );

// Turning OFF is always honoured (even mid-downgrade).
$set_off_locked         = new stdClass();
$set_off_locked->params = (object) array( 'replace_native' => false );
list( , $set_off ) = $registry['media.config.set']->run( $locked_plugin, $set_off_locked );
iwsl_assert_same( true, $set_off['ok'], 'set(off,locked): turning the takeover OFF is always allowed' );

// ════════════════════════════════════════════════════════════════════════════════
echo "\n-- native: upload.php takeover + escape hatch --\n";
// ════════════════════════════════════════════════════════════════════════════════

$target = $native_on->redirect_target( array() );
iwsl_assert_same( $native_on->explorer_url(), $target, 'redirect: plain upload.php → the Explorer page' );
iwsl_assert( false !== strpos( (string) $target, 'page=' . IWSL_Media_Native::EXPLORER_PAGE ), 'redirect: target is the Explorer submenu' );

iwsl_assert_same( null, $native_on->redirect_target( array( IWSL_Media_Native::ESCAPE_ARG => '1' ) ), 'redirect: ?iwsl_native=1 escape hatch renders stock (null)' );

$deep = $native_on->redirect_target( array( 's' => 'sunset', IWSL_Media_Folders::LIBRARY_FILTER_ARG => 42 ) );
iwsl_assert( false !== strpos( (string) $deep, 's=sunset' ), 'redirect: carries the search deep-link' );
iwsl_assert( false !== strpos( (string) $deep, 'folder=42' ), 'redirect: carries the folder deep-link' );

// With the takeover OFF, the redirect rule declines (renders stock).
iwsl_assert_same( null, $native->redirect_target( array() ), 'redirect: OFF site never redirects upload.php' );

// ════════════════════════════════════════════════════════════════════════════════
echo "\n-- native: localized_config shape (read surface + gates for the viewer) --\n";
// ════════════════════════════════════════════════════════════════════════════════

$GLOBALS['iwsl_mn_caps'] = array( 'manage_options' => true, 'upload_files' => true );
$cfg = $native_on->localized_config();
iwsl_assert_same( IWSL_Media_Native::AJAX_TREE, $cfg['actions']['tree'], 'config: tree action wired' );
iwsl_assert_same( IWSL_Media_Native::AJAX_LIST, $cfg['actions']['list'], 'config: list action wired' );
iwsl_assert_same( IWSL_Media_Native::AJAX_GET, $cfg['actions']['get'], 'config: get action wired' );
iwsl_assert_same( true, $cfg['features']['media_folders'], 'config: media_folders feature flag reported unlocked' );
iwsl_assert_same( IWSL_Media_Native::ESCAPE_ARG, $cfg['escapeArg'], 'config: escape arg exposed for the "classic library" link' );
iwsl_assert( isset( $cfg['nonce'] ) && '' !== $cfg['nonce'], 'config: a read nonce is minted' );
iwsl_assert( isset( $cfg['can']['upload_files'] ) && isset( $cfg['can']['manage_options'] ), 'config: capability map present so the UI hides verbs the user cannot perform' );

// ════════════════════════════════════════════════════════════════════════════════
echo "\n-- native: modal fallback is additive + try/catch-restores native (JS scan) --\n";
// ════════════════════════════════════════════════════════════════════════════════

$modal_js  = (string) file_get_contents( __DIR__ . '/../includes/assets/iwsl-media-modal.js' );
$viewer_js = (string) file_get_contents( __DIR__ . '/../includes/assets/iwsl-media-viewer.js' );

iwsl_assert( false !== strpos( $modal_js, "from \"./iwsl-media-viewer.js\"" ), 'fallback: modal imports the shared viewer (identical panel everywhere)' );
iwsl_assert( false !== strpos( $viewer_js, 'export function createAdminViewer' ), 'fallback: the shared viewer still exports createAdminViewer' );
iwsl_assert( false !== strpos( $modal_js, 'createAdminViewer' ), 'fallback: modal reuses createAdminViewer for the detail panel' );

iwsl_assert( false !== strpos( $modal_js, 'try {' ) && false !== strpos( $modal_js, 'catch' ), 'fallback: the injection seam is wrapped in try/catch' );
iwsl_assert( false !== strpos( $modal_js, 'restore()' ), 'fallback: on any throw the seam RESTORES the saved native methods' );
iwsl_assert( false !== strpos( $modal_js, 's.proto[s.key] = s.fn' ), 'fallback: restore puts the exact native prototype method back' );
iwsl_assert( false !== strpos( $modal_js, 'export function installIwslState' ), 'fallback: the seam is a single exported, testable function' );
iwsl_assert( false !== strpos( $modal_js, 'warnOnce' ) && false !== strpos( $modal_js, '_warned' ), 'fallback: failures log a single per-page warning' );

// ADDITIVE: never a wholesale reassignment of the core frame constructors.
iwsl_assert( false === strpos( $modal_js, 'MediaFrame.Select =' ), 'fallback: NEVER destructively replaces wp.media.view.MediaFrame.Select' );
iwsl_assert( false === strpos( $modal_js, 'MediaFrame.Post =' ), 'fallback: NEVER destructively replaces wp.media.view.MediaFrame.Post' );
iwsl_assert( false !== strpos( $modal_js, 'originalCreateStates.apply' ), 'fallback: additive — native createStates runs FIRST, ours only adds' );
iwsl_assert( false !== strpos( $modal_js, 'frame.setState("library")' ), 'fallback: a content-render failure reverts THAT frame to the native library (never a blank tab)' );
iwsl_assert( false !== strpos( $modal_js, 'wpMedia.attachment( id )' ) || false !== strpos( $modal_js, 'wpMedia.attachment(id)' ), 'insert contract: a chosen tile resolves to a real wp.media Attachment model' );
