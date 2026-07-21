<?php
/**
 * Site Statistics (gate flag `statistics`, tier Ultimate): the recording engine
 * (IWSL_Statistics) + the pure classifier/aggregation helper (IWSL_Stats_Classifier).
 *
 * Runs under the zero-dependency harness: the entitlement gate reads an in-memory
 * IWSL_Memory_Store with an injected clock; a RECORDING FAKE $wpdb records every
 * prepare()/query()/get_results() and returns seeded rows — so we can prove the gate
 * blocks BEFORE the database is ever touched (no insert, no CREATE), that every
 * write is a prepared statement over a hardcoded table identifier with bound values,
 * that retention pruning is bounded, and that the pure UA/referrer/country/aggregation
 * logic is correct. No WordPress and no real database are required.
 */

// ── recording fake $wpdb (records every call; returns seeded rows) ─────────────

final class IWSL_Stats_Fake_WPDB {

	/** Prefix property — the ONLY legitimate source of the table identifier. */
	public $prefix = 'wp_';

	/** @var int number of prepare() calls. */
	public $prepare_calls = 0;
	/** @var array<int, array{query:string, args:array}> recorded prepare() invocations. */
	public $prepared = array();
	/** @var string[] strings passed to query(). */
	public $writes = array();
	/** @var string[] strings passed to get_results(). */
	public $selects = array();

	/** @var array<int, array> canned rows returned by get_results(). */
	private $rows;

	public function __construct( array $rows = array() ) {
		$this->rows = $rows;
	}

	public function prepare( string $query, ...$args ): string {
		$this->prepare_calls++;
		$this->prepared[] = array(
			'query' => $query,
			'args'  => $args,
		);
		$out = $query;
		foreach ( $args as $a ) {
			$repl  = is_int( $a ) ? (string) $a : "'" . str_replace( "'", "''", (string) $a ) . "'";
			$pos_s = strpos( $out, '%s' );
			$pos_d = strpos( $out, '%d' );
			if ( false !== $pos_s && ( false === $pos_d || $pos_s < $pos_d ) ) {
				$pos = $pos_s;
			} elseif ( false !== $pos_d ) {
				$pos = $pos_d;
			} else {
				$pos = false;
			}
			if ( false !== $pos ) {
				$out = substr( $out, 0, $pos ) . $repl . substr( $out, $pos + 2 );
			}
		}
		return $out;
	}

	public function query( string $query ) {
		$this->writes[] = $query;
		return 0;
	}

	/** @param mixed $output */
	public function get_results( string $query, $output = null ) {
		$this->selects[] = $query;
		return $this->rows;
	}

	public function get_charset_collate(): string {
		return '';
	}
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function iwsl_st_clock( int $now_s ): callable {
	return static function () use ( $now_s ): int {
		return $now_s * 1000;
	};
}

/** A store seeded for the entitlement gate with one knob per leg + a fixed salt. */
function iwsl_st_store( string $state, int $last_verified_s, bool $flag, int $now_s ): IWSL_Memory_Store {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $last_verified_s * 1000 );
	$store->set( 'entitlements', array( 'plus' => true, 'statistics' => $flag ) );
	$store->set( 'stats_salt', 'fixed-test-salt' );
	// Suppress the throttled auto-prune during recording tests (set to "now").
	$store->set( 'stats_last_prune', $now_s );
	return $store;
}

/** An unlocked (active + fresh + statistics) engine over $store + $db. */
function iwsl_st_engine( IWSL_Memory_Store $store, $db, int $now_s ): IWSL_Statistics {
	$ent = new IWSL_Entitlements( $store, iwsl_st_clock( $now_s ) );
	return new IWSL_Statistics( $ent, $store, $db, iwsl_st_clock( $now_s ) );
}

