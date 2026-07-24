<?php
/**
 * IWSL_SEO_Console — the signed-channel SEO surface (seo.status / seo.audit.run /
 * seo.alt.backfill / seo.fix.apply).
 *
 * Runs under the zero-dependency harness. The pure cores (gate composition,
 * fold_status, plan_backfill, the validators, map_fix via the suite sanitizer) are
 * exercised directly; the runners are driven off-WP where every $wpdb gather degrades
 * to 0/null, so the ENVELOPE SHAPE + GATES + BOUNDS are pinned without a database.
 * A recording update_post_meta stub proves the fix write path. Subprocess-isolated,
 * so the two global function stubs defined here never leak to a sibling suite.
 */

// ── recording WP stubs (this suite runs in its own process) ───────────────────

$GLOBALS['iwsl_seoc_meta_writes'] = array();
$GLOBALS['iwsl_seoc_meta_store']  = array();

if ( ! function_exists( 'update_post_meta' ) ) {
	function update_post_meta( $post_id, $key, $value ) {
		$GLOBALS['iwsl_seoc_meta_writes'][]                 = array( 'id' => (int) $post_id, 'key' => (string) $key, 'value' => $value );
		$GLOBALS['iwsl_seoc_meta_store'][ (int) $post_id ][ (string) $key ] = $value;
		return true;
	}
}
if ( ! function_exists( 'get_post_meta' ) ) {
	function get_post_meta( $post_id, $key, $single = false ) {
		return $GLOBALS['iwsl_seoc_meta_store'][ (int) $post_id ][ (string) $key ] ?? '';
	}
}

// ── builder: an active, fresh, entitlement+switch-configurable console ─────────

$SEOC_NOW = 20000000;

/**
 * @param array<string,bool> $flags   entitlement flag map.
 * @param array<string,bool> $switches operator switch overrides (default: all on).
 * @return array{0:IWSL_Memory_Store,1:IWSL_Entitlements,2:IWSL_Feature_Switches,3:IWSL_SEO_Console}
 */
function iwsl_seoc_build( array $flags, array $switches = array(), int $now = 20000000 ): array {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', $flags );
	if ( array() !== $switches ) {
		$store->set( IWSL_Feature_Switches::OPTION, $switches );
	}
	$ent = new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
	$sw      = new IWSL_Feature_Switches( $ent, $store );
	$console = new IWSL_SEO_Console( $ent, $sw, $store );
	return array( $store, $ent, $sw, $console );
}

/** stdClass params from an assoc array (JSON-ish wire shape). */
function iwsl_seoc_params( array $vars ): stdClass {
	return (object) $vars;
}

// ── 1. gate(): entitlement AND operator switch ────────────────────────────────

list( , , , $c_both ) = iwsl_seoc_build( array( 'seo_audit' => true, 'seo_suite' => true ) );
$g_audit = $c_both->gate( 'seo_audit' );
$g_suite = $c_both->gate( 'seo_suite' );
iwsl_assert_same( true, $g_audit['unlocked'], 'gate: seo_audit unlocked when entitled + switch on' );
iwsl_assert_same( false, $g_audit['switched_off'], 'gate: switched_off=false when the switch is on' );
iwsl_assert_same( true, $g_suite['unlocked'], 'gate: seo_suite unlocked when entitled + switch on' );

list( , , , $c_off ) = iwsl_seoc_build( array( 'seo_audit' => true, 'seo_suite' => true ), array( 'seo_audit' => false ) );
$g_off = $c_off->gate( 'seo_audit' );
iwsl_assert_same( false, $g_off['unlocked'], 'gate: entitled but switched OFF → locked (F2 "off means off")' );
iwsl_assert_same( true, $g_off['switched_off'], 'gate: switched_off marker set' );
iwsl_assert( in_array( 'switched-off', $g_off['reasons'], true ), 'gate: switched-off reason surfaced' );
iwsl_assert_same( true, $c_off->gate( 'seo_suite' )['unlocked'], 'gate: an unrelated feature stays unlocked when another is switched off' );

