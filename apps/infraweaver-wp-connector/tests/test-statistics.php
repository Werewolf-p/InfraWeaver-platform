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
// Self-contained: the redesign legitimately ships an inline <script> island + one
// inlined IIFE, so we no longer forbid <script>; instead we forbid any EXTERNAL
// resource (a src= load, a <link>, or a known CDN host).
iwsl_assert(
	false === strpos( $html, '<link' )
	&& false === strpos( $html, ' src=' )
	&& false === stripos( $html, 'googleapis' )
	&& false === stripos( $html, 'unpkg' )
	&& false === stripos( $html, 'jsdelivr' )
	&& false === stripos( $html, 'chart.js' ),
	'render: no external link/script-src/CDN references (self-contained)'
);
iwsl_assert( false !== strpos( $html, 'id="iwsl-stats-data"' ), 'render: bounded JSON drill island emitted' );
iwsl_assert( false !== strpos( $html, 'application/json' ), 'render: drill island is inert application/json (not executable data)' );
iwsl_assert( false !== strpos( $html, IWSL_Statistics::RESET_ACTION ), 'render: gated reset form present' );

// ── 9. Insights redesign — pure classifier aggregations (Tier-1, no schema) ────

// channel(): search > direct > social > referral, subdomain-suffix aware.
iwsl_assert_same( 'search', IWSL_Stats_Classifier::channel( 'google.com', 'Google' ), 'channel: a search engine → search' );
iwsl_assert_same( 'direct', IWSL_Stats_Classifier::channel( '', '' ), 'channel: no referrer host → direct' );
iwsl_assert_same( 'referral', IWSL_Stats_Classifier::channel( 'example.com', '' ), 'channel: unknown host → referral' );
iwsl_assert_same( 'social', IWSL_Stats_Classifier::channel( 'facebook.com', '' ), 'channel: facebook.com → social' );
iwsl_assert_same( 'social', IWSL_Stats_Classifier::channel( 'l.facebook.com', '' ), 'classifies l.facebook.com referral as social' );
iwsl_assert_same( 'social', IWSL_Stats_Classifier::channel( 'out.reddit.com', '' ), 'channel: out.reddit.com subdomain → social' );
iwsl_assert_same( 'social', IWSL_Stats_Classifier::channel( 't.co', '' ), 'channel: t.co → social' );
iwsl_assert_same( true, IWSL_Stats_Classifier::is_social_host( 'threads.net' ), 'social host: exact match' );
iwsl_assert_same( false, IWSL_Stats_Classifier::is_social_host( 'notfacebook.com' ), 'social host: suffix guard rejects notfacebook.com' );
iwsl_assert_same( false, IWSL_Stats_Classifier::is_social_host( 'example.com' ), 'social host: unrelated host is not social' );

// visit_depths + quality: bounce and pages/visit.
$q_rows_single = array(
	iwsl_st_row( 1000, 'A', 'view', '/a' ),
	iwsl_st_row( 1000, 'B', 'view', '/b' ),
	iwsl_st_row( 1000, 'C', 'view', '/c' ),
);
$depths_single = IWSL_Stats_Classifier::visit_depths( $q_rows_single );
iwsl_assert_same( 1, $depths_single['A'], 'visit_depths: one view for visit A' );
iwsl_assert_same( 3, count( $depths_single ), 'visit_depths: three distinct visits' );
$q_single = IWSL_Stats_Classifier::quality( $q_rows_single );
iwsl_assert_same( 100.0, $q_single['bounce_pct'], 'bounce is 100 when every visit has one view' );
iwsl_assert_same( 1.0, $q_single['pages_per_visit'], 'quality: pages/visit is 1 when every visit is single-page' );
iwsl_assert_same( 3, $q_single['bounced'], 'quality: all three visits bounced' );

$q_rows_mixed = array(
	iwsl_st_row( 1000, 'A', 'view', '/a' ),
	iwsl_st_row( 1100, 'A', 'view', '/b' ),  // A has depth 2 → not a bounce
	iwsl_st_row( 1000, 'B', 'view', '/a' ),  // B has depth 1 → bounce
	iwsl_st_row( 1000, 'C', 'search', '/a' ), // non-view ignored by depth
);
$q_mixed = IWSL_Stats_Classifier::quality( $q_rows_mixed );
iwsl_assert_same( 50.0, $q_mixed['bounce_pct'], 'quality: one of two visits bounced → 50%' );
iwsl_assert_same( 1.5, $q_mixed['pages_per_visit'], 'quality: 3 views / 2 visits → 1.5 pages/visit' );
iwsl_assert_same( 2, $q_mixed['visits'], 'quality: search event does not create a visit' );
$q_empty = IWSL_Stats_Classifier::quality( array() );
iwsl_assert_same( 0.0, $q_empty['bounce_pct'], 'quality: empty rows → 0 bounce (no divide-by-zero)' );
iwsl_assert_same( 0, $q_empty['visits'], 'quality: empty rows → 0 visits' );

// daily_quality: 30 dense days, today reflects current quality.
$DQ_TODAY = ( 200 * 86400 );
$dq_rows  = array(
	iwsl_st_row( $DQ_TODAY + 100, 'A', 'view', '/a' ),
	iwsl_st_row( $DQ_TODAY + 200, 'A', 'view', '/b' ), // A depth 2 today
	iwsl_st_row( $DQ_TODAY + 100, 'B', 'view', '/a' ), // B depth 1 today (bounce)
);
$dq = IWSL_Stats_Classifier::daily_quality( $dq_rows, $DQ_TODAY );
iwsl_assert_same( 30, count( $dq ), 'daily_quality: exactly 30 dense days' );
iwsl_assert_same( 50.0, $dq[29]['bounce_pct'], 'daily_quality: today bounce 50%' );
iwsl_assert_same( 1.5, $dq[29]['ppv'], 'daily_quality: today pages/visit 1.5' );
iwsl_assert_same( 0.0, $dq[0]['bounce_pct'], 'daily_quality: an empty earlier day is 0 (zero-filled)' );