/** A normal front-end view context (nothing excluded). */
function iwsl_st_view_ctx(): array {
	return array(
		'is_admin'          => false,
		'is_ajax'           => false,
		'is_cron'           => false,
		'is_rest'           => false,
		'is_feed'           => false,
		'is_robots'         => false,
		'is_trackback'      => false,
		'is_search'         => false,
		'search_query'      => '',
		'is_404'            => false,
		'is_user_logged_in' => false,
		'is_admin_user'     => false,
	);
}

/** A realistic Chrome-on-Windows visitor from Google, in NL. */
function iwsl_st_server(): array {
	return array(
		'REQUEST_URI'          => '/hello?utm=x',
		'HTTP_USER_AGENT'      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
		'HTTP_REFERER'         => 'https://www.google.com/search?q=widgets',
		'HTTP_ACCEPT_LANGUAGE' => 'en-US,en;q=0.9',
		'HTTP_CF_IPCOUNTRY'    => 'NL',
	);
}

/** A stored row (aggregation fixture). */
function iwsl_st_row( int $hit_at, string $visit, string $type, string $path, array $extra = array() ): array {
	return array_merge(
		array(
			'hit_at'        => $hit_at,
			'visit_id'      => $visit,
			'path'          => $path,
			'referer_host'  => '',
			'search_engine' => '',
			'browser'       => '',
			'os'            => '',
			'device'        => '',
			'country'       => '',
			'event_type'    => $type,
			'event_label'   => '',
		),
		$extra
	);
}

/** How many issued strings contain a needle. */
function iwsl_st_count_containing( array $haystacks, string $needle ): int {
	$n = 0;
	foreach ( $haystacks as $h ) {
		if ( false !== strpos( (string) $h, $needle ) ) {
			$n++;
		}
	}
	return $n;
}

$ST_NOW = 8640000; // seconds; day boundary math is exercised below.

// ── 1. Gate BLOCKS recording — no insert, no CREATE, DB never touched ──────────

// (a) statistics flag ABSENT.
$fake1a  = new IWSL_Stats_Fake_WPDB();
$store1a = iwsl_st_store( 'active', $ST_NOW - 60, false, $ST_NOW );
$eng1a   = iwsl_st_engine( $store1a, $fake1a, $ST_NOW );
$r1a     = $eng1a->maybe_record( iwsl_st_server(), iwsl_st_view_ctx() );
iwsl_assert_same( false, $r1a['ok'], 'gate blocks (absent flag): ok=false' );
iwsl_assert_same( 'entitlement-locked', $r1a['reason'], 'gate blocks (absent flag): entitlement-locked' );
iwsl_assert_same( 0, $fake1a->prepare_calls, 'gate blocks (absent flag): $wpdb->prepare NEVER called' );
iwsl_assert_same( 0, count( $fake1a->writes ), 'gate blocks (absent flag): no INSERT/DELETE issued' );
iwsl_assert_same( 0, count( $fake1a->selects ), 'gate blocks (absent flag): no SELECT issued' );
iwsl_assert_same( 0, iwsl_st_count_containing( $fake1a->writes, 'CREATE' ), 'gate blocks (absent flag): no CREATE TABLE issued' );

// (b) state != active, even WITH the flag true.
$fake1b  = new IWSL_Stats_Fake_WPDB();
$store1b = iwsl_st_store( 'pending', $ST_NOW - 60, true, $ST_NOW );
$eng1b   = iwsl_st_engine( $store1b, $fake1b, $ST_NOW );
$r1b     = $eng1b->maybe_record( iwsl_st_server(), iwsl_st_view_ctx() );
iwsl_assert_same( 'entitlement-locked', $r1b['reason'], 'gate blocks (not active): locked despite flag' );
iwsl_assert_same( 0, $fake1b->prepare_calls, 'gate blocks (not active): $wpdb never touched' );

