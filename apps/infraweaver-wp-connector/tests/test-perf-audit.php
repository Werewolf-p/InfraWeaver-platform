<?php
/**
 * Load-Time Audit (FREE feature): the IWSL_Perf_Audit engine.
 *
 * Runs under the zero-dependency harness. Only the PURE core is exercised — the
 * WordPress-hooked collector (on_shutdown / is_measurable_request) is never
 * touched, so this suite installs NO WordPress stubs and no globals. What matters
 * for accuracy is the AGGREGATION MATH (averages, max, folds) and the threshold
 * JUDGEMENT, and both are pure and asserted crisply here.
 *
 * The engine takes NO IWSL_Entitlements — it is ungated (free on every plan) — so
 * there is no gate to flip; the store is the only dependency and the toggle/reset
 * paths run against the in-memory store.
 */

// ── 1. fold_sample(): immutable running aggregate ─────────────────────────────

$s0 = array();
$s1 = IWSL_Perf_Audit::fold_sample( $s0, '/home', 100.0, 10, 1000, 1000, 100 );
iwsl_assert_same( array(), $s0, 'fold_sample: input state is NOT mutated (immutable)' );
iwsl_assert_same( 1, $s1['samples']['/home']['count'], 'fold_sample: first sample counts once' );
iwsl_assert_same( 100.0, $s1['samples']['/home']['sum_ms'], 'fold_sample: sum_ms accumulates' );
iwsl_assert_same( 1000, $s1['since'], 'fold_sample: since stamped on first sample' );

// A second, slower sample on the same URL: sum/max/last update, count grows.
$s2 = IWSL_Perf_Audit::fold_sample( $s1, '/home', 300.0, 30, 2000, 1500, 100 );
iwsl_assert_same( 2, $s2['samples']['/home']['count'], 'fold_sample: second sample on same URL → count 2' );
iwsl_assert_same( 400.0, $s2['samples']['/home']['sum_ms'], 'fold_sample: sum_ms = 100 + 300' );
iwsl_assert_same( 300.0, $s2['samples']['/home']['max_ms'], 'fold_sample: max_ms tracks the slowest' );
iwsl_assert_same( 300.0, $s2['samples']['/home']['last_ms'], 'fold_sample: last_ms is the most recent' );
iwsl_assert_same( 30, $s2['samples']['/home']['max_q'], 'fold_sample: max_q tracks the peak query count' );
iwsl_assert_same( 1000, $s2['since'], 'fold_sample: since is NOT advanced by later samples' );

// A different URL is a distinct row.
$s3 = IWSL_Perf_Audit::fold_sample( $s2, '/about', 50.0, 5, 800, 3000, 100 );
iwsl_assert_same( 2, count( $s3['samples'] ), 'fold_sample: a new URL adds a new row' );

// ── 2. Negative / junk inputs are clamped, never stored raw ───────────────────

$sneg = IWSL_Perf_Audit::fold_sample( array(), '/x', -5.0, -3, -9, 500, 100 );
iwsl_assert_same( 0.0, $sneg['samples']['/x']['sum_ms'], 'fold_sample: negative gen_ms clamped to 0' );
iwsl_assert_same( 0, $sneg['samples']['/x']['max_q'], 'fold_sample: negative queries clamped to 0' );
iwsl_assert_same( 0, $sneg['samples']['/x']['max_mem'], 'fold_sample: negative memory clamped to 0' );

// ── 3. MAX_PATHS cap: new URLs past the cap are dropped and counted ───────────

$capped = array();
for ( $i = 0; $i < 3; $i++ ) {
	$capped = IWSL_Perf_Audit::fold_sample( $capped, "/p{$i}", 100.0, 1, 1, 1000, 3 );
}
iwsl_assert_same( 3, count( $capped['samples'] ), 'cap: exactly MAX_PATHS URLs stored' );
// A 4th DISTINCT URL is refused; overflow bumps.
$over = IWSL_Perf_Audit::fold_sample( $capped, '/p3', 100.0, 1, 1, 1000, 3 );
iwsl_assert_same( 3, count( $over['samples'] ), 'cap: a new URL past the cap is NOT added' );
iwsl_assert_same( 1, $over['overflow'], 'cap: the dropped new URL bumps overflow' );
// But an EXISTING URL still updates past the cap.
$over2 = IWSL_Perf_Audit::fold_sample( $over, '/p0', 200.0, 1, 1, 1000, 3 );
iwsl_assert_same( 2, $over2['samples']['/p0']['count'], 'cap: a known URL still updates past the cap' );

