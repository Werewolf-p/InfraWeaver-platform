<?php
/**
 * Response Time Scanner (gate flag `response_scan`, Pro): the engine
 * IWSL_Response_Scan.
 *
 * Runs under the zero-dependency harness. The PURE logic (median, host guard,
 * URL sanitize/build, run aggregation, snapshot ring-buffer, snapshot compare,
 * settings/state normalize, sitemap parse) is exercised directly with no
 * WordPress present. The ACTIVE probe is exercised through the engine's DEFAULT
 * fetcher with `wp_remote_get` STUBBED to return canned responses and an INJECTED
 * high-resolution clock supplying deterministic per-run timings — so the
 * wall-clock median math is asserted crisply without a real network call.
 *
 * The engine takes IWSL_Entitlements; a store seeded active + fresh-heartbeat +
 * the `response_scan` flag unlocks it, and the STATEMENT-1 gate is proven to block
 * a scan when the flag is absent.
 */

// ── stubbed WP HTTP API: canned responses keyed by URL ─────────────────────────
// wp_remote_get returns an opaque array carrying a spec; the retrieve_* helpers
// read it back. A spec of { error: msg } returns a WP_Error-like object instead.
// Guarded + this suite runs in its own subprocess, so the stubs never leak.

$GLOBALS['iwsl_rs_http']         = array();
$GLOBALS['iwsl_rs_http_default'] = array( 'code' => 200, 'body' => 'ok', 'clh' => 0 );

if ( ! class_exists( 'IWSL_RS_Fake_Error' ) ) {
	class IWSL_RS_Fake_Error {
		/** @var string */
		private $message;
		public function __construct( string $message ) {
			$this->message = $message;
		}
		public function get_error_message(): string {
			return $this->message;
		}
	}
}

if ( ! function_exists( 'wp_remote_get' ) ) {
	function wp_remote_get( $url, $args = array() ) {
		$spec = $GLOBALS['iwsl_rs_http'][ (string) $url ] ?? $GLOBALS['iwsl_rs_http_default'];
		if ( isset( $spec['error'] ) ) {
			return new IWSL_RS_Fake_Error( (string) $spec['error'] );
		}
		return array( '__iwsl_spec' => $spec );
	}
}
if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ) {
		return $thing instanceof IWSL_RS_Fake_Error;
	}
}
if ( ! function_exists( 'wp_remote_retrieve_response_code' ) ) {
	function wp_remote_retrieve_response_code( $r ) {
		return is_array( $r ) && isset( $r['__iwsl_spec']['code'] ) ? (int) $r['__iwsl_spec']['code'] : 0;
	}
}
if ( ! function_exists( 'wp_remote_retrieve_body' ) ) {
	function wp_remote_retrieve_body( $r ) {
		return is_array( $r ) && isset( $r['__iwsl_spec']['body'] ) ? (string) $r['__iwsl_spec']['body'] : '';
	}
}
if ( ! function_exists( 'wp_remote_retrieve_header' ) ) {
	function wp_remote_retrieve_header( $r, $h ) {
		if ( 'content-length' === strtolower( (string) $h ) && is_array( $r ) && isset( $r['__iwsl_spec']['clh'] ) ) {
			return (string) $r['__iwsl_spec']['clh'];
		}
		return '';
	}
}

// ── fixtures ────────────────────────────────────────────────────────────────────

/** A memory store seeded unlocked (active + fresh heartbeat + response_scan). */
function iwsl_rs_unlocked_store( int $now ): IWSL_Memory_Store {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'response_scan' => true ) );
	return $store;
}

/** A memory store that is linked + fresh but WITHOUT the response_scan flag (locked). */
function iwsl_rs_locked_store( int $now ): IWSL_Memory_Store {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array() );
	return $store;
}