// (c) stale heartbeat, even WITH the flag true.
$fake1c  = new IWSL_Stats_Fake_WPDB();
$store1c = iwsl_st_store( 'active', $ST_NOW - 10800, true, $ST_NOW ); // 3h ago — stale
$eng1c   = iwsl_st_engine( $store1c, $fake1c, $ST_NOW );
$r1c     = $eng1c->maybe_record( iwsl_st_server(), iwsl_st_view_ctx() );
iwsl_assert_same( 'entitlement-locked', $r1c['reason'], 'gate blocks (stale heartbeat): locked despite flag' );
iwsl_assert_same( 0, count( $fake1c->writes ), 'gate blocks (stale heartbeat): no query issued' );

// ── 2. Pure classifiers: UA → {browser,os,device} ─────────────────────────────

$ua_chrome  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
$ua_iphone  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
$ua_android = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
$ua_tablet  = 'Mozilla/5.0 (Android 13; Tablet; rv:120.0) Gecko/120.0 Firefox/120.0';
$ua_edge    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0';

$c = IWSL_Stats_Classifier::classify_ua( $ua_chrome );
iwsl_assert_same( 'Chrome', $c['browser'], 'ua: Chrome/Windows → browser Chrome' );
iwsl_assert_same( 'Windows', $c['os'], 'ua: Chrome/Windows → os Windows' );
iwsl_assert_same( 'desktop', $c['device'], 'ua: Chrome/Windows → device desktop' );

$i = IWSL_Stats_Classifier::classify_ua( $ua_iphone );
iwsl_assert_same( 'Safari', $i['browser'], 'ua: iPhone → browser Safari' );
iwsl_assert_same( 'iOS', $i['os'], 'ua: iPhone → os iOS' );
iwsl_assert_same( 'mobile', $i['device'], 'ua: iPhone → device mobile' );

$a = IWSL_Stats_Classifier::classify_ua( $ua_android );
iwsl_assert_same( 'Chrome', $a['browser'], 'ua: Android Chrome → browser Chrome' );
iwsl_assert_same( 'Android', $a['os'], 'ua: Android → os Android' );
iwsl_assert_same( 'mobile', $a['device'], 'ua: Android + Mobile → device mobile' );

$t = IWSL_Stats_Classifier::classify_ua( $ua_tablet );
iwsl_assert_same( 'Firefox', $t['browser'], 'ua: Android Firefox tablet → browser Firefox' );
iwsl_assert_same( 'tablet', $t['device'], 'ua: Android without Mobile / Tablet → device tablet' );

iwsl_assert_same( 'Edge', IWSL_Stats_Classifier::browser( $ua_edge ), 'ua: Edg token → browser Edge (superset ordering)' );

// referrer → search engine + host.
iwsl_assert_same( 'google.com', IWSL_Stats_Classifier::referer_host( 'https://www.google.com/search?q=x', 'mysite.test' ), 'referer: www stripped → google.com' );
iwsl_assert_same( '', IWSL_Stats_Classifier::referer_host( 'https://mysite.test/page', 'mysite.test' ), 'referer: same-origin → empty (not an external referrer)' );
iwsl_assert_same( 'Google', IWSL_Stats_Classifier::search_engine_from_host( 'google.co.uk' ), 'search engine: regional google → Google' );
iwsl_assert_same( 'DuckDuckGo', IWSL_Stats_Classifier::search_engine_from_host( 'duckduckgo.com' ), 'search engine: duckduckgo → DuckDuckGo' );
iwsl_assert_same( '', IWSL_Stats_Classifier::search_engine_from_host( 'example.com' ), 'search engine: non-engine host → empty' );

// country precedence: CF header > Accept-Language region > Unknown.
iwsl_assert_same( 'NL', IWSL_Stats_Classifier::country( 'NL', 'en-US,en;q=0.9' ), 'country: CF header wins' );
iwsl_assert_same( 'DE', IWSL_Stats_Classifier::country( 'XX', 'de-DE' ), 'country: CF "XX" ignored → Accept-Language region DE' );
iwsl_assert_same( 'FR', IWSL_Stats_Classifier::country( null, 'fr-FR,fr;q=0.9' ), 'country: no CF → first Accept-Language region FR' );
iwsl_assert_same( 'Unknown', IWSL_Stats_Classifier::country( null, 'nl' ), 'country: language without region → Unknown' );
iwsl_assert_same( 'Unknown', IWSL_Stats_Classifier::country( null, null ), 'country: nothing → Unknown' );

