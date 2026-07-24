<?php
/**
 * IWSL_Site_Health — the bounded aggregator behind `sitehealth.snapshot`. Driven
 * with the REAL feature engines over one shared in-memory store (home_url is
 * stubbed globally by the runner), so the suite asserts the exact payload shape,
 * the per-sub-section switch/lock behaviour, and the hard bounds with no WordPress.
 */

$SH_NOW = 60000000;

/** Unlocked entitlements over a shared store for a given flag set. */
function iwsl_sh_ent( IWSL_Store $store, int $now, array $flags ): IWSL_Entitlements {
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 1000 ); // fresh
	$store->set( 'entitlements', $flags );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** Build a Site Health aggregator over a store with the three real engines. */
function iwsl_sh_build( IWSL_Store $store, int $now, array $flags, ?callable $published = null, ?callable $notfound = null ): IWSL_Site_Health {
	$ent   = iwsl_sh_ent( $store, $now, $flags );
	$clock = static function () use ( $now ): int {
		return $now;
	};
	return new IWSL_Site_Health(
		$ent,
		new IWSL_Maintenance_Mode( $ent, $store, $clock ),
		new IWSL_Redirects( $ent, $store, $clock ),
		new IWSL_Broken_Link_Scan( $ent, $store, $clock ),
		$published,
		$notfound
	);
}

/** A valid stored redirect rule (id derived exactly like the engine). */
function iwsl_sh_rule( string $source, string $target, int $hits ): array {
	$norm = IWSL_Redirects::normalize_path( $source );
	return array(
		'id'         => 'r' . substr( sha1( $norm ), 0, 12 ),
		'source'     => $norm,
		'target'     => $target,
		'type'       => 301,
		'match'      => 'exact',
		'hits'       => $hits,
		'external'   => false,
		'created_at' => 0,
	);
}

// ── 1. Full snapshot: all flags granted → every sub-section unlocked + shaped ──

$store = new IWSL_Memory_Store();
$store->set( 'redirect_rules', array( iwsl_sh_rule( '/a', '/x', 3 ), iwsl_sh_rule( '/b', '/y', 9 ) ) );
$store->set( 'redirect_404_log', array( array( 'path' => '/2020/05/hello-world', 'count' => 7, 'last_seen' => 111 ) ) );
$store->set( 'redirect_404_log_enabled', true );
$store->set(
	'maintenance_mode',
	array( 'enabled' => true, 'headline' => 'Down', 'message' => 'Soon', 'retry_after' => true, 'until' => 0, 'allow_ips' => array( '1.2.3.4' ), 'saved_at' => 42 )
);
$store->set(
	'broken_link_scan_last',
	array(
		'ok'            => true,
		'broken'        => array(),
		'broken_images' => array(
			array( 'post_id' => 5, 'url' => '/wp-content/uploads/gone.jpg', 'attachment_id' => null, 'status' => 404 ),
			array( 'post_id' => 6, 'url' => 'https://ext.test/x.png', 'attachment_id' => null, 'status' => 'unsafe-host' ),
		),
	)
);

$published = static function (): array {
	return array( '/hello-world', '/about' );
};

$sh   = iwsl_sh_build( $store, $SH_NOW, array( 'maintenance_mode' => true, 'redirect_manager' => true, 'broken_link_scan' => true, 'statistics' => true ), $published );
$snap = $sh->snapshot();

iwsl_assert_same( true, $snap['switches']['maintenance_mode'], 'switches: maintenance_mode unlocked' );
iwsl_assert_same( true, $snap['switches']['redirect_manager'], 'switches: redirect_manager unlocked' );
iwsl_assert_same( true, $snap['switches']['broken_link_scan'], 'switches: broken_link_scan unlocked' );
iwsl_assert_same( true, $snap['switches']['statistics'], 'switches: statistics unlocked' );

iwsl_assert_same( false, $snap['maintenance']['locked'], 'maintenance: unlocked' );
iwsl_assert_same( true, $snap['maintenance']['enabled'], 'maintenance: enabled surfaced' );
iwsl_assert_same( array( '1.2.3.4' ), $snap['maintenance']['allow_ips'], 'maintenance: allow_ips surfaced' );

iwsl_assert_same( false, $snap['redirects']['locked'], 'redirects: unlocked' );
iwsl_assert_same( 2, $snap['redirects']['count'], 'redirects: rule count' );
iwsl_assert_same( true, $snap['redirects']['log_enabled'], 'redirects: log_enabled surfaced' );
iwsl_assert_same( '/b', $snap['redirects']['top'][0]['source'], 'redirects: top ranked by hits (highest first)' );
iwsl_assert_same( 'exact', $snap['redirects']['top'][0]['match'], 'redirects: top carries match key' );

iwsl_assert_same( false, $snap['notfound']['locked'], 'notfound: unlocked' );
iwsl_assert_same( '/2020/05/hello-world', $snap['notfound']['top'][0]['path'], 'notfound: ring-log path present' );
iwsl_assert_same( 'redirect_log', $snap['notfound']['top'][0]['source'], 'notfound: source labelled' );

iwsl_assert_same( 1, count( $snap['suggestions'] ), 'suggestions: one produced from the 404 feed' );
iwsl_assert_same( '/hello-world', $snap['suggestions'][0]['target'], 'suggestions: slug-tail target from published paths' );