// hourly_series: 24 dense hours bucketed within the calendar day.
$hs_rows = array(
	iwsl_st_row( $DQ_TODAY + ( 14 * 3600 ) + 5, 'A', 'view', '/a' ),
	iwsl_st_row( $DQ_TODAY + ( 14 * 3600 ) + 9, 'B', 'view', '/a' ),
	iwsl_st_row( $DQ_TODAY + ( 2 * 3600 ), 'C', 'view', '/a' ),
	iwsl_st_row( $DQ_TODAY - 50, 'D', 'view', '/a' ),          // previous day, excluded
	iwsl_st_row( $DQ_TODAY + ( 14 * 3600 ), 'E', 'search', '/a' ), // non-view, excluded
);
$hs = IWSL_Stats_Classifier::hourly_series( $hs_rows, $DQ_TODAY );
iwsl_assert_same( 24, count( $hs ), 'hourly_series: 24 dense hour buckets' );
iwsl_assert_same( 2, $hs[14]['views'], 'hourly_series: two views in hour 14' );
iwsl_assert_same( 2, $hs[14]['visits'], 'hourly_series: two distinct visits in hour 14' );
iwsl_assert_same( 1, $hs[2]['views'], 'hourly_series: one view in hour 2' );
iwsl_assert_same( 0, $hs[0]['views'], 'hourly_series: hour 0 is empty (dense zero)' );

// channels: visits grouped by ENTRY channel (first view row per visit).
$ch_rows = array(
	iwsl_st_row( 1000, 'A', 'view', '/a', array( 'search_engine' => 'Google', 'referer_host' => 'google.com' ) ), // search
	iwsl_st_row( 1000, 'B', 'view', '/a', array( 'referer_host' => 'l.facebook.com' ) ),                          // social
	iwsl_st_row( 1000, 'C', 'view', '/a' ),                                                                       // direct
	iwsl_st_row( 1000, 'D', 'view', '/a' ),                                                                       // direct
	iwsl_st_row( 1000, 'E', 'view', '/a', array( 'referer_host' => 'partner.example' ) ),                         // referral
);
$channels = IWSL_Stats_Classifier::channels( $ch_rows );
iwsl_assert_same( 'Direct', $channels[0]['label'], 'channels: Direct leads with 2 visits' );
iwsl_assert_same( 2, $channels[0]['count'], 'channels: 2 direct visits' );
$ch_map = array();
foreach ( $channels as $c ) {
	$ch_map[ $c['label'] ] = $c['count'];
}
iwsl_assert_same( 1, $ch_map['Search'], 'channels: 1 search visit' );
iwsl_assert_same( 1, $ch_map['Social'], 'channels: 1 social visit' );
iwsl_assert_same( 1, $ch_map['Referral'], 'channels: 1 referral visit' );

// channels classifies by the visit's FIRST view even if a later view differs.
$ch_first = array(
	iwsl_st_row( 1000, 'A', 'view', '/a', array( 'referer_host' => 'l.facebook.com' ) ), // first → social
	iwsl_st_row( 2000, 'A', 'view', '/b' ),                                              // later direct, ignored
);
$ch_first_out = IWSL_Stats_Classifier::channels( $ch_first );
iwsl_assert_same( 'Social', $ch_first_out[0]['label'], 'channels: visit classified by its first view (social)' );

// entry_exit: first/last view path per visit, ties break on row order.
$ee_rows = array(
	iwsl_st_row( 1000, 'A', 'view', '/home' ),
	iwsl_st_row( 2000, 'A', 'view', '/pricing' ), // A: entry /home, exit /pricing
	iwsl_st_row( 1500, 'B', 'view', '/contact' ), // B: entry+exit /contact
);
$ee = IWSL_Stats_Classifier::entry_exit( $ee_rows );
$entry_map = array();
foreach ( $ee['entries'] as $e ) {
	$entry_map[ $e['label'] ] = $e['count'];
}
$exit_map = array();
foreach ( $ee['exits'] as $e ) {
	$exit_map[ $e['label'] ] = $e['count'];
}
iwsl_assert_same( 1, $entry_map['/home'], 'entry_exit: /home is an entry page' );
iwsl_assert_same( 1, $entry_map['/contact'], 'entry_exit: /contact is an entry page' );
iwsl_assert_same( 1, $exit_map['/pricing'], 'entry_exit: /pricing is an exit page' );
iwsl_assert_same( false, isset( $entry_map['/pricing'] ), 'entry_exit: /pricing is never an entry (later view)' );

$ee_tie = array(
	iwsl_st_row( 1000, 'T', 'view', '/first' ),  // same hit_at, first in order
	iwsl_st_row( 1000, 'T', 'view', '/second' ),
);
$ee_tie_out = IWSL_Stats_Classifier::entry_exit( $ee_tie );
iwsl_assert_same( '/first', $ee_tie_out['entries'][0]['label'], 'entry page ties break on row order' );

// hour_dow: 7×24 grid, Monday row 0, bucketed in the injected zone.
$utc     = new DateTimeZone( 'UTC' );
$mon14   = ( new DateTimeImmutable( '2021-01-04 14:00:00', $utc ) )->getTimestamp(); // Monday
$sun09   = ( new DateTimeImmutable( '2021-01-10 09:00:00', $utc ) )->getTimestamp(); // Sunday
$hd_rows = array(
	iwsl_st_row( $mon14, 'A', 'view', '/a' ),
	iwsl_st_row( $mon14 + 30, 'B', 'view', '/a' ),
	iwsl_st_row( $sun09, 'C', 'view', '/a' ),
	iwsl_st_row( $mon14, 'D', 'search', '/a' ), // non-view excluded
);
$grid = IWSL_Stats_Classifier::hour_dow( $hd_rows, $utc );
iwsl_assert_same( 7, count( $grid ), 'hour_dow: 7 day rows' );
iwsl_assert_same( 24, count( $grid[0] ), 'hour_dow: 24 hour columns' );
iwsl_assert_same( 2, $grid[0][14], 'hour_dow: Monday 14:00 has 2 views (row 0 = Monday)' );
iwsl_assert_same( 1, $grid[6][9], 'hour_dow: Sunday 09:00 has 1 view (row 6 = Sunday)' );
iwsl_assert_same( 0, $grid[3][3], 'hour_dow: an empty cell is 0' );