list( , , , $c_none ) = iwsl_seoc_build( array() ); // nothing granted
iwsl_assert_same( false, $c_none->gate( 'seo_audit' )['unlocked'], 'gate: no entitlement → locked' );
iwsl_assert( in_array( 'requires-plus', $c_none->gate( 'seo_suite' )['reasons'], true ), 'gate: not-granted reason surfaced' );

// ── 2. Locked runners return a structured reply, never a raw error ─────────────

list( , , , $c_lock ) = iwsl_seoc_build( array() );
list( $ar_ok, $ar_res ) = $c_lock->run_audit( new stdClass() );
iwsl_assert_same( false, $ar_ok, 'run_audit locked: ok=false' );
iwsl_assert_same( true, $ar_res['locked'], 'run_audit locked: locked=true marker' );
iwsl_assert_same( 'entitlement-locked', $ar_res['reason'], 'run_audit locked: entitlement-locked reason' );
iwsl_assert( isset( $ar_res['gate']['reasons'] ), 'run_audit locked: carries the gate (for the console upsell)' );

list( $bf_ok, $bf_res ) = $c_lock->backfill_alt( new stdClass() );
iwsl_assert_same( false, $bf_ok, 'backfill locked: ok=false' );
iwsl_assert_same( 'entitlement-locked', $bf_res['reason'], 'backfill locked: entitlement-locked reason' );

list( $fx_ok, $fx_res ) = $c_lock->apply_fix( iwsl_seoc_params( array( 'post_id' => 1, 'field' => 'title', 'value' => 'x' ) ) );
iwsl_assert_same( false, $fx_ok, 'apply_fix locked: ok=false' );
iwsl_assert_same( 'entitlement-locked', $fx_res['reason'], 'apply_fix locked: entitlement-locked reason' );

// A Pro (audit-only) site: audit runs, but the Ultimate mutations stay locked.
list( , , , $c_pro ) = iwsl_seoc_build( array( 'seo_audit' => true ) );
iwsl_assert_same( 'entitlement-locked', $c_pro->apply_fix( iwsl_seoc_params( array( 'post_id' => 1, 'field' => 'title', 'value' => 'x' ) ) )[1]['reason'], 'tier: fix.apply is Ultimate — locked for a Pro (audit-only) site' );
iwsl_assert_same( 'entitlement-locked', $c_pro->backfill_alt( new stdClass() )[1]['reason'], 'tier: alt.backfill is Ultimate — locked for a Pro site' );

// ── 3. seo.status: bounded, counts-only, per-section markers ──────────────────

list( $st_store, , , $c_stat ) = iwsl_seoc_build( array( 'seo_audit' => true, 'seo_suite' => true ), array(), $SEOC_NOW );
// Seed a durable last-audit so the audit section reports counts.
$st_store->set(
	IWSL_SEO_Audit::LAST_AUDIT_OPTION,
	array(
		'ok'           => true,
		'generated_at' => '2026-07-24 10:00:00',
		'scanned'      => 12,
		'with_issues'  => 4,
		'issue_counts' => array( 'missing-meta-description' => 3, 'thin-content' => 1 ),
		'items'        => array( array( 'id' => 1, 'title' => 'A', 'issues' => array( 'thin-content' ) ) ),
	)
);
list( $s_ok, $status ) = $c_stat->status();
iwsl_assert_same( true, $s_ok, 'status: ok=true (safe read, never method-gated)' );
iwsl_assert( isset( $status['engines']['suite'], $status['engines']['audit'] ), 'status: engines.suite + engines.audit present' );
iwsl_assert_same( true, $status['engines']['suite']['unlocked'], 'status: suite section reflects the open gate' );
iwsl_assert_same( true, $status['engines']['audit']['unlocked'], 'status: audit section reflects the open gate' );
iwsl_assert_same( 12, $status['engines']['audit']['last']['scanned'], 'status: durable last-audit counts surface' );
iwsl_assert_same( 4, $status['engines']['audit']['last']['with_issues'], 'status: last-audit with_issues surfaces' );
iwsl_assert( ! isset( $status['engines']['audit']['last']['items'] ), 'status: audit.last is COUNTS ONLY — no item list on the wire' );
iwsl_assert( is_array( $status['alt'] ) && isset( $status['alt']['images'], $status['alt']['missing'] ), 'status: alt coverage counts present' );
iwsl_assert( array_key_exists( 'schema', $status ), 'status: schema key present (null off-WP is fine)' );
iwsl_assert_same( array(), $status['conflicting_engines'], 'status: no conflicting engines off-WP' );
iwsl_assert_same( null, $status['four04'], 'status: four04 null (site-health owns redirect.*)' );