// bot exclusion + DNT.
iwsl_assert_same( true, IWSL_Stats_Classifier::is_bot( 'Googlebot/2.1 (+http://www.google.com/bot.html)' ), 'bot: Googlebot excluded' );
iwsl_assert_same( true, IWSL_Stats_Classifier::is_bot( 'curl/8.0.1' ), 'bot: curl excluded' );
iwsl_assert_same( true, IWSL_Stats_Classifier::is_bot( '' ), 'bot: empty UA treated as bot' );
iwsl_assert_same( false, IWSL_Stats_Classifier::is_bot( $ua_chrome ), 'bot: real Chrome not a bot' );
iwsl_assert_same( true, IWSL_Stats_Classifier::dnt_set( array( 'HTTP_DNT' => '1' ) ), 'dnt: header 1 → set' );
iwsl_assert_same( false, IWSL_Stats_Classifier::dnt_set( array( 'HTTP_DNT' => '0' ) ), 'dnt: header 0 → not set' );

// bot + DNT block recording at the engine (no insert).
$fakeBot  = new IWSL_Stats_Fake_WPDB();
$storeBot = iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW );
$engBot   = iwsl_st_engine( $storeBot, $fakeBot, $ST_NOW );
$rBot     = $engBot->maybe_record( array( 'REQUEST_URI' => '/x', 'HTTP_USER_AGENT' => 'Googlebot/2.1' ), iwsl_st_view_ctx() );
iwsl_assert_same( 'bot', $rBot['reason'], 'engine: bot request records nothing (reason bot)' );
iwsl_assert_same( 0, count( $fakeBot->writes ), 'engine: bot request issues no INSERT' );

$fakeDnt  = new IWSL_Stats_Fake_WPDB();
$storeDnt = iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW );
$engDnt   = iwsl_st_engine( $storeDnt, $fakeDnt, $ST_NOW );
$rDnt     = $engDnt->maybe_record( array( 'REQUEST_URI' => '/x', 'HTTP_USER_AGENT' => $ua_chrome, 'HTTP_DNT' => '1' ), iwsl_st_view_ctx() );
iwsl_assert_same( 'dnt', $rDnt['reason'], 'engine: DNT request records nothing (reason dnt)' );
iwsl_assert_same( 0, count( $fakeDnt->writes ), 'engine: DNT request issues no INSERT' );

// ── 3. Recording writes ONE prepared INSERT with the classified row ───────────

$fake3  = new IWSL_Stats_Fake_WPDB();
$store3 = iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW );
$eng3   = iwsl_st_engine( $store3, $fake3, $ST_NOW );
$r3     = $eng3->maybe_record( iwsl_st_server(), iwsl_st_view_ctx() );
iwsl_assert_same( true, $r3['recorded'], 'record: a normal visitor is recorded' );
$row3 = $r3['row'];
iwsl_assert_same( '/hello', $row3['path'], 'record: path parsed without query string' );
iwsl_assert_same( 'Chrome', $row3['browser'], 'record: browser classified' );
iwsl_assert_same( 'Windows', $row3['os'], 'record: os classified' );
iwsl_assert_same( 'desktop', $row3['device'], 'record: device classified' );
iwsl_assert_same( 'NL', $row3['country'], 'record: country from CF header' );
iwsl_assert_same( 'google.com', $row3['referer_host'], 'record: referrer host folded' );
iwsl_assert_same( 'Google', $row3['search_engine'], 'record: search engine parsed from referrer' );
iwsl_assert_same( 'view', $row3['event_type'], 'record: default event type is view' );
iwsl_assert_same( 32, strlen( $row3['visit_id'] ), 'record: visit id is a 32-char anonymous bucket' );
iwsl_assert_same( 1, iwsl_st_count_containing( $fake3->writes, 'INSERT INTO' ), 'record: exactly one INSERT issued' );
iwsl_assert_same( 0, iwsl_st_count_containing( $fake3->writes, 'DELETE' ), 'record: no prune fired (throttle suppressed)' );