// heat_summary: deterministic English one-liner; empty grid → placeholder.
$summary = IWSL_Stats_Classifier::heat_summary( $grid );
iwsl_assert( false !== strpos( $summary, 'Busiest around Monday 14:00' ), 'heat_summary: busiest cell named' );
$empty_grid = array();
for ( $d = 0; $d < 7; $d++ ) {
	$empty_grid[ $d ] = array_fill( 0, 24, 0 );
}
iwsl_assert_same( 'No activity recorded yet.', IWSL_Stats_Classifier::heat_summary( $empty_grid ), 'heat_summary: empty grid → placeholder' );

// top_searches: rank on-site search queries.
$ts_rows = array(
	iwsl_st_row( 1000, 'A', 'search', '/', array( 'event_label' => 'widgets' ) ),
	iwsl_st_row( 1100, 'B', 'search', '/', array( 'event_label' => 'widgets' ) ),
	iwsl_st_row( 1200, 'C', 'search', '/', array( 'event_label' => 'gadgets' ) ),
	iwsl_st_row( 1300, 'D', 'view', '/', array( 'event_label' => 'not a search' ) ),
);
$ts = IWSL_Stats_Classifier::top_searches( $ts_rows );
iwsl_assert_same( 'widgets', $ts[0]['label'], 'top_searches: most frequent query first' );
iwsl_assert_same( 2, $ts[0]['count'], 'top_searches: widgets searched twice' );
iwsl_assert_same( 2, count( $ts ), 'top_searches: only search events counted' );

// filter_rows: exact field match.
$fr_rows = array(
	iwsl_st_row( 1000, 'A', 'view', '/a', array( 'country' => 'NL' ) ),
	iwsl_st_row( 1000, 'B', 'view', '/b', array( 'country' => 'DE' ) ),
	iwsl_st_row( 1000, 'C', 'view', '/a', array( 'country' => 'NL' ) ),
);
iwsl_assert_same( 2, count( IWSL_Stats_Classifier::filter_rows( $fr_rows, 'path', '/a' ) ), 'filter_rows: two rows on /a' );
iwsl_assert_same( 1, count( IWSL_Stats_Classifier::filter_rows( $fr_rows, 'country', 'DE' ) ), 'filter_rows: one row in DE' );
iwsl_assert_same( 0, count( IWSL_Stats_Classifier::filter_rows( $fr_rows, 'path', '/nope' ) ), 'filter_rows: no match → empty' );

// drill_payload: bounded, structured, four named dims only.
$dp_today = ( 300 * 86400 );
$dp_rows  = array(
	iwsl_st_row( $dp_today + 10, 'A', 'view', '/pricing', array( 'referer_host' => 'google.com', 'search_engine' => 'Google', 'country' => 'NL', 'device' => 'desktop' ) ),
	iwsl_st_row( $dp_today + 20, 'A', 'view', '/pricing', array( 'referer_host' => 'google.com', 'search_engine' => 'Google', 'country' => 'NL', 'device' => 'desktop' ) ),
	iwsl_st_row( $dp_today + 30, 'B', 'view', '/pricing', array( 'referer_host' => 'partner.example', 'country' => 'DE', 'device' => 'mobile' ) ),
	iwsl_st_row( $dp_today + 40, 'C', 'view', '/home', array( 'country' => 'NL', 'device' => 'desktop' ) ),
);
$drill = IWSL_Stats_Classifier::drill_payload( $dp_rows, $dp_today );
iwsl_assert_same( array( 'page', 'referrer', 'country', 'channel' ), array_keys( $drill ), 'drill_payload: exactly the four named dims' );
iwsl_assert( isset( $drill['page']['/pricing'] ), 'drill_payload: /pricing is a page key' );
$pri = $drill['page']['/pricing'];
iwsl_assert_same( 3, $pri['views'], 'drill_payload: /pricing has 3 views' );
iwsl_assert_same( 2, $pri['visits'], 'drill_payload: /pricing has 2 visits' );
iwsl_assert_same( 30, count( $pri['series'] ), 'drill_payload: entry carries a 30-day series' );
iwsl_assert_same( 3, $pri['series'][29], 'drill_payload: today slot of /pricing series = 3' );
iwsl_assert( 75.0 === $pri['share_pct'], 'drill_payload: /pricing = 3 of 4 views = 75%' );
iwsl_assert( count( $pri['a'] ) <= 5, 'drill_payload: complementary list a is ≤5 pairs' );
iwsl_assert( count( $pri['b'] ) <= 5, 'drill_payload: complementary list b is ≤5 pairs' );
iwsl_assert( count( $drill['page'] ) <= 10, 'drill_payload: page dim ≤ TOP_N keys' );
iwsl_assert( isset( $drill['channel']['search'] ), 'drill_payload: search channel present' );
iwsl_assert( isset( $drill['channel']['direct'] ), 'drill_payload: direct channel present' );
// Each drill pair is a compact [label,count] two-tuple.
$first_pair = $pri['a'][0] ?? null;
iwsl_assert( is_array( $first_pair ) && 2 === count( $first_pair ), 'drill_payload: pairs are [label,count] two-tuples' );