// Locked site → the status read still succeeds; sections just report locked/zeroed.
list( , , , $c_stat_lk ) = iwsl_seoc_build( array() );
list( $s_ok2, $status_lk ) = $c_stat_lk->status();
iwsl_assert_same( true, $s_ok2, 'status (locked site): still a well-formed read, ok=true' );
iwsl_assert_same( false, $status_lk['engines']['suite']['unlocked'], 'status (locked): suite section reports locked' );
iwsl_assert_same( null, $status_lk['engines']['audit']['last'], 'status (locked): no audit.last for a locked audit' );
iwsl_assert_same( null, $status_lk['schema'], 'status (locked): schema null when the suite is closed' );

// ── 4. fold_status(): pure shape + defensive casts ────────────────────────────

$folded = IWSL_SEO_Console::fold_status(
	array(
		'suite'               => array(
			'unlocked'       => true,
			'switched_off'   => false,
			'score'          => array( 'avg' => 73, 'histogram' => array( 'good' => 5, 'ok' => 2, 'poor' => 1, 'none' => 4 ) ),
			'sitemap'        => array( 'active' => true, 'url' => 'https://x.test/sitemap_index.xml' ),
			'robots_managed' => true,
		),
		'audit'               => array( 'unlocked' => true, 'switched_off' => false, 'last' => array( 'scanned' => 3 ) ),
		'alt'                 => array( 'images' => 10, 'missing' => 6 ),
		'keywords'            => array( 'set' => 4, 'missing' => 2, 'duplicates' => 0 ),
		'schema'              => array( 'site_representation' => true, 'typed_posts' => 3, 'published' => 7 ),
		'four04'              => null,
		'noindexed'           => 2,
		'conflicting_engines' => array( 'wordpress-seo/wp-seo.php', 5, 'ok' ),
	)
);
iwsl_assert_same( 73, $folded['engines']['suite']['score_avg'], 'fold_status: score_avg passthrough' );
iwsl_assert_same( 4, $folded['engines']['suite']['histogram']['none'], 'fold_status: histogram none bucket' );
iwsl_assert_same( 6, $folded['alt']['missing'], 'fold_status: alt.missing' );
iwsl_assert_same( true, $folded['schema']['site_representation'], 'fold_status: schema site_representation' );
iwsl_assert_same( array( 'wordpress-seo/wp-seo.php', 'ok' ), $folded['conflicting_engines'], 'fold_status: conflicting_engines filtered to strings' );
$folded_min = IWSL_SEO_Console::fold_status( array() );
iwsl_assert_same( null, $folded_min['engines']['suite']['score_avg'], 'fold_status: missing score → null' );
iwsl_assert_same( 0, $folded_min['alt']['images'], 'fold_status: missing alt → 0' );
iwsl_assert_same( null, $folded_min['schema'], 'fold_status: missing schema → null' );

// ── 5. plan_backfill(): never-clobber + idempotent (pure) ─────────────────────

$batch = array(
	array( 'id' => 1, 'current_alt' => '', 'title' => 'Sunset Over Bay', 'filename' => 'x.jpg', 'parent_title' => '' ),
	array( 'id' => 2, 'current_alt' => 'Author wrote this', 'title' => 'Ignored', 'filename' => 'y.jpg', 'parent_title' => '' ),
	array( 'id' => 3, 'current_alt' => '', 'title' => '', 'filename' => 'coffee-grinder_photo.JPG', 'parent_title' => '' ),
	array( 'id' => 4, 'current_alt' => '', 'title' => '', 'filename' => '', 'parent_title' => '' ), // nothing derivable
);
$plan = IWSL_SEO_Console::plan_backfill( $batch );
iwsl_assert_same( 4, $plan['scanned'], 'plan_backfill: scans every item in the batch' );
iwsl_assert_same( 2, count( $plan['fills'] ), 'plan_backfill: fills only items with an empty alt AND a derivable value' );
iwsl_assert_same( 1, $plan['fills'][0]['id'], 'plan_backfill: id 1 (title) filled' );
iwsl_assert_same( 'Sunset Over Bay', $plan['fills'][0]['derived'], 'plan_backfill: derives from the attachment title' );
iwsl_assert_same( 'Coffee Grinder Photo', $plan['fills'][1]['derived'], 'plan_backfill: derives + humanizes the filename when no title' );
$ids_filled = array_map( static function ( $f ) {
	return $f['id']; }, $plan['fills'] );
