<?php
/**
 * IWSL_DB_History — the capped ring of REAL cleanup runs.
 *
 * Pure storage over an in-memory IWSL_Store with an injected clock. Proves the
 * ring caps at MAX_ENTRIES (oldest evicted), normalizes source + cleaner ids +
 * counts, stamps `at` from the injected clock, and that purge() removes the key.
 */

function iwsl_hist_clock( int $now ): callable {
	return static function () use ( $now ): int {
		return $now;
	};
}

/** A run-mode summary with the given per-cleaner deletions. */
function iwsl_hist_summary( array $cleaners, int $total ): array {
	return array( 'ok' => true, 'mode' => 'run', 'cleaners' => $cleaners, 'total' => $total );
}

$HNOW = 60000000; // ms

// ── 1. A single record is stored newest-first with a clock-stamped `at` ────────

$store = new IWSL_Memory_Store();
$hist  = new IWSL_DB_History( $store, iwsl_hist_clock( $HNOW ) );
$hist->record( iwsl_hist_summary( array( array( 'id' => 'spam_comments', 'label' => 'Spam', 'deleted' => 4 ) ), 4 ), 'console' );
$all = $hist->all();
iwsl_assert_same( 1, count( $all ), 'record: one entry stored' );
iwsl_assert_same( (int) floor( $HNOW / 1000 ), $all[0]['at'], 'record: `at` stamped from injected clock (unix seconds)' );
iwsl_assert_same( 'console', $all[0]['source'], 'record: source preserved when in allow-list' );
iwsl_assert_same( 4, $all[0]['total'], 'record: total preserved' );
iwsl_assert_same( array( array( 'id' => 'spam_comments', 'deleted' => 4 ) ), $all[0]['cleaners'], 'record: cleaners normalized to {id,deleted} (label dropped)' );

// ── 2. Newest-first ordering across multiple records ──────────────────────────

$store = new IWSL_Memory_Store();
$hist  = new IWSL_DB_History( $store, iwsl_hist_clock( $HNOW ) );
$hist->record( iwsl_hist_summary( array(), 1 ), 'manual' );
$hist->record( iwsl_hist_summary( array(), 2 ), 'scheduled' );
$hist->record( iwsl_hist_summary( array(), 3 ), 'console' );
$all = $hist->all();
iwsl_assert_same( 3, count( $all ), 'order: three entries stored' );
iwsl_assert_same( 3, $all[0]['total'], 'order: newest entry is first' );
iwsl_assert_same( 1, $all[2]['total'], 'order: oldest entry is last' );

// ── 3. The ring caps at MAX_ENTRIES, evicting the oldest ──────────────────────

$store = new IWSL_Memory_Store();
$hist  = new IWSL_DB_History( $store, iwsl_hist_clock( $HNOW ) );
for ( $i = 1; $i <= IWSL_DB_History::MAX_ENTRIES + 5; $i++ ) {
	$hist->record( iwsl_hist_summary( array(), $i ), 'manual' );
}
$all = $hist->all();
iwsl_assert_same( IWSL_DB_History::MAX_ENTRIES, count( $all ), 'cap: ring never exceeds MAX_ENTRIES' );
iwsl_assert_same( IWSL_DB_History::MAX_ENTRIES + 5, $all[0]['total'], 'cap: newest survives' );
iwsl_assert_same( 6, $all[ IWSL_DB_History::MAX_ENTRIES - 1 ]['total'], 'cap: the oldest 5 were evicted' );

// ── 4. Normalization: unknown source clamps; hostile cleaner ids dropped ──────

$store = new IWSL_Memory_Store();
$hist  = new IWSL_DB_History( $store, iwsl_hist_clock( $HNOW ) );
$hist->record(
	iwsl_hist_summary(
		array(
			array( 'id' => 'wp_users; DROP TABLE wp_posts', 'deleted' => 9 ), // not registry-shaped → dropped
			array( 'id' => 'post_revisions', 'deleted' => -3 ),               // negative coerced to 0
			array( 'id' => 'auto_drafts', 'deleted' => 7 ),
		),
		16
	),
	'evil-source'
);
$all = $hist->all();
iwsl_assert_same( 'manual', $all[0]['source'], 'normalize: unknown source clamps to manual' );
iwsl_assert_same( 2, count( $all[0]['cleaners'] ), 'normalize: hostile (non-registry-shaped) id dropped' );
iwsl_assert_same( 'post_revisions', $all[0]['cleaners'][0]['id'], 'normalize: valid ids kept' );
iwsl_assert_same( 0, $all[0]['cleaners'][0]['deleted'], 'normalize: negative deleted coerced to 0' );

// ── 5. purge() removes the key and reports it; idempotent ─────────────────────

iwsl_assert_same( 1, $hist->purge(), 'purge: reports 1 when a key existed' );
iwsl_assert_same( array(), $hist->all(), 'purge: ring is empty afterward' );
iwsl_assert_same( 0, $hist->purge(), 'purge: idempotent — 0 when already clean' );

// ── 6. A malformed stored value degrades to an empty ring (never fatals) ──────

$store = new IWSL_Memory_Store();
$store->set( IWSL_DB_History::STORE_KEY, 'not-an-array' );
$hist = new IWSL_DB_History( $store, iwsl_hist_clock( $HNOW ) );
iwsl_assert_same( array(), $hist->all(), 'robust: a malformed stored value reads as an empty ring' );