// aggregate() now carries the redesign keys over the same single pass.
$AG2_NOW  = ( 400 * 86400 ) + 40000;
$ag2_rows = array(
	iwsl_st_row( $AG2_NOW - 100, 'A', 'view', '/a', array( 'referer_host' => 'google.com', 'search_engine' => 'Google', 'country' => 'NL', 'device' => 'desktop' ) ),
	iwsl_st_row( $AG2_NOW - 200, 'A', 'view', '/b', array( 'referer_host' => 'google.com', 'search_engine' => 'Google', 'country' => 'NL', 'device' => 'desktop' ) ),
	iwsl_st_row( $AG2_NOW - 300, 'B', 'view', '/a', array( 'country' => 'DE', 'device' => 'mobile' ) ),
);
$ag2 = IWSL_Stats_Classifier::aggregate( $ag2_rows, $AG2_NOW, 7, $utc );
iwsl_assert( isset( $ag2['quality']['bounce_pct'] ), 'aggregate: quality block present' );
iwsl_assert_same( 50.0, $ag2['quality']['bounce_pct'], 'aggregate: quality bounce (B bounced of A,B)' );
iwsl_assert( isset( $ag2['quality']['prev_bounce_pct'] ), 'aggregate: quality carries prev_bounce_pct for compare' );
iwsl_assert( isset( $ag2['quality']['prev_ppv'] ), 'aggregate: quality carries prev_ppv for compare' );
iwsl_assert( isset( $ag2['channels'] ), 'aggregate: channels block present' );
iwsl_assert( isset( $ag2['entries'] ) && isset( $ag2['exits'] ), 'aggregate: entries + exits present' );
iwsl_assert( isset( $ag2['heatmap'] ) && 7 === count( $ag2['heatmap'] ), 'aggregate: 7-row heatmap present' );
iwsl_assert( isset( $ag2['heat_summary'] ) && is_string( $ag2['heat_summary'] ), 'aggregate: heat_summary sentence present' );
iwsl_assert( isset( $ag2['daily_quality'] ) && 30 === count( $ag2['daily_quality'] ), 'aggregate: 30-day daily_quality present' );
iwsl_assert( isset( $ag2['drill']['page'] ), 'aggregate: drill payload present' );
iwsl_assert( isset( $ag2['searches'] ), 'aggregate: searches present' );
iwsl_assert_same( array(), $ag2['hourly'], 'aggregate: hourly is empty unless range=1' );

// range=1 populates the hourly + hourly_prev arms.
$ag_today = IWSL_Stats_Classifier::aggregate( $ag2_rows, $AG2_NOW, 1, $utc );
iwsl_assert_same( 24, count( $ag_today['hourly'] ), 'aggregate: range=1 → 24 hourly buckets' );
iwsl_assert_same( 24, count( $ag_today['hourly_prev'] ), 'aggregate: range=1 → 24 previous-day buckets' );

// ── 10. View render: KPI hero, charts, drill affordances, drawer, degradation ──

$V_NOW      = ( 500 * 86400 ) + 45000;
$view_rows  = array(
	iwsl_st_row( $V_NOW - 100, 'A', 'view', '/pricing', array( 'referer_host' => 'google.com', 'search_engine' => 'Google', 'country' => 'NL', 'device' => 'desktop', 'browser' => 'Chrome', 'os' => 'Windows' ) ),
	iwsl_st_row( $V_NOW - 200, 'A', 'view', '/home', array( 'referer_host' => 'google.com', 'search_engine' => 'Google', 'country' => 'NL', 'device' => 'desktop', 'browser' => 'Chrome', 'os' => 'Windows' ) ),
	iwsl_st_row( $V_NOW - 300, 'B', 'view', '/home', array( 'referer_host' => 'l.facebook.com', 'country' => 'DE', 'device' => 'mobile', 'browser' => 'Safari', 'os' => 'iOS' ) ),
	iwsl_st_row( $V_NOW - 400, 'C', 'search', '/', array( 'event_label' => 'blue widgets' ) ),
);
$fakeV = new IWSL_Stats_Fake_WPDB( $view_rows );
$engV  = iwsl_st_engine( iwsl_st_store( 'active', $V_NOW - 60, true, $V_NOW ), $fakeV, $V_NOW );
ob_start();
$engV->render_section();
$htmlV = ob_get_clean();
iwsl_assert( class_exists( 'IWSL_Statistics_View' ), 'view: IWSL_Statistics_View autoloaded via statistics.php require' );
iwsl_assert( false !== strpos( $htmlV, 'iwsl-stats__kpis' ), 'view: KPI hero strip rendered' );
iwsl_assert( false !== strpos( $htmlV, 'iwsl-donut' ), 'view: donut chart rendered' );
iwsl_assert( false !== strpos( $htmlV, 'iwsl-heat' ), 'view: activity heatmap rendered' );
iwsl_assert( false !== strpos( $htmlV, 'iwsl-drawer' ), 'view: drill drawer shell rendered' );
iwsl_assert( false !== strpos( $htmlV, 'data-dim="page"' ), 'view: page rows are drill buttons' );
iwsl_assert( false !== strpos( $htmlV, 'aria-haspopup="dialog"' ), 'view: drill rows advertise a dialog' );
iwsl_assert( false !== strpos( $htmlV, 'iwsl-stats__spark' ), 'view: KPI sparklines rendered' );
iwsl_assert( false !== strpos( $htmlV, 'id="iwsl-stats-data"' ), 'view: JSON island present in section' );
iwsl_assert( false === strpos( $htmlV, '<link' ) && false === strpos( $htmlV, ' src=' ), 'view: still fully self-contained (no external resource)' );
iwsl_assert( false !== strpos( $htmlV, 'aria-pressed' ), 'view: metric-toggle tiles expose aria-pressed (degradable)' );

// Zero-data render must still produce a full, readable dashboard (graceful empty).
$fakeVE = new IWSL_Stats_Fake_WPDB( array() );
$engVE  = iwsl_st_engine( iwsl_st_store( 'active', $V_NOW - 60, true, $V_NOW ), $fakeVE, $V_NOW );
ob_start();
$engVE->render_section();
$htmlVE = ob_get_clean();
iwsl_assert( false !== strpos( $htmlVE, 'iwsl-stats__kpis' ), 'view: zero-data still renders KPI strip' );
iwsl_assert( false !== strpos( $htmlVE, 'iwsl-stats' ), 'view: zero-data still renders the dashboard shell' );

