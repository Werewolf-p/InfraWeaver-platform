<?php
/**
 * Generic engine behind the gated "Site Statistics" feature — a privacy-respecting,
 * fully self-hosted analytics engine (our own WP-Statistics-style analytics).
 *
 * This is the payload behind the `statistics` entitlement (tier Ultimate), kept
 * separate from the gate (IWSL_Entitlements) and from the pure classifier /
 * aggregation math (IWSL_Stats_Classifier) so each can be reasoned about — and
 * tested — in isolation. It mirrors IWSL_DB_Optimizer's discipline for talking to
 * `$wpdb` (prepared statements, a hardcoded table identifier validated against the
 * prefix, a recording-fake $wpdb in the harness) and IWSL_Activity_Log's
 * purely-local admin surface (one gated admin-post action, per-user result
 * transient, PRG redirect).
 *
 * TRUST MODEL. Console-authoritative, like every other Plus feature: the
 * `statistics` flag is written ONLY by the dual-signed `entitlements.set` runner
 * (§7). There is deliberately NO self-set path, REST route, AJAX endpoint, cron, or
 * nopriv surface here — this is one passive front-end recording hook, one passive
 * comment hook, and one local "reset" admin action. The gate is re-checked at three
 * layers (admin page, admin-post handler, and here as STATEMENT 1 of maybe_record(),
 * on_comment(), prune(), reset() and render_section()). The innermost checks are
 * authoritative: a LOCKED site records NOTHING, the custom table is never created,
 * and no query is ever issued — the engine returns before the database handle is
 * touched.
 *
 * RESIDUAL RISK (honest statement). A site owner with direct database write access
 * can flip the local entitlement option and unlock this without the console —
 * exactly the accepted threat model of the existing `plus` gate, bounded by
 * heartbeat staleness (the gate re-locks within HEARTBEAT_FRESH_MS once the console
 * stops managing the site).
 *
 * PRIVACY & SAFETY. In-process only — no exec/shell_exec/proc_open, no network, no
 * external geo lookup. NO raw IP is ever read, stored, or hashed. Rows carry only
 * privacy-safe metadata (timestamp, path, referrer host, UA-derived browser/os/
 * device, coarse country, a daily anonymous visit bucket, a closed event-type
 * vocabulary and a bounded label). Retention is BOUNDED two ways — rows older than
 * RETENTION_DAYS are pruned and the table is capped to MAX_ROWS newest rows — so it
 * can never grow without limit. Every read/write uses $wpdb->prepare with a table
 * identifier that comes only from the $wpdb prefix (validated to a strict shape),
 * never from input; the recording insert binds every value as a placeholder. The
 * render surface escapes every dynamic fragment and hand-builds all charts as inline
 * SVG (no external JS/CSS/CDN). WordPress calls are function_exists-guarded so the
 * engine runs under the zero-dependency test harness with an injected store, a fake
 * $wpdb and a fixed clock.
 */

defined( 'ABSPATH' ) || exit;

// The render layer lives in its own file (kept under the size cap). Loading it here,
// guarded + idempotent, means every context that already requires this engine (the
// test harness top-requires and production) gets the view automatically — no other
// file needs to change.
if ( ! class_exists( 'IWSL_Statistics_View' ) ) {
	require_once __DIR__ . '/class-iwsl-statistics-view.php';
}

final class IWSL_Statistics {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'statistics';

	/** Custom table suffix (under $wpdb->prefix → e.g. wp_iwsl_stats_hits). */
	const TABLE_SUFFIX = 'iwsl_stats_hits';

	/** Schema version — bumped when the CREATE TABLE shape changes (drives dbDelta re-run). */
	const SCHEMA_VERSION = '1';

	/** Retention: prune rows older than this many days. */
	const RETENTION_DAYS = 90;
	/** Hard cap on total stored rows — the table is trimmed to the newest MAX_ROWS. */
	const MAX_ROWS = 100000;
	/** Minimum seconds between automatic prunes (throttled via a stored stamp). */
	const PRUNE_INTERVAL_S = 3600;

	/** Days of history read for the dashboard (30d window + its 30d comparison arm). */
	const AGG_WINDOW_DAYS = 60;
	/** Hard cap on rows read per dashboard render — bounds the read cost. */
	const MAX_READ_ROWS = 20000;

	/** Allowed KPI ranges (days) for the date switch. */
	const ALLOWED_RANGES = array( 1, 7, 30 );
	/** Default KPI range when none/invalid is requested. */
	const DEFAULT_RANGE = 7;
	/** GET parameter carrying the range switch. */
	const RANGE_PARAM = 'iwsl_stats_range';

	/** Store keys (IWSL_WP_Store prefixes → iwsl_stats_*). */
	const SCHEMA_KEY          = 'stats_schema_version';
	const SALT_KEY            = 'stats_salt';
	const LAST_PRUNE_KEY      = 'stats_last_prune';
	const EXCLUDE_LOGGED_KEY  = 'stats_exclude_logged_in';