iwsl_assert_same( 2, count( $snap['broken_images'] ), 'broken_images: both from last scan' );
iwsl_assert_same( '/wp-content/uploads/gone.jpg', $snap['broken_images'][0]['url'], 'broken_images: url carried' );
iwsl_assert_same( null, $snap['broken_images'][0]['attachment_id'], 'broken_images: attachment_id null when unresolved' );
iwsl_assert_same( 404, $snap['broken_images'][0]['status'], 'broken_images: int status preserved' );

// ── 2. Locked flags → locked markers, no lower-tier data leak ─────────────────

$store2 = new IWSL_Memory_Store();
$store2->set( 'redirect_rules', array( iwsl_sh_rule( '/a', '/x', 3 ) ) );
$store2->set( 'maintenance_mode', array( 'enabled' => true, 'headline' => 'H', 'message' => 'M', 'retry_after' => false, 'until' => 0, 'allow_ips' => array(), 'saved_at' => 1 ) );
$sh2   = iwsl_sh_build( $store2, $SH_NOW, array() ); // NO flags granted
$snap2 = $sh2->snapshot();

iwsl_assert_same( false, $snap2['switches']['redirect_manager'], 'locked: redirect_manager switch false' );
iwsl_assert_same( true, $snap2['maintenance']['locked'], 'locked: maintenance sub-section locked' );
iwsl_assert( ! isset( $snap2['maintenance']['enabled'] ), 'locked: maintenance data omitted (no leak)' );
iwsl_assert_same( true, $snap2['redirects']['locked'], 'locked: redirects sub-section locked' );
iwsl_assert_same( 0, $snap2['redirects']['count'], 'locked: redirect count zeroed (no leak of seeded rule)' );
iwsl_assert_same( array(), $snap2['redirects']['top'], 'locked: redirect top empty' );
iwsl_assert_same( true, $snap2['notfound']['locked'], 'locked: notfound locked when neither redirects nor statistics' );
iwsl_assert_same( array(), $snap2['suggestions'], 'locked: no suggestions when redirects locked' );
iwsl_assert_same( array(), $snap2['broken_images'], 'locked: no broken images when scanner locked' );
iwsl_assert_same( null, $snap2['links']['last_scan_summary'], 'locked: links last_scan_summary null' );

// ── 3. Bounds: >10 rules → top 10; >20 404s → top 20 ──────────────────────────

$store3 = new IWSL_Memory_Store();
$rules  = array();
for ( $i = 0; $i < 25; $i++ ) {
	$rules[] = iwsl_sh_rule( '/p' . $i, '/t' . $i, $i ); // hits == i, so /p24 is hottest
}
$store3->set( 'redirect_rules', $rules );
$log = array();
for ( $i = 0; $i < 40; $i++ ) {
	$log[] = array( 'path' => '/miss-' . $i, 'count' => 40 - $i, 'last_seen' => $i );
}
$store3->set( 'redirect_404_log', $log );
$sh3   = iwsl_sh_build( $store3, $SH_NOW, array( 'redirect_manager' => true ) );
$snap3 = $sh3->snapshot();
iwsl_assert_same( IWSL_Site_Health::TOP_REDIRECTS, count( $snap3['redirects']['top'] ), 'bounds: redirect top capped at 10' );
iwsl_assert_same( '/p24', $snap3['redirects']['top'][0]['source'], 'bounds: hottest rule ranked first' );
iwsl_assert_same( IWSL_Site_Health::TOP_NOTFOUND, count( $snap3['notfound']['top'] ), 'bounds: notfound top capped at 20' );
iwsl_assert_same( '/miss-0', $snap3['notfound']['top'][0]['path'], 'bounds: highest-count 404 ranked first' );

// ── 4. statistics feed merges + dedupes by path when its flag is unlocked ──────

$store4 = new IWSL_Memory_Store();
$store4->set( 'redirect_404_log', array( array( 'path' => '/dup', 'count' => 2, 'last_seen' => 10 ) ) );
$stats_provider = static function (): array {
	return array( array( 'path' => '/dup', 'count' => 5, 'last_seen' => 99 ), array( 'path' => '/stats-only', 'count' => 3, 'last_seen' => 5 ) );
};
$sh4   = iwsl_sh_build( $store4, $SH_NOW, array( 'redirect_manager' => true, 'statistics' => true ), null, $stats_provider );
$snap4 = $sh4->snapshot();
$dup   = null;
foreach ( $snap4['notfound']['top'] as $row ) {
	if ( '/dup' === $row['path'] ) {
		$dup = $row;
	}
}
iwsl_assert_same( 7, $dup['count'], 'merge: /dup count summed across ring-log + statistics' );
iwsl_assert_same( 99, $dup['last_seen'], 'merge: /dup last_seen is the newest' );
iwsl_assert_same( 'combined', $dup['source'], 'merge: /dup labelled combined (both feeds)' );

// statistics-only paths are excluded when the statistics flag is locked.
$sh4b   = iwsl_sh_build( $store4, $SH_NOW, array( 'redirect_manager' => true ), null, $stats_provider );
$snap4b = $sh4b->snapshot();
$paths4b = array_map(
	static function ( array $r ): string {
		return $r['path'];
	},
	$snap4b['notfound']['top']
);
iwsl_assert( ! in_array( '/stats-only', $paths4b, true ), 'merge: statistics rows excluded when the statistics flag is locked (no cross-tier leak)' );