// ── 11. purge(): teardown DROPS the table + removes option keys (idempotent) ──

$fake11  = new IWSL_Stats_Fake_WPDB();
$store11 = iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW );
$eng11   = iwsl_st_engine( $store11, $fake11, $ST_NOW );
$p11     = $eng11->purge();
iwsl_assert_same( true, $p11['ok'], 'purge: ok=true' );
iwsl_assert_same( true, $p11['table_dropped'], 'purge: table_dropped reported true (DROP issued)' );
iwsl_assert_same( 1, iwsl_st_count_containing( $fake11->writes, 'DROP TABLE IF EXISTS' ), 'purge: exactly one DROP TABLE IF EXISTS issued' );
iwsl_assert_same( 1, iwsl_st_count_containing( $fake11->writes, 'wp_iwsl_stats_hits' ), 'purge: DROP targets the hardcoded prefixed table' );
iwsl_assert_same(
	array( IWSL_Statistics::SCHEMA_KEY, IWSL_Statistics::SALT_KEY, IWSL_Statistics::LAST_PRUNE_KEY, IWSL_Statistics::EXCLUDE_LOGGED_KEY ),
	$p11['options_removed'],
	'purge: reports the four removed option keys'
);
iwsl_assert_same( null, $store11->get( IWSL_Statistics::SCHEMA_KEY ), 'purge: schema-version option removed' );
iwsl_assert_same( null, $store11->get( IWSL_Statistics::SALT_KEY ), 'purge: salt option removed' );
iwsl_assert_same( 0, $store11->get( IWSL_Statistics::LAST_PRUNE_KEY, 0 ), 'purge: last-prune stamp removed (reads back default 0)' );
iwsl_assert_same( null, $store11->get( IWSL_Statistics::EXCLUDE_LOGGED_KEY ), 'purge: exclude-logged-in option removed' );

// idempotent: purge again on an already-clean store/table is still cheap + safe.
$p11b = $eng11->purge();
iwsl_assert_same( true, $p11b['ok'], 'purge: idempotent — second call still ok' );
iwsl_assert_same( 2, iwsl_st_count_containing( $fake11->writes, 'DROP TABLE IF EXISTS' ), 'purge: second call re-issues its own guarded IF EXISTS drop (safe no-op on an absent table)' );
iwsl_assert_same( 0, iwsl_st_count_containing( $fake11->writes, 'TRUNCATE' ), 'purge: never TRUNCATE' );
iwsl_assert_same( 0, iwsl_st_count_containing( $fake11->writes, 'ALTER' ), 'purge: never ALTER' );

// no $wpdb: purge still clears the options; table_dropped reports false.
$store11n = iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW );
$eng11n   = iwsl_st_engine( $store11n, null, $ST_NOW );
$p11n     = $eng11n->purge();
iwsl_assert_same( true, $p11n['ok'], 'purge (no db): ok=true, options still removed' );
iwsl_assert_same( false, $p11n['table_dropped'], 'purge (no db): table_dropped=false (nothing to drop without a handle)' );
iwsl_assert_same( null, $store11n->get( IWSL_Statistics::SCHEMA_KEY ), 'purge (no db): schema option still removed' );

// hostile prefix collapses to no-database — purge does not smuggle anything.
$fake11h         = new IWSL_Stats_Fake_WPDB();
$fake11h->prefix = 'wp_; DROP TABLE x;--';
$eng11h          = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW ), $fake11h, $ST_NOW );
$p11h            = $eng11h->purge();
iwsl_assert_same( false, $p11h['table_dropped'], 'purge: hostile prefix → table_dropped=false, no query issued' );
iwsl_assert_same( 0, count( $fake11h->writes ), 'purge: hostile prefix issues zero queries' );

// purge is NOT gated by the entitlement — a revoked/locked site can still be torn down.
$fake11l  = new IWSL_Stats_Fake_WPDB();
$store11l = iwsl_st_store( 'active', $ST_NOW - 60, false, $ST_NOW ); // statistics flag FALSE (locked)
$eng11l   = iwsl_st_engine( $store11l, $fake11l, $ST_NOW );
$p11l     = $eng11l->purge();
iwsl_assert_same( true, $p11l['ok'], 'purge: works even when the entitlement is locked/revoked' );
iwsl_assert_same( 1, iwsl_st_count_containing( $fake11l->writes, 'DROP TABLE IF EXISTS' ), 'purge (locked): table still dropped' );
iwsl_assert_same( null, $store11l->get( IWSL_Statistics::SALT_KEY ), 'purge (locked): options still removed despite the lock' );

// No global $wpdb was ever installed by this suite; keep the harness clean for later
// suites regardless.
unset( $GLOBALS['wpdb'] );

// ── 12. GPC signal + consent classifier (S6, pure) ─────────────────────────────

iwsl_assert_same( true, IWSL_Stats_Classifier::gpc_set( array( 'HTTP_SEC_GPC' => '1' ) ), 'gpc: Sec-GPC 1 → set' );
iwsl_assert_same( false, IWSL_Stats_Classifier::gpc_set( array( 'HTTP_SEC_GPC' => '0' ) ), 'gpc: Sec-GPC 0 → not set' );
iwsl_assert_same( false, IWSL_Stats_Classifier::gpc_set( array() ), 'gpc: header absent → not set' );

iwsl_assert_same( null, IWSL_Stats_Classifier::consent_allows_statistics( null, 1 ), 'consent: no cookie → null (undecided)' );
iwsl_assert_same( null, IWSL_Stats_Classifier::consent_allows_statistics( 'not json', 1 ), 'consent: unparseable cookie → null' );
iwsl_assert_same( null, IWSL_Stats_Classifier::consent_allows_statistics( '{"v":1,"c":["statistics"]}', 2 ), 'consent: stale policy version → null' );
iwsl_assert_same( true, IWSL_Stats_Classifier::consent_allows_statistics( '{"v":1,"c":["necessary","statistics"]}', 1 ), 'consent: statistics granted → true' );
iwsl_assert_same( false, IWSL_Stats_Classifier::consent_allows_statistics( '{"v":1,"c":["necessary"]}', 1 ), 'consent: statistics omitted → false (declined)' );
iwsl_assert_same( null, IWSL_Stats_Classifier::consent_allows_statistics( str_repeat( 'a', IWSL_Stats_Classifier::MAX_CONSENT_COOKIE_LEN + 1 ), 1 ), 'consent: oversized cookie → null (bounded read)' );