iwsl_assert( ! in_array( 2, $ids_filled, true ), 'plan_backfill: NEVER clobbers an author-written alt (id 2 skipped)' );
iwsl_assert( ! in_array( 4, $ids_filled, true ), 'plan_backfill: skips items with nothing derivable (id 4)' );

// Idempotent: once the alt is set, a re-plan of the same items fills nothing.
$batch2 = $batch;
$batch2[0]['current_alt'] = 'Sunset Over Bay';
$batch2[2]['current_alt'] = 'Coffee Grinder Photo';
iwsl_assert_same( 0, count( IWSL_SEO_Console::plan_backfill( $batch2 )['fills'] ), 'plan_backfill: idempotent — a second run over a filled library fills 0' );

// ── 6. backfill_alt runner: dry-run default + shape (unlocked, off-WP) ─────────

list( , , , $c_bf ) = iwsl_seoc_build( array( 'seo_suite' => true ) );
list( $bf2_ok, $bf2 ) = $c_bf->backfill_alt( new stdClass() );
iwsl_assert_same( true, $bf2_ok, 'backfill unlocked: ok' );
iwsl_assert_same( true, $bf2['dry_run'], 'backfill: dry_run defaults TRUE (safe preview — must opt in to write)' );
iwsl_assert_same( 0, $bf2['filled'], 'backfill dry-run: writes nothing' );
iwsl_assert( array_key_exists( 'scanned', $bf2 ) && array_key_exists( 'remaining', $bf2 ) && array_key_exists( 'samples', $bf2 ), 'backfill: reusable shape { scanned, filled, fillable, remaining, samples } for the media explorer bulk bar' );
iwsl_assert( is_array( $bf2['samples'] ), 'backfill: samples is an array (≤10)' );

// ── 7. apply_fix: strict allow-list + suite-sanitized write ───────────────────

$GLOBALS['iwsl_seoc_meta_writes'] = array();
list( , , , $c_fix ) = iwsl_seoc_build( array( 'seo_suite' => true ) );

list( $t_ok, $t_res ) = $c_fix->apply_fix( iwsl_seoc_params( array( 'post_id' => 42, 'field' => 'title', 'value' => 'A Fine Title' ) ) );
iwsl_assert_same( true, $t_ok, 'apply_fix title: ok' );
iwsl_assert_same( 'A Fine Title', $t_res['stored'], 'apply_fix title: stored value echoed' );
$w = end( $GLOBALS['iwsl_seoc_meta_writes'] );
iwsl_assert_same( IWSL_SEO_Suite::META_TITLE, $w['key'], 'apply_fix title: writes the suite _iwseo_title meta' );
iwsl_assert_same( 42, $w['id'], 'apply_fix title: writes the requested post' );

$noidx = $c_fix->apply_fix( iwsl_seoc_params( array( 'post_id' => 42, 'field' => 'noindex', 'value' => 'on' ) ) )[1];
iwsl_assert_same( '1', $noidx['stored'], 'apply_fix noindex: truthy value → "1" via the suite sanitizer' );
$noidx_off = $c_fix->apply_fix( iwsl_seoc_params( array( 'post_id' => 42, 'field' => 'noindex', 'value' => '' ) ) )[1];
iwsl_assert_same( '', $noidx_off['stored'], 'apply_fix noindex: empty value → "" (off)' );

// Defensive re-validation inside the runner (belt-and-suspenders behind the wire validator).
$bad = $c_fix->apply_fix( iwsl_seoc_params( array( 'post_id' => 42, 'field' => 'evil', 'value' => 'x' ) ) );
iwsl_assert_same( false, $bad[0], 'apply_fix: an unknown field is refused even if it reaches the runner' );

