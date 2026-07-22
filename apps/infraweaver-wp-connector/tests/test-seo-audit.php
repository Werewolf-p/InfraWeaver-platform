<?php
/**
 * SEO Meta Audit (gate flag `seo_audit`): the IWSL_SEO_Audit engine.
 *
 * Runs under the zero-dependency harness. The engine is exercised two ways:
 *   1. evaluate_item() — the PURE per-item judgement over already-gathered fields;
 *      no WordPress at all, one crisp assertion per issue code.
 *   2. run_audit( $posts ) — fed already-resolved stdClass post fixtures, so the
 *      WordPress-poisoned readers (get_posts / get_post / get_post_meta) are never
 *      touched. This suite therefore installs NO WordPress stubs and no globals.
 *
 * The gate fixtures reuse the entitlement store so a single flip re-locks instantly.
 */

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Unlocked gate: active + fresh heartbeat + seo_audit flag. */
function iwsl_seo_unlocked_entitlements( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'plus' => true, 'seo_audit' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** $n words of visible text, optionally prefixed with an <h2> heading. */
function iwsl_seo_words( int $n, bool $heading = true ): string {
	$body = $heading ? '<h2>Heading</h2> ' : '';
	return $body . trim( str_repeat( 'word ', max( 0, $n ) ) );
}

/** A post fixture with SEO-clean defaults, overridable per field. */
function iwsl_seo_post( int $id, array $over = array() ): object {
	return (object) array_merge(
		array(
			'ID'               => $id,
			'post_title'       => str_repeat( 'a', 30 ) . ' ' . $id, // distinct per id, within [20,60]
			'post_content'     => iwsl_seo_words( 400, true ),    // 400 words + heading
			'post_excerpt'     => '',
			'meta_description' => 'A perfectly fine meta description.',
			'has_featured'     => true,
		),
		$over
	);
}

$SEO_NOW = 13000000;

// ── 1. evaluate_item(): one crisp assertion per issue code ────────────────────

$clean = array(
	'title'            => str_repeat( 'a', 40 ),
	'content'          => iwsl_seo_words( 400, true ),
	'meta_description' => 'A perfectly fine meta description.',
	'has_featured'     => true,
);
iwsl_assert_same( array(), IWSL_SEO_Audit::evaluate_item( $clean ), 'evaluate_item: a well-formed item has NO issues' );

$missing_title = array_merge( $clean, array( 'title' => '' ) );
iwsl_assert_same( array( 'missing-title' ), IWSL_SEO_Audit::evaluate_item( $missing_title ), 'evaluate_item: empty title → missing-title (and NOT title-too-short)' );

$long = array_merge( $clean, array( 'title' => str_repeat( 'x', 70 ) ) );
iwsl_assert_same( array( 'title-too-long' ), IWSL_SEO_Audit::evaluate_item( $long ), 'evaluate_item: 70-char title → title-too-long' );

$short = array_merge( $clean, array( 'title' => 'short' ) );
iwsl_assert_same( array( 'title-too-short' ), IWSL_SEO_Audit::evaluate_item( $short ), 'evaluate_item: 5-char title → title-too-short' );

$no_meta = array_merge( $clean, array( 'meta_description' => '' ) );
iwsl_assert_same( array( 'missing-meta-description' ), IWSL_SEO_Audit::evaluate_item( $no_meta ), 'evaluate_item: empty meta → missing-meta-description' );

$thin = array_merge( $clean, array( 'content' => iwsl_seo_words( 5, true ) ) );
iwsl_assert_same( array( 'thin-content' ), IWSL_SEO_Audit::evaluate_item( $thin ), 'evaluate_item: < 300 words → thin-content' );

$no_img = array_merge( $clean, array( 'has_featured' => false ) );
iwsl_assert_same( array( 'missing-featured-image' ), IWSL_SEO_Audit::evaluate_item( $no_img ), 'evaluate_item: no featured image → missing-featured-image' );

$no_head = array_merge( $clean, array( 'content' => iwsl_seo_words( 400, false ) ) );
iwsl_assert_same( array( 'no-heading' ), IWSL_SEO_Audit::evaluate_item( $no_head ), 'evaluate_item: no h1–h6 → no-heading' );

// ── 2. Gate blocks: run_audit inspects NOTHING for a locked site ──────────────

$problem_posts = array( iwsl_seo_post( 1, array( 'post_title' => '', 'post_content' => 'x', 'meta_description' => '', 'has_featured' => false ) ) );

// (a) seo_audit flag ABSENT.
$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $SEO_NOW - 60000 );
$store->set( 'entitlements', array( 'plus' => true ) ); // seo_audit absent
$ent   = new IWSL_Entitlements( $store, static function () use ( $SEO_NOW ): int {
	return $SEO_NOW; } );