// ── 13. summary_payload projection: shape, caps, byte-bound, no drill/heatmap ───

$sx_agg = IWSL_Stats_Classifier::aggregate(
	array(
		iwsl_st_row( $ST_NOW - 100, 'v1', 'view', '/a', array( 'referer_host' => 'google.com', 'search_engine' => 'Google', 'device' => 'desktop', 'country' => 'NL' ) ),
		iwsl_st_row( $ST_NOW - 200, 'v2', 'view', '/a', array( 'referer_host' => 'google.com', 'search_engine' => 'Google', 'device' => 'mobile', 'country' => 'NL' ) ),
		iwsl_st_row( $ST_NOW - 300, 'v3', 'search', '/', array( 'event_label' => 'widgets' ) ),
	),
	$ST_NOW,
	7
);
$sx_sp = IWSL_Stats_Classifier::summary_payload( $sx_agg );
iwsl_assert( isset( $sx_sp['kpi'], $sx_sp['quality'], $sx_sp['top_pages'], $sx_sp['channels'], $sx_sp['devices'], $sx_sp['countries'], $sx_sp['searches'], $sx_sp['privacy'] ), 'summary_payload: full compact shape present' );
iwsl_assert_same( array( 'dnt' => 1, 'gpc' => 1, 'consent_gated' => 0 ), $sx_sp['privacy'], 'summary_payload: privacy signals default {dnt,gpc,consent_gated:0}' );
iwsl_assert_same( array( '/a', 2 ), $sx_sp['top_pages'][0], 'summary_payload: top page flattened to [label,count]' );
iwsl_assert( ! isset( $sx_sp['drill'] ) && ! isset( $sx_sp['heatmap'] ) && ! isset( $sx_sp['series'] ) && ! isset( $sx_sp['recent_events'] ) && ! isset( $sx_sp['hourly'] ), 'summary_payload: drill/heatmap/series/recent_events/hourly NEVER cross the wire' );

// nullable delta passthrough (no prior baseline → null survives the projection).
$sx_null_model = array( 'range_days' => 7, 'generated' => 1, 'kpi' => array( 'views' => 3, 'views_delta_pct' => null ), 'quality' => array() );
iwsl_assert_same( null, IWSL_Stats_Classifier::summary_payload( $sx_null_model )['kpi']['views_delta_pct'], 'summary_payload: null delta (no baseline) passes through' );

// worst-case byte bound: 10 maxed entries per top list (projection slices to the caps).
$sx_pairs = static function ( int $n, int $len ): array {
	$out = array();
	for ( $i = 0; $i < $n; $i++ ) {
		$out[] = array( 'label' => str_repeat( 'p', $len ) . $i, 'count' => 999999 );
	}
	return $out;
};
$sx_worst = array(
	'range_days'    => 30,
	'generated'     => 1893456000,
	'kpi'           => array( 'views' => 999999, 'visits' => 999999, 'events' => 999999, 'views_today' => 999999, 'online_now' => 9999, 'prev_views' => 999999, 'prev_visits' => 999999, 'views_delta_pct' => 1234.5, 'visits_delta_pct' => -99.9 ),
	'quality'       => array( 'bounce_pct' => 99.9, 'pages_per_visit' => 12.34 ),
	'top_pages'     => $sx_pairs( 10, 190 ),
	'top_referrers' => $sx_pairs( 10, 190 ),
	'channels'      => $sx_pairs( 10, 12 ),
	'devices'       => $sx_pairs( 10, 10 ),
	'countries'     => $sx_pairs( 10, 16 ),
	'searches'      => $sx_pairs( 10, 190 ),
	// Heavy source-model islands that MUST be dropped by the projection:
	'drill'         => array_fill( 0, 40, str_repeat( 'x', 300 ) ),
	'heatmap'       => array_fill( 0, 7, array_fill( 0, 24, 5 ) ),
	'series'        => array_fill( 0, 30, array( 'day' => '2024-01-01', 'views' => 5, 'visits' => 3 ) ),
	'recent_events' => array_fill( 0, 25, array( 'at' => 1, 'type' => 'x', 'label' => 'y', 'path' => '/z' ) ),
);
$sx_wsp = IWSL_Stats_Classifier::summary_payload( $sx_worst );
iwsl_assert_same( IWSL_Stats_Classifier::SUMMARY_TOP_N, count( $sx_wsp['top_pages'] ), 'summary_payload: top_pages capped at SUMMARY_TOP_N' );
iwsl_assert_same( IWSL_Stats_Classifier::SUMMARY_CHANNELS_N, count( $sx_wsp['channels'] ), 'summary_payload: channels capped at SUMMARY_CHANNELS_N' );
iwsl_assert_same( IWSL_Stats_Classifier::SUMMARY_DEVICES_N, count( $sx_wsp['devices'] ), 'summary_payload: devices capped at SUMMARY_DEVICES_N' );
iwsl_assert( ! isset( $sx_wsp['drill'], $sx_wsp['heatmap'], $sx_wsp['series'] ), 'summary_payload: worst-case still drops drill/heatmap/series' );
$sx_wbytes = strlen( json_encode( $sx_wsp ) );
iwsl_assert( $sx_wbytes <= IWSL_Stats_Classifier::SUMMARY_MAX_BYTES, 'summary_payload: worst-case ' . $sx_wbytes . ' bytes under SUMMARY_MAX_BYTES (' . IWSL_Stats_Classifier::SUMMARY_MAX_BYTES . ')' );