// ── 8. validators: stray keys + type/range/enum enforcement ───────────────────

iwsl_assert_same( true, IWSL_SEO_Console::validate_audit_params( new stdClass() ), 'validate_audit: empty params OK (limit optional)' );
iwsl_assert_same( true, IWSL_SEO_Console::validate_audit_params( iwsl_seoc_params( array( 'limit' => 50 ) ) ), 'validate_audit: limit in range OK' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_audit_params( iwsl_seoc_params( array( 'limit' => 0 ) ) ), 'validate_audit: limit<1 rejected' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_audit_params( iwsl_seoc_params( array( 'limit' => 201 ) ) ), 'validate_audit: limit>200 rejected' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_audit_params( iwsl_seoc_params( array( 'limit' => 50.0 ) ) ), 'validate_audit: float limit rejected (strict int)' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_audit_params( iwsl_seoc_params( array( 'limit' => 50, 'x' => 1 ) ) ), 'validate_audit: STRAY key rejected' );

iwsl_assert_same( true, IWSL_SEO_Console::validate_backfill_params( iwsl_seoc_params( array( 'limit' => 100, 'dry_run' => false ) ) ), 'validate_backfill: limit + dry_run OK' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_backfill_params( iwsl_seoc_params( array( 'dry_run' => 'yes' ) ) ), 'validate_backfill: non-bool dry_run rejected' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_backfill_params( iwsl_seoc_params( array( 'nope' => 1 ) ) ), 'validate_backfill: STRAY key rejected' );

iwsl_assert_same( true, IWSL_SEO_Console::validate_fix_params( iwsl_seoc_params( array( 'post_id' => 3, 'field' => 'desc', 'value' => 'ok' ) ) ), 'validate_fix: complete valid params OK' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_fix_params( iwsl_seoc_params( array( 'post_id' => 3, 'field' => 'desc' ) ) ), 'validate_fix: missing required value rejected' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_fix_params( iwsl_seoc_params( array( 'post_id' => 0, 'field' => 'desc', 'value' => 'x' ) ) ), 'validate_fix: post_id must be > 0' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_fix_params( iwsl_seoc_params( array( 'post_id' => 3, 'field' => 'canonical', 'value' => 'x' ) ) ), 'validate_fix: field OUTSIDE the allow-list rejected' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_fix_params( iwsl_seoc_params( array( 'post_id' => 3, 'field' => 'desc', 'value' => str_repeat( 'a', 401 ) ) ) ), 'validate_fix: value over 400 bytes rejected' );
iwsl_assert_same( false, IWSL_SEO_Console::validate_fix_params( iwsl_seoc_params( array( 'post_id' => 3, 'field' => 'desc', 'value' => 'x', 'extra' => 1 ) ) ), 'validate_fix: STRAY key rejected' );

// ── 9. run_audit unlocked: persists the durable last-audit ────────────────────

list( $ra_store, , , $c_run ) = iwsl_seoc_build( array( 'seo_audit' => true ), array(), $SEOC_NOW );
iwsl_assert_same( null, $ra_store->get( IWSL_SEO_Audit::LAST_AUDIT_OPTION, null ), 'run_audit: no durable last-audit before the first run' );
list( $ra_ok, $ra_res ) = $c_run->run_audit( iwsl_seoc_params( array( 'limit' => 25 ) ) );
iwsl_assert_same( true, $ra_ok, 'run_audit unlocked: ok' );
iwsl_assert_same( true, $ra_res['ok'], 'run_audit unlocked: summary ok=true' );
iwsl_assert( is_array( $ra_store->get( IWSL_SEO_Audit::LAST_AUDIT_OPTION, null ) ), 'run_audit: persists the durable last-audit for cross-surface reads (B2)' );
iwsl_assert( isset( $ra_res['wire_item_cap'] ) && $ra_res['wire_item_cap'] <= IWSL_SEO_Console::WIRE_ITEM_CAP, 'run_audit: items capped on the wire (≤50)' );

// This suite defines get_post_meta/update_post_meta stubs; subprocess isolation keeps
// them out of sibling suites. Nothing to unset (no $GLOBALS['wpdb'] installed here).
