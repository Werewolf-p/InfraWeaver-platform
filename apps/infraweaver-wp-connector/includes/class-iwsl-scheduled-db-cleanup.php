<?php
/**
 * Generic engine behind the gated "Scheduled Database Cleanup" feature.
 *
 * This is the payload behind the `scheduled_db_cleanup` entitlement (tier Pro).
 * It does NOT re-implement any cleaning: it WRAPS the existing IWSL_DB_Optimizer
 * (constructed with the same entitlements gate) and drives its `run('run')` on a
 * WP-Cron schedule. Everything destructive still lives inside IWSL_DB_Optimizer
 * and its cleaners — the per-DELETE MAX_ROWS cap, the run lock, the core-table
 * allow-list, the "never DROP/TRUNCATE/ALTER" rule. This class only owns
 * scheduling, the gate for the scheduling surface, and a "last run" record.
 *
 * TWO FLAGS. Scheduling is gated on `scheduled_db_cleanup`; the wrapped optimizer
 * independently gates its own work on `db_optimization`. Both are Pro-tier flags
 * the console grants together, so a Pro site gets a working schedule; if only the
 * schedule flag is present the cron fires but the optimizer no-ops (its own gate),
 * and the run is still recorded (as a locked run) for the admin to see.
 *
 * TRUST MODEL. Console-authoritative, like every other Plus feature: both flags
 * are written ONLY by the dual-signed `entitlements.set` runner (§7). There is no
 * self-set path. The gate is re-checked at three layers (admin page, admin-post
 * handlers, and here as STATEMENT 1 of save_settings(), run_now() and the cron
 * callback run_scheduled()). The cron callback's check is authoritative AND
 * self-healing: a locked site's stray scheduled event is a no-op that unschedules
 * itself, so revoking the flag removes the automation with no admin action.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network. Only fixed
 * hook/schedule identifiers ever reach the WP-Cron API; no user input is scheduled.
 * WordPress calls are function_exists-guarded so the engine runs under the
 * zero-dependency test harness with an injected store, optimizer and clock.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Scheduled_DB_Cleanup {

	/** The entitlement flag the SCHEDULING surface gates on. */
	const FEATURE = 'scheduled_db_cleanup';

	/** admin-post action + nonce for the schedule settings save. */
	const SAVE_ACTION = 'iwsl_sdc_save';
	const SAVE_NONCE  = 'iwsl_sdc_save';

	/** admin-post action + nonce for the manual "Run now" button. */
	const RUN_ACTION = 'iwsl_sdc_run';
	const RUN_NONCE  = 'iwsl_sdc_run';

	/** The WP-Cron hook the recurring event fires. */
	const CRON_HOOK = 'iwsl_scheduled_db_cleanup';

	/** Custom cron schedule slug for the weekly cadence (core only guarantees daily). */
	const SCHEDULE_WEEKLY = 'iwsl_weekly';

	/** Seconds in a week — the interval of the custom weekly schedule. */
	const WEEK_IN_SECONDS = 604800;

	/** Delay before the first scheduled run so it never fires inside the save request. */
	const FIRST_RUN_DELAY = 300;

	/** Store key for the sanitized settings map (option `iwsl_scheduled_db_cleanup`). */
	const SETTINGS_KEY = 'scheduled_db_cleanup';

	/** Store key for the last-run record. */
	const LAST_RUN_KEY = 'scheduled_db_cleanup_last_run';

	/** Per-user PRG result transient prefix (append the user id). */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_sdc_result_';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings + last-run record live here. */
	private $store;

	/** @var IWSL_DB_Optimizer the wrapped, self-gated cleaner. */
	private $optimizer;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/**
	 * @param IWSL_Entitlements      $entitlements The gate (shared with the optimizer).
	 * @param IWSL_Store|null        $store        Settings + last-run persistence; defaults to the WP option store.
	 * @param IWSL_DB_Optimizer|null $optimizer    The wrapped optimizer; defaults to one over the same gate + global $wpdb.
	 * @param callable|null          $now_ms       Clock, mirrors IWSL_Entitlements.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?IWSL_Store $store = null,
		?IWSL_DB_Optimizer $optimizer = null,
		?callable $now_ms = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
		$this->optimizer    = null !== $optimizer ? $optimizer : new IWSL_DB_Optimizer( $entitlements );
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/**
	 * Register the custom schedule filter + the cron hook, then reconcile the
	 * scheduled event with the stored setting. Guarded so the harness can call it
	 * harmlessly. The filter is added BEFORE sync so wp_schedule_event can validate
	 * the custom weekly recurrence. Registered on EVERY request (front-end + cron):
	 * the cron callback re-checks the gate as its first act.
	 */
	public function register(): void {
		if ( function_exists( 'add_filter' ) ) {
			add_filter( 'cron_schedules', array( $this, 'filter_cron_schedules' ) );
		}
		if ( function_exists( 'add_action' ) ) {
			add_action( self::CRON_HOOK, array( $this, 'run_scheduled' ) );
		}
		$this->sync_schedule();
	}

	/**
	 * Add the custom weekly cron schedule. Immutable: returns a fresh/merged map,
	 * never mutates in place, and never clobbers an existing slug.
	 *
	 * @param mixed $schedules
	 * @return array
	 */
	public function filter_cron_schedules( $schedules ): array {
		$schedules = is_array( $schedules ) ? $schedules : array();
		if ( ! isset( $schedules[ self::SCHEDULE_WEEKLY ] ) ) {
			$schedules[ self::SCHEDULE_WEEKLY ] = array(
				'interval' => self::WEEK_IN_SECONDS,
				'display'  => 'Once weekly (InfraWeaver)',
			);
		}
		return $schedules;
	}

	// ── reads (safe on every render) ───────────────────────────────────────────

	/**
	 * The sanitized settings map, re-validated on every read. `saved_at` is
	 * preserved from the stored record.
	 *
	 * @return array{ enabled:bool, frequency:string, saved_at:int }
	 */
	public function settings(): array {
		$stored = $this->store->get( self::SETTINGS_KEY, array() );
		$stored = is_array( $stored ) ? $stored : array();
		$clean  = $this->sanitize_settings( $stored );
		$clean['saved_at'] = isset( $stored['saved_at'] ) ? (int) $stored['saved_at'] : 0;
		return $clean;
	}

	/** Whether the automated cleanup is switched on. */
	public function is_enabled(): bool {
		return ! empty( $this->settings()['enabled'] );
	}

	/**
	 * The last-run record, shape-validated on read, or null before any run.
	 *
	 * @return array{ at:int, ok:bool, mode:string, total:int, reason:string }|null
	 */
	public function last_run(): ?array {
		$stored = $this->store->get( self::LAST_RUN_KEY, null );
		if ( ! is_array( $stored ) ) {
			return null;
		}
		return array(
			'at'     => isset( $stored['at'] ) ? (int) $stored['at'] : 0,
			'ok'     => ! empty( $stored['ok'] ),
			'mode'   => isset( $stored['mode'] ) ? (string) $stored['mode'] : 'run',
			'total'  => isset( $stored['total'] ) ? (int) $stored['total'] : 0,
			'reason' => isset( $stored['reason'] ) ? (string) $stored['reason'] : '',
		);
	}

	/** The next scheduled run as a unix timestamp, or null when not scheduled. @return int|null */
	public function next_run(): ?int {
		if ( ! function_exists( 'wp_next_scheduled' ) ) {
			return null;
		}
		$ts = wp_next_scheduled( self::CRON_HOOK );
		return ( is_int( $ts ) && $ts > 0 ) ? $ts : null;
	}

	// ── mutator (STATEMENT 1 is the authoritative gate) ────────────────────────

	/**
	 * Persist a new schedule config. STATEMENT 1 is the authoritative entitlement
	 * gate — a locked site can neither enable nor change the cadence. After a valid
	 * write it reconciles the WP-Cron event with the new setting.
	 *
	 * @param array<string, mixed> $input Raw form input (unslashed by the caller).
	 * @return array{ ok:bool, reason?:string, settings?:array, gate?:array }
	 */
	public function save_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$clean             = $this->sanitize_settings( $input );
		$clean['saved_at'] = $this->now_seconds();
		$this->store->set( self::SETTINGS_KEY, $clean );

		$this->sync_schedule();

		return array( 'ok' => true, 'settings' => $clean );
	}

	// ── the effects (each re-checks the gate as STATEMENT 1) ───────────────────

	/**
	 * The WP-Cron callback. STATEMENT 1 is the authoritative gate: a locked site is
	 * a NO-OP that also unschedules itself, so revoking the flag tears the
	 * automation down with no admin action and the optimizer is never touched.
	 * Unlocked → delegate to the optimizer's bounded clean run and record it.
	 */
	public function run_scheduled(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->unschedule();
			return;
		}
		$summary = $this->optimizer->run( 'run' );
		$this->record_last_run( $summary );
	}

	/**
	 * Run the cleanup once, on demand (the admin "Run now" button). STATEMENT 1 is
	 * the gate; unlocked → the optimizer's clean run, recorded, and the summary is
	 * returned for the PRG notice.
	 *
	 * @return array Immutable run summary (or a locked refusal).
	 */
	public function run_now(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$summary = $this->optimizer->run( 'run' );
		$this->record_last_run( $summary );
		return $summary;
	}

	// ── scheduling reconciliation (all WordPress calls guarded) ────────────────

	/**
	 * Reconcile the WP-Cron event with the stored setting: schedule when enabled
	 * and not yet scheduled, re-schedule when the cadence changed, clear when
	 * disabled. Idempotent — safe to call on every request.
	 */
	public function sync_schedule(): void {
		if ( ! function_exists( 'wp_next_scheduled' ) || ! function_exists( 'wp_schedule_event' ) ) {
			return;
		}
		$settings   = $this->settings();
		$recurrence = $this->recurrence_for( (string) $settings['frequency'] );
		$next       = wp_next_scheduled( self::CRON_HOOK );

		if ( empty( $settings['enabled'] ) ) {
			if ( false !== $next ) {
				$this->unschedule();
			}
			return;
		}

		if ( false === $next ) {
			wp_schedule_event( $this->first_run_at(), $recurrence, self::CRON_HOOK );
			return;
		}

		if ( $this->current_recurrence() !== $recurrence ) {
			$this->unschedule();
			wp_schedule_event( $this->first_run_at(), $recurrence, self::CRON_HOOK );
		}
	}

	/** Map a stored frequency to a cron recurrence slug. */
	public function recurrence_for( string $frequency ): string {
		return ( 'weekly' === $frequency ) ? self::SCHEDULE_WEEKLY : 'daily';
	}

	/** The currently-scheduled recurrence for the hook, or '' when unknown/unscheduled. */
	private function current_recurrence(): string {
		if ( function_exists( 'wp_get_schedule' ) ) {
			$schedule = wp_get_schedule( self::CRON_HOOK );
			return is_string( $schedule ) ? $schedule : '';
		}
		return '';
	}

	/** Remove any scheduled event for the hook. */
	private function unschedule(): void {
		if ( function_exists( 'wp_clear_scheduled_hook' ) ) {
			wp_clear_scheduled_hook( self::CRON_HOOK );
		}
	}

	private function first_run_at(): int {
		return $this->now_seconds() + self::FIRST_RUN_DELAY;
	}

	// ── record builders / sanitizer ────────────────────────────────────────────

	/** Persist an immutable last-run record from a run summary. */
	private function record_last_run( array $summary ): void {
		$this->store->set(
			self::LAST_RUN_KEY,
			array(
				'at'     => $this->now_seconds(),
				'ok'     => ! empty( $summary['ok'] ),
				'mode'   => isset( $summary['mode'] ) ? (string) $summary['mode'] : 'run',
				'total'  => isset( $summary['total'] ) ? (int) $summary['total'] : 0,
				'reason' => isset( $summary['reason'] ) ? (string) $summary['reason'] : '',
			)
		);
	}

	/**
	 * Normalize a raw input map into the stored shape. Immutable: builds a fresh
	 * array. `frequency` is clamped to the allow-list (unknown → daily).
	 *
	 * @param array<string, mixed> $input
	 * @return array{ enabled:bool, frequency:string, saved_at:int }
	 */
	public function sanitize_settings( array $input ): array {
		$freq = isset( $input['frequency'] ) && is_string( $input['frequency'] ) ? $input['frequency'] : 'daily';
		return array(
			'enabled'   => ! empty( $input['enabled'] ),
			'frequency' => ( 'weekly' === $freq ) ? 'weekly' : 'daily',
			'saved_at'  => 0,
		);
	}

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}

	// ── admin surface (LAYER 1 UX + LAYER 2 handlers; wired by the main thread) ─

	/**
	 * Render the scheduled-cleanup admin section (LAYER 1 of the gate). Locked →
	 * reasons only, no controls. Unlocked → result notice + status (enabled / next
	 * run / last run) + the settings form + a manual "Run now" button. Guarded so
	 * it is harmless without WordPress.
	 */
	public function render_section(): void {
		if ( ! function_exists( 'esc_html__' ) || ! function_exists( 'admin_url' ) ) {
			return;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'Scheduled Database Cleanup', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Run the database cleanup automatically on a schedule — the same bounded, non-destructive cleaners as the manual tool, driven by WP-Cron. Revoking the entitlement removes the schedule on its next tick.', 'infraweaver-connector' ) . '</p>';

		if ( isset( $_GET['iwsl_sdc_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . esc_html__( 'The Scheduled Database Cleanup entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$this->render_result_notice();
		$this->render_status();
		$this->render_settings_form();
		$this->render_run_now_form();
	}

	/** Reason lines for a locked gate (no controls). */
	private function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The Scheduled Database Cleanup entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 Scheduled Database Cleanup is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			$total = (int) ( $result['total'] ?? 0 );
			$msg   = array_key_exists( 'total', $result )
				? sprintf( 'Cleanup ran — removed %d rows.', $total )
				: 'Schedule saved.';
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>' . esc_html( $msg ) . '</p></div>';
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>' . esc_html( sprintf( 'Action refused: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p></div>';
		}
	}

	/** The "enabled / next run / last run" status block. */
	private function render_status(): void {
		$on   = $this->is_enabled();
		$next = $this->next_run();
		$last = $this->last_run();
		$bg   = $on ? '#1a7f37' : '#8a6d3b';

		echo '<p style="margin-top:12px;"><span style="display:inline-block;padding:4px 12px;border-radius:999px;font-weight:650;color:#fff;background:' . esc_attr( $bg ) . ';">'
			. ( $on ? esc_html__( 'Scheduled cleanup is ON.', 'infraweaver-connector' ) : esc_html__( 'Scheduled cleanup is OFF.', 'infraweaver-connector' ) )
			. '</span></p>';

		echo '<table class="widefat striped" style="max-width:520px;margin-top:8px;"><tbody>';
		echo '<tr><th scope="row">' . esc_html__( 'Next run', 'infraweaver-connector' ) . '</th><td>' . esc_html( $this->format_ts( $next ) ) . '</td></tr>';
		if ( null !== $last ) {
			$when = $this->format_ts( $last['at'] > 0 ? $last['at'] : null );
			$what = $last['ok']
				? sprintf( 'Removed %d rows', (int) $last['total'] )
				: sprintf( 'Refused (%s)', (string) $last['reason'] );
			echo '<tr><th scope="row">' . esc_html__( 'Last run', 'infraweaver-connector' ) . '</th><td>' . esc_html( $when . ' — ' . $what ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	/** The nonce-protected schedule settings form (POST → admin-post.php). */
	private function render_settings_form(): void {
		$s    = $this->settings();
		$on   = ! empty( $s['enabled'] );
		$freq = isset( $s['frequency'] ) ? (string) $s['frequency'] : 'daily';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:16px;max-width:640px;">';
		wp_nonce_field( self::SAVE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::SAVE_ACTION ) . '">';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row">' . esc_html__( 'Automation', 'infraweaver-connector' ) . '</th><td>';
		echo '<label><input type="checkbox" name="iwsl_sdc_enabled" value="1"' . checked( $on, true, false ) . '> ' . esc_html__( 'Run the database cleanup automatically', 'infraweaver-connector' ) . iwsl_field_help( 'Automatically tidy your database on a set schedule.' ) . '</label></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-sdc-frequency">' . esc_html__( 'Frequency', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'How often the automatic database cleanup runs.' ) . '</th><td>';
		echo '<select id="iwsl-sdc-frequency" name="iwsl_sdc_frequency">';
		echo '<option value="daily"' . selected( $freq, 'daily', false ) . '>' . esc_html__( 'Daily', 'infraweaver-connector' ) . '</option>';
		echo '<option value="weekly"' . selected( $freq, 'weekly', false ) . '>' . esc_html__( 'Weekly', 'infraweaver-connector' ) . '</option>';
		echo '</select></td></tr>';

		echo '</tbody></table>';
		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Save schedule', 'infraweaver-connector' ) . '</button></p>';
		echo '</form>';
	}

	/** The nonce-protected manual "Run now" form (POST → admin-post.php). */
	private function render_run_now_form(): void {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:8px;">';
		wp_nonce_field( self::RUN_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::RUN_ACTION ) . '">';
		echo '<button type="submit" class="button">' . esc_html__( 'Run cleanup now', 'infraweaver-connector' ) . '</button>';
		echo '</form>';
	}

	/** Format a unix timestamp for display, or a dash when null. */
	private function format_ts( ?int $ts ): string {
		if ( null === $ts || $ts <= 0 ) {
			return '—';
		}
		if ( function_exists( 'wp_date' ) ) {
			return (string) wp_date( 'Y-m-d H:i', $ts );
		}
		return gmdate( 'Y-m-d H:i', $ts ) . ' UTC';
	}

	/**
	 * admin-post handler for the schedule settings save. LAYER 2 of the gate:
	 * capability + nonce, then re-check the entitlement before touching any stored
	 * setting, then save_settings() (LAYER 3 inside). POST-redirect-GET.
	 */
	public function handle_save(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::SAVE_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_sdc_locked', '1', $redirect ) );
			exit;
		}

		$input = array(
			'enabled'   => isset( $_POST['iwsl_sdc_enabled'] ),
			'frequency' => isset( $_POST['iwsl_sdc_frequency'] ) ? sanitize_key( wp_unslash( $_POST['iwsl_sdc_frequency'] ) ) : 'daily',
		);

		$result = $this->save_settings( $input ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	/**
	 * admin-post handler for the manual "Run now" button. LAYER 2 of the gate:
	 * capability + nonce, then re-check the entitlement, then run_now() (LAYER 3
	 * inside, and the wrapped optimizer gates again on `db_optimization`).
	 * POST-redirect-GET.
	 */
	public function handle_run_now(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::RUN_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_sdc_locked', '1', $redirect ) );
			exit;
		}

		$result = $this->run_now(); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}
}