// ── 14. timeseries_payload projection ──────────────────────────────────────────

$sx_ts_model = array( 'series' => array(), 'hourly' => array(), 'hourly_prev' => array() );
for ( $sx_i = 0; $sx_i < 30; $sx_i++ ) {
	$sx_ts_model['series'][] = array( 'day' => sprintf( '2024-%02d-%02d', 1, ( $sx_i % 28 ) + 1 ), 'views' => $sx_i, 'visits' => $sx_i );
}
for ( $sx_h = 0; $sx_h < 24; $sx_h++ ) {
	$sx_ts_model['hourly'][]      = array( 'hour' => $sx_h, 'views' => $sx_h, 'visits' => $sx_h );
	$sx_ts_model['hourly_prev'][] = array( 'hour' => $sx_h, 'views' => 0, 'visits' => 0 );
}
$sx_ts30 = IWSL_Stats_Classifier::timeseries_payload( $sx_ts_model, 30 );
iwsl_assert_same( 30, count( $sx_ts30['series'] ), 'timeseries: days=30 → 30 series entries' );
iwsl_assert( ! isset( $sx_ts30['hourly'] ), 'timeseries: days=30 → no hourly arrays' );
$sx_ts1 = IWSL_Stats_Classifier::timeseries_payload( $sx_ts_model, 1 );
iwsl_assert_same( 1, count( $sx_ts1['series'] ), 'timeseries: days=1 → last series day only' );
iwsl_assert_same( 24, count( $sx_ts1['hourly'] ), 'timeseries: days=1 → 24 hourly slots' );
iwsl_assert_same( 24, count( $sx_ts1['hourly_prev'] ), 'timeseries: days=1 → 24 previous-day slots' );
iwsl_assert_same( 30, IWSL_Stats_Classifier::timeseries_payload( $sx_ts_model, 99 )['days'], 'timeseries: days clamped down to SERIES_DAYS' );
iwsl_assert_same( 1, IWSL_Stats_Classifier::timeseries_payload( $sx_ts_model, 0 )['days'], 'timeseries: days clamped up to 1' );
iwsl_assert( strlen( json_encode( $sx_ts30 ) ) <= IWSL_Stats_Classifier::TIMESERIES_MAX_BYTES, 'timeseries: days=30 under TIMESERIES_MAX_BYTES' );
iwsl_assert( strlen( json_encode( $sx_ts1 ) ) <= IWSL_Stats_Classifier::TIMESERIES_MAX_BYTES, 'timeseries: days=1 under TIMESERIES_MAX_BYTES' );

// ── 15. maybe_record: GPC + consent skips (S6); default OFF = zero change ───────

unset( $GLOBALS['wpdb'] ); // engines below pass an explicit fake; guard default_db().

// A directly-built unlocked engine over a fresh store + fake $wpdb + injected consent ctx.
$sx_eng = static function ( $ctx ) use ( $ST_NOW ): array {
	$store = iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW );
	$fake  = new IWSL_Stats_Fake_WPDB();
	$ent   = new IWSL_Entitlements( $store, iwsl_st_clock( $ST_NOW ) );
	$eng   = new IWSL_Statistics( $ent, $store, $fake, iwsl_st_clock( $ST_NOW ), $ctx );
	return array( $eng, $fake );
};

// (a) Sec-GPC: 1 short-circuits before the DB is touched (default provider inactive).
$sx_gpc_store = iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW );
$sx_gpc_fake  = new IWSL_Stats_Fake_WPDB();
$sx_gpc_eng   = iwsl_st_engine( $sx_gpc_store, $sx_gpc_fake, $ST_NOW );
$sx_gpc_r     = $sx_gpc_eng->maybe_record( array_merge( iwsl_st_server(), array( 'HTTP_SEC_GPC' => '1' ) ), iwsl_st_view_ctx() );
iwsl_assert_same( 'gpc', $sx_gpc_r['reason'], 'maybe_record: Sec-GPC declines recording (reason gpc)' );
iwsl_assert_same( 0, count( $sx_gpc_fake->writes ), 'maybe_record: gpc → no INSERT' );

// (b) DEFAULT provider, banner OFF (cookie_consent locked) → records: ZERO change.
$sx_off_store = iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW );
$sx_off_fake  = new IWSL_Stats_Fake_WPDB();
$sx_off_eng   = iwsl_st_engine( $sx_off_store, $sx_off_fake, $ST_NOW );
$sx_off_r     = $sx_off_eng->maybe_record( iwsl_st_server(), iwsl_st_view_ctx() );
iwsl_assert_same( true, $sx_off_r['recorded'], 'maybe_record: default banner-OFF path still records (zero behavior change)' );

// (c) injected active opt-in banner, statistics DECLINED → not recorded.
list( $sx_dec_eng, $sx_dec_fake ) = $sx_eng( static function ( array $s ): array {
	return array( 'active' => true, 'allows' => false );
} );
$sx_dec_r = $sx_dec_eng->maybe_record( iwsl_st_server(), iwsl_st_view_ctx() );
iwsl_assert_same( 'consent-declined', $sx_dec_r['reason'], 'maybe_record: declined statistics consent → consent-declined' );
iwsl_assert_same( 0, count( $sx_dec_fake->writes ), 'maybe_record: consent-declined → no INSERT' );

// (d) injected active opt-in banner, UNDECIDED (no cookie) → not recorded (opt-in).
list( $sx_und_eng, $sx_und_fake ) = $sx_eng( static function ( array $s ): array {
	return array( 'active' => true, 'allows' => null );
} );
$sx_und_r = $sx_und_eng->maybe_record( iwsl_st_server(), iwsl_st_view_ctx() );
iwsl_assert_same( 'consent-declined', $sx_und_r['reason'], 'maybe_record: undecided under opt-in banner → not recorded' );