	/** admin-post action + nonce for the "Reset statistics" button. */
	const RESET_ACTION = 'iwsl_stats_reset';
	const RESET_NONCE  = 'iwsl_stats_reset';

	/** Per-user result transient prefix (iwsl_stats_result_<userid>). */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_stats_result_';
	/** Result transient TTL (seconds). */
	const RESULT_TTL = 60;

	/** The Plus admin page slug the PRG redirect returns to. */
	const PAGE_SLUG = 'infraweaver-plus';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store salt / schema-version / prune-stamp / config live here. */
	private $store;

	/** @var object|null A `$wpdb`-like handle (prepare/query/get_results + prefix). */
	private $db;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var string Lowercased home host (for same-origin referrer folding), '' outside WP. */
	private $home_host;

	/** @var callable(array):array{active:bool,allows:?bool} visitor-consent context provider. */
	private $consent_ctx;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Salt/schema/config persistence; defaults to a WP store.
	 * @param object|null       $db           A `$wpdb`-like handle; defaults to the global $wpdb.
	 * @param callable|null     $now_ms       Clock, mirrors IWSL_Entitlements.
	 * @param callable|null     $consent_ctx  fn(array $server):array{active:bool,allows:?bool} — the
	 *                                         visitor-consent decision (injectable for the harness);
	 *                                         defaults to a reader over the site's cookie-consent
	 *                                         settings + the request's first-party consent cookie.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?IWSL_Store $store = null,
		$db = null,
		?callable $now_ms = null,
		?callable $consent_ctx = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : self::default_store();
		$this->db           = null !== $db ? $db : self::default_db();
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		$this->home_host   = self::default_home_host();
		$this->consent_ctx = null !== $consent_ctx ? $consent_ctx : $this->default_consent_ctx();
	}

	/** A WP-backed store under WordPress, else an in-memory one (keeps ctor total). */
	private static function default_store(): IWSL_Store {
		if ( class_exists( 'IWSL_WP_Store' ) && function_exists( 'get_option' ) ) {
			return new IWSL_WP_Store();
		}
		return new IWSL_Memory_Store();
	}

	/** The global $wpdb under WordPress, or null outside it (harness). @return object|null */
	private static function default_db() {
		return isset( $GLOBALS['wpdb'] ) && is_object( $GLOBALS['wpdb'] ) ? $GLOBALS['wpdb'] : null;
	}

	/**
	 * Register the recording hooks + the admin-post reset. Guarded so the harness can
	 * call it harmlessly. Registered on EVERY request because every callback re-checks
	 * the gate as its first act — a locked site records nothing and never creates the
	 * table, so it is safe to bind the hooks unconditionally.
	 */
	public function register(): void {
		if ( ! function_exists( 'add_action' ) ) {
			return;
		}
		// `wp` fires once, after the main query is resolved (so is_search/is_404 are
		// known) but before output — cheap, never blocks, never echoes.
		add_action( 'wp', array( $this, 'on_wp' ) );
		add_action( 'comment_post', array( $this, 'on_comment' ), 10, 3 );
		add_action( 'admin_post_' . self::RESET_ACTION, array( $this, 'handle_reset' ) );
	}

	// ── recording path (STATEMENT 1 is the authoritative gate) ─────────────────

	/**
	 * The `wp` callback. Builds the request context from WordPress predicates and
	 * hands the current $_SERVER (unslashed) to maybe_record(). No output, no block.
	 */
	public function on_wp(): void {
		$ctx = array(
			'is_admin'          => function_exists( 'is_admin' ) && is_admin(),
			'is_ajax'           => function_exists( 'wp_doing_ajax' ) ? wp_doing_ajax() : ( defined( 'DOING_AJAX' ) && DOING_AJAX ),
			'is_cron'           => function_exists( 'wp_doing_cron' ) ? wp_doing_cron() : ( defined( 'DOING_CRON' ) && DOING_CRON ),
			'is_rest'           => defined( 'REST_REQUEST' ) && REST_REQUEST,
			'is_feed'           => function_exists( 'is_feed' ) && is_feed(),
			'is_robots'         => function_exists( 'is_robots' ) && is_robots(),
			'is_trackback'      => function_exists( 'is_trackback' ) && is_trackback(),
			'is_search'         => function_exists( 'is_search' ) && is_search(),
			'search_query'      => function_exists( 'get_search_query' ) ? (string) get_search_query( false ) : '',
			'is_404'            => function_exists( 'is_404' ) && is_404(),
			'is_user_logged_in' => function_exists( 'is_user_logged_in' ) && is_user_logged_in(),
			'is_admin_user'     => function_exists( 'current_user_can' ) && current_user_can( 'manage_options' ),
		);
		$this->maybe_record( $this->server(), $ctx );
	}

	/**
	 * Record one pageview/event for the current request. STATEMENT 1 is the
	 * authoritative entitlement gate — a locked site returns here with zero side
	 * effects, so the table is never created and no query is issued. Then the cheap
	 * WP-context skips (admin/REST/cron/AJAX/feed/robots/trackback), the visitor
	 * exclusions (admins always; logged-in optionally; DNT; bots), and finally a
	 * single bounded, fully-prepared INSERT plus a throttled retention prune.
	 *
	 * @param array $server The request server array (already unslashed).
	 * @param array $ctx    Request predicates (injectable for the harness).
	 * @return array { ok:bool, recorded?:bool, reason?:string, row?:array, gate?:array }
	 */
	public function maybe_record( array $server, array $ctx = array() ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		if ( self::flag( $ctx, 'is_admin' ) || self::flag( $ctx, 'is_ajax' ) || self::flag( $ctx, 'is_cron' )
			|| self::flag( $ctx, 'is_rest' ) || self::flag( $ctx, 'is_feed' ) || self::flag( $ctx, 'is_robots' )
			|| self::flag( $ctx, 'is_trackback' ) ) {
			return self::skipped( 'context' );
		}
		if ( self::flag( $ctx, 'is_admin_user' ) ) {
			return self::skipped( 'admin-user' );
		}
		if ( self::flag( $ctx, 'is_user_logged_in' ) && $this->exclude_logged_in() ) {
			return self::skipped( 'logged-in' );
		}

		$ua = isset( $server['HTTP_USER_AGENT'] ) ? (string) $server['HTTP_USER_AGENT'] : '';
		if ( IWSL_Stats_Classifier::gpc_set( $server ) ) {
			return self::skipped( 'gpc' );
		}
		if ( IWSL_Stats_Classifier::dnt_set( $server ) ) {
			return self::skipped( 'dnt' );
		}
		if ( IWSL_Stats_Classifier::is_bot( $ua ) ) {
			return self::skipped( 'bot' );
		}
		// Visitor consent (opt-in "statistics" banner only): a visitor who declined the
		// statistics category — or, under an opt-in banner, has not yet decided — is not
		// recorded. The context is INACTIVE by default (the consent banner ships OFF), so
		// this is a strict no-op for every site that never enabled it: zero behavior change.
		if ( self::consent_declines( ( $this->consent_ctx )( $server ) ) ) {
			return self::skipped( 'consent-declined' );
		}

		if ( ! is_object( $this->db ) ) {
			return self::skipped( 'no-database' );
		}
		$table = $this->table( $this->db );
		if ( null === $table ) {
			return self::skipped( 'no-database' );
		}

		$this->maybe_install();

		$row = $this->build_row( $server, $ctx );
		$this->insert_row( $this->db, $table, $row );
		$this->maybe_prune_throttled( $this->db, $table );

		return array( 'ok' => true, 'recorded' => true, 'row' => $row );
	}

	/**
	 * `comment_post`. STATEMENT 1 is the gate. Records a bounded "comment" event
	 * (metadata only — never the comment body or author PII). The path is the
	 * commented-on post's permalink path when resolvable, else '/'.
	 *
	 * @param mixed $comment_id
	 * @param mixed $approved
	 * @param mixed $commentdata
	 */
	public function on_comment( $comment_id, $approved = 1, $commentdata = array() ): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( ! is_object( $this->db ) ) {
			return;
		}
		$table = $this->table( $this->db );
		if ( null === $table ) {
			return;
		}

		$server = $this->server();
		$ua     = isset( $server['HTTP_USER_AGENT'] ) ? (string) $server['HTTP_USER_AGENT'] : '';
		if ( IWSL_Stats_Classifier::gpc_set( $server ) || IWSL_Stats_Classifier::dnt_set( $server ) || IWSL_Stats_Classifier::is_bot( $ua ) ) {
			return;
		}
		// Honor a declined/undecided statistics-consent choice for comment events too
		// (no-op unless an opt-in banner is enabled — see maybe_record()).
		if ( self::consent_declines( ( $this->consent_ctx )( $server ) ) ) {
			return;
		}

		$path    = '/';
		$post_id = is_array( $commentdata ) && isset( $commentdata['comment_post_ID'] ) ? (int) $commentdata['comment_post_ID'] : 0;
		if ( $post_id > 0 && function_exists( 'get_permalink' ) ) {
			$permalink = get_permalink( $post_id );
			if ( is_string( $permalink ) && '' !== $permalink ) {
				$path = IWSL_Stats_Classifier::path_from( array( 'REQUEST_URI' => $permalink ) );
			}
		}

		$this->maybe_install();
		$ctx = array(
			'event_type'  => IWSL_Stats_Classifier::EVENT_COMMENT,
			'event_label' => 'Comment posted',
			'path'        => $path,
		);
		$row = $this->build_row( $server, $ctx );
		$this->insert_row( $this->db, $table, $row );
	}

	/**
	 * Assemble one privacy-safe row from the request. All fields are classified via
	 * the pure IWSL_Stats_Classifier and capped; the event type comes from an explicit
	 * ctx override (comment) or the resolved page context (search / 404 / view).
	 *
	 * @return array
	 */
	private function build_row( array $server, array $ctx ): array {
		$now = $this->now_seconds();
		$ua  = isset( $server['HTTP_USER_AGENT'] ) ? (string) $server['HTTP_USER_AGENT'] : '';
		$al  = isset( $server['HTTP_ACCEPT_LANGUAGE'] ) ? (string) $server['HTTP_ACCEPT_LANGUAGE'] : '';
		$ref = isset( $server['HTTP_REFERER'] ) ? (string) $server['HTTP_REFERER'] : '';
		$cf  = isset( $server['HTTP_CF_IPCOUNTRY'] ) ? (string) $server['HTTP_CF_IPCOUNTRY'] : null;

		$ua_bits = IWSL_Stats_Classifier::classify_ua( $ua );
		$host    = IWSL_Stats_Classifier::referer_host( $ref, $this->home_host );

		if ( isset( $ctx['event_type'] ) && '' !== (string) $ctx['event_type'] ) {
			$type  = (string) $ctx['event_type'];
			$label = isset( $ctx['event_label'] ) ? (string) $ctx['event_label'] : '';
		} elseif ( self::flag( $ctx, 'is_search' ) ) {
			$type  = IWSL_Stats_Classifier::EVENT_SEARCH;
			$label = isset( $ctx['search_query'] ) ? (string) $ctx['search_query'] : '';
		} elseif ( self::flag( $ctx, 'is_404' ) ) {
			$type  = IWSL_Stats_Classifier::EVENT_404;
			$label = '';
		} else {
			$type  = IWSL_Stats_Classifier::EVENT_VIEW;
			$label = '';
		}

		$path = isset( $ctx['path'] ) ? (string) $ctx['path'] : IWSL_Stats_Classifier::path_from( $server );

		return array(
			'hit_at'        => $now,
			'visit_id'      => IWSL_Stats_Classifier::visit_id( $now, $ua, $al, $this->salt() ),
			'path'          => IWSL_Stats_Classifier::cap( $path, IWSL_Stats_Classifier::MAX_PATH_LEN ),
			'referer_host'  => $host,
			'search_engine' => IWSL_Stats_Classifier::search_engine_from_host( $host ),
			'browser'       => IWSL_Stats_Classifier::cap( $ua_bits['browser'], IWSL_Stats_Classifier::MAX_SHORT_LEN ),
			'os'            => IWSL_Stats_Classifier::cap( $ua_bits['os'], IWSL_Stats_Classifier::MAX_SHORT_LEN ),
			'device'        => $ua_bits['device'],
			'country'       => IWSL_Stats_Classifier::cap( IWSL_Stats_Classifier::country( $cf, $al ), IWSL_Stats_Classifier::MAX_SHORT_LEN ),
			'event_type'    => $type,
			'event_label'   => IWSL_Stats_Classifier::cap( self::clean_text( $label ), IWSL_Stats_Classifier::MAX_LABEL_LEN ),
		);
	}

	/** A single bounded, fully-prepared INSERT. The table id is hardcoded; every value is bound. */
	private function insert_row( $db, string $table, array $row ): void {
		$sql = $db->prepare(
			"INSERT INTO {$table}
			 (hit_at, visit_id, path, referer_host, search_engine, browser, os, device, country, event_type, event_label)
			 VALUES (%d, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
			$row['hit_at'],
			$row['visit_id'],
			$row['path'],
			$row['referer_host'],
			$row['search_engine'],
			$row['browser'],
			$row['os'],
			$row['device'],
			$row['country'],
			$row['event_type'],
			$row['event_label']
		);
		$db->query( $sql );
	}

	// ── retention (bounded, prepared, throttled) ───────────────────────────────

	/**
	 * Prune the table: delete rows older than RETENTION_DAYS and trim to the newest
	 * MAX_ROWS. STATEMENT 1 is the gate. Both DELETEs are prepared and bounded and the
	 * table identifier is hardcoded — nothing here DROPs, TRUNCATEs or ALTERs.
	 *
	 * @return array { ok:bool, reason?:string, pruned?:bool, gate?:array }
	 */
	public function prune( $db = null ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$db = null !== $db ? $db : $this->db;
		if ( ! is_object( $db ) ) {
			return array( 'ok' => false, 'reason' => 'no-database' );
		}
		$table = $this->table( $db );
		if ( null === $table ) {
			return array( 'ok' => false, 'reason' => 'no-database' );
		}
		$this->prune_now( $db, $table );
		return array( 'ok' => true, 'pruned' => true );
	}

	/** The bounded prune DELETEs (caller has already gated). */
	private function prune_now( $db, string $table ): void {
		$cutoff = $this->now_seconds() - ( self::RETENTION_DAYS * IWSL_Stats_Classifier::DAY_SECONDS );
		$db->query( $db->prepare( "DELETE FROM {$table} WHERE hit_at < %d", $cutoff ) );
		// Keep only the newest MAX_ROWS ids; a table at or below the cap deletes nothing
		// (the derived set contains every id, so NOT IN excludes everything).
		$db->query(
			$db->prepare(
				"DELETE FROM {$table} WHERE id NOT IN (
					SELECT id FROM ( SELECT id FROM {$table} ORDER BY id DESC LIMIT %d ) keep
				)",
				self::MAX_ROWS
			)
		);
	}

	/** Prune at most once per PRUNE_INTERVAL_S, tracked via a stored stamp. */
	private function maybe_prune_throttled( $db, string $table ): void {
		$last = (int) $this->store->get( self::LAST_PRUNE_KEY, 0 );
		$now  = $this->now_seconds();
		if ( $now - $last < self::PRUNE_INTERVAL_S ) {
			return;
		}
		$this->store->set( self::LAST_PRUNE_KEY, $now );
		$this->prune_now( $db, $table );
	}

	/**
	 * Empty the statistics table. STATEMENT 1 is the gate — a locked site cannot clear
	 * (or touch) the table. Uses a single DELETE (never TRUNCATE/DROP) over the
	 * hardcoded identifier.
	 *
	 * @return array { ok:bool, reason?:string, cleared?:bool, gate?:array }
	 */
	public function reset( $db = null ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$db = null !== $db ? $db : $this->db;
		if ( ! is_object( $db ) ) {
			return array( 'ok' => false, 'reason' => 'no-database' );
		}
		$table = $this->table( $db );
		if ( null === $table ) {
			return array( 'ok' => false, 'reason' => 'no-database' );
		}
		$db->query( "DELETE FROM {$table}" );
		return array( 'ok' => true, 'cleared' => true );
	}

	/**
	 * Teardown: permanently remove this feature's on-disk footprint. Goes further
	 * than reset() (which only empties the rows for an unlocked site): this DROPS
	 * the custom hits table itself (not just its rows) and deletes every option key
	 * this engine owns (schema version, salt, last-prune stamp, exclude-logged-in
	 * toggle) so a later re-enable starts from a genuinely clean slate — the table
	 * is lazily recreated by maybe_install() on the next recorded hit.
	 *
	 * NOT gated by the entitlement: a full teardown must succeed even after the
	 * `statistics` flag has already been revoked (that is precisely when a teardown
	 * is invoked). Idempotent + cheap when already clean: DROP TABLE IF EXISTS is a
	 * no-op against an absent table, and each store-key delete is a no-op once the
	 * key is already gone.
	 *
	 * @return array{ ok:bool, table_dropped:bool, options_removed:string[] }
	 */
	public function purge(): array {
		$table_dropped = false;
		if ( is_object( $this->db ) ) {
			$table = $this->table( $this->db );
			if ( null !== $table ) {
				$this->db->query( "DROP TABLE IF EXISTS `{$table}`" );
				$table_dropped = true;
			}
		}

		$options = array( self::SCHEMA_KEY, self::SALT_KEY, self::LAST_PRUNE_KEY, self::EXCLUDE_LOGGED_KEY );
		foreach ( $options as $key ) {
			$this->store->delete( $key );
		}

		return array(
			'ok'              => true,
			'table_dropped'   => $table_dropped,
			'options_removed' => $options,
		);
	}

	// ── admin-post handler (cap + nonce + gate, PRG) ───────────────────────────

	/**
	 * `admin_post_iwsl_stats_reset`. Capability + nonce + gate, then the gated reset(),
	 * a per-user result transient, and a PRG redirect back to the Plus page.
	 */
	public function handle_reset(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			$this->deny();
			return;
		}
		if ( function_exists( 'check_admin_referer' ) ) {
			check_admin_referer( self::RESET_NONCE );
		}
		$result = $this->reset();
		$this->store_result( $result );
		$this->redirect_back();
	}

	// ── reads (dashboard model) ────────────────────────────────────────────────

	/**
	 * Read the recent rows and fold them into the dashboard model for a KPI range.
	 * Bounded: reads at most MAX_READ_ROWS rows from the AGG_WINDOW_DAYS window.
	 *
	 * @return array The IWSL_Stats_Classifier::aggregate() model.
	 */
	public function dashboard( int $range_days ): array {
		$now   = $this->now_seconds();
		$since = $now - ( self::AGG_WINDOW_DAYS * IWSL_Stats_Classifier::DAY_SECONDS );
		$rows  = $this->fetch_rows( $this->db, $since, self::MAX_READ_ROWS );
		$tz    = function_exists( 'wp_timezone' ) ? wp_timezone() : new DateTimeZone( 'UTC' );
		return IWSL_Stats_Classifier::aggregate( $rows, $now, $range_days, $tz );
	}

	/**
	 * The recent rows since $since (prepared SELECT, hardcoded identifier, bounded
	 * LIMIT). Returns an array of associative rows, or [] when there is no handle.
	 *
	 * @return array<int, array>
	 */
	public function fetch_rows( $db, int $since, int $limit ): array {
		if ( ! is_object( $db ) || ! method_exists( $db, 'get_results' ) ) {
			return array();
		}
		$table = $this->table( $db );
		if ( null === $table ) {
			return array();
		}
		$sql = $db->prepare(
			"SELECT hit_at, visit_id, path, referer_host, search_engine, browser, os, device, country, event_type, event_label
			 FROM {$table}
			 WHERE hit_at >= %d
			 ORDER BY hit_at DESC
			 LIMIT %d",
			$since,
			$limit
		);
		$output = defined( 'ARRAY_A' ) ? ARRAY_A : 'ARRAY_A';
		$rows   = $db->get_results( $sql, $output );
		return is_array( $rows ) ? $rows : array();
	}

	// ── signed-channel projections (read-only; console-polled) ─────────────────

	/**
	 * The compact `stats.summary` projection for the signed channel. STATEMENT 1 is the
	 * authoritative gate — a locked site answers a well-formed { locked:true, gate } (the
	 * response is signed, so the console trusts and renders the gate reasons). Unlocked:
	 * a BOUNDED projection of dashboard() — the ~15 KB drill island, the heatmap and every
	 * raw hit row NEVER cross the wire — annotated with the site's live privacy posture
	 * (DNT + GPC always honored; consent_gated=1 only under an enabled opt-in statistics
	 * banner). Well under the §6.2 byte ceiling (SUMMARY_MAX_BYTES caps it in tests).
	 *
	 * @return array
	 */
	public function wire_summary( int $range_days ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'locked' => true, 'gate' => $gate );
		}
		$range             = in_array( $range_days, self::ALLOWED_RANGES, true ) ? $range_days : self::DEFAULT_RANGE;
		$payload           = IWSL_Stats_Classifier::summary_payload( $this->dashboard( $range ) );
		$payload['locked'] = false;
		// consent_gated reflects the site's config, not this request → probe with an
		// empty server (we only read the 'active' regime flag, never a visitor cookie).
		$consent = ( $this->consent_ctx )( array() );
		if ( is_array( $consent ) && ! empty( $consent['active'] ) ) {
			$payload['privacy']['consent_gated'] = 1;
		}
		return $payload;
	}

	/**
	 * The `stats.timeseries` projection (≤ SERIES_DAYS daily views/visits, plus the hourly
	 * + previous-day series only when days === 1). STATEMENT 1 is the gate; a locked site
	 * answers { locked:true, gate }.
	 *
	 * @return array
	 */
	public function wire_timeseries( int $days ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'locked' => true, 'gate' => $gate );
		}
		$days = max( 1, min( $days, IWSL_Stats_Classifier::SERIES_DAYS ) );
		// dashboard(1) populates the hourly arrays; for any other range the 30-day series
		// is identical (sliced in the projection), so range only matters when days === 1.
		$payload           = IWSL_Stats_Classifier::timeseries_payload( $this->dashboard( 1 === $days ? 1 : self::DEFAULT_RANGE ), $days );
		$payload['locked'] = false;
		return $payload;
	}

	/** Validate `stats.summary` params: empty, or { range_days: 1|7|30 }. */
	public static function validate_summary_params( $params ): bool {
		$vars = get_object_vars( $params );
		if ( array() === $vars ) {
			return true;
		}
		if ( array() !== array_diff_key( $vars, array( 'range_days' => 1 ) ) ) {
			return false;
		}
		return isset( $vars['range_days'] ) && is_int( $vars['range_days'] )
			&& in_array( $vars['range_days'], self::ALLOWED_RANGES, true );
	}

	/** Validate `stats.timeseries` params: empty, or { days: 1..SERIES_DAYS }. */
	public static function validate_timeseries_params( $params ): bool {
		$vars = get_object_vars( $params );
		if ( array() === $vars ) {
			return true;
		}
		if ( array() !== array_diff_key( $vars, array( 'days' => 1 ) ) ) {
			return false;
		}
		return isset( $vars['days'] ) && is_int( $vars['days'] )
			&& $vars['days'] >= 1 && $vars['days'] <= IWSL_Stats_Classifier::SERIES_DAYS;
	}

	// ── visitor-consent context (S6; default OFF ⇒ no behavior change) ──────────

	/**
	 * Whether a consent context result means the visitor's pageview must NOT be recorded:
	 * true only when the opt-in statistics-consent regime is ACTIVE and the visitor's
	 * decision is not an explicit grant (declined, or — under opt-in — undecided). An
	 * inactive context (the default) never declines, so recording is unchanged.
	 *
	 * @param mixed $consent The consent_ctx result.
	 */
	private static function consent_declines( $consent ): bool {
		if ( ! is_array( $consent ) || empty( $consent['active'] ) ) {
			return false;
		}
		return true !== ( isset( $consent['allows'] ) ? $consent['allows'] : null );
	}

	/**
	 * The default visitor-consent context provider: a closure that, given a request
	 * $server map, reports whether an opt-in "statistics" consent regime is in force on
	 * this site and, if so, what the visitor's first-party consent cookie decided.
	 *
	 * The regime is "active" ONLY when the cookie_consent feature is UNLOCKED, ENABLED,
	 * configured with an OPT-IN model, and declares the statistics category in use —
	 * exactly the conditions under which a visitor is actually asked. Otherwise (the
	 * default: the banner ships OFF) the context is inactive and changes nothing, so a
	 * site that never enabled the banner keeps recording under the engine's cookieless,
	 * DNT/GPC-honored basis. Side-effect free; short-circuits before building the consent
	 * engine when the feature is locked, and no-ops entirely when the classes are absent.
	 *
	 * @return callable(array):array{active:bool,allows:?bool}
	 */
	private function default_consent_ctx(): callable {
		$entitlements = $this->entitlements;
		$store        = $this->store;
		$now_ms       = $this->now_ms;
		return static function ( array $server ) use ( $entitlements, $store, $now_ms ): array {
			$inactive = array( 'active' => false, 'allows' => null );
			if ( ! class_exists( 'IWSL_Cookie_Consent' ) || ! class_exists( 'IWSL_Consent_Classifier' ) ) {
				return $inactive;
			}
			$gate = $entitlements->evaluate( IWSL_Cookie_Consent::FEATURE );
			if ( empty( $gate['unlocked'] ) ) {
				return $inactive; // no banner is shown → no statistics choice is collected.
			}
			$consent  = new IWSL_Cookie_Consent( $entitlements, $store, $now_ms, $server );
			$settings = $consent->settings();
			$active   = ! empty( $settings['enabled'] )
				&& IWSL_Consent_Classifier::MODEL_OPT_IN === ( isset( $settings['default_model'] ) ? $settings['default_model'] : '' )
				&& ! empty( $settings['categories']['statistics'] );
			if ( ! $active ) {
				return $inactive;
			}
			$raw    = self::read_consent_cookie( $server );
			$allows = IWSL_Stats_Classifier::consent_allows_statistics( $raw, $consent->policy_version() );
			return array( 'active' => true, 'allows' => $allows );
		};
	}

	/** Read the first-party consent cookie from a request $server map's Cookie header, or null. */
	private static function read_consent_cookie( array $server ): ?string {
		$header = isset( $server['HTTP_COOKIE'] ) && is_string( $server['HTTP_COOKIE'] ) ? $server['HTTP_COOKIE'] : '';
		if ( '' === $header ) {
			return null;
		}
		$name = IWSL_Cookie_Consent::COOKIE_NAME;
		foreach ( explode( ';', $header ) as $pair ) {
			$eq = strpos( $pair, '=' );
			if ( false === $eq ) {
				continue;
			}
			if ( trim( substr( $pair, 0, $eq ) ) === $name ) {
				return urldecode( trim( substr( $pair, $eq + 1 ) ) );
			}
		}
		return null;
	}

	// ── render ─────────────────────────────────────────────────────────────────

	/**
	 * The admin section. Locked → a notice listing the gate reasons. Unlocked → the
	 * full "Insights" dashboard. This method stays thin: it re-checks the gate (the
	 * authoritative innermost check), reads the bounded dashboard model, and hands
	 * rendering to IWSL_Statistics_View. All markup, charts, escaping, the drill
	 * island and the inlined interactivity live in the view, keeping this engine file
	 * focused on recording / retention / reads.
	 */
	public function render_section(): void {
		$gate  = $this->entitlements->evaluate( self::FEATURE );
		$range = $this->requested_range();
		if ( empty( $gate['unlocked'] ) ) {
			( new IWSL_Statistics_View( array(), $range ) )->render_locked( $gate );
			return;
		}
		$data = $this->dashboard( $range );
		( new IWSL_Statistics_View( $data, $range ) )->render();
	}

	// ── table + dbDelta install ────────────────────────────────────────────────

	/**
	 * The prefixed, re-validated table name — or null when the prefix is missing or
	 * malformed. Belt-and-braces (mirrors IWSL_DB_Optimize_Tables_Cleaner): a hostile
	 * $wpdb->prefix collapses to null so an identifier can never be smuggled into SQL.
	 */
	private function table( $db ): ?string {
		$prefix = isset( $db->prefix ) ? (string) $db->prefix : '';
		if ( '' === $prefix || ! preg_match( '/^[a-z0-9_]+$/', $prefix ) ) {
			return null;
		}
		$table = $prefix . self::TABLE_SUFFIX;
		if ( ! preg_match( '/^[a-z0-9_]+$/', $table ) ) {
			return null;
		}
		return $table;
	}

	/**
	 * Lazily create/upgrade the custom table via dbDelta — only ever reached after the
	 * gate has passed (called from the recording path). Cheap common case: a single
	 * option read short-circuits when the schema is current. Only loads the WordPress
	 * upgrade API when it must actually run dbDelta, and is a no-op under the harness
	 * (where dbDelta does not exist), so a locked/test run never creates a table.
	 */
	private function maybe_install(): void {
		if ( self::SCHEMA_VERSION === (string) $this->store->get( self::SCHEMA_KEY, '' ) ) {
			return;
		}
		$db = $this->db;
		if ( ! is_object( $db ) ) {
			return;
		}
		$table = $this->table( $db );
		if ( null === $table ) {
			return;
		}
		if ( ! function_exists( 'dbDelta' ) ) {
			$upgrade = defined( 'ABSPATH' ) ? rtrim( (string) ABSPATH, '/\\' ) . '/wp-admin/includes/upgrade.php' : '';
			if ( '' !== $upgrade && is_readable( $upgrade ) ) {
				require_once $upgrade;
			}
		}
		if ( ! function_exists( 'dbDelta' ) ) {
			return; // no WordPress upgrade API (harness) — nothing to install.
		}
		$collate = method_exists( $db, 'get_charset_collate' ) ? (string) $db->get_charset_collate() : '';
		$sql     = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			hit_at INT UNSIGNED NOT NULL DEFAULT 0,
			visit_id CHAR(32) NOT NULL DEFAULT '',
			path VARCHAR(190) NOT NULL DEFAULT '',
			referer_host VARCHAR(190) NOT NULL DEFAULT '',
			search_engine VARCHAR(32) NOT NULL DEFAULT '',
			browser VARCHAR(32) NOT NULL DEFAULT '',
			os VARCHAR(32) NOT NULL DEFAULT '',
			device VARCHAR(16) NOT NULL DEFAULT '',
			country VARCHAR(16) NOT NULL DEFAULT '',
			event_type VARCHAR(16) NOT NULL DEFAULT 'view',
			event_label VARCHAR(190) NOT NULL DEFAULT '',
			PRIMARY KEY  (id),
			KEY hit_at (hit_at),
			KEY visit_id (visit_id)
		) {$collate};";
		dbDelta( $sql );
		$this->store->set( self::SCHEMA_KEY, self::SCHEMA_VERSION );
	}

	// ── small helpers ──────────────────────────────────────────────────────────

	/** A per-install random salt for the visit bucket, generated once and stored. */
	private function salt(): string {
		$existing = $this->store->get( self::SALT_KEY, '' );
		if ( is_string( $existing ) && '' !== $existing ) {
			return $existing;
		}
		$new = function_exists( 'wp_generate_password' )
			? (string) wp_generate_password( 32, false, false )
			: bin2hex( random_bytes( 16 ) );
		$this->store->set( self::SALT_KEY, $new );
		return $new;
	}

	/** Whether logged-in (non-admin) visitors are excluded from recording (default true). */
	private function exclude_logged_in(): bool {
		return false !== $this->store->get( self::EXCLUDE_LOGGED_KEY, true );
	}

	/** The KPI range requested via GET, validated against ALLOWED_RANGES. */
	private function requested_range(): int {
		$raw = 0;
		if ( isset( $_GET[ self::RANGE_PARAM ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			$raw = (int) $_GET[ self::RANGE_PARAM ]; // phpcs:ignore WordPress.Security.NonceVerification.Recommended, WordPress.Security.ValidatedSanitizedInput.MissingUnslash
		}
		return in_array( $raw, self::ALLOWED_RANGES, true ) ? $raw : self::DEFAULT_RANGE;
	}

	/** Coarse boolean read from the ctx array. */
	private static function flag( array $ctx, string $key ): bool {
		return isset( $ctx[ $key ] ) && $ctx[ $key ];
	}

	/** A fresh "recorded nothing" result carrying the skip reason. */
	private static function skipped( string $reason ): array {
		return array( 'ok' => true, 'recorded' => false, 'reason' => $reason );
	}

	/** Strip control characters + trim (labels are escaped again at render). */
	private static function clean_text( string $value ): string {
		$stripped = preg_replace( '/[\x00-\x1F\x7F]/', '', $value );
		return null === $stripped ? '' : trim( $stripped );
	}

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}

	/** The current request server array, unslashed when WordPress is present. */
	private function server(): array {
		if ( ! isset( $_SERVER ) || ! is_array( $_SERVER ) ) {
			return array();
		}
		// Only header/path values are read (never echoed raw), classified + escaped
		// downstream; unslash for WP-consistency.
		return function_exists( 'wp_unslash' ) ? (array) wp_unslash( $_SERVER ) : $_SERVER; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized, WordPress.Security.ValidatedSanitizedInput.MissingUnslash
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

	/** Lowercased home host from home_url(), '' outside WordPress. */
	private static function default_home_host(): string {
		if ( function_exists( 'home_url' ) ) {
			$home = home_url();
			if ( is_string( $home ) && '' !== $home ) {
				$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $home ) : parse_url( $home );
				if ( is_array( $parts ) && isset( $parts['host'] ) && is_string( $parts['host'] ) ) {
					return strtolower( $parts['host'] );
				}
			}
		}
		return '';
	}

	private static function esc_html_safe( string $value ): string {
		return function_exists( 'esc_html' ) ? esc_html( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}
