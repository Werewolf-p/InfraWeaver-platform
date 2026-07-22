<?php
/**
 * Generic engine behind the gated "Scheduled Auto-Convert" feature.
 *
 * This is the payload behind the `auto_convert` entitlement (tier Ultimate). It
 * does NOT re-implement image conversion — it WRAPS the existing, already-gated
 * IWSL_Media_Optimizer, adding two triggers on top of it: (1) convert each NEW
 * upload to WebP as it lands (`add_attachment`), and (2) a bounded WP-Cron sweep
 * that chips away at the not-yet-converted backlog. Both feed a single conversion
 * seam so the whole thing is testable without an image engine.
 *
 * TRUST MODEL. Console-authoritative, like every Plus feature: the `auto_convert`
 * flag is written ONLY by the dual-signed `entitlements.set` runner (§7). There is
 * no self-set path. The gate is re-checked at four layers (admin page, admin-post
 * handlers, here as STATEMENT 1 of register()/save_settings()/convert_backlog()/
 * on_add_attachment()/run_cron_sweep(), AND — authoritatively — inside
 * IWSL_Media_Optimizer::run() itself). A locked site is a strict NO-OP: register()
 * unschedules the cron, so nothing fires, and any conversion that is somehow reached
 * is refused by the optimizer's own gate before a single file is touched.
 *
 * RESIDUAL RISK (honest statement). A site owner with direct database write access
 * can flip the local entitlement option; that is bounded by heartbeat staleness —
 * the gate (and the wrapped optimizer's gate) re-lock within HEARTBEAT_FRESH_MS (2h)
 * once the console stops managing the site.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network. Conversion
 * safety (originals never modified in copy mode, atomic temp+rename, keep-only-if-
 * smaller, the full pre-decode gauntlet, single-flight lock) all live in the wrapped
 * IWSL_Media_Optimizer and are inherited unchanged; every batch here is bounded
 * (single upload = 1 image; sweep / backlog capped). Cron is scheduled only while
 * unlocked AND enabled. WordPress calls are function_exists-guarded so the engine
 * runs under the zero-dependency test harness with an injected store, clock, and a
 * conversion-runner seam (so no real optimizer / image engine is needed to test it).
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Auto_Convert {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'auto_convert';

	/** Store key for the settings map (IWSL_WP_Store prefixes → iwsl_auto_convert). */
	const SETTINGS_KEY = 'auto_convert';
	/** Store key for the last-run record shown in the admin panel. */
	const LAST_RUN_KEY = 'auto_convert_last_run';

	/** The WP-Cron hook the periodic backlog sweep fires on. */
	const CRON_HOOK = 'iwsl_auto_convert_sweep';
	/** The recurrence for that cron event. */
	const CRON_SCHEDULE = 'hourly';

	/** Images converted per single upload (bounded — one attachment). */
	const UPLOAD_BATCH = 1;
	/** Images converted per periodic cron sweep (bounded backlog chunk). */
	const SWEEP_BATCH = 20;
	/** Images converted per manual "convert backlog now" click (bounded). */
	const BACKLOG_BATCH = 50;

	/** Conversion modes (mirror IWSL_Media_Optimizer). */
	const MODE_COPY = 'copy';
	const MODE_REPLACE = 'replace';

	/** admin-post actions + nonces. */
	const ACTION_SAVE = 'iwsl_auto_convert_save';
	const NONCE_SAVE = 'iwsl_auto_convert_save';
	const ACTION_BACKLOG = 'iwsl_auto_convert_backlog';
	const NONCE_BACKLOG = 'iwsl_auto_convert_backlog';

	/** Per-user result transient prefix (iwsl_auto_convert_result_<userid>). */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_auto_convert_result_';
	/** Result transient TTL (seconds). */
	const RESULT_TTL = 60;

	/** The Plus admin page slug the PRG redirect returns to. */
	const PAGE_SLUG = 'infraweaver-plus';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings + last-run live here. */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var IWSL_Media_Optimizer|null the wrapped optimizer (lazy default). */
	private $optimizer;

	/** @var callable fn(int[] $ids, string $mode, bool $rewrite, int $limit): array */
	private $convert_runner;

	/**
	 * @param IWSL_Entitlements       $entitlements   The gate (also the wrapped optimizer's gate).
	 * @param IWSL_Store              $store          Settings + last-run persistence.
	 * @param callable|null           $now_ms         Clock, mirrors IWSL_Entitlements.
	 * @param IWSL_Media_Optimizer|null $optimizer    The optimizer to wrap; built lazily from
	 *                                                $entitlements when null.
	 * @param callable|null           $convert_runner Conversion seam — fn(ids,mode,rewrite,limit):array.
	 *                                                Tests inject a recording runner so no real
	 *                                                optimizer / image engine is needed.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		IWSL_Store $store,
		?callable $now_ms = null,
		?IWSL_Media_Optimizer $optimizer = null,
		?callable $convert_runner = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = $store;
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		$this->optimizer      = $optimizer;
		$this->convert_runner = $convert_runner ?? function ( array $ids, string $mode, bool $rewrite, int $limit ): array {
			$optimizer = $this->optimizer instanceof IWSL_Media_Optimizer
				? $this->optimizer
				: new IWSL_Media_Optimizer( $this->entitlements );
			return $optimizer->run( 'webp_lossless', $limit, $mode, false, 'auto', $ids, $rewrite );
		};
	}

	// ── reads (safe on every render) ───────────────────────────────────────────

	/**
	 * The normalized settings map. Defensive: unknown/tampered values collapse to the
	 * safe defaults (disabled, copy mode, no rewrite).
	 *
	 * @return array{ enabled:bool, mode:string, rewrite:bool }
	 */
	public function settings(): array {
		return self::normalize_settings( $this->store->get( self::SETTINGS_KEY, array() ) );
	}

	/** The last-run record, or an empty shape. @return array{ at:int, converted:int, source:string } */
	public function last_run(): array {
		$stored = $this->store->get( self::LAST_RUN_KEY, array() );
		if ( ! is_array( $stored ) ) {
			return array( 'at' => 0, 'converted' => 0, 'source' => '' );
		}
		return array(
			'at'        => isset( $stored['at'] ) ? (int) $stored['at'] : 0,
			'converted' => isset( $stored['converted'] ) ? (int) $stored['converted'] : 0,
			'source'    => isset( $stored['source'] ) && is_string( $stored['source'] ) ? $stored['source'] : '',
		);
	}

	/** The next scheduled cron time (unix seconds), or null. @return int|null */
	public function next_run() {
		if ( ! function_exists( 'wp_next_scheduled' ) ) {
			return null;
		}
		$ts = wp_next_scheduled( self::CRON_HOOK );
		return ( is_int( $ts ) && $ts > 0 ) ? $ts : null;
	}

	// ── registration (STATEMENT 1 is the gate; locked ⇒ unschedule + no-op) ────

	/**
	 * Register the upload hook + cron on EVERY request. STATEMENT 1 is the gate: a
	 * locked site unschedules its cron and returns — a strict no-op. When unlocked,
	 * the cron action is wired (its own handler re-gates); the upload hook + the
	 * scheduled event exist only while the feature is enabled, so toggling off (or
	 * revoking) cleanly tears the schedule down.
	 */
	public function register(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->unschedule_cron();
			return;
		}

		if ( function_exists( 'add_action' ) ) {
			add_action( self::CRON_HOOK, array( $this, 'run_cron_sweep' ) );
		}

		if ( ! empty( $this->settings()['enabled'] ) ) {
			if ( function_exists( 'add_action' ) ) {
				add_action( 'add_attachment', array( $this, 'on_add_attachment' ) );
			}
			$this->ensure_scheduled();
		} else {
			$this->unschedule_cron();
		}
	}

	// ── triggers (STATEMENT 1 is the gate) ─────────────────────────────────────

	/**
	 * `add_attachment`. STATEMENT 1 is the gate. When enabled, hands the single new
	 * attachment to the optimizer (bounded to one image). The optimizer re-validates
	 * the id server-side (real attachment + convertible MIME) and re-checks the gate,
	 * so a non-image or a revoked flag is a harmless no-op.
	 *
	 * @param mixed $attachment_id
	 */
	public function on_add_attachment( $attachment_id ): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) ) {
			return;
		}
		$id = (int) $attachment_id;
		if ( $id <= 0 ) {
			return;
		}
		$summary = $this->run_conversion( array( $id ), $settings, self::UPLOAD_BATCH );
		$this->remember_run( $summary, 'upload' );
	}

	/**
	 * The WP-Cron sweep callback. STATEMENT 1 is the gate: a revoked flag unschedules
	 * and returns. When enabled, converts a bounded auto-selected backlog chunk; when
	 * disabled, unschedules itself (self-healing if a stale event lingers).
	 */
	public function run_cron_sweep(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->unschedule_cron();
			return;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) ) {
			$this->unschedule_cron();
			return;
		}
		$summary = $this->run_conversion( array(), $settings, self::SWEEP_BATCH );
		$this->remember_run( $summary, 'cron' );
	}

	// ── mutators (STATEMENT 1 is the authoritative gate) ───────────────────────

	/**
	 * Persist a new settings map. STATEMENT 1 is the gate — a locked site cannot write
	 * settings. After storing, the cron schedule is synced to the new enabled state.
	 *
	 * @param array<string, mixed> $input Raw form input (unslashed by the caller).
	 * @return array{ ok:bool, reason?:string, settings?:array, gate?:array }
	 */
	public function save_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$clean = self::normalize_settings( $input );
		$this->store->set( self::SETTINGS_KEY, $clean );
		$this->sync_schedule( ! empty( $clean['enabled'] ) );
		return array( 'ok' => true, 'settings' => $clean );
	}

	/**
	 * Convert a bounded chunk of the existing backlog now (the manual button).
	 * STATEMENT 1 is the gate. Runs regardless of the enabled toggle — it is an
	 * explicit, one-shot, nonce-protected operator action.
	 *
	 * @return array{ ok:bool, reason?:string, converted?:int, summary?:array, gate?:array }
	 */
	public function convert_backlog(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$settings = $this->settings();
		$summary  = $this->run_conversion( array(), $settings, self::BACKLOG_BATCH );
		$this->remember_run( $summary, 'backlog' );
		return array(
			'ok'        => true,
			'converted' => isset( $summary['converted'] ) ? (int) $summary['converted'] : 0,
			'summary'   => $summary,
		);
	}

	// ── admin-post handlers (cap + nonce + gate, PRG) ──────────────────────────

	/** `admin_post_iwsl_auto_convert_save`. Cap + nonce + gate → save_settings → PRG. */
	public function handle_save(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			$this->deny();
			return;
		}
		if ( function_exists( 'check_admin_referer' ) ) {
			check_admin_referer( self::NONCE_SAVE );
		}
		$input  = array(
			'enabled' => ! empty( $_POST['enabled'] ),
			'mode'    => isset( $_POST['mode'] ) ? self::request_string( $_POST['mode'] ) : self::MODE_COPY,
			'rewrite' => ! empty( $_POST['rewrite'] ),
		);
		$result = $this->save_settings( $input );
		$this->store_result( $result );
		$this->redirect_back();
	}

	/** `admin_post_iwsl_auto_convert_backlog`. Cap + nonce + gate → convert_backlog → PRG. */
	public function handle_backlog(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			$this->deny();
			return;
		}
		if ( function_exists( 'check_admin_referer' ) ) {
			check_admin_referer( self::NONCE_BACKLOG );
		}
		$result = $this->convert_backlog();
		$this->store_result( $result );
		$this->redirect_back();
	}

	// ── render ──────────────────────────────────────────────────────────────────

	/**
	 * The admin section. Locked → a notice listing the gate reasons. Unlocked → the
	 * settings form (enable toggle, mode select, rewrite checkbox), the last-run /
	 * next-run display, and a gated "Convert existing backlog now" button.
	 */
	public function render_section(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$settings = $this->settings();
		$action_url = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : 'admin-post.php';

		echo '<div class="iwsl-auto-convert">';
		echo '<h2>' . self::esc_html_safe( 'Scheduled Auto-Convert' ) . '</h2>';

		// Primary: run the existing backlog now, with the run/queue-count meta.
		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">';
		$this->render_run_status();
		echo '</span>';
		$this->render_backlog_form( (string) $action_url );
		echo '</div>';

		// Advanced: the auto-convert schedule + mode/rewrite settings form.
		echo '<details class="iwsl-adv"><summary>' . self::esc_html_safe( 'Advanced settings' ) . '</summary><div class="iwsl-adv__body">';
		echo '<form method="post" action="' . self::esc_url_safe( (string) $action_url ) . '">';
		echo '<input type="hidden" name="action" value="' . self::esc_attr_safe( self::ACTION_SAVE ) . '" />';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::NONCE_SAVE );
		}
		echo '<p><label><input type="checkbox" name="enabled" value="1" ' . self::checked( ! empty( $settings['enabled'] ) ) . '/> ';
		echo self::esc_html_safe( 'Automatically convert new uploads to WebP' ) . iwsl_field_help( 'Turn each newly uploaded image into a faster WebP copy.' ) . '</label></p>';

		echo '<p><label>' . self::esc_html_safe( 'Mode' ) . iwsl_field_help( 'Choose whether to keep the original image or replace it.' ) . ' ';
		echo '<select name="mode">';
		echo '<option value="' . self::esc_attr_safe( self::MODE_COPY ) . '" ' . self::selected( self::MODE_COPY === $settings['mode'] ) . '>' . self::esc_html_safe( 'Copy (keep original)' ) . '</option>';
		echo '<option value="' . self::esc_attr_safe( self::MODE_REPLACE ) . '" ' . self::selected( self::MODE_REPLACE === $settings['mode'] ) . '>' . self::esc_html_safe( 'Replace (remove original)' ) . '</option>';
		echo '</select></label></p>';

		echo '<p><label><input type="checkbox" name="rewrite" value="1" ' . self::checked( ! empty( $settings['rewrite'] ) ) . '/> ';
		echo self::esc_html_safe( 'Rewrite page references to the WebP copy (copy mode only)' ) . iwsl_field_help( 'Point your pages at the new WebP copies automatically.' ) . '</label></p>';

		echo '<button type="submit" class="button button-primary">' . self::esc_html_safe( 'Save settings' ) . '</button>';
		echo '</form>';
		echo '</div></details>';

		echo '</div>';
	}

	/** Last-run / next-run summary line. */
	private function render_run_status(): void {
		$last = $this->last_run();
		$next = $this->next_run();

		echo '<p>';
		if ( $last['at'] > 0 ) {
			echo self::esc_html_safe(
				sprintf(
					'Last run: %s — %d converted (%s).',
					self::format_time( $last['at'] ),
					$last['converted'],
					'' !== $last['source'] ? $last['source'] : 'manual'
				)
			);
		} else {
			echo self::esc_html_safe( 'Last run: never.' );
		}
		echo ' ';
		echo self::esc_html_safe( null !== $next ? 'Next sweep: ' . self::format_time( $next ) . '.' : 'Next sweep: not scheduled.' );
		echo '</p>';
	}

	/** The gated "Convert existing backlog now" admin-post form. */
	private function render_backlog_form( string $action_url ): void {
		echo '<form method="post" action="' . self::esc_url_safe( $action_url ) . '">';
		echo '<input type="hidden" name="action" value="' . self::esc_attr_safe( self::ACTION_BACKLOG ) . '" />';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::NONCE_BACKLOG );
		}
		echo '<button type="submit" class="button button-secondary">' . self::esc_html_safe( 'Convert existing backlog now' ) . '</button>';
		echo '</form>';
	}

	/** The locked-state notice with the human gate reasons. */
	private function render_locked_notice( array $gate ): void {
		$reasons = isset( $gate['reasons'] ) && is_array( $gate['reasons'] ) ? $gate['reasons'] : array();
		echo '<div class="notice notice-warning"><p>';
		echo self::esc_html_safe( 'Scheduled Auto-Convert is locked.' );
		if ( array() !== $reasons ) {
			echo ' ' . self::esc_html_safe( 'Reasons: ' . implode( ', ', array_map( 'strval', $reasons ) ) );
		}
		echo '</p></div>';
	}

	// ── conversion + cron helpers ──────────────────────────────────────────────

	/**
	 * Invoke the conversion seam with the settings-derived mode/rewrite and a bounded
	 * limit. Rewrite only applies in copy mode (replace already repoints the canonical
	 * attachment), mirroring IWSL_Media_Optimizer::run().
	 *
	 * @param int[]                              $ids
	 * @param array{enabled:bool,mode:string,rewrite:bool} $settings
	 */
	private function run_conversion( array $ids, array $settings, int $limit ): array {
		$mode    = self::MODE_REPLACE === $settings['mode'] ? self::MODE_REPLACE : self::MODE_COPY;
		$rewrite = ! empty( $settings['rewrite'] ) && self::MODE_COPY === $mode;
		$limit   = max( 1, $limit );
		$summary = ( $this->convert_runner )( $ids, $mode, $rewrite, $limit );
		return is_array( $summary ) ? $summary : array();
	}

	/** Record a compact last-run summary for the admin panel. */
	private function remember_run( array $summary, string $source ): void {
		$this->store->set(
			self::LAST_RUN_KEY,
			array(
				'at'        => $this->now_seconds(),
				'converted' => isset( $summary['converted'] ) ? (int) $summary['converted'] : 0,
				'source'    => $source,
			)
		);
	}

	/** Sync the cron schedule to the desired enabled state. */
	private function sync_schedule( bool $enabled ): void {
		if ( $enabled ) {
			$this->ensure_scheduled();
		} else {
			$this->unschedule_cron();
		}
	}

	/** Schedule the recurring sweep if not already scheduled. */
	private function ensure_scheduled(): void {
		if ( ! function_exists( 'wp_next_scheduled' ) || ! function_exists( 'wp_schedule_event' ) ) {
			return;
		}
		if ( false === wp_next_scheduled( self::CRON_HOOK ) ) {
			$start = function_exists( 'time' ) ? time() : 0;
			wp_schedule_event( $start, self::CRON_SCHEDULE, self::CRON_HOOK );
		}
	}

	/** Remove any scheduled sweep event. */
	private function unschedule_cron(): void {
		if ( function_exists( 'wp_clear_scheduled_hook' ) ) {
			wp_clear_scheduled_hook( self::CRON_HOOK );
		}
	}

	/**
	 * Teardown: remove this feature's ENTIRE persistent footprint — its
	 * settings + last-run store keys and the scheduled backlog-sweep cron
	 * event. Idempotent (check-before-delete) and cheap when already clean: a
	 * second call finds nothing left and reports zeros/false. Scoped strictly
	 * to THIS trigger layer — never touches the wrapped IWSL_Media_Optimizer's
	 * own footprint (its purge() is independent, since image_optimization can
	 * stay enabled after auto_convert is disabled).
	 *
	 * @return array{ options:int, meta:int, cron:bool }
	 */
	public function purge(): array {
		$options = 0;
		foreach ( array( self::SETTINGS_KEY, self::LAST_RUN_KEY ) as $key ) {
			if ( null !== $this->store->get( $key, null ) ) {
				$this->store->delete( $key );
				++$options;
			}
		}

		$had_cron = null !== $this->next_run();
		if ( $had_cron ) {
			$this->unschedule_cron();
		}

		return array( 'options' => $options, 'meta' => 0, 'cron' => $had_cron );
	}

	// ── input / settings normalization ─────────────────────────────────────────

	/**
	 * Normalize a raw settings map (form input or stored value) into the canonical
	 * shape. Immutable; unknown mode collapses to copy; everything defaults safe.
	 *
	 * @param mixed $raw
	 * @return array{ enabled:bool, mode:string, rewrite:bool }
	 */
	private static function normalize_settings( $raw ): array {
		$raw  = is_array( $raw ) ? $raw : array();
		$mode = ( isset( $raw['mode'] ) && self::MODE_REPLACE === $raw['mode'] ) ? self::MODE_REPLACE : self::MODE_COPY;
		return array(
			'enabled' => ! empty( $raw['enabled'] ),
			'mode'    => $mode,
			'rewrite' => ! empty( $raw['rewrite'] ),
		);
	}

	/** Read a scalar request value as a trimmed string. */
	private static function request_string( $value ): string {
		if ( ! is_scalar( $value ) ) {
			return '';
		}
		$str = (string) $value;
		if ( function_exists( 'wp_unslash' ) ) {
			$str = (string) wp_unslash( $str );
		}
		return trim( $str );
	}

	// ── output helpers ─────────────────────────────────────────────────────────

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}

	private static function format_time( int $unix ): string {
		if ( $unix <= 0 ) {
			return '—';
		}
		if ( function_exists( 'wp_date' ) ) {
			$formatted = wp_date( 'Y-m-d H:i:s', $unix );
			if ( is_string( $formatted ) && '' !== $formatted ) {
				return $formatted;
			}
		}
		return gmdate( 'Y-m-d H:i:s', $unix );
	}

	private static function checked( bool $on ): string {
		return $on ? 'checked="checked" ' : '';
	}

	private static function selected( bool $on ): string {
		return $on ? 'selected="selected"' : '';
	}

	/** Per-user result transient key. */
	private function result_transient_key(): string {
		$uid = function_exists( 'get_current_user_id' ) ? (int) get_current_user_id() : 0;
		return self::RESULT_TRANSIENT_PREFIX . $uid;
	}

	private function store_result( array $result ): void {
		if ( function_exists( 'set_transient' ) ) {
			set_transient( $this->result_transient_key(), $result, self::RESULT_TTL );
		}
	}

	private function deny(): void {
		if ( function_exists( 'wp_die' ) ) {
			wp_die( self::esc_html_safe( 'Insufficient permissions.' ) );
		}
	}

	/** PRG redirect back to the Plus admin page, then stop. */
	private function redirect_back(): void {
		$url = 'admin.php?page=' . self::PAGE_SLUG;
		if ( function_exists( 'admin_url' ) ) {
			$url = admin_url( $url );
		}
		if ( function_exists( 'wp_safe_redirect' ) ) {
			wp_safe_redirect( $url );
		}
		exit;
	}

	private static function esc_html_safe( string $value ): string {
		return function_exists( 'esc_html' ) ? esc_html( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_attr_safe( string $value ): string {
		return function_exists( 'esc_attr' ) ? esc_attr( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_url_safe( string $value ): string {
		return function_exists( 'esc_url' ) ? esc_url( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}
