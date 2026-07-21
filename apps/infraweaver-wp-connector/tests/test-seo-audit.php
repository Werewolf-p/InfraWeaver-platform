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
			'post_title'       => str_repeat( 'a', 40 ),         // 40 chars → within [20,60]
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

// This suite installs no globals — nothing to unset.
