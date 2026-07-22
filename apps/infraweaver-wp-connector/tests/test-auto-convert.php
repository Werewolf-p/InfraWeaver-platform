<?php
/**
 * Scheduled Auto-Convert (gate flag `auto_convert`, tier Ultimate): the trigger
 * layer (IWSL_Auto_Convert) that wraps the already-gated IWSL_Media_Optimizer.
 *
 * Runs under the zero-dependency harness: an in-memory IWSL_Store, a fixed clock,
 * stubbed WP-Cron functions (backed by a single global so scheduling is
 * observable), and a RECORDING CONVERSION RUNNER injected as the conversion seam —
 * so NO real optimizer or image engine is exercised. This proves the trigger logic
 * in isolation: the gate blocks conversion + unschedules cron when locked, an
 * upload fires exactly one bounded conversion when enabled, settings persist, the
 * cron sweep + manual backlog run bounded auto-batches, and revocation is instant.
 */

// ── stubbed WP-Cron surface (guarded; backed by one global) ───────────────────

$GLOBALS['iwsl_ac_cron'] = false; // false = not scheduled, or an int timestamp.

if ( ! function_exists( 'wp_next_scheduled' ) ) {
	function wp_next_scheduled( $hook, $args = array() ) {
		return $GLOBALS['iwsl_ac_cron'];
	}
}
if ( ! function_exists( 'wp_schedule_event' ) ) {
	function wp_schedule_event( $timestamp, $recurrence, $hook, $args = array() ) {
		$GLOBALS['iwsl_ac_cron'] = (int) $timestamp > 0 ? (int) $timestamp : 1;
		return true;
	}
}
if ( ! function_exists( 'wp_clear_scheduled_hook' ) ) {
	function wp_clear_scheduled_hook( $hook, $args = array() ) {
		$GLOBALS['iwsl_ac_cron'] = false;
		return 0;
	}
}

// ── recording conversion runner (the injected seam) ───────────────────────────

/** Records every conversion request and returns a canned summary. */
final class IWSL_AC_Recording_Runner {

	/** @var array<int, array{ ids:int[], mode:string, rewrite:bool, limit:int }> */
	public $calls = array();

	/** @var int converted count reported back to the engine. */
	public $converted = 1;