$audit = new IWSL_SEO_Audit( $ent );
$r     = $audit->run_audit( $problem_posts );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'gate blocks (absent flag): entitlement-locked' );
iwsl_assert_same( 0, $r['scanned'], 'gate blocks (absent flag): scanned=0 (nothing inspected)' );
iwsl_assert_same( 0, count( $r['items'] ), 'gate blocks (absent flag): no items produced' );

// (b) state != active.
$store_b = new IWSL_Memory_Store();
$store_b->set( 'state', 'pending' );
$store_b->set( 'last_verified_at', $SEO_NOW - 60000 );
$store_b->set( 'entitlements', array( 'seo_audit' => true ) );
$audit_b = new IWSL_SEO_Audit( new IWSL_Entitlements( $store_b, static function () use ( $SEO_NOW ): int {
	return $SEO_NOW; } ) );
$r_b = $audit_b->run_audit( $problem_posts );
iwsl_assert_same( 'entitlement-locked', $r_b['reason'], 'gate blocks (not active): entitlement-locked despite flag' );
iwsl_assert_same( 0, $r_b['scanned'], 'gate blocks (not active): scanned=0' );

// (c) stale heartbeat.
$store_c = new IWSL_Memory_Store();
$store_c->set( 'state', 'active' );
$store_c->set( 'last_verified_at', $SEO_NOW - 10800000 ); // 3h — stale
$store_c->set( 'entitlements', array( 'seo_audit' => true ) );
$audit_c = new IWSL_SEO_Audit( new IWSL_Entitlements( $store_c, static function () use ( $SEO_NOW ): int {
	return $SEO_NOW; } ) );
$r_c = $audit_c->run_audit( $problem_posts );
iwsl_assert_same( 'entitlement-locked', $r_c['reason'], 'gate blocks (stale heartbeat): entitlement-locked despite flag' );
iwsl_assert_same( 0, $r_c['scanned'], 'gate blocks (stale heartbeat): scanned=0' );

// ── 3. Unlock → the audit scans and folds an immutable summary ────────────────

$posts = array(
	iwsl_seo_post( 1 ),                                                                              // clean
	iwsl_seo_post( 2, array( 'post_title' => '', 'post_content' => 'short text', 'meta_description' => '', 'has_featured' => false ) ), // 5 issues
	iwsl_seo_post( 3, array( 'meta_description' => '', 'post_excerpt' => 'A long-enough excerpt used as the description fallback.' ) ), // excerpt fallback → clean
);
$audit = new IWSL_SEO_Audit( iwsl_seo_unlocked_entitlements( $SEO_NOW ) );
$sum   = $audit->run_audit( $posts );

iwsl_assert_same( true, $sum['ok'], 'unlock: audit ok' );
iwsl_assert_same( 3, $sum['scanned'], 'unlock: all three items scanned' );
iwsl_assert_same( 1, $sum['with_issues'], 'unlock: exactly one item has issues' );
iwsl_assert_same( 3, count( $sum['items'] ), 'unlock: one row per scanned item' );
iwsl_assert_same( array(), $sum['items'][0]['issues'], 'unlock: the clean post has no issues' );
iwsl_assert_same( array(), $sum['items'][2]['issues'], 'unlock: excerpt fallback satisfies the meta-description check' );
$bad = $sum['items'][1]['issues'];
iwsl_assert_same( 5, count( $bad ), 'unlock: the problem post flags five issues' );
iwsl_assert( in_array( 'missing-title', $bad, true ), 'unlock: missing-title flagged' );
iwsl_assert( in_array( 'missing-meta-description', $bad, true ), 'unlock: missing-meta-description flagged' );
iwsl_assert( in_array( 'thin-content', $bad, true ), 'unlock: thin-content flagged' );
iwsl_assert( in_array( 'missing-featured-image', $bad, true ), 'unlock: missing-featured-image flagged' );
iwsl_assert( in_array( 'no-heading', $bad, true ), 'unlock: no-heading flagged' );
iwsl_assert_same( 1, $sum['issue_counts']['missing-title'], 'unlock: issue_counts tallies missing-title once' );

// Read-only + immutable: the source fixtures are untouched, and a re-run of the
// SAME input yields an identical summary.
iwsl_assert_same( '', $posts[0]->post_excerpt, 'read-only: source fixture not mutated by the audit' );
iwsl_assert_same( $sum, $audit->run_audit( $posts ), 'immutable: re-running the same input yields an identical summary' );

// ── 4. Bounded: limit caps the scan and reports partial ───────────────────────

