<?php
/**
 * Activity Log (gate flag `activity_log`, tier Ultimate): the bounded metadata-ring
 * engine (IWSL_Activity_Log).
 *
 * Runs under the zero-dependency harness: an in-memory IWSL_Store, a fixed clock,
 * and plain stdClass posts. No WordPress function is required — the engine's actor
 * resolution ('system') and escaping (htmlspecialchars) both fall back cleanly
 * outside WP — so every gate / append / FIFO-cap / clear / escaping / revocation
 * assertion runs with no external dependency.
 */

// ── fixtures ──────────────────────────────────────────────────────────────────

/** An entitlement gate at a chosen state / heartbeat-age / flag set, on a fixed clock. */
function iwsl_al_entitlements( int $now, string $state, int $verified_age_ms, array $flags ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $now - $verified_age_ms );
	$store->set( 'entitlements', $flags );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** Unlocked gate: active + fresh heartbeat + activity_log flag. */
function iwsl_al_unlocked( int $now ): IWSL_Entitlements {
	return iwsl_al_entitlements( $now, 'active', 60000, array( 'plus' => true, 'activity_log' => true ) );
}

/** A WP_Post-like object. */
function iwsl_al_post( int $id, string $title, string $type = 'post', string $status = 'publish' ) {
	return (object) array(
		'ID'          => $id,
		'post_title'  => $title,
		'post_type'   => $type,
		'post_status' => $status,
	);
}

$AL_NOW = 20000000;
$al_clock = static function () use ( $AL_NOW ): int {
	return $AL_NOW;
};

// ── 1. Gate blocks: nothing is logged and the store is never written ──────────

// (a) activity_log flag ABSENT.
$store1a = new IWSL_Memory_Store();
$al1a    = new IWSL_Activity_Log( iwsl_al_entitlements( $AL_NOW, 'active', 60000, array( 'plus' => true ) ), $store1a, $al_clock );
$al1a->on_wp_login( 'admin' );
iwsl_assert_same( 0, count( $al1a->entries() ), 'gate blocks (absent flag): login logs nothing' );
iwsl_assert_same( null, $store1a->get( IWSL_Activity_Log::LOG_KEY ), 'gate blocks (absent flag): store NEVER written' );
$rec1a = $al1a->record( 'x', 'y', 'z' );
iwsl_assert_same( 'entitlement-locked', $rec1a['reason'], 'gate blocks (absent flag): record → entitlement-locked' );

// (b) state != active, even WITH the flag true.
$store1b = new IWSL_Memory_Store();
$al1b    = new IWSL_Activity_Log( iwsl_al_entitlements( $AL_NOW, 'pending', 60000, array( 'activity_log' => true ) ), $store1b, $al_clock );
$al1b->on_transition_post_status( 'publish', 'draft', iwsl_al_post( 1, 'Hi' ) );
iwsl_assert_same( 0, count( $al1b->entries() ), 'gate blocks (not active): transition logs nothing despite flag' );

// (c) stale heartbeat, even WITH the flag true.
$store1c = new IWSL_Memory_Store();
$al1c    = new IWSL_Activity_Log( iwsl_al_entitlements( $AL_NOW, 'active', 10800000, array( 'activity_log' => true ) ), $store1c, $al_clock );
$al1c->on_activated_plugin( 'akismet/akismet.php' );
iwsl_assert_same( 0, count( $al1c->entries() ), 'gate blocks (stale heartbeat): nothing logged despite flag' );

// ── 2. Unlock: a login appends exactly one bounded entry ──────────────────────

$store2 = new IWSL_Memory_Store();
$al2    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store2, $al_clock );
$al2->on_wp_login( 'admin' );
$e2 = $al2->entries();
iwsl_assert_same( 1, count( $e2 ), 'unlock: one entry appended for a login' );
iwsl_assert_same( 'user_login', $e2[0]['action'], 'unlock: action is user_login' );
iwsl_assert_same( 'admin', $e2[0]['actor'], 'unlock: actor is the login' );
iwsl_assert_same( 20000, (int) $e2[0]['at'], 'unlock: timestamp derived from the injected clock' );

// ── 3. Transitions: publish/update/trash logged; churn + revisions skipped ────

$store3 = new IWSL_Memory_Store();
$al3    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store3, $al_clock );
$al3->on_transition_post_status( 'publish', 'draft', iwsl_al_post( 42, 'Hello World' ) );
$e3 = $al3->entries();
iwsl_assert_same( 1, count( $e3 ), 'transition: publish logs one entry' );
iwsl_assert_same( 'post_published', $e3[0]['action'], 'transition: publish → post_published' );
iwsl_assert_same( 'Hello World', $e3[0]['object'], 'transition: object is the post title' );

$al3->on_transition_post_status( 'publish', 'publish', iwsl_al_post( 42, 'Hello World v2' ) );
iwsl_assert_same( 'post_updated', $al3->entries()[1]['action'], 'transition: publish→publish → post_updated' );