// search event.
$fake3s = new IWSL_Stats_Fake_WPDB();
$eng3s  = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW ), $fake3s, $ST_NOW );
$ctx_s  = array_merge( iwsl_st_view_ctx(), array( 'is_search' => true, 'search_query' => 'blue widgets' ) );
$r3s    = $eng3s->maybe_record( iwsl_st_server(), $ctx_s );
iwsl_assert_same( 'search', $r3s['row']['event_type'], 'record: search context → event type search' );
iwsl_assert_same( 'blue widgets', $r3s['row']['event_label'], 'record: search query captured as label' );

// 404 event.
$fake3n = new IWSL_Stats_Fake_WPDB();
$eng3n  = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW ), $fake3n, $ST_NOW );
$ctx_n  = array_merge( iwsl_st_view_ctx(), array( 'is_404' => true ) );
$r3n    = $eng3n->maybe_record( iwsl_st_server(), $ctx_n );
iwsl_assert_same( 'not_found', $r3n['row']['event_type'], 'record: 404 context → event type not_found' );

// admin user + logged-in exclusion.
$fake3a = new IWSL_Stats_Fake_WPDB();
$eng3a  = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW ), $fake3a, $ST_NOW );
$r3a    = $eng3a->maybe_record( iwsl_st_server(), array_merge( iwsl_st_view_ctx(), array( 'is_admin_user' => true ) ) );
iwsl_assert_same( 'admin-user', $r3a['reason'], 'record: admins are excluded' );
iwsl_assert_same( 0, count( $fake3a->writes ), 'record: admin request issues no INSERT' );

$fake3l = new IWSL_Stats_Fake_WPDB();
$eng3l  = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW ), $fake3l, $ST_NOW );
$r3l    = $eng3l->maybe_record( iwsl_st_server(), array_merge( iwsl_st_view_ctx(), array( 'is_user_logged_in' => true ) ) );
iwsl_assert_same( 'logged-in', $r3l['reason'], 'record: logged-in visitors excluded by default' );

// ── 4. SQL uses prepared statements + hardcoded identifiers ────────────────────

$insert_prepared = null;
foreach ( $fake3->prepared as $p ) {
	if ( false !== strpos( $p['query'], 'INSERT INTO' ) ) {
		$insert_prepared = $p;
	}
}
iwsl_assert( null !== $insert_prepared, 'sql: the INSERT went through $wpdb->prepare()' );
if ( null !== $insert_prepared ) {
	iwsl_assert( false !== strpos( $insert_prepared['query'], 'INSERT INTO wp_iwsl_stats_hits' ), 'sql: INSERT targets the hardcoded prefixed table' );
	iwsl_assert_same( 11, count( $insert_prepared['args'] ), 'sql: all 11 column values are bound arguments' );
	iwsl_assert_same( 11, substr_count( $insert_prepared['query'], '%' ), 'sql: 11 placeholders in the INSERT template (no interpolated values)' );
}
// Every table identifier in every issued query is exactly the one hardcoded table.
$only_known = true;
foreach ( array_merge( $fake3->writes, $fake3->selects ) as $q ) {
	if ( preg_match_all( '/\bwp_[a-z_]+/', $q, $m ) ) {
		foreach ( $m[0] as $ident ) {
			if ( 'wp_iwsl_stats_hits' !== $ident ) {
				$only_known = false;
			}
		}
	}
}
iwsl_assert( true === $only_known, 'sql: every wp_ identifier in every query is the hardcoded stats table' );