$many = array();
for ( $i = 1; $i <= 5; $i++ ) {
	$many[] = iwsl_seo_post( $i, array( 'has_featured' => false ) );
}
$audit  = new IWSL_SEO_Audit( iwsl_seo_unlocked_entitlements( $SEO_NOW ) );
$capped = $audit->run_audit( $many, 3 );
iwsl_assert_same( 3, $capped['scanned'], 'bounded: only the first 3 of 5 items scanned' );
iwsl_assert_same( true, $capped['partial'], 'bounded: run reports partial when the limit is hit' );

// ── 5. Revocation is instant (shared store, single flip re-locks) ─────────────

$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $SEO_NOW - 60000 );
$store->set( 'entitlements', array( 'seo_audit' => true ) );
$ent   = new IWSL_Entitlements( $store, static function () use ( $SEO_NOW ): int {
	return $SEO_NOW; } );
$audit = new IWSL_SEO_Audit( $ent );
iwsl_assert_same( true, $audit->run_audit( array( iwsl_seo_post( 1 ) ) )['ok'], 'revocation: unlocked audit succeeds' );
$store->set( 'entitlements', array( 'seo_audit' => false ) ); // console revokes the flag
$r = $audit->run_audit( array( iwsl_seo_post( 1 ) ) );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'revocation: identical call after revoke is entitlement-locked' );
iwsl_assert_same( 0, $r['scanned'], 'revocation: nothing scanned once re-locked' );

// ── 6. find_duplicates(): identical vs unique values ──────────────────────────

$dups = IWSL_SEO_Audit::find_duplicates( array( 1 => 'Hello World', 2 => 'hello world', 3 => 'Unique' ) );
iwsl_assert_same( 1, count( $dups ), 'find_duplicates: one duplicate group (case/space-insensitive)' );
iwsl_assert_same( array( 1, 2 ), $dups['hello world'], 'find_duplicates: ids 1 and 2 grouped under the normalized value' );

iwsl_assert_same( array(), IWSL_SEO_Audit::find_duplicates( array( 1 => 'A', 2 => 'B', 3 => 'C' ) ), 'find_duplicates: all-unique → no groups' );

$dups_empty = IWSL_SEO_Audit::find_duplicates( array( 1 => '', 2 => '', 3 => 'Real' ) );
iwsl_assert_same( array(), $dups_empty, 'find_duplicates: empty values are never duplicates' );

// ── 7. compute_orphans(): orphan vs linked-from-two ───────────────────────────

$content = array(
	1 => '<p>See <a href="https://ex.com/two">two</a> and <a href="https://ex.com/three">three</a>.</p>',
	2 => '<p>Back to <a href="https://ex.com/three">three</a>.</p>',
	3 => '<p>No outbound links here.</p>',
	4 => '<p>Lonely page, links to <a href="https://ex.com/one">one</a>.</p>',
);
$permalinks = array(
	1 => 'https://ex.com/one',
	2 => 'https://ex.com/two',
	3 => 'https://ex.com/three',
	4 => 'https://ex.com/four',
);
$orphans = IWSL_SEO_Audit::compute_orphans( $content, $permalinks );
iwsl_assert( in_array( 4, $orphans, true ), 'compute_orphans: page 4 has no inbound links → orphan' );
iwsl_assert( ! in_array( 1, $orphans, true ), 'compute_orphans: page 1 is linked from page 4 → not orphan' );
iwsl_assert( ! in_array( 3, $orphans, true ), 'compute_orphans: page 3 is linked from two pages → not orphan' );
iwsl_assert( ! in_array( 2, $orphans, true ), 'compute_orphans: page 2 is linked once → not orphan' );

// A self-link does not save a page from being an orphan.
$self = IWSL_SEO_Audit::compute_orphans(
	array( 5 => '<a href="/five">me</a>' ),
	array( 5 => 'https://ex.com/five' )
);
iwsl_assert_same( array( 5 ), $self, 'compute_orphans: a self-link does not count as an inbound link' );

// A page with no resolvable permalink is not evaluated for orphan status.
$no_perma = IWSL_SEO_Audit::compute_orphans( array( 6 => 'no links' ), array( 6 => '' ) );
iwsl_assert_same( array(), $no_perma, 'compute_orphans: permalink-less pages are skipped (not flagged)' );

// ── 8. run_audit corpus pass surfaces duplicate + orphan issue codes ──────────

