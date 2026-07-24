<?php
/**
 * IWSL_Redirect_Suggestions — the pure, bounded 404 → target suggestion engine (S6).
 * No gate, no store, no network: every input is supplied, so the suite asserts the
 * ranking, the confidence labels, the degenerate cases, and the hard bounds directly.
 */

// ── 1. Exact tail-slug match wins as 'high' ───────────────────────────────────

$s = IWSL_Redirect_Suggestions::suggest(
	array( '/2020/05/hello-world' ),
	array( '/blog/hello-world', '/about' )
);
iwsl_assert_same( 1, count( $s ), 'exact tail: one suggestion produced' );
iwsl_assert_same( '/2020/05/hello-world', $s[0]['path'], 'exact tail: dead path echoed' );
iwsl_assert_same( '/blog/hello-world', $s[0]['target'], 'exact tail: best target is the slug-tail match (date prefix ignored)' );
iwsl_assert_same( 'high', $s[0]['confidence'], 'exact tail: confidence is high' );

// ── 2. Extension variants collapse to the same tail slug ──────────────────────

$s = IWSL_Redirect_Suggestions::suggest( array( '/contact.html' ), array( '/contact' ) );
iwsl_assert_same( 'high', $s[0]['confidence'], 'extension: /contact.html ↔ /contact is a high match' );
iwsl_assert_same( '/contact', $s[0]['target'], 'extension: target is the live /contact' );

// ── 3. Fuzzy near-miss is a lower confidence, not high ────────────────────────

$s = IWSL_Redirect_Suggestions::suggest( array( '/produkts' ), array( '/products' ) );
iwsl_assert_same( 1, count( $s ), 'fuzzy: a near-miss still yields a suggestion' );
iwsl_assert( in_array( $s[0]['confidence'], array( 'medium', 'low' ), true ), 'fuzzy: near-miss confidence is medium/low, not high' );
iwsl_assert_same( '/products', $s[0]['target'], 'fuzzy: target is the closest slug' );

// ── 4. No candidate clears the floor → no suggestion for that path ────────────

$s = IWSL_Redirect_Suggestions::suggest( array( '/xyzzy' ), array( '/about-our-company-history' ) );
iwsl_assert_same( 0, count( $s ), 'floor: an unrelated dead path produces no suggestion' );

// ── 5. Degenerate inputs never error ──────────────────────────────────────────

iwsl_assert_same( array(), IWSL_Redirect_Suggestions::suggest( array(), array( '/a' ) ), 'degenerate: no dead paths → []' );
iwsl_assert_same( array(), IWSL_Redirect_Suggestions::suggest( array( '/a' ), array() ), 'degenerate: no candidates → []' );
iwsl_assert_same( array(), IWSL_Redirect_Suggestions::suggest( array( 123, null, '' ), array( '/a' ) ), 'degenerate: non-string / empty dead paths dropped' );
iwsl_assert_same( '', IWSL_Redirect_Suggestions::tail_slug( '/' ), 'degenerate: root path has no tail slug' );

// ── 6. Bounds: at most MAX_PATHS suggestions, order preserved ─────────────────

$dead = array();
for ( $i = 0; $i < IWSL_Redirect_Suggestions::MAX_PATHS + 10; $i++ ) {
	$dead[] = '/gone-' . $i;
}
$live = array();
for ( $i = 0; $i < IWSL_Redirect_Suggestions::MAX_PATHS + 10; $i++ ) {
	$live[] = '/gone-' . $i; // each dead path has an exact live twin
}
$s = IWSL_Redirect_Suggestions::suggest( $dead, $live );
iwsl_assert_same( IWSL_Redirect_Suggestions::MAX_PATHS, count( $s ), 'bounds: output capped at MAX_PATHS' );
iwsl_assert_same( '/gone-0', $s[0]['path'], 'bounds: input ranking preserved (first dead path first)' );

// ── 7. Candidate list is de-duped + capped (bounded work) ─────────────────────

// Fillers share NO characters with the target slug, so no fuzzy match can occur;
// the ONLY possible match is the exact twin, which we place BEYOND the candidate
// cap. A result of 0 therefore proves the candidate list is truncated to
// MAX_CANDIDATES (a within-cap fuzzy lookalike would otherwise mask the bound).
$many = array();
for ( $i = 0; $i < IWSL_Redirect_Suggestions::MAX_CANDIDATES; $i++ ) {
	$many[] = sprintf( '/f%04d', $i );
}
$many[] = '/zzzzzzzzzz'; // exact twin, index MAX_CANDIDATES (beyond the cap)
$s = IWSL_Redirect_Suggestions::suggest( array( '/zzzzzzzzzz' ), $many );
iwsl_assert_same( 0, count( $s ), 'bounds: candidates beyond MAX_CANDIDATES are not compared' );

// Control: the SAME exact twin within the cap IS found (guards against a false pass).
$s = IWSL_Redirect_Suggestions::suggest( array( '/zzzzzzzzzz' ), array( '/zzzzzzzzzz' ) );
iwsl_assert_same( 'high', $s[0]['confidence'], 'bounds control: an in-cap exact twin is still found' );