	public function __invoke( array $ids, string $mode, bool $rewrite, int $limit ): array {
		$this->calls[] = array(
			'ids'     => $ids,
			'mode'    => $mode,
			'rewrite' => $rewrite,
			'limit'   => $limit,
		);
		return array( 'ok' => true, 'converted' => $this->converted );
	}
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** An entitlement gate at a chosen state / heartbeat-age / flag set, on a fixed clock. */
function iwsl_ac_entitlements( int $now, string $state, int $verified_age_ms, array $flags ): IWSL_Entitlements {
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

/** Unlocked gate: active + fresh heartbeat + auto_convert flag. */
function iwsl_ac_unlocked( int $now ): IWSL_Entitlements {
	return iwsl_ac_entitlements( $now, 'active', 60000, array( 'plus' => true, 'auto_convert' => true ) );
}

/** Build an auto-convert engine over $store with the injected gate + conversion runner. */
function iwsl_ac_engine( IWSL_Store $store, int $now, IWSL_Entitlements $ent, IWSL_AC_Recording_Runner $runner ): IWSL_Auto_Convert {
	return new IWSL_Auto_Convert(
		$ent,
		$store,
		static function () use ( $now ): int {
			return $now;
		},
		null,
		$runner
	);
}

/** A settings map. */
function iwsl_ac_settings( bool $enabled, string $mode = 'copy', bool $rewrite = false ): array {
	return array( 'enabled' => $enabled, 'mode' => $mode, 'rewrite' => $rewrite );
}

$AC_NOW = 20000000;

// ── 1. Gate blocks: no conversion + register unschedules the cron ─────────────

// (a) auto_convert flag ABSENT.
$GLOBALS['iwsl_ac_cron'] = 12345; // pretend a stale event is scheduled.
$store1a = new IWSL_Memory_Store();
$store1a->set( 'auto_convert', iwsl_ac_settings( true ) );
$run1a = new IWSL_AC_Recording_Runner();
$ac1a  = iwsl_ac_engine( $store1a, $AC_NOW, iwsl_ac_entitlements( $AC_NOW, 'active', 60000, array( 'plus' => true ) ), $run1a );
$ac1a->register();
iwsl_assert_same( false, $GLOBALS['iwsl_ac_cron'], 'gate blocks (absent flag): register() unschedules the cron' );
$ac1a->on_add_attachment( 101 );
iwsl_assert_same( 0, count( $run1a->calls ), 'gate blocks (absent flag): an upload triggers NO conversion' );

// (b) state != active, even WITH the flag true.
$GLOBALS['iwsl_ac_cron'] = 999;
$store1b = new IWSL_Memory_Store();
$store1b->set( 'auto_convert', iwsl_ac_settings( true ) );
$run1b = new IWSL_AC_Recording_Runner();
$ac1b  = iwsl_ac_engine( $store1b, $AC_NOW, iwsl_ac_entitlements( $AC_NOW, 'pending', 60000, array( 'auto_convert' => true ) ), $run1b );
$ac1b->register();
iwsl_assert_same( false, $GLOBALS['iwsl_ac_cron'], 'gate blocks (not active): register() unschedules despite the flag' );
$ac1b->on_add_attachment( 101 );
iwsl_assert_same( 0, count( $run1b->calls ), 'gate blocks (not active): no conversion despite the flag' );

// (c) stale heartbeat, even WITH the flag true.
$GLOBALS['iwsl_ac_cron'] = 777;
$store1c = new IWSL_Memory_Store();
$store1c->set( 'auto_convert', iwsl_ac_settings( true ) );
$run1c = new IWSL_AC_Recording_Runner();
$ac1c  = iwsl_ac_engine( $store1c, $AC_NOW, iwsl_ac_entitlements( $AC_NOW, 'active', 10800000, array( 'auto_convert' => true ) ), $run1c );
$ac1c->register();
iwsl_assert_same( false, $GLOBALS['iwsl_ac_cron'], 'gate blocks (stale heartbeat): register() unschedules despite the flag' );
$ac1c->on_add_attachment( 101 );
iwsl_assert_same( 0, count( $run1c->calls ), 'gate blocks (stale heartbeat): no conversion despite the flag' );

// ── 2. Unlocked + enabled: an upload fires exactly one bounded conversion ─────

$store2 = new IWSL_Memory_Store();
$store2->set( 'auto_convert', iwsl_ac_settings( true, 'copy', true ) );
$run2 = new IWSL_AC_Recording_Runner();
$ac2  = iwsl_ac_engine( $store2, $AC_NOW, iwsl_ac_unlocked( $AC_NOW ), $run2 );
$ac2->on_add_attachment( 101 );
iwsl_assert_same( 1, count( $run2->calls ), 'unlock+enabled: exactly one conversion per upload' );
iwsl_assert_same( array( 101 ), $run2->calls[0]['ids'], 'unlock+enabled: converts exactly the uploaded id' );
iwsl_assert_same( IWSL_Auto_Convert::UPLOAD_BATCH, $run2->calls[0]['limit'], 'unlock+enabled: upload batch bounded to UPLOAD_BATCH' );
iwsl_assert_same( 'copy', $run2->calls[0]['mode'], 'unlock+enabled: mode taken from settings' );
iwsl_assert_same( true, $run2->calls[0]['rewrite'], 'unlock+enabled: rewrite taken from settings (copy mode)' );

// An invalid attachment id is a no-op.
$ac2->on_add_attachment( 0 );
iwsl_assert_same( 1, count( $run2->calls ), 'unlock+enabled: a zero attachment id triggers nothing' );

// Replace mode forces rewrite off (mirrors the optimizer contract).
$store2->set( 'auto_convert', iwsl_ac_settings( true, 'replace', true ) );
$ac2->on_add_attachment( 102 );
$last2 = $run2->calls[ count( $run2->calls ) - 1 ];
iwsl_assert_same( 'replace', $last2['mode'], 'unlock+enabled: replace mode propagates' );
iwsl_assert_same( false, $last2['rewrite'], 'unlock+enabled: rewrite is forced off in replace mode' );

// ── 3. Unlocked + disabled: an upload converts nothing ────────────────────────

$store3 = new IWSL_Memory_Store();
$store3->set( 'auto_convert', iwsl_ac_settings( false ) );
$run3 = new IWSL_AC_Recording_Runner();
$ac3  = iwsl_ac_engine( $store3, $AC_NOW, iwsl_ac_unlocked( $AC_NOW ), $run3 );
$ac3->on_add_attachment( 101 );
iwsl_assert_same( 0, count( $run3->calls ), 'unlock+disabled: auto-conversion is off' );

// ── 4. Settings persist; save syncs the cron; a locked save writes nothing ────

$GLOBALS['iwsl_ac_cron'] = false;
$store4 = new IWSL_Memory_Store();
$ac4    = iwsl_ac_engine( $store4, $AC_NOW, iwsl_ac_unlocked( $AC_NOW ), new IWSL_AC_Recording_Runner() );
$r4     = $ac4->save_settings( array( 'enabled' => true, 'mode' => 'replace', 'rewrite' => true ) );
iwsl_assert_same( true, $r4['ok'], 'save: ok=true' );
$s4 = $ac4->settings();
iwsl_assert_same( true, $s4['enabled'], 'save: enabled persisted' );
iwsl_assert_same( 'replace', $s4['mode'], 'save: mode persisted' );
iwsl_assert_same( true, $s4['rewrite'], 'save: rewrite persisted' );
iwsl_assert( false !== $GLOBALS['iwsl_ac_cron'], 'save(enabled): cron scheduled' );

$ac4->save_settings( array( 'enabled' => false ) );
iwsl_assert_same( false, $GLOBALS['iwsl_ac_cron'], 'save(disabled): cron unscheduled' );
iwsl_assert_same( 'copy', $ac4->settings()['mode'], 'save: unknown/absent mode defaults to copy' );

$store4b = new IWSL_Memory_Store();
$ac4b    = iwsl_ac_engine( $store4b, $AC_NOW, iwsl_ac_entitlements( $AC_NOW, 'active', 60000, array() ), new IWSL_AC_Recording_Runner() );
$r4b     = $ac4b->save_settings( array( 'enabled' => true ) );
iwsl_assert_same( 'entitlement-locked', $r4b['reason'], 'locked save: entitlement-locked' );
iwsl_assert_same( null, $store4b->get( 'auto_convert' ), 'locked save: settings NEVER written' );

// ── 5. register() schedules when enabled, unschedules when disabled ───────────

$GLOBALS['iwsl_ac_cron'] = false;
$store5 = new IWSL_Memory_Store();
$store5->set( 'auto_convert', iwsl_ac_settings( true ) );
$ac5 = iwsl_ac_engine( $store5, $AC_NOW, iwsl_ac_unlocked( $AC_NOW ), new IWSL_AC_Recording_Runner() );
$ac5->register();
iwsl_assert( false !== $GLOBALS['iwsl_ac_cron'], 'register(enabled): schedules the sweep' );
$store5->set( 'auto_convert', iwsl_ac_settings( false ) );
$ac5->register();
iwsl_assert_same( false, $GLOBALS['iwsl_ac_cron'], 'register(disabled): tears the schedule down' );

// ── 6. Cron sweep converts a bounded auto-selected batch ──────────────────────

$store6 = new IWSL_Memory_Store();
$store6->set( 'auto_convert', iwsl_ac_settings( true ) );
$run6 = new IWSL_AC_Recording_Runner();
$ac6  = iwsl_ac_engine( $store6, $AC_NOW, iwsl_ac_unlocked( $AC_NOW ), $run6 );
$ac6->run_cron_sweep();
iwsl_assert_same( 1, count( $run6->calls ), 'cron sweep: one conversion pass' );
iwsl_assert_same( array(), $run6->calls[0]['ids'], 'cron sweep: auto-selects the backlog (empty id list)' );
iwsl_assert_same( IWSL_Auto_Convert::SWEEP_BATCH, $run6->calls[0]['limit'], 'cron sweep: bounded to SWEEP_BATCH' );
$lr6 = $ac6->last_run();
iwsl_assert_same( 'cron', $lr6['source'], 'cron sweep: last-run source recorded' );
iwsl_assert_same( 1, $lr6['converted'], 'cron sweep: converted count recorded' );

// A locked cron sweep converts nothing and self-unschedules.
$GLOBALS['iwsl_ac_cron'] = 555;
$run6b = new IWSL_AC_Recording_Runner();
$ac6b  = iwsl_ac_engine( new IWSL_Memory_Store(), $AC_NOW, iwsl_ac_entitlements( $AC_NOW, 'active', 60000, array() ), $run6b );
$ac6b->run_cron_sweep();
iwsl_assert_same( 0, count( $run6b->calls ), 'locked cron sweep: no conversion' );
iwsl_assert_same( false, $GLOBALS['iwsl_ac_cron'], 'locked cron sweep: self-unschedules' );

// ── 7. Manual backlog runs a bounded auto-batch; locked backlog refused ───────

$store7 = new IWSL_Memory_Store();
$store7->set( 'auto_convert', iwsl_ac_settings( false ) ); // manual works even while auto is off.
$run7 = new IWSL_AC_Recording_Runner();
$ac7  = iwsl_ac_engine( $store7, $AC_NOW, iwsl_ac_unlocked( $AC_NOW ), $run7 );
$r7   = $ac7->convert_backlog();
iwsl_assert_same( true, $r7['ok'], 'backlog: ok=true' );
iwsl_assert_same( 1, count( $run7->calls ), 'backlog: one conversion pass' );
iwsl_assert_same( array(), $run7->calls[0]['ids'], 'backlog: auto-selects the backlog' );
iwsl_assert_same( IWSL_Auto_Convert::BACKLOG_BATCH, $run7->calls[0]['limit'], 'backlog: bounded to BACKLOG_BATCH' );

$run7b = new IWSL_AC_Recording_Runner();
$ac7b  = iwsl_ac_engine( new IWSL_Memory_Store(), $AC_NOW, iwsl_ac_entitlements( $AC_NOW, 'active', 60000, array() ), $run7b );
$r7b   = $ac7b->convert_backlog();
iwsl_assert_same( 'entitlement-locked', $r7b['reason'], 'locked backlog: entitlement-locked' );
iwsl_assert_same( 0, count( $run7b->calls ), 'locked backlog: no conversion' );

// ── 8. Revocation is instant (register unschedules; upload no-ops) ────────────

$GLOBALS['iwsl_ac_cron'] = false;
$store8 = new IWSL_Memory_Store();
$store8->set( 'auto_convert', iwsl_ac_settings( true ) );
$run8 = new IWSL_AC_Recording_Runner();
$ac8  = iwsl_ac_engine( $store8, $AC_NOW, iwsl_ac_unlocked( $AC_NOW ), $run8 );
$ac8->register();
$ac8->on_add_attachment( 101 );
iwsl_assert_same( 1, count( $run8->calls ), 'revocation: unlocked upload converts' );
iwsl_assert( false !== $GLOBALS['iwsl_ac_cron'], 'revocation: scheduled while unlocked + enabled' );

$run8b       = new IWSL_AC_Recording_Runner();
$ac8_revoked = iwsl_ac_engine( $store8, $AC_NOW, iwsl_ac_entitlements( $AC_NOW, 'active', 60000, array() ), $run8b );
$ac8_revoked->register();
iwsl_assert_same( false, $GLOBALS['iwsl_ac_cron'], 'revocation: register() unschedules the moment the flag is revoked' );
$ac8_revoked->on_add_attachment( 102 );
iwsl_assert_same( 0, count( $run8b->calls ), 'revocation: an upload after revoke is a no-op' );

// ── 9. Render: unlocked shows the settings form; locked shows the notice ──────

$store9 = new IWSL_Memory_Store();
$store9->set( 'auto_convert', iwsl_ac_settings( true, 'replace', false ) );
$ac9 = iwsl_ac_engine( $store9, $AC_NOW, iwsl_ac_unlocked( $AC_NOW ), new IWSL_AC_Recording_Runner() );
ob_start();
$ac9->render_section();
$html9 = ob_get_clean();
iwsl_assert( false !== strpos( $html9, 'Scheduled Auto-Convert' ), 'render: heading present' );
iwsl_assert( false !== strpos( $html9, IWSL_Auto_Convert::ACTION_SAVE ), 'render: the save form is wired' );
iwsl_assert( false !== strpos( $html9, IWSL_Auto_Convert::ACTION_BACKLOG ), 'render: the backlog form is wired' );
iwsl_assert( false !== strpos( $html9, 'value="replace" selected' ), 'render: the current mode is reflected in the select' );

$ac9_locked = iwsl_ac_engine( new IWSL_Memory_Store(), $AC_NOW, iwsl_ac_entitlements( $AC_NOW, 'active', 60000, array() ), new IWSL_AC_Recording_Runner() );
ob_start();
$ac9_locked->render_section();
$html9b = ob_get_clean();
iwsl_assert( false !== strpos( $html9b, 'locked' ), 'render(locked): shows the locked notice' );
iwsl_assert( false !== strpos( $html9b, 'requires-plus' ), 'render(locked): lists the gate reason' );

// ── 10. purge(): teardown removes settings/last-run keys + the sweep cron ────

$GLOBALS['iwsl_ac_cron'] = false;
$store10 = new IWSL_Memory_Store();
$ac10    = iwsl_ac_engine( $store10, $AC_NOW, iwsl_ac_unlocked( $AC_NOW ), new IWSL_AC_Recording_Runner() );

// (a) cheap no-op when nothing exists: fresh store, no cron scheduled.
$pg10_clean = $ac10->purge();
iwsl_assert_same( 0, $pg10_clean['options'], 'purge(clean): options=0 (nothing stored)' );
iwsl_assert_same( 0, $pg10_clean['meta'], 'purge(clean): meta=0 (this engine writes no postmeta of its own)' );
iwsl_assert_same( false, $pg10_clean['cron'], 'purge(clean): cron=false (nothing was scheduled)' );

// (b) seed a real footprint: settings + last-run + a scheduled sweep.
$store10->set( IWSL_Auto_Convert::SETTINGS_KEY, iwsl_ac_settings( true, 'replace', true ) );
$store10->set( IWSL_Auto_Convert::LAST_RUN_KEY, array( 'at' => 123, 'converted' => 4, 'source' => 'cron' ) );
$GLOBALS['iwsl_ac_cron'] = 456;

$pg10 = $ac10->purge();
iwsl_assert_same( 2, $pg10['options'], 'purge: both settings + last-run keys removed' );
iwsl_assert_same( true, $pg10['cron'], 'purge: reports the sweep WAS scheduled' );
iwsl_assert_same( false, $GLOBALS['iwsl_ac_cron'], 'purge: sweep cron event cleared' );
iwsl_assert_same( null, $store10->get( IWSL_Auto_Convert::SETTINGS_KEY ), 'purge: settings key gone' );
iwsl_assert_same( null, $store10->get( IWSL_Auto_Convert::LAST_RUN_KEY ), 'purge: last-run key gone' );

// (c) idempotent: a second call finds nothing left, reports zeros/false.
$pg10b = $ac10->purge();
iwsl_assert_same( 0, $pg10b['options'], 'purge(idempotent): second call removes no keys' );
iwsl_assert_same( false, $pg10b['cron'], 'purge(idempotent): second call — nothing scheduled to clear' );

// This suite installs a stubbed cron surface backed by $GLOBALS['iwsl_ac_cron'];
// remove the global so it never leaks into a later suite.
unset( $GLOBALS['iwsl_ac_cron'] );