$corpus = array(
	(object) array( 'ID' => 10, 'post_title' => 'Shared Title Here Now', 'post_content' => iwsl_seo_words( 400, true ), 'meta_description' => 'Meta ten.', 'has_featured' => true, 'permalink' => 'https://ex.com/ten' ),
	(object) array( 'ID' => 11, 'post_title' => 'Shared Title Here Now', 'post_content' => iwsl_seo_words( 400, true ) . '<a href="https://ex.com/ten">ten</a>', 'meta_description' => 'Meta eleven.', 'has_featured' => true, 'permalink' => 'https://ex.com/eleven' ),
);
$audit_c2 = new IWSL_SEO_Audit( iwsl_seo_unlocked_entitlements( $SEO_NOW ) );
$sum_c2   = $audit_c2->run_audit( $corpus );
$issues10 = $sum_c2['items'][0]['issues'];
$issues11 = $sum_c2['items'][1]['issues'];
iwsl_assert( in_array( 'duplicate-title', $issues10, true ), 'run_audit corpus: page 10 flagged duplicate-title' );
iwsl_assert( in_array( 'duplicate-title', $issues11, true ), 'run_audit corpus: page 11 flagged duplicate-title' );
iwsl_assert( ! in_array( 'orphan-page', $issues10, true ), 'run_audit corpus: page 10 is linked from 11 → not orphan' );
iwsl_assert( in_array( 'orphan-page', $issues11, true ), 'run_audit corpus: page 11 has no inbound links → orphan' );

// ── 9. purge(): scrubs the plugin last-audit transients; never a non-plugin option ─
// The audit is read-only (no durable option, no post meta, no cron). Its only
// persisted footprint is the per-user last-summary transient, so purge issues one
// bounded, prepared DELETE matched on the plugin transient prefix. A recording fake
// $wpdb captures the query. esc_like() is a no-op here so the prefix stays legible
// (real WordPress escapes the LIKE metacharacters; the code calls it either way).

final class IWSL_SEO_Audit_Fake_WPDB {
	public $options = 'wp_options';
	/** @var string[] recorded prepared queries. */
	public $queries = array();
	/** @var int */
	private $rows;
	public function __construct( int $rows = 0 ) {
		$this->rows = $rows;
	}
	public function esc_like( string $s ): string {
		return $s; // no-op: keeps the asserted prefix readable in the fake.
	}
	public function prepare( string $query, ...$args ): string {
		$out = $query;
		foreach ( $args as $a ) {
			$pos = strpos( $out, '%s' );
			if ( false !== $pos ) {
				$out = substr( $out, 0, $pos ) . "'" . str_replace( "'", "''", (string) $a ) . "'" . substr( $out, $pos + 2 );
			}
		}
		return $out;
	}
	public function query( string $query ) {
		$this->queries[] = $query;
		return $this->rows;
	}
}

$audit_pg = new IWSL_SEO_Audit( iwsl_seo_unlocked_entitlements( $SEO_NOW ) );

$GLOBALS['wpdb'] = new IWSL_SEO_Audit_Fake_WPDB( 3 ); // 3 transient rows removed
$apg = $audit_pg->purge();
iwsl_assert_same( true, $apg['ok'], 'audit purge: ok=true' );
iwsl_assert_same( array(), $apg['options'], 'audit purge: no durable option key (read-only engine)' );
iwsl_assert_same( array(), $apg['cron'], 'audit purge: no cron scheduled by this engine' );
iwsl_assert_same( 3, $apg['transients'], 'audit purge: reports the transient rows removed' );
iwsl_assert_same( 1, count( $GLOBALS['wpdb']->queries ), 'audit purge: a single bounded DELETE' );
$q = $GLOBALS['wpdb']->queries[0];
iwsl_assert( false !== strpos( $q, 'DELETE FROM wp_options' ), 'audit purge: DELETE targets the options table' );
iwsl_assert( false !== strpos( $q, '_transient_iwsl_seo_result_' ), 'audit purge: scrubs the plugin transient prefix' );
iwsl_assert( false !== strpos( $q, '_transient_timeout_iwsl_seo_result_' ), 'audit purge: scrubs the transient timeout rows too' );
iwsl_assert( false === strpos( $q, "'%'" ), 'audit purge: never an unbounded wildcard (no non-plugin options at risk)' );

// Idempotent + cheap-when-clean: a clean site reports zero rows.
$GLOBALS['wpdb'] = new IWSL_SEO_Audit_Fake_WPDB( 0 );
$apg2 = $audit_pg->purge();
iwsl_assert_same( 0, $apg2['transients'], 'audit purge cheap-when-clean: zero rows when nothing stored' );

// Guard: no $wpdb → harmless no-op, still ok.
unset( $GLOBALS['wpdb'] );
$apg3 = $audit_pg->purge();
iwsl_assert_same( true, $apg3['ok'], 'audit purge (no $wpdb): harmless no-op ok=true' );
iwsl_assert_same( 0, $apg3['transients'], 'audit purge (no $wpdb): nothing removed without a DB handle' );

// This suite installs only $GLOBALS['wpdb'] (above); ensure it never leaks.
unset( $GLOBALS['wpdb'] );