function iwsl_rs_ent( IWSL_Store $store, int $now ): IWSL_Entitlements {
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** A clock closure that hands back the supplied ms values in order (last repeats). */
function iwsl_rs_clock( array $values ): callable {
	$i = 0;
	return function () use ( $values, &$i ): float {
		$v = $values[ $i ] ?? ( array() === $values ? 0 : $values[ count( $values ) - 1 ] );
		$i++;
		return (float) $v;
	};
}

/** Build an engine over $store with injected home, clock and seconds-clock. */
function iwsl_rs_engine( IWSL_Store $store, int $now, callable $clock, string $home = 'https://example.test/' ): IWSL_Response_Scan {
	return new IWSL_Response_Scan(
		iwsl_rs_ent( $store, $now ),
		$store,
		$home,
		null, // default fetcher → uses the wp_remote_get stub above
		$clock,
		static function () use ( $now ): int {
			return (int) floor( $now / 1000 );
		}
	);
}

/** A per-URL aggregate row (as make_snapshot / compare expect). */
function iwsl_rs_row( string $url, int $median, bool $ok = true ): array {
	return array(
		'url'            => $url,
		'path'           => (string) ( parse_url( $url, PHP_URL_PATH ) ?: '/' ),
		'ok'             => $ok,
		'code'           => $ok ? 200 : 0,
		'runs'           => 3,
		'ok_runs'        => $ok ? 3 : 0,
		'median_ms'      => $median,
		'min_ms'         => $median,
		'max_ms'         => $median,
		'median_bytes'   => 100,
		'content_length' => 0,
		'error'          => $ok ? '' : 'request-failed',
	);
}

// ── 1. median(): outlier-robust central value ─────────────────────────────────

iwsl_assert_same( 0.0, IWSL_Response_Scan::median( array() ), 'median: empty list → 0.0' );
iwsl_assert_same( 200.0, IWSL_Response_Scan::median( array( 200 ) ), 'median: single value' );
iwsl_assert_same( 200.0, IWSL_Response_Scan::median( array( 100, 300, 200 ) ), 'median: odd count → middle after sort' );
iwsl_assert_same( 250.0, IWSL_Response_Scan::median( array( 100, 400, 300, 200 ) ), 'median: even count → mean of two middle' );
iwsl_assert_same( 200.0, IWSL_Response_Scan::median( array( 200, 200, 9000 ) ), 'median: robust to a single huge outlier' );
iwsl_assert_same( 100.0, IWSL_Response_Scan::median( array( 100, 'junk', null, 100 ) ), 'median: non-numeric entries ignored' );

// ── 2. same_host(): the SSRF guard ────────────────────────────────────────────

iwsl_assert( IWSL_Response_Scan::same_host( 'https://example.test/', 'example.test' ), 'same_host: exact host + https allowed' );
iwsl_assert( IWSL_Response_Scan::same_host( 'http://Example.Test/path?x=1', 'example.test' ), 'same_host: case-insensitive, path/query irrelevant' );
iwsl_assert( ! IWSL_Response_Scan::same_host( 'https://evil.com/', 'example.test' ), 'same_host: a different host is REJECTED' );
iwsl_assert( ! IWSL_Response_Scan::same_host( 'https://sub.example.test/', 'example.test' ), 'same_host: a subdomain is not the same host' );
iwsl_assert( ! IWSL_Response_Scan::same_host( 'ftp://example.test/', 'example.test' ), 'same_host: non-http(s) scheme rejected' );
iwsl_assert( ! IWSL_Response_Scan::same_host( 'javascript:alert(1)', 'example.test' ), 'same_host: javascript: rejected' );
iwsl_assert( ! IWSL_Response_Scan::same_host( '/relative/path', 'example.test' ), 'same_host: relative URL (no host) rejected' );
iwsl_assert( ! IWSL_Response_Scan::same_host( 'https://example.test@evil.com/', 'example.test' ), 'same_host: credential trick → real host evil.com rejected' );
iwsl_assert( ! IWSL_Response_Scan::same_host( 'https://user:pw@example.test/', 'example.test' ), 'same_host: embedded credentials rejected even on the right host' );
iwsl_assert( ! IWSL_Response_Scan::same_host( 'https://example.test/', '' ), 'same_host: empty home host → nothing matches' );

// ── 3. sanitize_urls(): same-host filter + dedupe + cap ────────────────────────

$raw = "https://example.test/a\nhttps://evil.com/x\n https://example.test/b \nhttps://example.test/a\nnot a url";
$urls = IWSL_Response_Scan::sanitize_urls( $raw, 'example.test' );
iwsl_assert_same( array( 'https://example.test/a', 'https://example.test/b' ), $urls, 'sanitize_urls: foreign host dropped, trimmed, deduped, junk ignored' );

$many = array();
for ( $i = 0; $i < 30; $i++ ) {
	$many[] = "https://example.test/p{$i}";
}
$capped = IWSL_Response_Scan::sanitize_urls( implode( "\n", $many ), 'example.test', 20 );
iwsl_assert_same( 20, count( $capped ), 'sanitize_urls: capped at the supplied max (20)' );

// ── 4. build_targets(): home first, MAX_URLS cap, sitemap seeds ────────────────

$targets = IWSL_Response_Scan::build_targets( 'https://example.test/', "https://example.test/about\nhttps://evil.com/no", array(), 'example.test' );
iwsl_assert_same( 'https://example.test/', $targets[0], 'build_targets: home URL is always first' );
iwsl_assert_same( array( 'https://example.test/', 'https://example.test/about' ), $targets, 'build_targets: same-host extras kept, foreign dropped' );

// Home + 25 extras → capped at MAX_URLS with home included.
$extra25 = array();
for ( $i = 0; $i < 25; $i++ ) {
	$extra25[] = "https://example.test/x{$i}";
}
$targets_cap = IWSL_Response_Scan::build_targets( 'https://example.test/', implode( "\n", $extra25 ), array(), 'example.test', IWSL_Response_Scan::MAX_URLS );
iwsl_assert_same( IWSL_Response_Scan::MAX_URLS, count( $targets_cap ), 'build_targets: total capped at MAX_URLS' );
iwsl_assert_same( 'https://example.test/', $targets_cap[0], 'build_targets: home survives the cap (added first)' );

// Sitemap seeds are host-filtered too.
$targets_sm = IWSL_Response_Scan::build_targets( 'https://example.test/', '', array( 'https://example.test/blog', 'https://evil.com/leak' ), 'example.test' );
iwsl_assert_same( array( 'https://example.test/', 'https://example.test/blog' ), $targets_sm, 'build_targets: sitemap seeds filtered to same host' );

// ── 5. sanitize_runs(): clamp to [RUNS_MIN, RUNS_MAX] ──────────────────────────

iwsl_assert_same( IWSL_Response_Scan::RUNS_MIN, IWSL_Response_Scan::sanitize_runs( 0 ), 'sanitize_runs: 0 → RUNS_MIN' );
iwsl_assert_same( IWSL_Response_Scan::RUNS_MAX, IWSL_Response_Scan::sanitize_runs( 99 ), 'sanitize_runs: huge → RUNS_MAX' );
iwsl_assert_same( 3, IWSL_Response_Scan::sanitize_runs( 3 ), 'sanitize_runs: in-range value preserved' );

// ── 6. sanitize_label(): control strip + length cap ────────────────────────────

iwsl_assert_same( 'before lossless', IWSL_Response_Scan::sanitize_label( "  before\tlossless\n " ), 'sanitize_label: control chars → space, trimmed' );
iwsl_assert_same( IWSL_Response_Scan::LABEL_MAX_LEN, strlen( IWSL_Response_Scan::sanitize_label( str_repeat( 'a', 400 ) ) ), 'sanitize_label: capped at LABEL_MAX_LEN' );

// ── 7. aggregate_runs(): median timing + status + verdict ──────────────────────

$agg = IWSL_Response_Scan::aggregate_runs( 'https://example.test/', '/', 3, array( 100.0, 300.0, 200.0 ), array( 10, 12, 11 ), array( 200, 200, 200 ), 12345, 3, '' );
iwsl_assert_same( true, $agg['ok'], 'aggregate_runs: any successful run → ok' );
iwsl_assert_same( 200, $agg['median_ms'], 'aggregate_runs: median of 100/300/200 = 200' );
iwsl_assert_same( 100, $agg['min_ms'], 'aggregate_runs: min tracked' );
iwsl_assert_same( 300, $agg['max_ms'], 'aggregate_runs: max tracked' );
iwsl_assert_same( 11, $agg['median_bytes'], 'aggregate_runs: median downloaded bytes' );
iwsl_assert_same( 200, $agg['code'], 'aggregate_runs: most-common status code' );
iwsl_assert_same( 12345, $agg['content_length'], 'aggregate_runs: content-length carried through' );

$agg_fail = IWSL_Response_Scan::aggregate_runs( 'https://example.test/x', '/x', 2, array(), array(), array( 0, 0 ), 0, 0, 'timeout' );
iwsl_assert_same( false, $agg_fail['ok'], 'aggregate_runs: zero successes → not ok' );
iwsl_assert_same( 0, $agg_fail['median_ms'], 'aggregate_runs: no successes → 0 ms (no invented number)' );
iwsl_assert_same( 'timeout', $agg_fail['error'], 'aggregate_runs: failure carries the error' );

// ── 8. pick_code(): most frequent status ──────────────────────────────────────

iwsl_assert_same( 200, IWSL_Response_Scan::pick_code( array( 200, 500, 200 ) ), 'pick_code: majority wins' );
iwsl_assert_same( 0, IWSL_Response_Scan::pick_code( array() ), 'pick_code: empty → 0' );

// ── 9. aggregate_results(): site median-of-medians + mean ──────────────────────

$results = array(
	iwsl_rs_row( 'https://example.test/', 100 ),
	iwsl_rs_row( 'https://example.test/a', 300 ),
	iwsl_rs_row( 'https://example.test/b', 200 ),
	iwsl_rs_row( 'https://example.test/down', 0, false ),
);
$sagg = IWSL_Response_Scan::aggregate_results( $results );
iwsl_assert_same( 4, $sagg['count'], 'aggregate_results: total URL count' );
iwsl_assert_same( 3, $sagg['ok_count'], 'aggregate_results: only responding URLs counted ok' );
iwsl_assert_same( 200, $sagg['median_ms'], 'aggregate_results: median of [100,300,200] = 200' );
iwsl_assert_same( 200, $sagg['avg_ms'], 'aggregate_results: mean of [100,300,200] = 200' );

// ── 10. make_snapshot() + append_snapshot() ring buffer ────────────────────────

$snap = IWSL_Response_Scan::make_snapshot( 1000, "  my run\n", 3, $results );
iwsl_assert_same( 'my run', $snap['label'], 'make_snapshot: label sanitized' );
iwsl_assert_same( 4, $snap['urls_scanned'], 'make_snapshot: url count' );
iwsl_assert_same( 200, $snap['aggregate']['median_ms'], 'make_snapshot: aggregate embedded' );

$ring = array();
for ( $i = 0; $i < 13; $i++ ) {
	$ring = IWSL_Response_Scan::append_snapshot( $ring, IWSL_Response_Scan::make_snapshot( $i, "s{$i}", 1, array() ), IWSL_Response_Scan::MAX_SNAPSHOTS );
}
iwsl_assert_same( IWSL_Response_Scan::MAX_SNAPSHOTS, count( $ring ), 'append_snapshot: ring bounded at MAX_SNAPSHOTS' );
iwsl_assert_same( 's12', $ring[ count( $ring ) - 1 ]['label'], 'append_snapshot: newest is last' );
iwsl_assert_same( 's3', $ring[0]['label'], 'append_snapshot: oldest kept is s3 (s0..s2 dropped)' );

// Immutability of append_snapshot.
$before = array( IWSL_Response_Scan::make_snapshot( 1, 'x', 1, array() ) );
$after  = IWSL_Response_Scan::append_snapshot( $before, IWSL_Response_Scan::make_snapshot( 2, 'y', 1, array() ), 10 );
iwsl_assert_same( 1, count( $before ), 'append_snapshot: input list is NOT mutated (immutable)' );
iwsl_assert_same( 2, count( $after ), 'append_snapshot: returns a new, longer list' );

// ── 11. compare_snapshots(): per-URL delta + direction + site roll-up ──────────

$older = IWSL_Response_Scan::make_snapshot( 100, 'before', 3, array(
	iwsl_rs_row( 'https://example.test/a', 200 ),
	iwsl_rs_row( 'https://example.test/b', 400 ),
) );
$newer = IWSL_Response_Scan::make_snapshot( 200, 'after', 3, array(
	iwsl_rs_row( 'https://example.test/a', 100 ),
	iwsl_rs_row( 'https://example.test/b', 200 ),
	iwsl_rs_row( 'https://example.test/c', 150 ),
) );
$cmp = IWSL_Response_Scan::compare_snapshots( $newer, $older );
iwsl_assert_same( 2, $cmp['matched'], 'compare: two URLs matched across snapshots' );
iwsl_assert_same( -100, $cmp['rows'][0]['delta_ms'], 'compare: /a delta = 100 - 200 = -100' );
iwsl_assert_same( -50.0, $cmp['rows'][0]['pct'], 'compare: /a is 50% faster' );
iwsl_assert_same( 'faster', $cmp['rows'][0]['direction'], 'compare: /a direction faster' );
iwsl_assert_same( true, $cmp['rows'][0]['matched'], 'compare: /a is matched' );
iwsl_assert_same( 'faster', $cmp['rows'][1]['direction'], 'compare: /b also faster' );
iwsl_assert_same( 'new', $cmp['rows'][2]['direction'], 'compare: /c is new this scan (unmatched)' );
iwsl_assert_same( false, $cmp['rows'][2]['matched'], 'compare: /c unmatched' );
iwsl_assert_same( -150, $cmp['site']['delta_ms'], 'compare: site median 300 → 150 = -150' );
iwsl_assert_same( 'faster', $cmp['site']['direction'], 'compare: site got faster' );

// A URL present in both but broken in one is NOT matched (no false comparison).
$older_ok  = IWSL_Response_Scan::make_snapshot( 1, 'o', 1, array( iwsl_rs_row( 'https://example.test/a', 200 ) ) );
$newer_bad = IWSL_Response_Scan::make_snapshot( 2, 'n', 1, array( iwsl_rs_row( 'https://example.test/a', 0, false ) ) );
$cmp_bad   = IWSL_Response_Scan::compare_snapshots( $newer_bad, $older_ok );
iwsl_assert_same( 0, $cmp_bad['matched'], 'compare: a URL broken in one snapshot is not matched' );

// ── 12. classify_delta(): noise band ──────────────────────────────────────────

iwsl_assert_same( 'same', IWSL_Response_Scan::classify_delta( 10 ), 'classify_delta: +10 ms within noise band → same' );
iwsl_assert_same( 'same', IWSL_Response_Scan::classify_delta( -14 ), 'classify_delta: -14 ms within noise band → same' );
iwsl_assert_same( 'faster', IWSL_Response_Scan::classify_delta( -50 ), 'classify_delta: -50 ms → faster' );
iwsl_assert_same( 'slower', IWSL_Response_Scan::classify_delta( 200 ), 'classify_delta: +200 ms → slower' );

// ── 13. parse_sitemap_locs(): bounded <loc> extraction ─────────────────────────

$xml = '<urlset><url><loc>https://example.test/one</loc></url><url><loc> https://example.test/two </loc></url>'
	. '<url><loc>https://example.test/three</loc></url><url><loc>https://example.test/four</loc></url>'
	. '<url><loc>https://example.test/five</loc></url><url><loc>https://example.test/six</loc></url></urlset>';
$locs = IWSL_Response_Scan::parse_sitemap_locs( $xml, 5 );
iwsl_assert_same( 5, count( $locs ), 'parse_sitemap_locs: capped at max' );
iwsl_assert_same( 'https://example.test/one', $locs[0], 'parse_sitemap_locs: first loc extracted' );
iwsl_assert_same( 'https://example.test/two', $locs[1], 'parse_sitemap_locs: inner whitespace trimmed' );
iwsl_assert_same( array(), IWSL_Response_Scan::parse_sitemap_locs( 'not xml', 5 ), 'parse_sitemap_locs: non-XML → empty' );

// ── 14. sanitize_settings() + normalize_state() ────────────────────────────────

$settings = IWSL_Response_Scan::sanitize_settings( array( 'urls' => "a\nb", 'runs' => 99, 'include_sitemap' => '1' ) );
iwsl_assert_same( IWSL_Response_Scan::RUNS_MAX, $settings['runs'], 'sanitize_settings: runs clamped' );
iwsl_assert_same( true, $settings['include_sitemap'], 'sanitize_settings: sitemap flag coerced to bool' );
iwsl_assert_same( "a\nb", $settings['urls'], 'sanitize_settings: URL textarea preserved' );

$state = IWSL_Response_Scan::normalize_state( 'garbage' );
iwsl_assert_same( array(), $state['snapshots'], 'normalize_state: junk → empty snapshots' );
iwsl_assert_same( IWSL_Response_Scan::RUNS_DEFAULT, $state['settings']['runs'], 'normalize_state: default runs' );

$dirty = IWSL_Response_Scan::normalize_snapshots( array( array( 'ts' => 1 ), 'nope', 5, array( 'ts' => 2 ) ) );
iwsl_assert_same( 2, count( $dirty ), 'normalize_snapshots: non-array entries dropped' );

// ── 15. small formatters ───────────────────────────────────────────────────────

iwsl_assert_same( '512 B', IWSL_Response_Scan::format_bytes( 512 ), 'format_bytes: bytes' );
iwsl_assert_same( '1.5 KB', IWSL_Response_Scan::format_bytes( 1536 ), 'format_bytes: kilobytes' );
iwsl_assert_same( '/shop?p=2', IWSL_Response_Scan::path_of( 'https://example.test/shop?p=2#x' ), 'path_of: path + query (fragment gone)' );
iwsl_assert_same( '/', IWSL_Response_Scan::path_of( 'https://example.test' ), 'path_of: empty path → /' );
iwsl_assert_same( 'example.test', IWSL_Response_Scan::host_of( 'https://Example.Test/x' ), 'host_of: lowercased host' );
iwsl_assert_same( 'https://example.test/a', IWSL_Response_Scan::normalize_url( 'https://example.test/a#frag' ), 'normalize_url: fragment stripped' );

// ── 16. probe_url(): stubbed HTTP + injected clock timing ──────────────────────

$now   = 1_700_000_000_000;
$store = iwsl_rs_unlocked_store( $now );
// One probe consumes two clock reads (t0, t1) → delta 175 ms.
$engine = iwsl_rs_engine( $store, $now, iwsl_rs_clock( array( 1000, 1175 ) ) );
$GLOBALS['iwsl_rs_http']['https://example.test/'] = array( 'code' => 200, 'body' => 'hello world', 'clh' => 4096 );
$probe = $engine->probe_url( 'https://example.test/' );
iwsl_assert_same( true, $probe['ok'], 'probe_url: 200 → ok' );
iwsl_assert_same( 200, $probe['code'], 'probe_url: status captured' );
iwsl_assert_same( 175.0, $probe['ms'], 'probe_url: wall-clock = t1 - t0 from injected clock' );
iwsl_assert_same( 11, $probe['bytes'], 'probe_url: downloaded body byte count' );
iwsl_assert_same( 4096, $probe['content_length'], 'probe_url: content-length header captured' );

// SSRF: a foreign host is refused WITHOUT a request (no clock reads needed).
$probe_ssrf = $engine->probe_url( 'https://evil.com/' );
iwsl_assert_same( false, $probe_ssrf['ok'], 'probe_url: foreign host blocked' );
iwsl_assert_same( 'ssrf-blocked', $probe_ssrf['error'], 'probe_url: SSRF reason recorded' );

// A transport error (WP_Error) → not ok, error surfaced.
$store2  = iwsl_rs_unlocked_store( $now );
$engine2 = iwsl_rs_engine( $store2, $now, iwsl_rs_clock( array( 0, 50 ) ) );
$GLOBALS['iwsl_rs_http']['https://example.test/boom'] = array( 'error' => 'cURL error 28' );
$probe_err = $engine2->probe_url( 'https://example.test/boom' );
iwsl_assert_same( false, $probe_err['ok'], 'probe_url: WP_Error → not ok' );
iwsl_assert_same( 'cURL error 28', $probe_err['error'], 'probe_url: transport error message surfaced' );

// ── 17. run_url(): N probes → median kept ──────────────────────────────────────

$store3 = iwsl_rs_unlocked_store( $now );
// 3 runs, deltas 100 / 500 / 200 (median 200): clock = t0,t1 pairs.
$engine3 = iwsl_rs_engine( $store3, $now, iwsl_rs_clock( array( 0, 100, 1000, 1500, 2000, 2200 ) ) );
$GLOBALS['iwsl_rs_http']['https://example.test/page'] = array( 'code' => 200, 'body' => 'x', 'clh' => 0 );
$row = $engine3->run_url( 'https://example.test/page', 3 );
iwsl_assert_same( 200, $row['median_ms'], 'run_url: median of 100/500/200 = 200 (outlier 500 ignored)' );
iwsl_assert_same( 100, $row['min_ms'], 'run_url: min run kept' );
iwsl_assert_same( 500, $row['max_ms'], 'run_url: max run kept' );
iwsl_assert_same( 3, $row['ok_runs'], 'run_url: all three runs succeeded' );

// ── 18. run(): end-to-end scan, gate + snapshot persistence ────────────────────

$store4 = iwsl_rs_unlocked_store( $now );
// home + /about + /shop, 2 runs each = 6 probes = 12 clock reads, every delta 100 ms.
$clock_vals = array();
for ( $k = 0; $k < 6; $k++ ) {
	$clock_vals[] = $k * 1000;
	$clock_vals[] = $k * 1000 + 100;
}
$engine4 = iwsl_rs_engine( $store4, $now, iwsl_rs_clock( $clock_vals ) );
$result  = $engine4->run(
	array(
		'label' => 'before lossless',
		'urls'  => "https://example.test/about\nhttps://evil.com/x\nhttps://example.test/shop",
		'runs'  => 2,
	)
);
iwsl_assert_same( true, $result['ok'], 'run: scan succeeds when unlocked' );
iwsl_assert_same( 3, count( $result['targets'] ), 'run: home + two same-host extras (foreign dropped)' );
iwsl_assert_same( 'https://example.test/', $result['targets'][0], 'run: home probed first' );
iwsl_assert_same( 100, $result['snapshot']['aggregate']['median_ms'], 'run: every URL measured 100 ms → site median 100' );
iwsl_assert_same( 'before lossless', $result['snapshot']['label'], 'run: label stored on the snapshot' );
// Persistence: the snapshot is appended to the store.
iwsl_assert_same( 1, count( $engine4->snapshots() ), 'run: snapshot persisted to the store' );
// Settings remembered.
iwsl_assert_same( 2, $engine4->settings()['runs'], 'run: last-used runs persisted' );

// ── 19. run(): STATEMENT-1 gate blocks a locked site ───────────────────────────

$locked_store  = iwsl_rs_locked_store( $now );
$locked_engine = iwsl_rs_engine( $locked_store, $now, iwsl_rs_clock( array( 0, 100 ) ) );
$locked_result = $locked_engine->run( array( 'label' => 'x', 'urls' => '', 'runs' => 3 ) );
iwsl_assert_same( false, $locked_result['ok'], 'run: locked site → scan refused' );
iwsl_assert_same( 'entitlement-locked', $locked_result['reason'], 'run: reason is entitlement-locked' );
iwsl_assert_same( 0, count( $locked_engine->snapshots() ), 'run: locked site writes NO snapshot' );

// ── 20. run(): sitemap seeding (optional) ──────────────────────────────────────

$store5 = iwsl_rs_unlocked_store( $now );
// home + 2 sitemap locs, 1 run each → 3 probes = 6 clock reads; plus the sitemap
// fetch itself consumes NO clock read (it is fetched, not timed).
$engine5 = iwsl_rs_engine( $store5, $now, iwsl_rs_clock( array( 0, 90, 1000, 1090, 2000, 2090 ) ) );
$GLOBALS['iwsl_rs_http']['https://example.test/wp-sitemap.xml'] = array(
	'code' => 200,
	'body' => '<urlset><url><loc>https://example.test/blog</loc></url><url><loc>https://evil.com/leak</loc></url><url><loc>https://example.test/news</loc></url></urlset>',
	'clh'  => 0,
);
$result5 = $engine5->run( array( 'label' => 'sm', 'urls' => '', 'runs' => 1, 'include_sitemap' => true ) );
iwsl_assert_same( true, $result5['ok'], 'run: sitemap scan succeeds' );
iwsl_assert_same( array( 'https://example.test/', 'https://example.test/blog', 'https://example.test/news' ), $result5['targets'], 'run: same-host sitemap locs seeded, foreign dropped' );

// ── 21. register(): safe outside WordPress (no add_action) ─────────────────────

$store6  = iwsl_rs_unlocked_store( $now );
$engine6 = iwsl_rs_engine( $store6, $now, iwsl_rs_clock( array( 0, 0 ) ) );
$engine6->register(); // must not fatal though add_action is undefined here
iwsl_assert( true, 'register: no-op without add_action (does not fatal)' );

// clean up the suite globals.
unset( $GLOBALS['iwsl_rs_http'], $GLOBALS['iwsl_rs_http_default'] );
