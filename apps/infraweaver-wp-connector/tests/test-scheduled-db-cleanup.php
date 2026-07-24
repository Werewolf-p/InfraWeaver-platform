<?php
/**
 * Scheduled Database Cleanup (gate flag `scheduled_db_cleanup`): the WP-Cron
 * scheduling wrapper around the existing IWSL_DB_Optimizer.
 *
 * Runs under the zero-dependency harness: the scheduler takes a shared in-memory
 * IWSL_Store, a REAL IWSL_DB_Optimizer built over a recording fake $wpdb (so we
 * can prove the optimizer actually runs — or is NEVER touched — through the
 * scheduler), and a fixed clock. The WP-Cron API (wp_next_scheduled /
 * wp_schedule_event / wp_clear_scheduled_hook / wp_get_schedule) is stubbed with
 * recording globals so scheduling calls can be asserted without WordPress.
 */

// ── recording fake $wpdb (minimal: records writes; returns canned scalars) ────

if ( ! class_exists( 'IWSL_SDC_Fake_WPDB' ) ) {
	final class IWSL_SDC_Fake_WPDB {

		public $prefix             = 'wp_';
		public $posts              = 'wp_posts';
		public $postmeta           = 'wp_postmeta';
		public $comments           = 'wp_comments';
		public $commentmeta        = 'wp_commentmeta';
		public $options            = 'wp_options';
		public $terms              = 'wp_terms';
		public $termmeta           = 'wp_termmeta';
		public $term_relationships = 'wp_term_relationships';
		public $term_taxonomy      = 'wp_term_taxonomy';
		public $users              = 'wp_users';
		public $usermeta           = 'wp_usermeta';
		public $links              = 'wp_links';

		/** @var string[] strings passed to query(). */
		public $writes = array();

		/** @var int */
		private $count_value;
		/** @var int */
		private $deleted_value;

		public function __construct( int $count = 0, int $deleted = 0 ) {
			$this->count_value   = $count;
			$this->deleted_value = $deleted;
		}

		public function esc_like( string $text ): string {
			return addcslashes( $text, '_%\\' );
		}

		public function prepare( string $query, ...$args ): string {
			return $query;
		}

		public function get_var( string $query ) {
			return (string) $this->count_value;
		}

		public function query( string $query ) {
			$this->writes[] = $query;
			return $this->deleted_value;
		}
	}
}

// ── recording WP-Cron stubs (record into globals; guarded) ────────────────────

$GLOBALS['iwsl_sdc_scheduled']  = array(); // list of [ timestamp, recurrence, hook ]
$GLOBALS['iwsl_sdc_cleared']    = 0;       // wp_clear_scheduled_hook call count
$GLOBALS['iwsl_sdc_next']       = false;   // what wp_next_scheduled returns
$GLOBALS['iwsl_sdc_sched_name'] = '';      // what wp_get_schedule returns ('' → false)

if ( ! function_exists( 'wp_next_scheduled' ) ) {
	function wp_next_scheduled( string $hook ) {
		return $GLOBALS['iwsl_sdc_next'] ?? false;
	}
}
if ( ! function_exists( 'wp_schedule_event' ) ) {
	function wp_schedule_event( int $timestamp, string $recurrence, string $hook ): bool {
		$GLOBALS['iwsl_sdc_scheduled'][] = array( $timestamp, $recurrence, $hook );
		$GLOBALS['iwsl_sdc_next']        = $timestamp;
		$GLOBALS['iwsl_sdc_sched_name']  = $recurrence;
		return true;
	}
}
if ( ! function_exists( 'wp_clear_scheduled_hook' ) ) {
	function wp_clear_scheduled_hook( string $hook ): int {
		$GLOBALS['iwsl_sdc_cleared']    = ( $GLOBALS['iwsl_sdc_cleared'] ?? 0 ) + 1;
		$GLOBALS['iwsl_sdc_next']       = false;
		$GLOBALS['iwsl_sdc_sched_name'] = '';
		return 1;
	}
}
if ( ! function_exists( 'wp_get_schedule' ) ) {
	function wp_get_schedule( string $hook ) {
		$name = $GLOBALS['iwsl_sdc_sched_name'] ?? '';
		return '' !== $name ? $name : false;
	}
}

