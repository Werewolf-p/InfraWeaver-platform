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

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Salt/schema/config persistence; defaults to a WP store.
	 * @param object|null       $db           A `$wpdb`-like handle; defaults to the global $wpdb.
	 * @param callable|null     $now_ms       Clock, mirrors IWSL_Entitlements.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?IWSL_Store $store = null,
		$db = null,
		?callable $now_ms = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : self::default_store();
		$this->db           = null !== $db ? $db : self::default_db();
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		$this->home_host = self::default_home_host();
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
		if ( IWSL_Stats_Classifier::dnt_set( $server ) ) {
			return self::skipped( 'dnt' );
		}
		if ( IWSL_Stats_Classifier::is_bot( $ua ) ) {
			return self::skipped( 'bot' );
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
		if ( IWSL_Stats_Classifier::dnt_set( $server ) || IWSL_Stats_Classifier::is_bot( $ua ) ) {
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
		return IWSL_Stats_Classifier::aggregate( $rows, $now, $range_days );
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

	// ── render ─────────────────────────────────────────────────────────────────

	/**
	 * The admin section. Locked → a notice listing the gate reasons. Unlocked → the
	 * analytics dashboard: KPI tiles, a 30-day views time-series (inline SVG), bar
	 * charts for browsers / search engines / countries / devices, and ranked tables
	 * for top pages, referrers and recent events. Every dynamic fragment is escaped;
	 * all charts are self-contained inline SVG (no external JS/CSS/CDN).
	 */
	public function render_section(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$range = $this->requested_range();
		$data  = $this->dashboard( $range );

		echo '<div class="iwsl-stats">';
		$this->render_styles();
		echo '<h2 class="iwsl-stats__title">' . self::esc_html_safe( 'Site Statistics' ) . '</h2>';
		echo '<p class="iwsl-stats__intro">' . self::esc_html_safe(
			'Privacy-respecting, self-hosted analytics. No IP addresses are stored and no external service is contacted.'
		) . '</p>';

		$this->render_range_switch( $range );
		$this->render_kpis( $data['kpi'], $range );
		$this->render_timeseries( isset( $data['series'] ) ? $data['series'] : array() );

		echo '<div class="iwsl-stats__grid">';
		$this->render_bar_card( 'Browsers', $data['browsers'], 1 );
		$this->render_bar_card( 'Search engines', $data['search_engines'], 2 );
		$this->render_bar_card( 'Countries', $data['countries'], 3 );
		$this->render_bar_card( 'Devices', $data['devices'], 6 );
		echo '</div>';

		echo '<div class="iwsl-stats__grid">';
		$this->render_table_card( 'Top pages', $data['top_pages'], 'Page' );
		$this->render_table_card( 'Top referrers', $data['top_referrers'], 'Referrer' );
		echo '</div>';

		$this->render_events_card( isset( $data['recent_events'] ) ? $data['recent_events'] : array() );

		echo '<details class="iwsl-adv"><summary>' . self::esc_html_safe( 'Advanced settings' ) . '</summary><div class="iwsl-adv__body">';
		$this->render_reset_form();
		echo '</div></details>';
		echo '</div>';
	}

	/** The KPI stat tiles: views / visits with up-down vs the prior period, plus today + online. */
	private function render_kpis( array $kpi, int $range ): void {
		$label = $this->range_label( $range );
		echo '<div class="iwsl-stats__tiles">';
		$this->render_tile( 'Views (' . $label . ')', (int) $kpi['views'], $kpi['views_delta_pct'] );
		$this->render_tile( 'Unique visits (' . $label . ')', (int) $kpi['visits'], $kpi['visits_delta_pct'] );
		$this->render_tile( 'Views today', (int) $kpi['views_today'], null );
		$this->render_tile( 'Events (' . $label . ')', (int) $kpi['events'], null );
		$this->render_tile( 'Online now', (int) $kpi['online_now'], null );
		echo '</div>';
	}

	/** One KPI tile with an optional accessible up/down delta (arrow + sign, never color-only). */
	private function render_tile( string $label, int $value, ?float $delta ): void {
		echo '<div class="iwsl-stats__tile">';
		echo '<div class="iwsl-stats__tile-label">' . self::esc_html_safe( $label ) . '</div>';
		echo '<div class="iwsl-stats__tile-value">' . self::esc_html_safe( self::num( $value ) ) . '</div>';
		if ( null !== $delta ) {
			$up   = $delta >= 0;
			$arrow = $up ? '▲' : '▼';
			$cls  = $up ? 'is-up' : 'is-down';
			$sign = $up ? '+' : '';
			echo '<div class="iwsl-stats__delta ' . self::esc_attr_safe( $cls ) . '">'
				. '<span aria-hidden="true">' . self::esc_html_safe( $arrow ) . '</span> '
				. self::esc_html_safe( $sign . self::num_f( $delta ) . '% vs prior period' )
				. '</div>';
		} else {
			echo '<div class="iwsl-stats__delta is-flat">&nbsp;</div>';
		}
		echo '</div>';
	}

	/** The 30-day views time-series as a hand-built inline SVG area+line chart. */
	private function render_timeseries( array $series ): void {
		$n = count( $series );
		echo '<div class="iwsl-stats__card">';
		echo '<h3 class="iwsl-stats__card-title">' . self::esc_html_safe( 'Views — last 30 days' ) . '</h3>';
		if ( 0 === $n ) {
			echo '<p class="iwsl-stats__empty">' . self::esc_html_safe( 'No data recorded yet.' ) . '</p></div>';
			return;
		}

		$max = 1;
		foreach ( $series as $s ) {
			$max = max( $max, (int) $s['views'] );
		}
		$w    = 760;
		$h    = 200;
		$padl = 44;
		$padr = 16;
		$padt = 16;
		$padb = 28;
		$iw   = $w - $padl - $padr;
		$ih   = $h - $padt - $padb;
		$step = $n > 1 ? $iw / ( $n - 1 ) : 0;

		$pts  = array();
		$last = null;
		foreach ( $series as $i => $s ) {
			$x = $padl + ( $step * $i );
			$y = $padt + $ih - ( ( (int) $s['views'] / $max ) * $ih );
			$pts[] = self::coord( $x ) . ',' . self::coord( $y );
			$last  = array( 'x' => $x, 'y' => $y, 'v' => (int) $s['views'], 'day' => (string) $s['day'] );
		}
		$area  = 'M' . self::coord( $padl ) . ',' . self::coord( $padt + $ih );
		$area .= ' L' . implode( ' L', $pts );
		$area .= ' L' . self::coord( $padl + $iw ) . ',' . self::coord( $padt + $ih ) . ' Z';

		$first_day = (string) $series[0]['day'];
		$last_day  = (string) $series[ $n - 1 ]['day'];

		echo '<div class="iwsl-stats__chart">';
		echo '<svg viewBox="0 0 ' . $w . ' ' . $h . '" width="100%" height="auto" role="img" '
			. 'aria-label="' . self::esc_attr_safe( 'Daily views over the last 30 days, peak ' . self::num( $max ) . ' views' ) . '" '
			. 'preserveAspectRatio="xMidYMid meet" class="iwsl-svg">';
		echo '<title>' . self::esc_html_safe( 'Views — last 30 days' ) . '</title>';
		// baseline + max gridline
		echo '<line x1="' . $padl . '" y1="' . self::coord( $padt + $ih ) . '" x2="' . ( $padl + $iw ) . '" y2="' . self::coord( $padt + $ih ) . '" class="iwsl-svg__axis" />';
		echo '<line x1="' . $padl . '" y1="' . $padt . '" x2="' . ( $padl + $iw ) . '" y2="' . $padt . '" class="iwsl-svg__grid" />';
		echo '<text x="' . ( $padl - 8 ) . '" y="' . ( $padt + 4 ) . '" text-anchor="end" class="iwsl-svg__tick">' . self::esc_html_safe( self::num( $max ) ) . '</text>';
		echo '<text x="' . ( $padl - 8 ) . '" y="' . self::coord( $padt + $ih ) . '" text-anchor="end" class="iwsl-svg__tick">0</text>';
		// area + line
		echo '<path d="' . self::esc_attr_safe( $area ) . '" class="iwsl-svg__area" />';
		echo '<polyline points="' . self::esc_attr_safe( implode( ' ', $pts ) ) . '" class="iwsl-svg__line" fill="none" />';
		if ( null !== $last ) {
			echo '<circle cx="' . self::coord( $last['x'] ) . '" cy="' . self::coord( $last['y'] ) . '" r="4" class="iwsl-svg__dot" />';
			echo '<text x="' . self::coord( $last['x'] - 4 ) . '" y="' . self::coord( $last['y'] - 8 ) . '" text-anchor="end" class="iwsl-svg__endlabel">' . self::esc_html_safe( self::num( $last['v'] ) ) . '</text>';
		}
		// x labels (first + last)
		echo '<text x="' . $padl . '" y="' . ( $h - 8 ) . '" text-anchor="start" class="iwsl-svg__tick">' . self::esc_html_safe( $first_day ) . '</text>';
		echo '<text x="' . ( $padl + $iw ) . '" y="' . ( $h - 8 ) . '" text-anchor="end" class="iwsl-svg__tick">' . self::esc_html_safe( $last_day ) . '</text>';
		echo '</svg>';
		echo '</div></div>';
	}

	/** A card with a horizontal-bar chart for a top-N breakdown (value labels = non-color cue). */
	private function render_bar_card( string $title, array $rows, int $slot ): void {
		echo '<div class="iwsl-stats__card">';
		echo '<h3 class="iwsl-stats__card-title">' . self::esc_html_safe( $title ) . '</h3>';
		if ( array() === $rows ) {
			echo '<p class="iwsl-stats__empty">' . self::esc_html_safe( 'No data yet.' ) . '</p></div>';
			return;
		}
		$max = 1;
		foreach ( $rows as $r ) {
			$max = max( $max, (int) $r['count'] );
		}
		$n      = count( $rows );
		$rowh   = 26;
		$gap    = 6;
		$w      = 420;
		$labelw = 130;
		$barx   = $labelw + 8;
		$barw   = $w - $barx - 52;
		$h      = ( $rowh + $gap ) * $n + 8;
		$color  = 'var(--iwsl-series-' . (int) $slot . ')';

		echo '<div class="iwsl-stats__chart">';
		echo '<svg viewBox="0 0 ' . $w . ' ' . $h . '" width="100%" height="auto" role="img" '
			. 'aria-label="' . self::esc_attr_safe( $title . ' breakdown' ) . '" class="iwsl-svg">';
		echo '<title>' . self::esc_html_safe( $title ) . '</title>';
		$y = 8;
		foreach ( $rows as $r ) {
			$count = (int) $r['count'];
			$label = (string) $r['label'];
			$bw    = $max > 0 ? ( $count / $max ) * $barw : 0;
			$cy    = $y + ( $rowh / 2 ) + 4;
			echo '<text x="0" y="' . self::coord( $cy ) . '" class="iwsl-svg__rowlabel">' . self::esc_html_safe( self::truncate( $label, 22 ) ) . '</text>';
			echo '<rect x="' . $barx . '" y="' . $y . '" width="' . self::coord( max( 2, $bw ) ) . '" height="' . $rowh . '" rx="4" fill="' . self::esc_attr_safe( $color ) . '" class="iwsl-svg__bar">';
			echo '<title>' . self::esc_html_safe( $label . ': ' . self::num( $count ) ) . '</title>';
			echo '</rect>';
			echo '<text x="' . self::coord( $barx + max( 2, $bw ) + 6 ) . '" y="' . self::coord( $cy ) . '" class="iwsl-svg__barvalue">' . self::esc_html_safe( self::num( $count ) ) . '</text>';
			$y += $rowh + $gap;
		}
		echo '</svg>';
		echo '</div></div>';
	}

	/** A ranked table card (top pages / referrers). Wide content scrolls inside the card. */
	private function render_table_card( string $title, array $rows, string $col ): void {
		echo '<div class="iwsl-stats__card">';
		echo '<h3 class="iwsl-stats__card-title">' . self::esc_html_safe( $title ) . '</h3>';
		if ( array() === $rows ) {
			echo '<p class="iwsl-stats__empty">' . self::esc_html_safe( 'No data yet.' ) . '</p></div>';
			return;
		}
		echo '<div class="iwsl-stats__scroll"><table class="widefat striped"><thead><tr>';
		echo '<th>' . self::esc_html_safe( $col ) . '</th><th class="iwsl-stats__num">' . self::esc_html_safe( 'Views' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $rows as $r ) {
			echo '<tr><td>' . self::esc_html_safe( self::truncate( (string) $r['label'], 80 ) ) . '</td>'
				. '<td class="iwsl-stats__num">' . self::esc_html_safe( self::num( (int) $r['count'] ) ) . '</td></tr>';
		}
		echo '</tbody></table></div></div>';
	}

	/** The recent visitor-actions stream (searches, 404s, comments). */
	private function render_events_card( array $events ): void {
		echo '<div class="iwsl-stats__card">';
		echo '<h3 class="iwsl-stats__card-title">' . self::esc_html_safe( 'Recent visitor actions' ) . '</h3>';
		if ( array() === $events ) {
			echo '<p class="iwsl-stats__empty">' . self::esc_html_safe( 'No visitor actions recorded yet.' ) . '</p></div>';
			return;
		}
		echo '<div class="iwsl-stats__scroll"><table class="widefat striped"><thead><tr>';
		echo '<th>' . self::esc_html_safe( 'When' ) . '</th>';
		echo '<th>' . self::esc_html_safe( 'Action' ) . '</th>';
		echo '<th>' . self::esc_html_safe( 'Detail' ) . '</th>';
		echo '<th>' . self::esc_html_safe( 'Page' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $events as $e ) {
			echo '<tr>';
			echo '<td>' . self::esc_html_safe( self::format_time( (int) $e['at'] ) ) . '</td>';
			echo '<td>' . self::esc_html_safe( self::event_label( (string) $e['type'] ) ) . '</td>';
			echo '<td>' . self::esc_html_safe( self::truncate( (string) $e['label'], 60 ) ) . '</td>';
			echo '<td>' . self::esc_html_safe( self::truncate( (string) $e['path'], 48 ) ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table></div></div>';
	}

	/** The date-range switch (today / 7d / 30d) as gated, escaped GET links. */
	private function render_range_switch( int $active ): void {
		$base = $this->page_base_url();
		echo '<div class="iwsl-stats__ranges" role="group" aria-label="' . self::esc_attr_safe( 'Date range' ) . '">';
		foreach ( self::ALLOWED_RANGES as $days ) {
			$url = self::add_query_arg_safe( $base, self::RANGE_PARAM, (string) $days );
			$cls = $days === $active ? 'iwsl-stats__range is-active' : 'iwsl-stats__range';
			$aria = $days === $active ? ' aria-current="true"' : '';
			echo '<a class="' . self::esc_attr_safe( $cls ) . '" href="' . self::esc_url_safe( $url ) . '"' . $aria . '>'
				. self::esc_html_safe( $this->range_label( $days ) ) . '</a>';
		}
		echo '</div>';
	}

	/** The gated "Reset statistics" admin-post form. */
	private function render_reset_form(): void {
		$action_url = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : 'admin-post.php';
		echo '<form method="post" action="' . self::esc_url_safe( (string) $action_url ) . '" class="iwsl-stats__reset" '
			. 'onsubmit="return confirm(\'Clear all recorded statistics? This cannot be undone.\');">';
		echo '<input type="hidden" name="action" value="' . self::esc_attr_safe( self::RESET_ACTION ) . '" />';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::RESET_NONCE );
		}
		echo '<button type="submit" class="button button-secondary">' . self::esc_html_safe( 'Reset statistics' ) . '</button>';
		echo '</form>';
	}

	/** The locked-state notice with the human gate reasons. */
	private function render_locked_notice( array $gate ): void {
		$reasons = isset( $gate['reasons'] ) && is_array( $gate['reasons'] ) ? $gate['reasons'] : array();
		echo '<div class="notice notice-warning"><p>';
		echo self::esc_html_safe( 'Site Statistics is locked.' );
		if ( array() !== $reasons ) {
			echo ' ' . self::esc_html_safe( 'Reasons: ' . implode( ', ', array_map( 'strval', $reasons ) ) );
		}
		echo '</p></div>';
	}

	/**
	 * The self-contained, theme-aware chart/tile styles. Scoped to `.iwsl-stats`, using
	 * the dataviz reference palette (validated categorical slots), with a
	 * prefers-color-scheme dark override and support for the shell's explicit dark
	 * theme. Transparent card fills so it inherits the surrounding admin surface.
	 */
	private function render_styles(): void {
		echo '<style>
.iwsl-stats{--iwsl-ink:#0b0b0b;--iwsl-ink-2:#52514e;--iwsl-muted:#898781;--iwsl-line:#e1e0d9;--iwsl-axis:#c3c2b7;--iwsl-card:rgba(11,11,11,0.03);--iwsl-good:#006300;--iwsl-bad:#d03b3b;--iwsl-series-1:#2a78d6;--iwsl-series-2:#1baf7a;--iwsl-series-3:#eda100;--iwsl-series-6:#e34948;}
@media (prefers-color-scheme:dark){.iwsl-stats{--iwsl-ink:#ffffff;--iwsl-ink-2:#c3c2b7;--iwsl-muted:#898781;--iwsl-line:#2c2c2a;--iwsl-axis:#383835;--iwsl-card:rgba(255,255,255,0.04);--iwsl-good:#0ca30c;--iwsl-bad:#e66767;--iwsl-series-1:#3987e5;--iwsl-series-2:#199e70;--iwsl-series-3:#c98500;--iwsl-series-6:#e66767;}}
.iwsl-shell .iwsl-stats,:root[data-theme="dark"] .iwsl-stats{--iwsl-ink:#ffffff;--iwsl-ink-2:#c3c2b7;--iwsl-line:#2c2c2a;--iwsl-axis:#383835;--iwsl-card:rgba(255,255,255,0.04);--iwsl-good:#0ca30c;--iwsl-bad:#e66767;--iwsl-series-1:#3987e5;--iwsl-series-2:#199e70;--iwsl-series-3:#c98500;--iwsl-series-6:#e66767;}
.iwsl-stats__title{margin:0 0 4px;}
.iwsl-stats__intro{color:var(--iwsl-ink-2);margin:0 0 16px;max-width:60ch;}
.iwsl-stats__ranges{display:inline-flex;gap:2px;margin-bottom:16px;border:1px solid var(--iwsl-line);border-radius:8px;overflow:hidden;}
.iwsl-stats__range{padding:6px 14px;text-decoration:none;color:var(--iwsl-ink-2);font-size:13px;}
.iwsl-stats__range.is-active{background:var(--iwsl-series-1);color:#fff;font-weight:600;}
.iwsl-stats__tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px;}
.iwsl-stats__tile{background:var(--iwsl-card);border:1px solid var(--iwsl-line);border-radius:12px;padding:14px 16px;}
.iwsl-stats__tile-label{color:var(--iwsl-ink-2);font-size:12px;text-transform:uppercase;letter-spacing:.03em;}
.iwsl-stats__tile-value{color:var(--iwsl-ink);font-size:30px;font-weight:700;line-height:1.15;margin-top:4px;font-variant-numeric:tabular-nums;}
.iwsl-stats__delta{font-size:12px;margin-top:4px;color:var(--iwsl-muted);}
.iwsl-stats__delta.is-up{color:var(--iwsl-good);}
.iwsl-stats__delta.is-down{color:var(--iwsl-bad);}
.iwsl-stats__card{background:var(--iwsl-card);border:1px solid var(--iwsl-line);border-radius:12px;padding:16px;margin-bottom:18px;}
.iwsl-stats__card-title{margin:0 0 12px;font-size:14px;color:var(--iwsl-ink);}
.iwsl-stats__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;}
.iwsl-stats__chart{overflow-x:auto;}
.iwsl-stats__scroll{overflow-x:auto;}
.iwsl-stats__num{text-align:right;font-variant-numeric:tabular-nums;}
.iwsl-stats__empty{color:var(--iwsl-muted);margin:4px 0 0;}
.iwsl-stats__reset{margin-top:8px;}
.iwsl-svg{max-width:100%;display:block;}
.iwsl-svg__axis{stroke:var(--iwsl-axis);stroke-width:1;}
.iwsl-svg__grid{stroke:var(--iwsl-line);stroke-width:1;}
.iwsl-svg__area{fill:var(--iwsl-series-1);opacity:.14;}
.iwsl-svg__line{stroke:var(--iwsl-series-1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;}
.iwsl-svg__dot{fill:var(--iwsl-series-1);stroke:var(--iwsl-card);stroke-width:2;}
.iwsl-svg__tick{fill:var(--iwsl-muted);font-size:11px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
.iwsl-svg__endlabel{fill:var(--iwsl-ink);font-size:12px;font-weight:600;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
.iwsl-svg__rowlabel{fill:var(--iwsl-ink-2);font-size:12px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
.iwsl-svg__barvalue{fill:var(--iwsl-ink);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
</style>';
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

	/** Human label for a range in days. */
	private function range_label( int $days ): string {
		if ( 1 === $days ) {
			return 'Today';
		}
		return $days . ' days';
	}

	/** The Plus admin page base URL (for the range switch links). */
	private function page_base_url(): string {
		$url = 'admin.php?page=' . self::PAGE_SLUG;
		if ( function_exists( 'admin_url' ) ) {
			$url = admin_url( $url );
		}
		return $url;
	}

	/** Append/replace a query arg on a URL, WordPress-native when available. */
	private static function add_query_arg_safe( string $url, string $key, string $value ): string {
		if ( function_exists( 'add_query_arg' ) ) {
			return (string) add_query_arg( $key, $value, $url );
		}
		$sep = false === strpos( $url, '?' ) ? '?' : '&';
		return $url . $sep . rawurlencode( $key ) . '=' . rawurlencode( $value );
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

	/** Human event label for the recent-actions table. */
	private static function event_label( string $type ): string {
		switch ( $type ) {
			case IWSL_Stats_Classifier::EVENT_SEARCH:
				return 'Search';
			case IWSL_Stats_Classifier::EVENT_404:
				return 'Not found (404)';
			case IWSL_Stats_Classifier::EVENT_COMMENT:
				return 'Comment';
			default:
				return 'View';
		}
	}

	/** Integer, thousands-separated (i18n when available). */
	private static function num( int $value ): string {
		if ( function_exists( 'number_format_i18n' ) ) {
			return (string) number_format_i18n( $value );
		}
		return number_format( $value );
	}

	/** One-decimal float without trailing noise. */
	private static function num_f( float $value ): string {
		return rtrim( rtrim( number_format( $value, 1, '.', '' ), '0' ), '.' );
	}

	/** Round a coordinate to 2dp for compact, deterministic SVG output. */
	private static function coord( float $value ): string {
		return rtrim( rtrim( number_format( $value, 2, '.', '' ), '0' ), '.' );
	}

	/** Truncate a display string with an ellipsis (never mid-escape — plain text). */
	private static function truncate( string $value, int $max ): string {
		if ( strlen( $value ) <= $max ) {
			return $value;
		}
		return substr( $value, 0, max( 0, $max - 1 ) ) . '…';
	}

	/** A human timestamp; falls back to a raw ISO-ish string outside WordPress. */
	private static function format_time( int $unix ): string {
		if ( $unix <= 0 ) {
			return '—';
		}
		if ( function_exists( 'wp_date' ) ) {
			$formatted = wp_date( 'Y-m-d H:i', $unix );
			if ( is_string( $formatted ) && '' !== $formatted ) {
				return $formatted;
			}
		}
		return gmdate( 'Y-m-d H:i', $unix );
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

	private static function esc_attr_safe( string $value ): string {
		return function_exists( 'esc_attr' ) ? esc_attr( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_url_safe( string $value ): string {
		return function_exists( 'esc_url' ) ? esc_url( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}
