<?php
/**
 * Broken Link Scanner (gate flag `broken_link_scan`): the read-only scan engine
 * (IWSL_Broken_Link_Scan).
 *
 * Runs under the zero-dependency harness. Because an EARLIER suite
 * (media-optimizer) already defines get_posts()/get_post_field()/is_wp_error()
 * globally — and function_exists() would keep this suite from overriding them —
 * the engine takes an INJECTED post source and an INJECTED HTTP fetcher. The scan
 * therefore depends on nothing leaked from another suite: posts come from a
 * closure, links are resolved by a recording fetcher, the clock is fixed, and the
 * home host is injected. url_to_postid()/get_post_status() (unused elsewhere) are
 * stubbed here to exercise the cheap internal-existence path.
 *
 * The gate assertions prove a lower tier NEVER reads a post and NEVER makes a
 * request (recording counters stay at 0). The functional assertions prove
 * internal/external classification, broken detection, SSRF-safe scheme filtering,
 * the time budget (`partial`), and durable persistence via handle_scan().
 */

// ── recording fakes (post source + HTTP fetcher) ──────────────────────────────

$GLOBALS['iwsl_bls_fetches']        = 0; // fetcher invocation counter
$GLOBALS['iwsl_bls_provider_calls'] = 0; // post-source invocation counter
$GLOBALS['iwsl_bls_postids']        = array(); // url => internal post id
$GLOBALS['iwsl_bls_status']         = array(); // post id => status

// url_to_postid / get_post_status are free names (no other suite defines them).
if ( ! function_exists( 'url_to_postid' ) ) {
	function url_to_postid( $url ) {
		return isset( $GLOBALS['iwsl_bls_postids'][ (string) $url ] ) ? (int) $GLOBALS['iwsl_bls_postids'][ (string) $url ] : 0;
	}
}
if ( ! function_exists( 'get_post_status' ) ) {
	function get_post_status( $id ) {
		return isset( $GLOBALS['iwsl_bls_status'][ (int) $id ] ) ? $GLOBALS['iwsl_bls_status'][ (int) $id ] : 'publish';
	}
}

/** A recording post source. */
function iwsl_bls_provider( array $posts ): callable {
	return static function () use ( $posts ): array {
		$GLOBALS['iwsl_bls_provider_calls']++;
		return $posts;
	};
}

/** A recording fetcher over a url => {code|error} map (default 200 for unmapped). */
function iwsl_bls_fetcher( array $remote ): callable {
	return static function ( string $url ) use ( $remote ): array {
		$GLOBALS['iwsl_bls_fetches']++;
		if ( isset( $remote[ $url ] ) ) {
			return $remote[ $url ];
		}
		return array( 'code' => 200, 'error' => '' );
	};
}

/** Reset the recording counters. */
function iwsl_bls_reset(): void {
	$GLOBALS['iwsl_bls_fetches']        = 0;
	$GLOBALS['iwsl_bls_provider_calls'] = 0;
}