// ── 4. evaluate_path(): threshold judgement (SLOW_MS 800, VERY_SLOW 2000, Q 80) ─

$fast = array( 'count' => 4, 'sum_ms' => 4 * 200.0, 'max_q' => 10 );
iwsl_assert_same( array(), IWSL_Perf_Audit::evaluate_path( $fast ), 'evaluate_path: a fast page (avg 200 ms) has NO issues' );

$slow = array( 'count' => 2, 'sum_ms' => 2 * 1200.0, 'max_q' => 10 );
iwsl_assert_same( array( 'slow-server-generation' ), IWSL_Perf_Audit::evaluate_path( $slow ), 'evaluate_path: avg 1200 ms → slow-server-generation' );

$vslow = array( 'count' => 1, 'sum_ms' => 2500.0, 'max_q' => 10 );
iwsl_assert_same( array( 'very-slow-server-generation' ), IWSL_Perf_Audit::evaluate_path( $vslow ), 'evaluate_path: avg 2500 ms → very-slow (NOT also slow)' );

$hi_q = array( 'count' => 3, 'sum_ms' => 3 * 100.0, 'max_q' => 120 );
iwsl_assert_same( array( 'high-query-count' ), IWSL_Perf_Audit::evaluate_path( $hi_q ), 'evaluate_path: 120 queries → high-query-count' );

$both = array( 'count' => 1, 'sum_ms' => 3000.0, 'max_q' => 200 );
iwsl_assert_same( array( 'very-slow-server-generation', 'high-query-count' ), IWSL_Perf_Audit::evaluate_path( $both ), 'evaluate_path: slow AND query-heavy → both codes' );

// Boundary: exactly SLOW_MS is NOT slow (strictly greater than).
$edge = array( 'count' => 1, 'sum_ms' => 800.0, 'max_q' => 80 );
iwsl_assert_same( array(), IWSL_Perf_Audit::evaluate_path( $edge ), 'evaluate_path: exactly at the threshold is not flagged (strict >)' );

$zero = array( 'count' => 0, 'sum_ms' => 0.0, 'max_q' => 0 );
iwsl_assert_same( array(), IWSL_Perf_Audit::evaluate_path( $zero ), 'evaluate_path: a zero-count row is inert' );

// ── 5. build_report(): site roll-up + slowest-first ordering ──────────────────

$state = array();
// /slow: two views, avg 1500 ms → flagged. /fast: one view, 100 ms.
$state = IWSL_Perf_Audit::fold_sample( $state, '/slow', 1000.0, 10, 1, 1000, 100 );
$state = IWSL_Perf_Audit::fold_sample( $state, '/slow', 2000.0, 90, 1, 1000, 100 );
$state = IWSL_Perf_Audit::fold_sample( $state, '/fast', 100.0, 5, 1, 1000, 100 );

$report = IWSL_Perf_Audit::build_report( $state );
iwsl_assert_same( true, $report['ok'], 'build_report: ok' );
iwsl_assert_same( 3, $report['total_samples'], 'build_report: total samples across URLs' );
iwsl_assert_same( 2, $report['paths_tracked'], 'build_report: two URLs tracked' );
// Site avg = (1000+2000+100)/3 = 1033.33 → 1033.
iwsl_assert_same( 1033, $report['avg_ms'], 'build_report: site average is the sample-weighted mean' );
iwsl_assert_same( 1, $report['slow_paths'], 'build_report: one URL is flagged' );
iwsl_assert_same( '/slow', $report['items'][0]['path'], 'build_report: slowest URL sorts first' );
iwsl_assert_same( 1500, $report['items'][0]['avg_ms'], 'build_report: /slow average = (1000+2000)/2 = 1500' );
iwsl_assert_same( 2000, $report['items'][0]['max_ms'], 'build_report: /slow max = 2000' );
iwsl_assert_same( 90, $report['items'][0]['max_q'], 'build_report: /slow peak queries = 90' );
iwsl_assert( in_array( 'slow-server-generation', $report['items'][0]['issues'], true ), 'build_report: /slow carries the slow issue code' );
iwsl_assert_same( array(), $report['items'][1]['issues'], 'build_report: /fast has no issues' );
iwsl_assert_same( '/slow', $report['worst_path'], 'build_report: worst_path is the slowest URL' );