/** Reset the recording cron globals to an unscheduled baseline. */
function iwsl_sdc_reset_cron(): void {
	$GLOBALS['iwsl_sdc_scheduled']  = array();
	$GLOBALS['iwsl_sdc_cleared']    = 0;
	$GLOBALS['iwsl_sdc_next']       = false;
	$GLOBALS['iwsl_sdc_sched_name'] = '';
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function iwsl_sdc_clock( int $now ): callable {
	return static function () use ( $now ): int {
		return $now;
	};
}

/** Unlocked gate: active + fresh heartbeat + BOTH scheduled_db_cleanup and db_optimization. */
function iwsl_sdc_unlocked_entitlements( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // fresh
	$store->set( 'entitlements', array( 'plus' => true, 'scheduled_db_cleanup' => true, 'db_optimization' => true ) );
	return new IWSL_Entitlements( $store, iwsl_sdc_clock( $now ) );
}

/** Locked gate: the scheduling flag is ABSENT (db_optimization present is irrelevant). */
function iwsl_sdc_locked_entitlements( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array( 'plus' => true, 'db_optimization' => true ) ); // scheduled_db_cleanup ABSENT
	return new IWSL_Entitlements( $store, iwsl_sdc_clock( $now ) );
}

$SDC_NOW = 50000000;

// Clear any leftover db-optimizer run lock from a prior suite's transient stub.
if ( isset( $GLOBALS['iwsl_mo_transients'] ) ) {
	$GLOBALS['iwsl_mo_transients'] = array();
}

// ── 1. Custom weekly schedule is registered (and never clobbers a slug) ───────