$al3->on_transition_post_status( 'trash', 'publish', iwsl_al_post( 42, 'Hello World v2' ) );
iwsl_assert_same( 'post_trashed', $al3->entries()[2]['action'], 'transition: → trash → post_trashed' );

$before3 = count( $al3->entries() );
$al3->on_transition_post_status( 'draft', 'auto-draft', iwsl_al_post( 43, 'Draft' ) );
$al3->on_transition_post_status( 'publish', 'inherit', iwsl_al_post( 44, 'Rev', 'revision' ) );
iwsl_assert_same( $before3, count( $al3->entries() ), 'transition: draft churn + revisions are not logged' );

// ── 4. Plugin + option events (option values are NEVER stored) ────────────────

$store4 = new IWSL_Memory_Store();
$al4    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store4, $al_clock );
$al4->on_activated_plugin( 'akismet/akismet.php' );
$al4->on_deactivated_plugin( 'akismet/akismet.php' );
$al4->on_updated_option( 'blogname', 'Old Name', 'New Name' );
$al4->on_updated_option( 'blogname', 'Same', 'Same' );        // unchanged → no entry
$al4->on_updated_option( 'some_random_option', 'a', 'b' );     // not watched → no entry
$e4 = $al4->entries();
iwsl_assert_same( 3, count( $e4 ), 'events: activate + deactivate + one real option change logged (noise ignored)' );
iwsl_assert_same( 'plugin_activated', $e4[0]['action'], 'events: plugin_activated recorded' );
iwsl_assert_same( 'option_updated', $e4[2]['action'], 'events: watched option change recorded' );
iwsl_assert( false === strpos( $e4[2]['summary'] . $e4[2]['object'], 'New Name' ), 'events: the option VALUE is never stored (metadata only)' );

// ── 5. FIFO cap enforced (oldest dropped) ─────────────────────────────────────

$store5 = new IWSL_Memory_Store();
$al5    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store5, $al_clock );
$overflow = IWSL_Activity_Log::MAX_ENTRIES + 2;
for ( $i = 0; $i < $overflow; $i++ ) {
	$al5->on_wp_login( 'u' . $i );
}
$e5 = $al5->entries();
iwsl_assert_same( IWSL_Activity_Log::MAX_ENTRIES, count( $e5 ), 'FIFO: log capped at MAX_ENTRIES' );
iwsl_assert_same( 'u2', $e5[0]['actor'], 'FIFO: the two oldest were dropped (u0,u1)' );
iwsl_assert_same( 'u' . ( $overflow - 1 ), $e5[ count( $e5 ) - 1 ]['actor'], 'FIFO: the newest entry is retained' );

// ── 6. Bounded fields: over-long / control-laden text is capped + stripped ────

$store6 = new IWSL_Memory_Store();
$al6    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store6, $al_clock );
$al6->record( 'post_published', str_repeat( 'x', 500 ), str_repeat( 'y', 500 ) );
$e6 = $al6->entries();
iwsl_assert_same( IWSL_Activity_Log::MAX_FIELD_LEN, strlen( $e6[0]['object'] ), 'bounded: object hard-truncated to MAX_FIELD_LEN' );
iwsl_assert_same( IWSL_Activity_Log::MAX_FIELD_LEN, strlen( $e6[0]['summary'] ), 'bounded: summary hard-truncated to MAX_FIELD_LEN' );
$al6->record( 'a', "line1\r\nline2\x00tail", 's' );
$obj6 = $al6->entries()[1]['object'];
iwsl_assert( false === strpos( $obj6, "\r" ) && false === strpos( $obj6, "\n" ) && false === strpos( $obj6, "\x00" ), 'bounded: control characters stripped from stored text' );

// ── 7. Clear empties the log; a locked clear is a no-op ───────────────────────

$store7 = new IWSL_Memory_Store();
$al7    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store7, $al_clock );
$al7->on_wp_login( 'admin' );
iwsl_assert_same( 1, count( $al7->entries() ), 'clear: one entry seeded' );
$clr7 = $al7->clear();
iwsl_assert_same( true, $clr7['ok'], 'clear: reported ok' );
iwsl_assert_same( 0, count( $al7->entries() ), 'clear: log emptied' );

// A locked engine over the SAME store cannot clear.
$store7b = new IWSL_Memory_Store();
$al7b    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store7b, $al_clock );
$al7b->on_wp_login( 'keep' );
$al7b_locked = new IWSL_Activity_Log( iwsl_al_entitlements( $AL_NOW, 'active', 60000, array() ), $store7b, $al_clock );
$clr7b       = $al7b_locked->clear();
iwsl_assert_same( 'entitlement-locked', $clr7b['reason'], 'locked clear: entitlement-locked' );
iwsl_assert_same( 1, count( $al7b->entries() ), 'locked clear: the entry survives' );

// ── 8. Render escapes hostile text; locked render shows the gate reasons ──────