/** Unlocked entitlement gate: active + fresh heartbeat + broken_link_scan flag. */
function iwsl_bls_unlocked( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // fresh
	$store->set( 'entitlements', array( 'plus' => true, 'broken_link_scan' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** Build an unlocked scanner over injected posts + remote map (+ optional clock). */
function iwsl_bls_engine( int $now, array $posts, array $remote, ?callable $clock = null, ?IWSL_Store $store = null ): IWSL_Broken_Link_Scan {
	return new IWSL_Broken_Link_Scan(
		iwsl_bls_unlocked( $now ),
		$store ?? new IWSL_Memory_Store(),
		$clock ?? static function () use ( $now ): int {
			return $now;
		},
		'site',
		iwsl_bls_provider( $posts ),
		iwsl_bls_fetcher( $remote )
	);
}

/** Find a broken entry by url in a summary, or null. */
function iwsl_bls_find( array $summary, string $url ) {
	foreach ( ( $summary['broken'] ?? array() ) as $entry ) {
		if ( isset( $entry['url'] ) && $entry['url'] === $url ) {
			return $entry;
		}
	}
	return null;
}

$BLS_NOW = 40000000;

// ── 1. Gate blocks a lower tier: scan reads NOTHING, fetches NOTHING ──────────

// (a) broken_link_scan flag ABSENT (Basic shape has only `plus`).
iwsl_bls_reset();
$store_a = new IWSL_Memory_Store();
$store_a->set( 'state', 'active' );
$store_a->set( 'last_verified_at', $BLS_NOW - 60000 );
$store_a->set( 'entitlements', array( 'plus' => true ) ); // flag absent
$ent_a = new IWSL_Entitlements( $store_a, static function () use ( $BLS_NOW ): int {
	return $BLS_NOW; } );
$posts_a = array( array( 'id' => 1, 'title' => 'P', 'content' => '<a href="http://external.test/x">x</a>' ) );
$eng_a   = new IWSL_Broken_Link_Scan(
	$ent_a,
	new IWSL_Memory_Store(),
	static function () use ( $BLS_NOW ): int {
		return $BLS_NOW; },
	'site',
	iwsl_bls_provider( $posts_a ),
	iwsl_bls_fetcher( array( 'http://external.test/x' => array( 'code' => 404, 'error' => '' ) ) )
);
$r_a = $eng_a->scan();
iwsl_assert_same( false, $r_a['ok'], 'gate blocks (absent flag): ok=false' );
iwsl_assert_same( 'entitlement-locked', $r_a['reason'], 'gate blocks (absent flag): entitlement-locked' );
iwsl_assert_same( 0, $r_a['broken_count'], 'gate blocks (absent flag): broken_count=0' );
iwsl_assert_same( 0, $GLOBALS['iwsl_bls_provider_calls'], 'gate blocks (absent flag): post source NEVER read' );
iwsl_assert_same( 0, $GLOBALS['iwsl_bls_fetches'], 'gate blocks (absent flag): fetcher NEVER called' );

// (b) state != active, even WITH the flag.
iwsl_bls_reset();
$store_b = new IWSL_Memory_Store();
$store_b->set( 'state', 'pending' );
$store_b->set( 'last_verified_at', $BLS_NOW - 60000 );
$store_b->set( 'entitlements', array( 'broken_link_scan' => true ) );
$eng_b = new IWSL_Broken_Link_Scan(
	new IWSL_Entitlements( $store_b, static function () use ( $BLS_NOW ): int {
		return $BLS_NOW; } ),
	new IWSL_Memory_Store(),
	static function () use ( $BLS_NOW ): int {
		return $BLS_NOW; },
	'site',
	iwsl_bls_provider( $posts_a ),
	iwsl_bls_fetcher( array() )
);
$r_b = $eng_b->scan();
iwsl_assert_same( 'entitlement-locked', $r_b['reason'], 'gate blocks (not active): entitlement-locked despite flag' );
iwsl_assert_same( 0, $GLOBALS['iwsl_bls_fetches'], 'gate blocks (not active): fetcher NEVER called' );

// (c) stale heartbeat, even WITH the flag.
iwsl_bls_reset();
$store_c = new IWSL_Memory_Store();
$store_c->set( 'state', 'active' );
$store_c->set( 'last_verified_at', $BLS_NOW - 10800000 ); // 3h — stale
$store_c->set( 'entitlements', array( 'broken_link_scan' => true ) );
$eng_c = new IWSL_Broken_Link_Scan(
	new IWSL_Entitlements( $store_c, static function () use ( $BLS_NOW ): int {
		return $BLS_NOW; } ),
	new IWSL_Memory_Store(),
	static function () use ( $BLS_NOW ): int {
		return $BLS_NOW; },
	'site',
	iwsl_bls_provider( $posts_a ),
	iwsl_bls_fetcher( array() )
);
iwsl_assert_same( 'entitlement-locked', $eng_c->scan()['reason'], 'gate blocks (stale heartbeat): entitlement-locked despite flag' );
iwsl_assert_same( 0, $GLOBALS['iwsl_bls_fetches'], 'gate blocks (stale heartbeat): fetcher NEVER called' );

// ── 2. Unlocked scan: internal + external classification, broken detection ────

iwsl_bls_reset();
$GLOBALS['iwsl_bls_postids'] = array( 'http://site/good' => 10 );
$GLOBALS['iwsl_bls_status']  = array( 10 => 'publish' );
$content = '<a href="http://site/good">g</a>'
	. '<a href="http://external.test/ok">o</a>'
	. '<a href="http://external.test/missing">m</a>'
	. '<a href="http://external.test/err">e</a>'
	. '<a href="/relative-internal">rel</a>'
	. '<a href="mailto:x@y.com">mail</a>'
	. '<a href="#frag">frag</a>'
	. '<a href="javascript:alert(1)">js</a>';
$posts2  = array( array( 'id' => 7, 'title' => 'Hello World', 'content' => $content ) );
$remote2 = array(
	'http://external.test/ok'      => array( 'code' => 200, 'error' => '' ),
	'http://external.test/missing' => array( 'code' => 404, 'error' => '' ),
	'http://external.test/err'     => array( 'code' => 0, 'error' => 'could not resolve host' ),
	'/relative-internal'           => array( 'code' => 200, 'error' => '' ),
);
$eng2 = iwsl_bls_engine( $BLS_NOW, $posts2, $remote2 );
$r2   = $eng2->scan();
iwsl_assert_same( true, $r2['ok'], 'scan: ok=true' );
iwsl_assert_same( 1, $r2['scanned_posts'], 'scan: one post scanned' );
iwsl_assert_same( 5, $r2['checked_links'], 'scan: 5 checkable links (mailto/#frag/javascript skipped)' );
iwsl_assert_same( 2, $r2['broken_count'], 'scan: 2 broken links (missing + err)' );
iwsl_assert_same( false, $r2['partial'], 'scan: complete run (not partial)' );
iwsl_assert_same( 4, $GLOBALS['iwsl_bls_fetches'], 'scan: internal /good used url_to_postid (no fetch); 4 fetched' );
$missing = iwsl_bls_find( $r2, 'http://external.test/missing' );
$err     = iwsl_bls_find( $r2, 'http://external.test/err' );
iwsl_assert( is_array( $missing ), 'scan: 404 link reported broken' );
iwsl_assert_same( 404, $missing['status'], 'scan: broken 404 carries the status code' );
iwsl_assert_same( 7, $missing['post_id'], 'scan: broken entry carries its post id' );
iwsl_assert_same( 'Hello World', $missing['post_title'], 'scan: broken entry carries its post title' );
iwsl_assert( is_array( $err ), 'scan: transport-error link reported broken' );
iwsl_assert_same( 'could not resolve host', $err['status'], 'scan: transport error carries its message' );
iwsl_assert( null === iwsl_bls_find( $r2, 'http://external.test/ok' ), 'scan: a 200 link is NOT reported broken' );
iwsl_assert( null === iwsl_bls_find( $r2, 'http://site/good' ), 'scan: a resolved internal link is NOT reported broken' );

// ── 3. SSRF-safety: only http/https are ever fetched ──────────────────────────

iwsl_bls_reset();
$only_unsafe = array(
	array(
		'id'      => 3,
		'title'   => 'Unsafe',
		'content' => '<a href="javascript:alert(1)">j</a><a href="data:text/html,<script>">d</a><a href="mailto:a@b.c">m</a><a href="tel:123">t</a><a href="#x">f</a>',
	),
);
$eng3 = iwsl_bls_engine( $BLS_NOW, $only_unsafe, array() );
$r3   = $eng3->scan();
iwsl_assert_same( 0, $r3['checked_links'], 'ssrf: no non-http(s) scheme is ever checked' );
iwsl_assert_same( 0, $GLOBALS['iwsl_bls_fetches'], 'ssrf: fetcher NEVER called for javascript:/data:/mailto:/tel:/#' );

// ── 4. Internal non-published target is reported broken (via url_to_postid) ───

iwsl_bls_reset();
$GLOBALS['iwsl_bls_postids'] = array( 'http://site/draft' => 20 );
$GLOBALS['iwsl_bls_status']  = array( 20 => 'draft' );
$posts4 = array( array( 'id' => 4, 'title' => 'Draftlink', 'content' => '<a href="http://site/draft">d</a>' ) );
$eng4   = iwsl_bls_engine( $BLS_NOW, $posts4, array() );
$r4     = $eng4->scan();
iwsl_assert_same( 1, $r4['broken_count'], 'internal draft: reported broken' );
iwsl_assert_same( 'draft', iwsl_bls_find( $r4, 'http://site/draft' )['status'], 'internal draft: status is the non-public state' );
iwsl_assert_same( 0, $GLOBALS['iwsl_bls_fetches'], 'internal draft: resolved via url_to_postid, no network' );

// ── 5. Dedup: the same URL across posts is checked once ───────────────────────

iwsl_bls_reset();
$dup = '<a href="http://external.test/dup">d</a>';
$posts5 = array(
	array( 'id' => 51, 'title' => 'A', 'content' => $dup ),
	array( 'id' => 52, 'title' => 'B', 'content' => $dup . $dup ),
);
$eng5 = iwsl_bls_engine( $BLS_NOW, $posts5, array( 'http://external.test/dup' => array( 'code' => 200, 'error' => '' ) ) );
$r5   = $eng5->scan();
iwsl_assert_same( 2, $r5['scanned_posts'], 'dedup: both posts scanned' );
iwsl_assert_same( 1, $r5['checked_links'], 'dedup: the repeated URL is checked once' );
iwsl_assert_same( 1, $GLOBALS['iwsl_bls_fetches'], 'dedup: only one fetch for the duplicated URL' );

// ── 6. Time budget → partial, and read-only (source content untouched) ────────

iwsl_bls_reset();
$ticks     = 0;
$jumpclock = function () use ( &$ticks ): int {
	$ticks++;
	return $ticks <= 1 ? 0 : ( IWSL_Broken_Link_Scan::TIME_BUDGET_MS + 5000 );
};
$src_content = '<a href="http://external.test/ok">o</a>';
$posts6      = array( array( 'id' => 61, 'title' => 'One', 'content' => $src_content ) );
$eng6        = iwsl_bls_engine( $BLS_NOW, $posts6, array( 'http://external.test/ok' => array( 'code' => 200, 'error' => '' ) ), $jumpclock );
$r6          = $eng6->scan();
iwsl_assert_same( true, $r6['partial'], 'budget: run reports partial once the clock is exceeded' );
iwsl_assert_same( 0, $r6['scanned_posts'], 'budget: stopped before scanning any post' );
iwsl_assert_same( $src_content, $posts6[0]['content'], 'read-only: the source post content is never modified' );

// ── 7. handle_scan persists a durable last_scan (no WP redirect in harness) ───
//
// In the harness wp_safe_redirect()/current_user_can()/check_admin_referer() are
// absent, so handle_scan() runs the scan and persists it without redirecting or
// exiting — proving the durable store round-trip + last_scan() reader.

iwsl_bls_reset();
$store7 = new IWSL_Memory_Store();
$posts7 = array( array( 'id' => 71, 'title' => 'Persisted', 'content' => '<a href="http://external.test/missing">m</a>' ) );
$eng7   = iwsl_bls_engine( $BLS_NOW, $posts7, array( 'http://external.test/missing' => array( 'code' => 404, 'error' => '' ) ), null, $store7 );
iwsl_assert_same( null, $eng7->last_scan(), 'persist: no last scan before running' );
$eng7->handle_scan();
$last = $eng7->last_scan();
iwsl_assert( is_array( $last ), 'persist: handle_scan stored a durable summary' );
iwsl_assert_same( 1, $last['broken_count'], 'persist: durable summary carries the broken count' );
iwsl_assert_same( 404, iwsl_bls_find( $last, 'http://external.test/missing' )['status'], 'persist: durable summary carries the broken link' );

// ── 8. purge(): drops the durable last-scan option; idempotent + cheap-when-clean ─

iwsl_bls_reset();
$store_pg = new IWSL_Memory_Store();
$posts_pg = array( array( 'id' => 81, 'title' => 'P', 'content' => '<a href="http://external.test/x">x</a>' ) );
$eng_pg   = iwsl_bls_engine( $BLS_NOW, $posts_pg, array( 'http://external.test/x' => array( 'code' => 404, 'error' => '' ) ), null, $store_pg );
$store_pg->set( 'broken_link_scan_last', $eng_pg->scan() ); // persist a real summary durably
iwsl_assert( is_array( $eng_pg->last_scan() ), 'purge: a durable last-scan exists before purge' );

$pg = $eng_pg->purge();
iwsl_assert_same( true, $pg['ok'], 'purge: ok=true' );
iwsl_assert_same( array( 'broken_link_scan_last' ), $pg['options'], 'purge: the durable last-scan option key removed' );
iwsl_assert_same( array(), $pg['cron'], 'purge: no cron scheduled by this engine' );
iwsl_assert_same( null, $eng_pg->last_scan(), 'purge: last-scan actually gone from the store' );

// Idempotent + cheap-when-clean.
$pg2 = $eng_pg->purge();
iwsl_assert_same( array(), $pg2['options'], 'purge idempotent: second purge removes nothing' );
$store_clean = new IWSL_Memory_Store();
$eng_clean   = iwsl_bls_engine( $BLS_NOW, array(), array(), null, $store_clean );
iwsl_assert_same( array(), $eng_clean->purge()['options'], 'purge cheap-when-clean: a never-scanned engine removes nothing' );

// Clean up the stubs' global state so nothing leaks into a later suite.
unset(
	$GLOBALS['iwsl_bls_fetches'],
	$GLOBALS['iwsl_bls_provider_calls'],
	$GLOBALS['iwsl_bls_postids'],
	$GLOBALS['iwsl_bls_status']
);