// Hostile $wpdb->prefix collapses to no-database — nothing is ever written.
$fake4h         = new IWSL_Stats_Fake_WPDB();
$fake4h->prefix = 'wp_; DROP TABLE x;--';
$eng4h          = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW ), $fake4h, $ST_NOW );
$r4h            = $eng4h->maybe_record( iwsl_st_server(), iwsl_st_view_ctx() );
iwsl_assert_same( 'no-database', $r4h['reason'], 'sql: hostile prefix → no-database, nothing recorded' );
iwsl_assert_same( 0, count( $fake4h->writes ), 'sql: hostile prefix → zero queries issued' );

// ── 5. Aggregation math (top-N, uniques, period comparison) ────────────────────

$AG_NOW      = ( 100 * 86400 ) + 50000; // mid-day on day 100.
$today_start = $AG_NOW - ( $AG_NOW % 86400 );
$day         = 86400;
$rows        = array(
	iwsl_st_row( $AG_NOW - 3600, 'A', 'view', '/a', array( 'browser' => 'Chrome', 'country' => 'NL', 'device' => 'desktop', 'search_engine' => 'Google' ) ),
	iwsl_st_row( $AG_NOW - 7200, 'A', 'view', '/a', array( 'browser' => 'Chrome', 'country' => 'NL', 'device' => 'desktop', 'search_engine' => 'Google' ) ),
	iwsl_st_row( $AG_NOW - ( 3 * $day ), 'B', 'view', '/b', array( 'browser' => 'Firefox', 'country' => 'DE', 'device' => 'mobile' ) ),
	iwsl_st_row( $AG_NOW - ( 5 * $day ), 'C', 'view', '/c', array( 'browser' => 'Safari', 'country' => 'US', 'device' => 'tablet' ) ),
	iwsl_st_row( $AG_NOW - ( 5 * $day ), 'C', 'search', '/c', array( 'event_label' => 'query text' ) ),
	iwsl_st_row( $AG_NOW - ( 8 * $day ), 'D', 'view', '/d' ), // prior window
	iwsl_st_row( $AG_NOW - ( 9 * $day ), 'D', 'view', '/d' ), // prior window
	iwsl_st_row( $AG_NOW - 200, 'E', 'view', '/a', array( 'browser' => 'Chrome', 'country' => 'NL', 'device' => 'desktop', 'search_engine' => 'Bing' ) ),
);

$agg = IWSL_Stats_Classifier::aggregate( $rows, $AG_NOW, 7 );
$kpi = $agg['kpi'];
iwsl_assert_same( 5, $kpi['views'], 'agg: 5 views in the 7-day window' );
iwsl_assert_same( 4, $kpi['visits'], 'agg: 4 unique visits in the window (A,B,C,E)' );
iwsl_assert_same( 1, $kpi['events'], 'agg: 1 non-view event in the window (the search)' );
iwsl_assert_same( 3, $kpi['views_today'], 'agg: 3 views today' );
iwsl_assert_same( 1, $kpi['online_now'], 'agg: 1 visitor online now (within 5 min)' );
iwsl_assert_same( 2, $kpi['prev_views'], 'agg: 2 views in the prior 7-day window' );
iwsl_assert_same( 1, $kpi['prev_visits'], 'agg: 1 unique visit in the prior window' );
iwsl_assert_same( 150.0, $kpi['views_delta_pct'], 'agg: views delta +150% vs prior' );
iwsl_assert_same( 300.0, $kpi['visits_delta_pct'], 'agg: visits delta +300% vs prior' );