$store8 = new IWSL_Memory_Store();
$al8    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store8, $al_clock );
$al8->record( 'post_published', '<script>alert(1)</script>', 'x' );
ob_start();
$al8->render_section();
$html8 = ob_get_clean();
iwsl_assert( false === strpos( $html8, '<script>' ), 'render: raw <script> absent from the table (escaped)' );
iwsl_assert( false !== strpos( $html8, '&lt;script&gt;' ), 'render: the object text is HTML-escaped' );
iwsl_assert( false !== strpos( $html8, IWSL_Activity_Log::ACTION_CLEAR ), 'render: the gated clear form is wired' );

$al8_locked = new IWSL_Activity_Log( iwsl_al_entitlements( $AL_NOW, 'active', 60000, array() ), new IWSL_Memory_Store(), $al_clock );
ob_start();
$al8_locked->render_section();
$html8b = ob_get_clean();
iwsl_assert( false !== strpos( $html8b, 'locked' ), 'render(locked): shows the locked notice' );
iwsl_assert( false !== strpos( $html8b, 'requires-plus' ), 'render(locked): lists the gate reason' );

// ── 9. Revocation is instant (a revoked flag stops all logging) ───────────────

$store9 = new IWSL_Memory_Store();
$al9    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store9, $al_clock );
$al9->on_wp_login( 'before' );
iwsl_assert_same( 1, count( $al9->entries() ), 'revocation: unlocked login logged' );
$al9_revoked = new IWSL_Activity_Log( iwsl_al_entitlements( $AL_NOW, 'active', 60000, array() ), $store9, $al_clock );
$al9_revoked->on_wp_login( 'after' );
iwsl_assert_same( 1, count( $al9->entries() ), 'revocation: a login after revoke adds NOTHING' );

// ── 10. purge(): teardown removes the log option key (idempotent, ungated) ───

$store10 = new IWSL_Memory_Store();
$al10    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store10, $al_clock );
$al10->on_wp_login( 'admin' );
iwsl_assert_same( 1, count( $al10->entries() ), 'purge: one entry seeded before teardown' );
$p10 = $al10->purge();
iwsl_assert_same( true, $p10['ok'], 'purge: ok=true' );
iwsl_assert_same( array( IWSL_Activity_Log::LOG_KEY ), $p10['options_removed'], 'purge: reports the removed log option key' );
iwsl_assert_same( null, $store10->get( IWSL_Activity_Log::LOG_KEY ), 'purge: log option removed from the store' );
iwsl_assert_same( 0, count( $al10->entries() ), 'purge: entries() reads back empty after teardown' );

// idempotent + cheap on an already-clean store.
$p10b = $al10->purge();
iwsl_assert_same( true, $p10b['ok'], 'purge: idempotent — second call on a clean store still ok' );
iwsl_assert_same( array( IWSL_Activity_Log::LOG_KEY ), $p10b['options_removed'], 'purge: idempotent call reports the same key' );

// purge is NOT gated by the entitlement — teardown works on a revoked/locked site.
$store10l      = new IWSL_Memory_Store();
$al10_unlocked = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store10l, $al_clock );
$al10_unlocked->on_wp_login( 'keep' );
$al10_locked = new IWSL_Activity_Log( iwsl_al_entitlements( $AL_NOW, 'active', 60000, array() ), $store10l, $al_clock );
$p10l        = $al10_locked->purge();
iwsl_assert_same( true, $p10l['ok'], 'purge: works even when the entitlement is locked/revoked' );
iwsl_assert_same( null, $store10l->get( IWSL_Activity_Log::LOG_KEY ), 'purge (locked): log option removed despite the lock' );

// ── 11. record() optimistic re-read: a concurrent entry survives the append ───
// record() builds its entry WITHOUT reading the log, then merges onto a FRESH
// entries() read taken immediately before the set. An entry a racing writer
// appended between two records must be preserved — an audit trail must not drop
// entries by merging onto a stale snapshot.
$store11 = new IWSL_Memory_Store();
$al11    = new IWSL_Activity_Log( iwsl_al_unlocked( $AL_NOW ), $store11, $al_clock );
$al11->record( 'first_action', 'obj1', 'sum1' );
// A concurrent writer appends directly to the store between the two records.
$store11->set(
	IWSL_Activity_Log::LOG_KEY,
	array_merge(
		$al11->entries(),
		array( array( 'at' => 123, 'actor' => 'racer', 'action' => 'concurrent_action', 'object' => 'o', 'summary' => 's' ) )
	)
);
$al11->record( 'second_action', 'obj2', 'sum2' );
$actions11 = array_map(
	static function ( array $e ): string {
		return (string) $e['action'];
	},
	$al11->entries()
);
iwsl_assert( in_array( 'concurrent_action', $actions11, true ), 'record re-read: the concurrently-written entry survives' );
iwsl_assert( in_array( 'second_action', $actions11, true ), 'record re-read: the new entry is stored' );
iwsl_assert_same( 3, count( $actions11 ), 'record re-read: all three entries present (audit trail intact)' );