// (e) injected active opt-in banner, statistics GRANTED → recorded.
list( $sx_grt_eng, $sx_grt_fake ) = $sx_eng( static function ( array $s ): array {
	return array( 'active' => true, 'allows' => true );
} );
$sx_grt_r = $sx_grt_eng->maybe_record( iwsl_st_server(), iwsl_st_view_ctx() );
iwsl_assert_same( true, $sx_grt_r['recorded'], 'maybe_record: granted statistics consent → recorded' );

// (f) injected INACTIVE context (banner off / not opt-in) → records unchanged.
list( $sx_ina_eng, $sx_ina_fake ) = $sx_eng( static function ( array $s ): array {
	return array( 'active' => false, 'allows' => null );
} );
$sx_ina_r = $sx_ina_eng->maybe_record( iwsl_st_server(), iwsl_st_view_ctx() );
iwsl_assert_same( true, $sx_ina_r['recorded'], 'maybe_record: inactive consent context records (no gate)' );

// ── 16. wire_summary / wire_timeseries (signed projections) ────────────────────

// locked → { locked:true, gate } and NO numbers leak.
$sx_wl = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, false, $ST_NOW ), null, $ST_NOW )->wire_summary( 7 );
iwsl_assert_same( true, $sx_wl['locked'], 'wire_summary(locked): locked=true' );
iwsl_assert( isset( $sx_wl['gate']['reasons'] ), 'wire_summary(locked): carries signed gate reasons' );
iwsl_assert( ! isset( $sx_wl['kpi'] ), 'wire_summary(locked): no traffic numbers leak' );

// unlocked (no $wpdb → bounded empty reads) → well-formed zero projection.
$sx_wu = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW ), null, $ST_NOW )->wire_summary( 7 );
iwsl_assert_same( false, $sx_wu['locked'], 'wire_summary(unlocked): locked=false' );
iwsl_assert( isset( $sx_wu['kpi'], $sx_wu['top_pages'], $sx_wu['privacy'] ), 'wire_summary(unlocked): summary-shaped' );
iwsl_assert_same( 0, $sx_wu['privacy']['consent_gated'], 'wire_summary: consent_gated=0 with no opt-in banner' );
iwsl_assert( strlen( json_encode( $sx_wu ) ) <= IWSL_Stats_Classifier::SUMMARY_MAX_BYTES, 'wire_summary: result under SUMMARY_MAX_BYTES' );

// consent_gated overlay: an active opt-in banner flips the privacy flag to 1.
$sx_wc_store = iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW );
$sx_wc_eng   = new IWSL_Statistics( new IWSL_Entitlements( $sx_wc_store, iwsl_st_clock( $ST_NOW ) ), $sx_wc_store, null, iwsl_st_clock( $ST_NOW ), static function ( array $s ): array {
	return array( 'active' => true, 'allows' => null );
} );
iwsl_assert_same( 1, $sx_wc_eng->wire_summary( 7 )['privacy']['consent_gated'], 'wire_summary: consent_gated=1 under an active opt-in banner' );

// wire_timeseries: locked, days=1 (hourly present), days=30 (series only).
iwsl_assert_same( true, iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, false, $ST_NOW ), null, $ST_NOW )->wire_timeseries( 7 )['locked'], 'wire_timeseries(locked): locked=true' );
$sx_ts_eng = iwsl_st_engine( iwsl_st_store( 'active', $ST_NOW - 60, true, $ST_NOW ), null, $ST_NOW );
$sx_wts1   = $sx_ts_eng->wire_timeseries( 1 );
iwsl_assert_same( false, $sx_wts1['locked'], 'wire_timeseries(1): unlocked' );
iwsl_assert_same( 24, count( $sx_wts1['hourly'] ), 'wire_timeseries(1): hourly present (24 slots)' );
$sx_wts30 = $sx_ts_eng->wire_timeseries( 30 );
iwsl_assert( isset( $sx_wts30['series'] ) && ! isset( $sx_wts30['hourly'] ), 'wire_timeseries(30): series only, no hourly' );

// ── 17. param validators ───────────────────────────────────────────────────────

$sx_mkp = static function ( array $a ): stdClass {
	$o = new stdClass();
	foreach ( $a as $k => $v ) {
		$o->$k = $v;
	}
	return $o;
};
iwsl_assert_same( true, IWSL_Statistics::validate_summary_params( $sx_mkp( array() ) ), 'validate summary: empty params ok (default range)' );
iwsl_assert_same( true, IWSL_Statistics::validate_summary_params( $sx_mkp( array( 'range_days' => 7 ) ) ), 'validate summary: range_days 7 ok' );
iwsl_assert_same( false, IWSL_Statistics::validate_summary_params( $sx_mkp( array( 'range_days' => 5 ) ) ), 'validate summary: range_days 5 rejected (not in ALLOWED_RANGES)' );
iwsl_assert_same( false, IWSL_Statistics::validate_summary_params( $sx_mkp( array( 'range_days' => '7' ) ) ), 'validate summary: string range_days rejected' );
iwsl_assert_same( false, IWSL_Statistics::validate_summary_params( $sx_mkp( array( 'range_days' => 7, 'x' => 1 ) ) ), 'validate summary: unexpected extra key rejected' );
iwsl_assert_same( true, IWSL_Statistics::validate_timeseries_params( $sx_mkp( array() ) ), 'validate timeseries: empty params ok' );
iwsl_assert_same( true, IWSL_Statistics::validate_timeseries_params( $sx_mkp( array( 'days' => 30 ) ) ), 'validate timeseries: days 30 ok' );
iwsl_assert_same( false, IWSL_Statistics::validate_timeseries_params( $sx_mkp( array( 'days' => 31 ) ) ), 'validate timeseries: days 31 rejected' );
iwsl_assert_same( false, IWSL_Statistics::validate_timeseries_params( $sx_mkp( array( 'days' => 0 ) ) ), 'validate timeseries: days 0 rejected' );
iwsl_assert_same( false, IWSL_Statistics::validate_timeseries_params( $sx_mkp( array( 'days' => '7' ) ) ), 'validate timeseries: string days rejected' );

unset( $GLOBALS['wpdb'] );
