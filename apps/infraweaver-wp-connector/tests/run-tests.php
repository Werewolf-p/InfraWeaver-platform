<?php
/**
 * Zero-dependency IWSL Connector test runner:
 *   php tests/run-tests.php
 *
 * Regenerate fixtures first if the protocol changed:
 *   cd ../infraweaver-console && npx tsx ../infraweaver-wp-connector/tests/gen-fixtures.ts
 */

declare(strict_types=1);

error_reporting( E_ALL );
ini_set( 'display_errors', '1' );

// Stub the one WordPress function the Connector self-report reads (§5 identity
// binding). Defined before any suite so IWSL_Plugin::canonical_site_url()
// resolves a deterministic URL the plugin test can assert against.
if ( ! function_exists( 'home_url' ) ) {
	function home_url( string $path = '' ): string {
		return 'https://fixture-site.test' . $path;
	}
}
define( 'IWSL_FIXTURE_SITE_URL', 'https://fixture-site.test' );

// The plugin's PHP files now carry a `defined('ABSPATH')||exit;` guard (WP.org
// best practice — direct-access protection). This harness is not a WordPress
// runtime, so define a stub ABSPATH before loading any include, or the guard
// would exit the whole run.
defined( 'ABSPATH' ) || define( 'ABSPATH', __DIR__ . '/' );

require __DIR__ . '/../includes/class-iwsl-jcs.php';
require __DIR__ . '/../includes/class-iwsl-slhdsa.php';
require __DIR__ . '/../includes/class-iwsl-crypto.php';
require __DIR__ . '/../includes/class-iwsl-store.php';
require __DIR__ . '/../includes/class-iwsl-verifier.php';
require __DIR__ . '/../includes/class-iwsl-enrollment.php';
require __DIR__ . '/../includes/class-iwsl-rotation.php';
require __DIR__ . '/../includes/class-iwsl-responder.php';
require __DIR__ . '/../includes/class-iwsl-command-handler.php';
require __DIR__ . '/../includes/class-iwsl-entitlements.php';
require __DIR__ . '/../includes/class-iwsl-plugin.php';
require __DIR__ . '/../includes/class-iwsl-media-converter.php';
require __DIR__ . '/../includes/class-iwsl-webp-lossless-converter.php';
require __DIR__ . '/../includes/class-iwsl-media-optimizer.php';
require __DIR__ . '/../includes/class-iwsl-redirect-matcher.php';
require __DIR__ . '/../includes/class-iwsl-exact-path-matcher.php';
require __DIR__ . '/../includes/class-iwsl-redirects.php';
require __DIR__ . '/../includes/iwsl-page-cache-helpers.php';
require __DIR__ . '/../includes/class-iwsl-page-cache.php';
require __DIR__ . '/../includes/class-iwsl-mail-transport.php';
require __DIR__ . '/../includes/class-iwsl-smtp-transport.php';
require __DIR__ . '/../includes/class-iwsl-email-delivery.php';
require __DIR__ . '/../includes/class-iwsl-brand-surface.php';
require __DIR__ . '/../includes/class-iwsl-login-brand-surface.php';
require __DIR__ . '/../includes/class-iwsl-admin-brand-surface.php';
require __DIR__ . '/../includes/class-iwsl-white-label.php';
require __DIR__ . '/../includes/class-iwsl-db-cleaner.php';
require __DIR__ . '/../includes/class-iwsl-db-cleaners.php';
require __DIR__ . '/../includes/class-iwsl-db-optimizer.php';
require __DIR__ . '/../includes/class-iwsl-config-editor.php';

$GLOBALS['iwsl_pass'] = 0;
$GLOBALS['iwsl_fail'] = 0;

function iwsl_assert( bool $condition, string $label ): void {
	if ( $condition ) {
		$GLOBALS['iwsl_pass']++;
		echo "  [ok]   {$label}\n";
	} else {
		$GLOBALS['iwsl_fail']++;
		echo "  [FAIL] {$label}\n";
	}
}

/** @param mixed $expected @param mixed $actual */
function iwsl_assert_same( $expected, $actual, string $label ): void {
	if ( $expected === $actual ) {
		$GLOBALS['iwsl_pass']++;
		echo "  [ok]   {$label}\n";
	} else {
		$GLOBALS['iwsl_fail']++;
		echo "  [FAIL] {$label}\n         expected: " . var_export( $expected, true )
			. "\n         actual:   " . var_export( $actual, true ) . "\n";
	}
}

function iwsl_fixtures(): stdClass {
	static $fixtures = null;
	if ( null === $fixtures ) {
		$raw = file_get_contents( __DIR__ . '/fixtures/iwsl-fixtures.json' );
		if ( false === $raw ) {
			fwrite( STDERR, "fixtures missing — run gen-fixtures.ts first\n" );
			exit( 2 );
		}
		$fixtures = json_decode( $raw );
	}
	return $fixtures;
}

/** Deep-clone a decoded JSON value (stdClass-safe). */
function iwsl_clone( $value ) {
	return unserialize( serialize( $value ) );
}

/** Memory store seeded as an enrolled/active site pinned to the fixture IW keys. */
function iwsl_seed_store(): IWSL_Memory_Store {
	$f     = iwsl_fixtures();
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'site_id', $f->site_id );
	$store->set(
		'iw_keys.1',
		array(
			IWSL_Crypto::ALG_ED25519 => IWSL_Crypto::b64u_decode( $f->keys->iw_pub->{'ed25519'} ),
			IWSL_Crypto::ALG_SLHDSA  => IWSL_Crypto::b64u_decode( $f->keys->iw_pub->{'slh-dsa-192s'} ),
		)
	);
	$store->set( 'iw_current_kid', 1 );
	$store->set( 'iw_epoch_floor', 1 );
	$store->set( 'last_seq', 0 );
	$store->set( 'nonces', array() );
	return $store;
}

function iwsl_now_t0( int $offset_ms = 5000 ): callable {
	$now = iwsl_fixtures()->t0 + $offset_ms;
	return static function () use ( $now ): int {
		return $now;
	};
}

$suites = array( 'jcs', 'slhdsa', 'verifier', 'enrollment', 'rotation', 'plugin', 'purge', 'entitlements', 'media-optimizer', 'email-delivery', 'redirects', 'white-label', 'db-optimizer', 'page-cache', 'config-editor' );
foreach ( $suites as $suite ) {
	echo "== {$suite}\n";
	require __DIR__ . '/test-' . $suite . '.php';
}

echo "\n{$GLOBALS['iwsl_pass']} passed, {$GLOBALS['iwsl_fail']} failed\n";
exit( $GLOBALS['iwsl_fail'] > 0 ? 1 : 0 );