iwsl_assert_same( '/a', $agg['top_pages'][0]['label'], 'agg: top page is /a' );
iwsl_assert_same( 3, $agg['top_pages'][0]['count'], 'agg: /a has 3 views' );
iwsl_assert_same( 'Chrome', $agg['browsers'][0]['label'], 'agg: top browser Chrome' );
iwsl_assert_same( 3, $agg['browsers'][0]['count'], 'agg: Chrome has 3 views' );
iwsl_assert_same( 'Google', $agg['search_engines'][0]['label'], 'agg: top search engine Google' );
iwsl_assert_same( 2, $agg['search_engines'][0]['count'], 'agg: Google has 2 hits' );
iwsl_assert_same( 'NL', $agg['countries'][0]['label'], 'agg: top country NL' );
iwsl_assert_same( 3, $agg['countries'][0]['count'], 'agg: NL has 3 views' );
iwsl_assert_same( 'desktop', $agg['devices'][0]['label'], 'agg: top device desktop' );
iwsl_assert_same( 1, count( $agg['recent_events'] ), 'agg: 1 recent event surfaced' );
iwsl_assert_same( 'search', $agg['recent_events'][0]['type'], 'agg: recent event is the search' );
iwsl_assert_same( 30, count( $agg['series'] ), 'agg: 30-day series is dense (zero-filled)' );
iwsl_assert_same( 3, $agg['series'][29]['views'], 'agg: last series day = today has 3 views' );

// pure helpers.
iwsl_assert_same( null, IWSL_Stats_Classifier::delta_pct( 5, 0 ), 'agg: delta vs zero baseline is null' );
iwsl_assert_same( 100.0, IWSL_Stats_Classifier::delta_pct( 4, 2 ), 'agg: delta 4 vs 2 = +100%' );
$topn = IWSL_Stats_Classifier::top_n( array( 'b' => 2, 'a' => 2, 'c' => 1 ), 10 );
iwsl_assert_same( 'a', $topn[0]['label'], 'agg: top_n breaks count ties by label ascending (deterministic)' );

// ── 6. Retention pruning caps the table (bounded, prepared) ────────────────────

$fake6  = new IWSL_Stats_Fake_WPDB();
$eng6   = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW ), $fake6, $ST_NOW );
$r6     = $eng6->prune( $fake6 );
iwsl_assert_same( true, $r6['ok'], 'prune: ok=true' );
iwsl_assert_same( 2, count( $fake6->writes ), 'prune: exactly two bounded DELETE statements' );
iwsl_assert_same( 2, $fake6->prepare_calls, 'prune: both DELETEs go through prepare()' );
iwsl_assert_same( 2, iwsl_st_count_containing( $fake6->writes, 'DELETE FROM wp_iwsl_stats_hits' ), 'prune: both DELETEs target the hardcoded table' );
iwsl_assert_same( 1, iwsl_st_count_containing( $fake6->writes, 'hit_at <' ), 'prune: age-based DELETE (hit_at < cutoff)' );
iwsl_assert_same( 1, iwsl_st_count_containing( $fake6->writes, (string) IWSL_Statistics::MAX_ROWS ), 'prune: cap DELETE bounded to MAX_ROWS newest rows' );
$no_ddl6 = 0 === iwsl_st_count_containing( $fake6->writes, 'DROP' )
	&& 0 === iwsl_st_count_containing( $fake6->writes, 'TRUNCATE' )
	&& 0 === iwsl_st_count_containing( $fake6->writes, 'ALTER' );
iwsl_assert( true === $no_ddl6, 'prune: never DROP/TRUNCATE/ALTER' );

// locked prune touches nothing.
$fake6l  = new IWSL_Stats_Fake_WPDB();
$eng6l   = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, false, $ST_NOW ), $fake6l, $ST_NOW );
$r6l     = $eng6l->prune( $fake6l );
iwsl_assert_same( 'entitlement-locked', $r6l['reason'], 'prune: locked site cannot prune' );
iwsl_assert_same( 0, count( $fake6l->writes ), 'prune: locked prune issues no query' );

