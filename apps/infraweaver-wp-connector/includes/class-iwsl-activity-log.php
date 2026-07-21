<?php
/**
 * Generic engine behind the gated "Activity Log" feature.
 *
 * This is the payload behind the `activity_log` entitlement (tier Ultimate), kept
 * separate from the gate (IWSL_Entitlements) and from the store so each can be
 * reasoned about — and tested — in isolation. It mirrors IWSL_White_Label /
 * IWSL_Redirects exactly: a bounded ring buffer of records, an immutable append,
 * injectable dependencies, and a purely-local admin surface with no self-set,
 * REST, AJAX, cron or nopriv path.
 *
 * TRUST MODEL. Console-authoritative, like every other Plus feature: the
 * `activity_log` flag is written ONLY by the dual-signed `entitlements.set` runner
 * (§7). There is deliberately no self-set path here — this class is a handful of
 * passive read-only admin-event hooks plus one local "clear" admin action. The
 * gate is re-checked at three layers (admin page, admin-post handler, and here as
 * STATEMENT 1 of every event callback, record() and clear()). The innermost checks
 * are authoritative: they survive any future caller that forgets the outer two, so
 * revoking the flag from the console instantly stops all logging.
 *
 * RESIDUAL RISK (honest statement). A site owner with direct database write access
 * can flip the local entitlement option and unlock this without the console —
 * exactly the accepted threat model of the existing `plus` gate. That is bounded by
 * heartbeat staleness: the gate re-locks within HEARTBEAT_FRESH_MS (2h) once the
 * console stops managing the site.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network. Records are
 * METADATA ONLY: an action name, the acting user's login (or id), a short object
 * label and a summary — never a password, secret, option value or request body.
 * Every field is control-stripped and length-capped before storage; the log is a
 * bounded FIFO ring (MAX_ENTRIES) so it can never grow without limit. The render
 * surface escapes every dynamic fragment it emits. WordPress calls are
 * function_exists-guarded so the engine runs under the zero-dependency test harness
 * with an injected store + clock.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Activity_Log {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'activity_log';

	/** Store key for the log ring buffer (IWSL_WP_Store prefixes → iwsl_activity_log). */
	const LOG_KEY = 'activity_log';

	/** Hard FIFO cap on stored entries — bounds option size / per-request cost. */
	const MAX_ENTRIES = 500;
	/** Rows shown in the admin table (most recent first). */
	const MAX_DISPLAY = 100;
	/** Byte ceiling on a single stored text field (object / summary). */
	const MAX_FIELD_LEN = 200;
	/** Byte ceiling on the action token / actor label. */
	const MAX_TOKEN_LEN = 64;

	/** admin-post action + nonce for the "Clear log" button. */
	const ACTION_CLEAR = 'iwsl_activity_log_clear';
	const NONCE_CLEAR = 'iwsl_activity_log_clear';

	/** Per-user result transient prefix (iwsl_activity_log_result_<userid>). */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_activity_log_result_';
	/** Result transient TTL (seconds). */
	const RESULT_TTL = 60;

	/** The Plus admin page slug the PRG redirect returns to. */
	const PAGE_SLUG = 'infraweaver-plus';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store the log lives here. */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store        $store        Log persistence.
	 * @param callable|null     $now_ms       Clock, mirrors IWSL_Entitlements.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		IWSL_Store $store,
		?callable $now_ms = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = $store;
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/**
	 * The small allow-list of options whose changes are worth a log entry. Kept tiny
	 * and low-frequency so `updated_option` (which fires for every option write) stays
	 * cheap — anything not on this list is ignored without a store read.
	 *
	 * @return string[]
	 */
	private static function watched_options(): array {
		return array(
			'blogname',
			'blogdescription',
			'siteurl',
			'home',
			'admin_email',
			'template',
			'stylesheet',
			'users_can_register',
			'default_role',
			'timezone_string',
			'start_of_week',
			'WPLANG',
			'permalink_structure',
		);
	}

	/**
	 * Register the passive admin-event hooks. Guarded so the harness can call it
	 * harmlessly. Registered on EVERY request because each callback re-checks the gate
	 * as its first act — a locked or revoked site records nothing instantly.
	 */
	public function register(): void {
		if ( ! function_exists( 'add_action' ) ) {
			return;
		}
		add_action( 'transition_post_status', array( $this, 'on_transition_post_status' ), 10, 3 );
		add_action( 'wp_login', array( $this, 'on_wp_login' ), 10, 2 );
		add_action( 'activated_plugin', array( $this, 'on_activated_plugin' ), 10, 2 );
		add_action( 'deactivated_plugin', array( $this, 'on_deactivated_plugin' ), 10, 2 );
		add_action( 'updated_option', array( $this, 'on_updated_option' ), 10, 3 );
	}

	// ── reads (safe on every render) ───────────────────────────────────────────

	/**
	 * The stored entries, each defensively re-validated in shape on read. A malformed
	 * entry is dropped, never mutated in place. Oldest first (chronological).
	 *
	 * @return array<int, array{ at:int, actor:string, action:string, object:string, summary:string }>
	 */
	public function entries(): array {
		$stored = $this->store->get( self::LOG_KEY, array() );
		if ( ! is_array( $stored ) ) {
			return array();
		}
		$out = array();
		foreach ( $stored as $entry ) {
			$valid = self::sanitize_entry_shape( $entry );
			if ( null !== $valid ) {
				$out[] = $valid;
			}
		}
		return $out;
	}

	// ── event callbacks (STATEMENT 1 is the authoritative gate) ────────────────

	/**
	 * `transition_post_status`. STATEMENT 1 is the gate. Logs only the meaningful
	 * publish/update/trash transitions of real content — draft/autosave/revision/
	 * inherit noise is skipped so the ring is not flooded.
	 *
	 * @param mixed $new_status
	 * @param mixed $old_status
	 * @param mixed $post       A WP_Post-like object.
	 */
	public function on_transition_post_status( $new_status, $old_status, $post ): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( ! is_object( $post ) ) {
			return;
		}
		$type = isset( $post->post_type ) ? (string) $post->post_type : '';
		if ( in_array( $type, array( 'revision', 'nav_menu_item', 'customize_changeset', 'oembed_cache' ), true ) ) {
			return;
		}
		$new = (string) $new_status;
		$old = (string) $old_status;
		if ( 'auto-draft' === $new || 'inherit' === $new ) {
			return;
		}

		if ( 'trash' === $new && 'trash' !== $old ) {
			$action = 'post_trashed';
		} elseif ( 'publish' === $new && 'publish' !== $old ) {
			$action = 'post_published';
		} elseif ( 'publish' === $new && 'publish' === $old ) {
			$action = 'post_updated';
		} else {
			return; // draft/pending/private churn is not logged (keep the ring small).
		}

		$title = isset( $post->post_title ) && is_string( $post->post_title ) && '' !== $post->post_title
			? $post->post_title
			: '(no title)';
		$id      = isset( $post->ID ) ? (int) $post->ID : 0;
		$summary = ( '' !== $type ? $type : 'post' ) . ' #' . $id;
		$this->record( $action, $title, $summary );
	}

	/**
	 * `wp_login`. STATEMENT 1 is the gate. The actor is the logging-in user's login
	 * (the hook's first argument), so this works even before the current user is set.
	 *
	 * @param mixed $user_login
	 * @param mixed $user       Optional WP_User (unused; login string is authoritative).
	 */
	public function on_wp_login( $user_login, $user = null ): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		$actor = self::clean_token( (string) $user_login, self::MAX_TOKEN_LEN );
		$this->record( 'user_login', '' !== $actor ? $actor : 'unknown', 'Signed in', $actor );
	}

	/**
	 * `activated_plugin`. STATEMENT 1 is the gate. Stores only the plugin slug.
	 *
	 * @param mixed $plugin
	 * @param mixed $network_wide
	 */
	public function on_activated_plugin( $plugin, $network_wide = false ): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		$this->record( 'plugin_activated', (string) $plugin, 'Plugin activated' );
	}

	/**
	 * `deactivated_plugin`. STATEMENT 1 is the gate. Stores only the plugin slug.
	 *
	 * @param mixed $plugin
	 * @param mixed $network_wide
	 */
	public function on_deactivated_plugin( $plugin, $network_wide = false ): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		$this->record( 'plugin_deactivated', (string) $plugin, 'Plugin deactivated' );
	}

	/**
	 * `updated_option`. STATEMENT 1 is the gate. Cheap by design: only options on the
	 * small watch-list are considered, and the VALUE is never stored — just the name
	 * and the fact that it changed (no secrets, no request bodies).
	 *
	 * @param mixed $option
	 * @param mixed $old_value
	 * @param mixed $value
	 */
	public function on_updated_option( $option, $old_value, $value ): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		$name = (string) $option;
		if ( ! in_array( $name, self::watched_options(), true ) ) {
			return;
		}
		if ( $old_value === $value ) {
			return; // no real change.
		}
		$this->record( 'option_updated', $name, 'Setting changed' );
	}

	// ── mutators (STATEMENT 1 is the authoritative gate) ───────────────────────

	/**
	 * Append one metadata record. STATEMENT 1 is the authoritative entitlement gate —
	 * nothing below it runs for a locked site, so a bypassed hook still cannot write.
	 * Every field is control-stripped and length-capped; the ring is FIFO-trimmed to
	 * MAX_ENTRIES (oldest dropped). Immutable: a fresh list is built and stored.
	 *
	 * @return array{ ok:bool, reason?:string, entries_count?:int, gate?:array }
	 */
	public function record( string $action, string $object, string $summary, ?string $actor = null ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$entry = array(
			'at'      => $this->now_seconds(),
			'actor'   => null !== $actor ? self::clean_token( $actor, self::MAX_TOKEN_LEN ) : $this->current_actor(),
			'action'  => self::clean_token( $action, self::MAX_TOKEN_LEN ),
			'object'  => self::clean_text( $object, self::MAX_FIELD_LEN ),
			'summary' => self::clean_text( $summary, self::MAX_FIELD_LEN ),
		);

		$next = array_merge( $this->entries(), array( $entry ) );
		if ( count( $next ) > self::MAX_ENTRIES ) {
			$next = array_slice( $next, -self::MAX_ENTRIES ); // FIFO: drop the oldest.
		}
		$this->store->set( self::LOG_KEY, $next );

		return array( 'ok' => true, 'entries_count' => count( $next ) );
	}

	/**
	 * Empty the log. STATEMENT 1 is the gate — a locked site cannot clear (or touch)
	 * the store at all, so the log survives a bypassed admin layer.
	 *
	 * @return array{ ok:bool, reason?:string, cleared?:bool, gate?:array }
	 */
	public function clear(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$this->store->set( self::LOG_KEY, array() );
		return array( 'ok' => true, 'cleared' => true );
	}

	// ── admin-post handler (cap + nonce + gate, PRG) ───────────────────────────

	/**
	 * `admin_post_iwsl_activity_log_clear`. Capability + nonce + gate, then the gated
	 * clear(), a per-user result transient, and a PRG redirect back to the Plus page.
	 */
	public function handle_clear(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			$this->deny();
			return;
		}
		if ( function_exists( 'check_admin_referer' ) ) {
			check_admin_referer( self::NONCE_CLEAR );
		}
		$result = $this->clear();
		$this->store_result( $result );
		$this->redirect_back();
	}

	// ── render ──────────────────────────────────────────────────────────────────

	/**
	 * The admin section. Locked → a notice listing the gate reasons. Unlocked → the
	 * read-only log table (most recent first, capped at MAX_DISPLAY) plus a gated
	 * "Clear log" button. Every dynamic fragment is escaped.
	 */
	public function render_section(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$rows = array_slice( array_reverse( $this->entries() ), 0, self::MAX_DISPLAY );

		echo '<div class="iwsl-activity-log">';
		echo '<h2>' . self::esc_html_safe( 'Activity Log' ) . '</h2>';

		if ( array() === $rows ) {
			echo '<p>' . self::esc_html_safe( 'No activity recorded yet.' ) . '</p>';
		} else {
			echo '<table class="widefat striped"><thead><tr>';
			echo '<th>' . self::esc_html_safe( 'When' ) . '</th>';
			echo '<th>' . self::esc_html_safe( 'Actor' ) . '</th>';
			echo '<th>' . self::esc_html_safe( 'Action' ) . '</th>';
			echo '<th>' . self::esc_html_safe( 'Object' ) . '</th>';
			echo '<th>' . self::esc_html_safe( 'Summary' ) . '</th>';
			echo '</tr></thead><tbody>';
			foreach ( $rows as $row ) {
				echo '<tr>';
				echo '<td>' . self::esc_html_safe( self::format_time( (int) $row['at'] ) ) . '</td>';
				echo '<td>' . self::esc_html_safe( (string) $row['actor'] ) . '</td>';
				echo '<td>' . self::esc_html_safe( (string) $row['action'] ) . '</td>';
				echo '<td>' . self::esc_html_safe( (string) $row['object'] ) . '</td>';
				echo '<td>' . self::esc_html_safe( (string) $row['summary'] ) . '</td>';
				echo '</tr>';
			}
			echo '</tbody></table>';
		}

		echo '<details class="iwsl-adv"><summary>' . self::esc_html_safe( 'Advanced settings' ) . '</summary><div class="iwsl-adv__body">';
		$this->render_clear_form();
		echo '</div></details>';
		echo '</div>';
	}

	/** The gated "Clear log" admin-post form. */
	private function render_clear_form(): void {
		$action_url = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : 'admin-post.php';
		echo '<form method="post" action="' . self::esc_url_safe( (string) $action_url ) . '">';
		echo '<input type="hidden" name="action" value="' . self::esc_attr_safe( self::ACTION_CLEAR ) . '" />';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::NONCE_CLEAR );
		}
		echo '<button type="submit" class="button button-secondary">' . self::esc_html_safe( 'Clear log' ) . '</button>';
		echo '</form>';
	}

	/** The locked-state notice with the human gate reasons. */
	private function render_locked_notice( array $gate ): void {
		$reasons = isset( $gate['reasons'] ) && is_array( $gate['reasons'] ) ? $gate['reasons'] : array();
		echo '<div class="notice notice-warning"><p>';
		echo self::esc_html_safe( 'Activity Log is locked.' );
		if ( array() !== $reasons ) {
			echo ' ' . self::esc_html_safe( 'Reasons: ' . implode( ', ', array_map( 'strval', $reasons ) ) );
		}
		echo '</p></div>';
	}

	// ── helpers ──────────────────────────────────────────────────────────────────

	/** Best-effort acting user label — login, else `#id`, else 'system'. No stub needed. */
	private function current_actor(): string {
		if ( function_exists( 'wp_get_current_user' ) ) {
			$user = wp_get_current_user();
			if ( is_object( $user ) ) {
				if ( ! empty( $user->user_login ) && is_string( $user->user_login ) ) {
					return self::clean_token( $user->user_login, self::MAX_TOKEN_LEN );
				}
				if ( ! empty( $user->ID ) ) {
					return '#' . (int) $user->ID;
				}
			}
		}
		return 'system';
	}

	/** Re-validate one stored entry's shape, returning a fresh normalized copy or null. */
	private static function sanitize_entry_shape( $entry ): ?array {
		if ( ! is_array( $entry ) ) {
			return null;
		}
		if ( ! isset( $entry['action'] ) || ! is_string( $entry['action'] ) ) {
			return null;
		}
		return array(
			'at'      => isset( $entry['at'] ) ? (int) $entry['at'] : 0,
			'actor'   => isset( $entry['actor'] ) && is_string( $entry['actor'] ) ? $entry['actor'] : 'system',
			'action'  => $entry['action'],
			'object'  => isset( $entry['object'] ) && is_string( $entry['object'] ) ? $entry['object'] : '',
			'summary' => isset( $entry['summary'] ) && is_string( $entry['summary'] ) ? $entry['summary'] : '',
		);
	}

	/**
	 * Normalize a free-text field: strip control characters (including CR/LF), trim,
	 * and hard-truncate to $max bytes. Kept plain — the renderer escapes at output.
	 */
	private static function clean_text( string $value, int $max ): string {
		$stripped = preg_replace( '/[\x00-\x1F\x7F]/', '', $value );
		$stripped = null === $stripped ? '' : trim( $stripped );
		if ( strlen( $stripped ) > $max ) {
			$stripped = substr( $stripped, 0, $max );
		}
		return $stripped;
	}

	/** A short token (action / actor): text-cleaned and capped. */
	private static function clean_token( string $value, int $max ): string {
		return self::clean_text( $value, $max );
	}

	/** A human timestamp; falls back to a raw ISO-ish string outside WordPress. */
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

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
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