$store = new IWSL_Memory_Store();
$sdc   = new IWSL_Scheduled_DB_Cleanup( iwsl_sdc_unlocked_entitlements( $SDC_NOW ), $store, new IWSL_DB_Optimizer( iwsl_sdc_unlocked_entitlements( $SDC_NOW ), new IWSL_SDC_Fake_WPDB(), iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$schedules = $sdc->filter_cron_schedules( array( 'daily' => array( 'interval' => 86400, 'display' => 'Daily' ) ) );
iwsl_assert( isset( $schedules[ IWSL_Scheduled_DB_Cleanup::SCHEDULE_WEEKLY ] ), 'schedules: the custom weekly slug is added' );
iwsl_assert_same( IWSL_Scheduled_DB_Cleanup::WEEK_IN_SECONDS, $schedules[ IWSL_Scheduled_DB_Cleanup::SCHEDULE_WEEKLY ]['interval'], 'schedules: weekly interval is one week' );
iwsl_assert( isset( $schedules['daily'] ), 'schedules: existing slugs are preserved' );

// ── 2. Gate blocks: the cron callback is a NO-OP and unschedules itself ───────

iwsl_sdc_reset_cron();
$GLOBALS['iwsl_sdc_next'] = $SDC_NOW; // pretend a stray event is scheduled
$store = new IWSL_Memory_Store();
$fake2 = new IWSL_SDC_Fake_WPDB( 5, 4 );
$ent2  = iwsl_sdc_locked_entitlements( $SDC_NOW );
$opt2  = new IWSL_DB_Optimizer( $ent2, $fake2, iwsl_sdc_clock( $SDC_NOW ) );
$sdc2  = new IWSL_Scheduled_DB_Cleanup( $ent2, $store, $opt2, iwsl_sdc_clock( $SDC_NOW ) );
$sdc2->run_scheduled();
iwsl_assert_same( 0, count( $fake2->writes ), 'gate blocks (cron): optimizer NEVER touched (no writes)' );
iwsl_assert( $GLOBALS['iwsl_sdc_cleared'] >= 1, 'gate blocks (cron): a locked run unschedules itself' );
iwsl_assert_same( null, $store->get( IWSL_Scheduled_DB_Cleanup::LAST_RUN_KEY ), 'gate blocks (cron): no last-run recorded for a locked no-op' );

// ── 3. Gate blocks: run_now refuses without touching the database ─────────────

$store = new IWSL_Memory_Store();
$fake3 = new IWSL_SDC_Fake_WPDB( 5, 4 );
$ent3  = iwsl_sdc_locked_entitlements( $SDC_NOW );
$sdc3  = new IWSL_Scheduled_DB_Cleanup( $ent3, $store, new IWSL_DB_Optimizer( $ent3, $fake3, iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$r3    = $sdc3->run_now();
iwsl_assert_same( false, $r3['ok'], 'gate blocks (run now): ok=false' );
iwsl_assert_same( 'entitlement-locked', $r3['reason'], 'gate blocks (run now): entitlement-locked' );
iwsl_assert_same( 0, count( $fake3->writes ), 'gate blocks (run now): optimizer never touched' );

// ── 4. save_settings is gated: a locked site cannot enable a schedule ─────────

iwsl_sdc_reset_cron();
$store = new IWSL_Memory_Store();
$ent4  = iwsl_sdc_locked_entitlements( $SDC_NOW );
$sdc4  = new IWSL_Scheduled_DB_Cleanup( $ent4, $store, new IWSL_DB_Optimizer( $ent4, new IWSL_SDC_Fake_WPDB(), iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$r4    = $sdc4->save_settings( array( 'enabled' => true, 'frequency' => 'daily' ) );
iwsl_assert_same( false, $r4['ok'], 'locked save: ok=false' );
iwsl_assert_same( 'entitlement-locked', $r4['reason'], 'locked save: entitlement-locked' );
iwsl_assert_same( null, $store->get( IWSL_Scheduled_DB_Cleanup::SETTINGS_KEY ), 'locked save: settings untouched' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_sdc_scheduled'] ), 'locked save: nothing scheduled' );

// ── 5. Enabling (daily) schedules the event with the daily recurrence ─────────

iwsl_sdc_reset_cron();
$store = new IWSL_Memory_Store();
$ent5  = iwsl_sdc_unlocked_entitlements( $SDC_NOW );
$sdc5  = new IWSL_Scheduled_DB_Cleanup( $ent5, $store, new IWSL_DB_Optimizer( $ent5, new IWSL_SDC_Fake_WPDB(), iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$r5    = $sdc5->save_settings( array( 'enabled' => true, 'frequency' => 'daily' ) );
iwsl_assert_same( true, $r5['ok'], 'enable daily: saved (ok=true)' );
iwsl_assert_same( 1, count( $GLOBALS['iwsl_sdc_scheduled'] ), 'enable daily: exactly one wp_schedule_event call' );
iwsl_assert_same( 'daily', $GLOBALS['iwsl_sdc_scheduled'][0][1], 'enable daily: scheduled with the daily recurrence' );
iwsl_assert_same( IWSL_Scheduled_DB_Cleanup::CRON_HOOK, $GLOBALS['iwsl_sdc_scheduled'][0][2], 'enable daily: scheduled on the cron hook' );
iwsl_assert( $GLOBALS['iwsl_sdc_scheduled'][0][0] > $SDC_NOW / 1000, 'enable daily: first run is in the future' );

// ── 6. Enabling (weekly) uses the custom weekly recurrence ────────────────────

iwsl_sdc_reset_cron();
$store = new IWSL_Memory_Store();
$ent6  = iwsl_sdc_unlocked_entitlements( $SDC_NOW );
$sdc6  = new IWSL_Scheduled_DB_Cleanup( $ent6, $store, new IWSL_DB_Optimizer( $ent6, new IWSL_SDC_Fake_WPDB(), iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$sdc6->save_settings( array( 'enabled' => true, 'frequency' => 'weekly' ) );
iwsl_assert_same( IWSL_Scheduled_DB_Cleanup::SCHEDULE_WEEKLY, $GLOBALS['iwsl_sdc_scheduled'][0][1], 'enable weekly: scheduled with the custom weekly recurrence' );

// ── 7. Disabling clears the scheduled event ───────────────────────────────────

iwsl_sdc_reset_cron();
$GLOBALS['iwsl_sdc_next']       = $SDC_NOW; // an event exists
$GLOBALS['iwsl_sdc_sched_name'] = 'daily';
$store = new IWSL_Memory_Store();
$ent7  = iwsl_sdc_unlocked_entitlements( $SDC_NOW );
$sdc7  = new IWSL_Scheduled_DB_Cleanup( $ent7, $store, new IWSL_DB_Optimizer( $ent7, new IWSL_SDC_Fake_WPDB(), iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$sdc7->save_settings( array( 'enabled' => false, 'frequency' => 'daily' ) );
iwsl_assert( $GLOBALS['iwsl_sdc_cleared'] >= 1, 'disable: the scheduled event is cleared' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_sdc_scheduled'] ), 'disable: nothing re-scheduled' );

// ── 8. Unlocked cron run drives the optimizer and records the last run ────────

iwsl_sdc_reset_cron();
$store = new IWSL_Memory_Store();
$fake8 = new IWSL_SDC_Fake_WPDB( 5, 4 ); // 8 DELETE cleaners × 4 removed + 12 optimized tables = 44
$ent8  = iwsl_sdc_unlocked_entitlements( $SDC_NOW );
$sdc8  = new IWSL_Scheduled_DB_Cleanup( $ent8, $store, new IWSL_DB_Optimizer( $ent8, $fake8, iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$sdc8->run_scheduled();
iwsl_assert_same( 9, count( $fake8->writes ), 'cron run: optimizer issued 9 writes (8 DELETE + 1 OPTIMIZE)' );
$last8 = $sdc8->last_run();
iwsl_assert( is_array( $last8 ), 'cron run: a last-run record is stored' );
iwsl_assert_same( true, $last8['ok'], 'cron run: last run recorded ok' );
iwsl_assert_same( 44, $last8['total'], 'cron run: last run total = rows removed + tables optimized' );
iwsl_assert_same( (int) floor( $SDC_NOW / 1000 ), $last8['at'], 'cron run: last run stamped with the injected clock' );

// ── 9. run_now returns the summary AND records the last run ───────────────────

iwsl_sdc_reset_cron();
$store = new IWSL_Memory_Store();
$fake9 = new IWSL_SDC_Fake_WPDB( 5, 4 );
$ent9  = iwsl_sdc_unlocked_entitlements( $SDC_NOW );
$sdc9  = new IWSL_Scheduled_DB_Cleanup( $ent9, $store, new IWSL_DB_Optimizer( $ent9, $fake9, iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$r9    = $sdc9->run_now();
iwsl_assert_same( true, $r9['ok'], 'run now: ok=true' );
iwsl_assert_same( 'run', $r9['mode'], 'run now: mode=run' );
iwsl_assert_same( 44, $r9['total'], 'run now: total matches' );
iwsl_assert_same( 44, $sdc9->last_run()['total'], 'run now: last run recorded too' );

// ── 10. Settings sanitizer clamps the frequency allow-list ────────────────────

$store = new IWSL_Memory_Store();
$ent10 = iwsl_sdc_unlocked_entitlements( $SDC_NOW );
$sdc10 = new IWSL_Scheduled_DB_Cleanup( $ent10, $store, new IWSL_DB_Optimizer( $ent10, new IWSL_SDC_Fake_WPDB(), iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
iwsl_assert_same( 'daily', $sdc10->sanitize_settings( array( 'frequency' => 'hourly' ) )['frequency'], 'sanitize: unknown frequency clamps to daily' );
iwsl_assert_same( 'weekly', $sdc10->sanitize_settings( array( 'frequency' => 'weekly' ) )['frequency'], 'sanitize: weekly is accepted' );
iwsl_assert_same( false, $sdc10->sanitize_settings( array() )['enabled'], 'sanitize: enabled defaults to false' );
iwsl_assert_same( IWSL_Scheduled_DB_Cleanup::SCHEDULE_WEEKLY, $sdc10->recurrence_for( 'weekly' ), 'recurrence_for: weekly → custom slug' );
iwsl_assert_same( 'daily', $sdc10->recurrence_for( 'anything' ), 'recurrence_for: anything else → daily' );

// ── 11. purge(): teardown deletes BOTH option keys AND clears the cron event ──

// (a) A configured + scheduled site: purge() removes settings, last-run, and the event.
iwsl_sdc_reset_cron();
$store = new IWSL_Memory_Store();
$ent11 = iwsl_sdc_unlocked_entitlements( $SDC_NOW );
$sdc11 = new IWSL_Scheduled_DB_Cleanup( $ent11, $store, new IWSL_DB_Optimizer( $ent11, new IWSL_SDC_Fake_WPDB(), iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$sdc11->save_settings( array( 'enabled' => true, 'frequency' => 'daily' ) ); // writes settings + schedules the event
$sdc11->run_now();                                                            // writes a last-run record
iwsl_assert( is_array( $store->get( IWSL_Scheduled_DB_Cleanup::SETTINGS_KEY ) ), 'purge setup: settings present' );
iwsl_assert( is_array( $store->get( IWSL_Scheduled_DB_Cleanup::LAST_RUN_KEY ) ), 'purge setup: last-run present' );
iwsl_assert( false !== $GLOBALS['iwsl_sdc_next'], 'purge setup: an event is scheduled' );

$GLOBALS['iwsl_sdc_cleared'] = 0;
$p11 = $sdc11->purge();
iwsl_assert_same( true, $p11['ok'], 'purge: ok=true' );
iwsl_assert_same( true, $p11['settings_deleted'], 'purge: settings_deleted true (a map existed)' );
iwsl_assert_same( true, $p11['last_run_deleted'], 'purge: last_run_deleted true (a record existed)' );
iwsl_assert_same( true, $p11['cron_cleared'], 'purge: cron_cleared true (a scheduled event existed)' );
iwsl_assert( $GLOBALS['iwsl_sdc_cleared'] >= 1, 'purge: wp_clear_scheduled_hook called for the cron hook' );
iwsl_assert_same( null, $store->get( IWSL_Scheduled_DB_Cleanup::SETTINGS_KEY ), 'purge: settings option key deleted' );
iwsl_assert_same( null, $store->get( IWSL_Scheduled_DB_Cleanup::LAST_RUN_KEY ), 'purge: last-run option key deleted' );
iwsl_assert_same( null, $sdc11->last_run(), 'purge: a fresh last_run() read is null after purge' );
iwsl_assert_same( false, $sdc11->settings()['enabled'], 'purge: settings() falls back to defaults (disabled) after purge' );

// (b) idempotent + cheap-when-clean: a second purge finds nothing and does not touch WP-Cron.
$GLOBALS['iwsl_sdc_cleared'] = 0;
$p11b = $sdc11->purge();
iwsl_assert_same( true, $p11b['ok'], 'purge: second call still ok (idempotent)' );
iwsl_assert_same( false, $p11b['settings_deleted'], 'purge: second call reports no settings to delete' );
iwsl_assert_same( false, $p11b['last_run_deleted'], 'purge: second call reports no last-run to delete' );
iwsl_assert_same( false, $p11b['cron_cleared'], 'purge: second call clears no cron (cheap-when-clean)' );
iwsl_assert_same( 0, $GLOBALS['iwsl_sdc_cleared'], 'purge: no wp_clear_scheduled_hook call when already clean' );

// (c) a fresh, never-configured engine: purge() is a clean no-op.
iwsl_sdc_reset_cron();
$storeF = new IWSL_Memory_Store();
$entF   = iwsl_sdc_unlocked_entitlements( $SDC_NOW );
$sdcF   = new IWSL_Scheduled_DB_Cleanup( $entF, $storeF, new IWSL_DB_Optimizer( $entF, new IWSL_SDC_Fake_WPDB(), iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$pF     = $sdcF->purge();
iwsl_assert_same( false, $pF['settings_deleted'], 'purge (never configured): no settings existed' );
iwsl_assert_same( false, $pF['last_run_deleted'], 'purge (never configured): no last-run existed' );
iwsl_assert_same( false, $pF['cron_cleared'], 'purge (never configured): nothing scheduled to clear' );

// ── 12. Category subset: save sanitizes ids; run drives ONLY the saved subset ──

iwsl_sdc_reset_cron();
$store  = new IWSL_Memory_Store();
$fake12 = new IWSL_SDC_Fake_WPDB( 5, 4 );
$ent12  = iwsl_sdc_unlocked_entitlements( $SDC_NOW );
$sdc12  = new IWSL_Scheduled_DB_Cleanup( $ent12, $store, new IWSL_DB_Optimizer( $ent12, $fake12, iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$sdc12->save_settings(
	array(
		'enabled'    => true,
		'frequency'  => 'daily',
		'categories' => array( 'spam_comments', 'trashed_posts', 'evil_id; DROP TABLE wp_posts' ),
	)
);
$saved12 = $sdc12->settings();
iwsl_assert_same( array( 'spam_comments', 'trashed_posts' ), $saved12['categories'], 'subset: unknown/hostile category ids are dropped on save' );
$sdc12->run_scheduled();
iwsl_assert_same( 2, count( $fake12->writes ), 'subset: run_scheduled drives ONLY the saved categories (2 DELETEs, not all 9)' );

// An empty saved subset means ALL categories (the engine default).
iwsl_sdc_reset_cron();
$store13 = new IWSL_Memory_Store();
$fake13  = new IWSL_SDC_Fake_WPDB( 5, 4 );
$ent13   = iwsl_sdc_unlocked_entitlements( $SDC_NOW );
$sdc13   = new IWSL_Scheduled_DB_Cleanup( $ent13, $store13, new IWSL_DB_Optimizer( $ent13, $fake13, iwsl_sdc_clock( $SDC_NOW ) ), iwsl_sdc_clock( $SDC_NOW ) );
$sdc13->save_settings( array( 'enabled' => true, 'frequency' => 'daily', 'categories' => array() ) );
$sdc13->run_scheduled();
iwsl_assert_same( 9, count( $fake13->writes ), 'subset: an empty saved subset runs ALL categories (9 writes)' );

// ── clean up the recording globals so no suite that follows inherits them ─────

unset( $GLOBALS['iwsl_sdc_scheduled'], $GLOBALS['iwsl_sdc_cleared'], $GLOBALS['iwsl_sdc_next'], $GLOBALS['iwsl_sdc_sched_name'] );