// reset clears via a single DELETE (never DDL); locked reset does nothing.
$fake6r = new IWSL_Stats_Fake_WPDB();
$eng6r  = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW ), $fake6r, $ST_NOW );
$rr     = $eng6r->reset( $fake6r );
iwsl_assert_same( true, $rr['cleared'], 'reset: cleared=true' );
iwsl_assert_same( 1, iwsl_st_count_containing( $fake6r->writes, 'DELETE FROM wp_iwsl_stats_hits' ), 'reset: one DELETE over the hardcoded table' );
iwsl_assert_same( 0, iwsl_st_count_containing( $fake6r->writes, 'TRUNCATE' ), 'reset: never TRUNCATE' );

$fake6rl = new IWSL_Stats_Fake_WPDB();
$eng6rl  = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, false, $ST_NOW ), $fake6rl, $ST_NOW );
$rrl     = $eng6rl->reset( $fake6rl );
iwsl_assert_same( 'entitlement-locked', $rrl['reason'], 'reset: locked site cannot clear' );
iwsl_assert_same( 0, count( $fake6rl->writes ), 'reset: locked reset issues no query' );

// ── 7. Dashboard read path uses one prepared, bounded SELECT ───────────────────

$read_rows = array(
	iwsl_st_row( $AG_NOW - 3600, 'A', 'view', '/a' ),
	iwsl_st_row( $AG_NOW - 7200, 'B', 'view', '/b' ),
);
$fake7 = new IWSL_Stats_Fake_WPDB( $read_rows );
$eng7  = iwsl_st_engine( iwsl_st_store( 'active', ( $AG_NOW / 1 ) - 60, true, $AG_NOW ), $fake7, $AG_NOW );
$dash  = $eng7->dashboard( 7 );
iwsl_assert_same( 2, $dash['kpi']['views'], 'dashboard: aggregates the rows returned by get_results' );
iwsl_assert_same( 1, count( $fake7->selects ), 'dashboard: exactly one SELECT issued' );
iwsl_assert( false !== strpos( $fake7->selects[0], 'FROM wp_iwsl_stats_hits' ), 'dashboard: SELECT targets the hardcoded table' );
iwsl_assert( false !== strpos( $fake7->selects[0], 'WHERE hit_at >=' ), 'dashboard: SELECT is windowed by hit_at' );
iwsl_assert( false !== stripos( $fake7->selects[0], 'LIMIT' ), 'dashboard: SELECT is bounded by a LIMIT' );

// ── 8. render_section escapes + self-gates (locked shows a notice, unlocked SVG) ─

// Locked render emits only a warning notice — no table, no chart.
$fake8l = new IWSL_Stats_Fake_WPDB();
$eng8l  = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, false, $ST_NOW ), $fake8l, $ST_NOW );
ob_start();
$eng8l->render_section();
$html_locked = ob_get_clean();
iwsl_assert( false !== strpos( $html_locked, 'notice-warning' ), 'render: locked → warning notice' );
iwsl_assert( false === strpos( $html_locked, '<svg' ), 'render: locked → no chart rendered' );

// Unlocked render emits the dashboard with inline SVG and no external references.
$fake8 = new IWSL_Stats_Fake_WPDB( $read_rows );
$eng8  = iwsl_st_engine( iwsl_st_store( 'active', $AG_NOW - 60, true, $AG_NOW ), $fake8, $AG_NOW );
ob_start();
$eng8->render_section();
$html = ob_get_clean();
iwsl_assert( false !== strpos( $html, '<svg' ), 'render: unlocked → inline SVG charts present' );
iwsl_assert( false !== strpos( $html, 'Site Statistics' ), 'render: unlocked → dashboard heading present' );
iwsl_assert( false === strpos( $html, 'http://' ) && false === strpos( $html, '<script' ), 'render: no external http/script references (self-contained)' );
iwsl_assert( false !== strpos( $html, IWSL_Statistics::RESET_ACTION ), 'render: gated reset form present' );

// No global $wpdb was ever installed by this suite; keep the harness clean for later
// suites regardless.
unset( $GLOBALS['wpdb'] );
