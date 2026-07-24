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
require __DIR__ . '/../includes/class-iwsl-feature-switches.php';
require __DIR__ . '/../includes/iwsl-ui-help.php';
require __DIR__ . '/../includes/class-iwsl-plugin.php';
require __DIR__ . '/../includes/class-iwsl-media-converter.php';
require __DIR__ . '/../includes/class-iwsl-webp-lossless-converter.php';
require __DIR__ . '/../includes/class-iwsl-media-optimizer.php';
require __DIR__ . '/../includes/class-iwsl-s3-client.php';
require __DIR__ . '/../includes/class-iwsl-media-offload.php';
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
require __DIR__ . '/../includes/class-iwsl-email-brand-surface.php';
require __DIR__ . '/../includes/class-iwsl-white-label.php';
require __DIR__ . '/../includes/class-iwsl-db-cleaner.php';
require __DIR__ . '/../includes/class-iwsl-db-cleaners.php';
require __DIR__ . '/../includes/class-iwsl-db-history.php';
require __DIR__ . '/../includes/class-iwsl-db-optimizer.php';
require __DIR__ . '/../includes/class-iwsl-db-analyzer.php';
require __DIR__ . '/../includes/class-iwsl-config-editor.php';
// Plus feature engines (wave 2) — classifiers/helpers before their engines.
require __DIR__ . '/../includes/class-iwsl-lazy-load.php';
require __DIR__ . '/../includes/class-iwsl-cdn-rewrite.php';
require __DIR__ . '/../includes/class-iwsl-duplicate-post.php';
require __DIR__ . '/../includes/class-iwsl-seo-audit.php';
require __DIR__ . '/../includes/class-iwsl-svg-upload.php';
require __DIR__ . '/../includes/class-iwsl-broken-link-scan.php';
require __DIR__ . '/../includes/class-iwsl-maintenance-mode.php';
require __DIR__ . '/../includes/class-iwsl-scheduled-db-cleanup.php';
require __DIR__ . '/../includes/class-iwsl-activity-log.php';
require __DIR__ . '/../includes/class-iwsl-auto-convert.php';
require __DIR__ . '/../includes/class-iwsl-speed-pack.php';
require __DIR__ . '/../includes/class-iwsl-stats-classifier.php';
require __DIR__ . '/../includes/class-iwsl-statistics.php';
require __DIR__ . '/../includes/class-iwsl-consent-classifier.php';
require __DIR__ . '/../includes/class-iwsl-cookie-consent.php';
require __DIR__ . '/../includes/class-iwsl-seo-analyzer.php';
require __DIR__ . '/../includes/class-iwsl-seo-head.php';
require __DIR__ . '/../includes/class-iwsl-seo-sitemap.php';
require __DIR__ . '/../includes/class-iwsl-seo-suite.php';
require __DIR__ . '/../includes/class-iwsl-perf-audit.php';
// New Wave engines. Guarded so an in-progress file never fatals sibling suites.
foreach ( array( 'class-iwsl-response-scan.php', 'class-iwsl-media-protection.php', 'class-iwsl-seo-alt-text.php', 'class-iwsl-seo-console.php', 'class-iwsl-elementor-blocks.php', 'class-iwsl-media-folders.php', 'class-iwsl-media-folders-ui.php', 'class-iwsl-media-library.php', 'class-iwsl-security-headers.php' ) as $iwsl_new_inc ) {
	$iwsl_new_path = __DIR__ . '/../includes/' . $iwsl_new_inc;
	if ( file_exists( $iwsl_new_path ) ) {
		require_once $iwsl_new_path;
	}
}

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

$suites = array( 'jcs', 'slhdsa', 'slhdsa-192f', 'verifier', 'enrollment', 'wp-store', 'rotation', 'plugin', 'command-handler', 'purge', 'entitlements', 'feature-switches', 'media-optimizer', 's3-client', 'media-offload', 'email-delivery', 'redirects', 'white-label', 'db-optimizer', 'db-history', 'db-analyzer', 'db-command', 'page-cache', 'config-editor', 'ui-help',
	// Wave 2 feature suites. broken-link-scan runs after media-optimizer (whose
	// global stubs it is designed around); speed-pack MUST be last (it defines
	// remove_action/remove_filter recorder stubs).
	'lazy-load', 'cdn-rewrite', 'duplicate-post', 'seo-audit', 'svg-upload', 'broken-link-scan', 'maintenance-mode', 'scheduled-db-cleanup', 'activity-log', 'auto-convert', 'statistics', 'cookie-consent', 'seo-suite', 'seo-alt-text', 'seo-console', 'perf-audit', 'media-protection', 'media-folders', 'media-library', 'media-commands', 'response-scan', 'security-headers', 'elementor-blocks', 'content-branding', 'teardown', 'speed-pack' );
// CHILD MODE: `php run-tests.php <suite>` runs exactly ONE suite in this process.
// Each suite is self-contained (it defines its own guarded WP-function stubs), so
// running it in isolation is authoritative and free of cross-suite global leakage.
if ( isset( $argv[1] ) && '' !== $argv[1] ) {
	$suite = (string) $argv[1];
	require __DIR__ . '/test-' . $suite . '.php';
	echo "\n{$GLOBALS['iwsl_pass']} passed, {$GLOBALS['iwsl_fail']} failed\n";
	exit( $GLOBALS['iwsl_fail'] > 0 ? 1 : 0 );
}

// PARENT MODE: run every suite in its OWN php process and aggregate. Process
// isolation is the fix for suites that (legitimately) define global function
// stubs which would otherwise collide when required into one shared process.
$total_pass = 0;
$total_fail = 0;
$had_crash  = false;
foreach ( $suites as $suite ) {
	$out = array();
	$rc  = 0;
	exec( escapeshellarg( PHP_BINARY ) . ' ' . escapeshellarg( __FILE__ ) . ' ' . escapeshellarg( $suite ) . ' 2>&1', $out, $rc );
	$joined = implode( "\n", $out );
	if ( preg_match( '/(\d+) passed, (\d+) failed/', $joined, $m ) ) {
		$p = (int) $m[1];
		$f = (int) $m[2];
		$total_pass += $p;
		$total_fail += $f;
		if ( $f > 0 ) {
			echo "== {$suite}: {$p} passed, {$f} FAILED\n";
			foreach ( $out as $line ) {
				if ( false !== strpos( $line, '[FAIL]' ) || false !== stripos( $line, 'fail' ) ) {
					echo "     {$line}\n";
				}
			}
		} else {
			echo "== {$suite}: {$p} passed\n";
		}
	} else {
		$had_crash   = true;
		$total_fail += 1;
		echo "== {$suite}: CRASH (rc={$rc})\n";
		echo implode( "\n", array_slice( $out, -12 ) ) . "\n";
	}
}

echo "\n{$total_pass} passed, {$total_fail} failed" . ( $had_crash ? ' (with crashes)' : '' ) . "\n";
exit( $total_fail > 0 || $had_crash ? 1 : 0 );
