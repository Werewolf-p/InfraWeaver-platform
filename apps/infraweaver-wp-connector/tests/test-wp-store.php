<?php
/**
 * IWSL_WP_Store — the production options-table store (get/set/delete/add).
 *
 * The harness bootstrap loads only the interface + IWSL_Memory_Store; the WP-
 * backed store needs the WordPress options API, so this suite loads it and stands
 * a tiny in-memory options table behind function_exists-guarded WP stubs (the
 * same pattern test-teardown uses). test-teardown drives IWSL_WP_Store as a
 * collaborator but never asserts its own contract — this suite covers it directly:
 *   - set/get round-trip across scalar, array and RAW-BYTE values (key material
 *     must survive the base64+serialize wrapping untouched);
 *   - boolean-false round-trips as false, not the default (the `b:0;` edge);
 *   - a missing key and a corrupt blob both fall back to the default;
 *   - delete removes the option;
 *   - add is insert-if-absent (the atomic enrollment-claim primitive);
 *   - unserialize(allowed_classes=false): a stored serialized object is NEVER
 *     rehydrated into a real class (no __wakeup/__destruct gadget from the DB).
 */

declare(strict_types=1);

require_once __DIR__ . '/../includes/class-iwsl-wp-store.php';

// Fake options table + WP options API (guarded so isolated runs never fatal).
$GLOBALS['iwsl_ws_opts'] = array();

if ( ! function_exists( 'get_option' ) ) {
	function get_option( string $name, $default = false ) {
		return array_key_exists( $name, $GLOBALS['iwsl_ws_opts'] ) ? $GLOBALS['iwsl_ws_opts'][ $name ] : $default;
	}
}
if ( ! function_exists( 'update_option' ) ) {
	function update_option( string $name, $value, $autoload = null ): bool {
		$GLOBALS['iwsl_ws_opts'][ $name ] = $value;
		return true;
	}
}
if ( ! function_exists( 'add_option' ) ) {
	function add_option( string $name, $value = '', $deprecated = '', $autoload = null ): bool {
		if ( array_key_exists( $name, $GLOBALS['iwsl_ws_opts'] ) ) {
			return false;
		}
		$GLOBALS['iwsl_ws_opts'][ $name ] = $value;
		return true;
	}
}
if ( ! function_exists( 'delete_option' ) ) {
	function delete_option( string $name ): bool {
		unset( $GLOBALS['iwsl_ws_opts'][ $name ] );
		return true;
	}
}

/** A marker class used only to prove allowed_classes=false strips it on read. */
final class IWSL_WS_Gadget {
	/** @var string */
	public $payload = 'boom';
}

$store = new IWSL_WP_Store();

// ── missing key returns the default ────────────────────────────────────────────
iwsl_assert_same( null, $store->get( 'absent' ), 'get(missing) returns null default' );
iwsl_assert_same( 'fallback', $store->get( 'absent', 'fallback' ), 'get(missing) returns the supplied default' );

// ── scalar + array round-trips ─────────────────────────────────────────────────
$store->set( 'a_string', 'hello-world' );
iwsl_assert_same( 'hello-world', $store->get( 'a_string' ), 'string round-trips' );

$store->set( 'an_int', 4242 );
iwsl_assert_same( 4242, $store->get( 'an_int' ), 'int round-trips with type preserved' );

$nested = array( 'ed25519' => 'x', 'kids' => array( 1, 2, 3 ), 'flags' => array( 'plus' => true ) );
$store->set( 'nested', $nested );
iwsl_assert_same( $nested, $store->get( 'nested' ), 'nested array round-trips structurally' );

// ── option name is prefixed with iwsl_ (namespacing the options table) ─────────
iwsl_assert( array_key_exists( 'iwsl_a_string', $GLOBALS['iwsl_ws_opts'] ), 'set() writes under the iwsl_ option prefix' );

// ── RAW BYTES: key material must survive utf8mb4 columns byte-for-byte ──────────
$raw = random_bytes( 64 ); // includes NULs and high bytes
$store->set( 'wp_sk', $raw );
$got = $store->get( 'wp_sk' );
iwsl_assert_same( 64, strlen( (string) $got ), 'raw 64-byte blob keeps its length' );
iwsl_assert( hash_equals( $raw, (string) $got ), 'raw key material round-trips byte-for-byte' );

// ── boolean false is a value, not "missing" (the b:0; edge) ─────────────────────
$store->set( 'off', false );
iwsl_assert_same( false, $store->get( 'off', 'DEFAULT' ), 'stored boolean false returns false, not the default' );

// ── a corrupt/non-decodable stored blob falls back to the default ──────────────
$GLOBALS['iwsl_ws_opts']['iwsl_corrupt'] = '!!!not-base64-serialized!!!';
iwsl_assert_same( 'safe', $store->get( 'corrupt', 'safe' ), 'corrupt stored blob falls back to the default (no fatal)' );

// ── delete removes the option ──────────────────────────────────────────────────
$store->set( 'temp', 'v' );
iwsl_assert_same( 'v', $store->get( 'temp' ), 'value present before delete' );
$store->delete( 'temp' );
iwsl_assert_same( null, $store->get( 'temp' ), 'delete() removes the option (get returns default)' );

// ── add(): insert-if-absent, the atomic enrollment-claim primitive ─────────────
iwsl_assert_same( true, $store->add( 'claim', 1 ), 'add() on an absent key succeeds (true)' );
iwsl_assert_same( false, $store->add( 'claim', 2 ), 'add() on an existing key fails (false)' );
iwsl_assert_same( 1, $store->get( 'claim' ), 'a losing add() did not overwrite the existing value' );

// ── unserialize(allowed_classes=false): a stored object is NEVER rehydrated ─────
// Simulate a DB row holding a serialized object (a tampered/legacy blob). get()
// must strip the class rather than instantiate IWSL_WS_Gadget (no __wakeup gadget).
$GLOBALS['iwsl_ws_opts']['iwsl_evil'] = base64_encode( serialize( new IWSL_WS_Gadget() ) );
$loaded = $store->get( 'evil' );
iwsl_assert( ! ( $loaded instanceof IWSL_WS_Gadget ), 'stored object is NOT rehydrated into its real class (allowed_classes=false)' );
iwsl_assert_same( '__PHP_Incomplete_Class', get_class( $loaded ), 'stored object degrades to __PHP_Incomplete_Class on read' );