// Empty state → an honest empty report.
$empty = IWSL_Perf_Audit::build_report( array() );
iwsl_assert_same( 0, $empty['total_samples'], 'build_report: empty state → 0 samples' );
iwsl_assert_same( 0, $empty['avg_ms'], 'build_report: empty state → 0 average (no divide-by-zero)' );
iwsl_assert_same( array(), $empty['items'], 'build_report: empty state → no rows' );

// ── 6. normalize_path(): query strip + leading slash + length cap ─────────────

iwsl_assert_same( '/shop', IWSL_Perf_Audit::normalize_path( '/shop?p=2&x=1' ), 'normalize_path: query string stripped' );
iwsl_assert_same( '/a', IWSL_Perf_Audit::normalize_path( '/a#frag' ), 'normalize_path: fragment stripped' );
iwsl_assert_same( '/x', IWSL_Perf_Audit::normalize_path( 'x' ), 'normalize_path: leading slash forced' );
iwsl_assert_same( '/', IWSL_Perf_Audit::normalize_path( '' ), 'normalize_path: empty → /' );
iwsl_assert_same( IWSL_Perf_Audit::PATH_MAX_LEN, strlen( IWSL_Perf_Audit::normalize_path( '/' . str_repeat( 'a', 500 ) ) ), 'normalize_path: capped at PATH_MAX_LEN' );

// ── 7. normalize_state(): default enabled = on; junk coerced ──────────────────

$def = IWSL_Perf_Audit::normalize_state( array() );
iwsl_assert_same( true, $def['enabled'], 'normalize_state: missing enabled defaults ON' );
iwsl_assert_same( array(), $def['samples'], 'normalize_state: missing samples → empty' );
$off = IWSL_Perf_Audit::normalize_state( array( 'enabled' => false ) );
iwsl_assert_same( false, $off['enabled'], 'normalize_state: explicit false preserved' );
$junk = IWSL_Perf_Audit::normalize_state( array( 'samples' => array( 5 => 'nope', '/ok' => array( 'count' => 2, 'sum_ms' => 200.0 ) ) ) );
iwsl_assert_same( 1, count( $junk['samples'] ), 'normalize_state: non-string keys / non-array rows dropped' );
iwsl_assert_same( 2, $junk['samples']['/ok']['count'], 'normalize_state: a valid row survives' );

// ── 8. store-backed toggle + reset (in-memory store, no WordPress) ────────────

$store = new IWSL_Memory_Store();
$engine = new IWSL_Perf_Audit(
	$store,
	static function (): int {
		return 5000;
	}
);
iwsl_assert_same( true, $engine->is_enabled(), 'engine: enabled defaults ON with an empty store' );
$store->set( 'perf_audit', IWSL_Perf_Audit::fold_sample( array(), '/seed', 100.0, 1, 1, 5000, 100 ) );
iwsl_assert_same( 1, count( IWSL_Perf_Audit::normalize_state( $store->get( 'perf_audit' ) )['samples'] ), 'engine: seed sample stored' );

$engine->set_enabled( false );
iwsl_assert_same( false, $engine->is_enabled(), 'engine: set_enabled(false) turns collection off' );
// Toggling off must PRESERVE samples.
iwsl_assert_same( 1, count( IWSL_Perf_Audit::normalize_state( $store->get( 'perf_audit' ) )['samples'] ), 'engine: turning off keeps existing samples' );

$engine->reset_samples();
iwsl_assert_same( 0, count( IWSL_Perf_Audit::normalize_state( $store->get( 'perf_audit' ) )['samples'] ), 'engine: reset clears samples' );
iwsl_assert_same( false, $engine->is_enabled(), 'engine: reset preserves the enabled flag (still off)' );

// This suite installs no globals — nothing to unset.
