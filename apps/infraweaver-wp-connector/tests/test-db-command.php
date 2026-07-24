<?php
/**
 * The signed `db.analyze` / `db.cleanup` / `db.schedule` commands (§7 registry).
 *
 * Drives the runners directly through the private command registry (reflection,
 * as test-command-handler does) over a REAL IWSL_Plugin whose store is seeded
 * unlocked, with a recording fake $wpdb installed as $GLOBALS['wpdb'] so the
 * engines the runners build pick it up. Proves the triple gate (entitlement +
 * local switch, engine STATEMENT 1), preview-by-default at the wire, the
 * downward-only cap, console-sourced history, and strict param validators —
 * without any signed fixtures or a real database.
 */

// ── combined recording fake $wpdb (cleaners + analyzer both drive it) ─────────

final class IWSL_DBC_Fake_WPDB {

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

	/** @var string[] strings passed to query() (writes). */
	public $writes = array();
	/** @var string[] strings passed to get_var()/get_results() (reads). */
	public $reads = array();

	public function esc_like( string $text ): string {
		return addcslashes( $text, '_%\\' );
	}

	public function prepare( string $query, ...$args ): string {
		$out = $query;
		foreach ( $args as $a ) {
			$repl = is_int( $a ) ? (string) $a : "'" . str_replace( "'", "''", (string) $a ) . "'";
			$pos  = false;
			$ps   = strpos( $out, '%s' );
			$pd   = strpos( $out, '%d' );
			if ( false !== $ps && ( false === $pd || $ps < $pd ) ) {
				$pos = $ps;
			} elseif ( false !== $pd ) {
				$pos = $pd;
			}
			if ( false !== $pos ) {
				$out = substr( $out, 0, $pos ) . $repl . substr( $out, $pos + 2 );
			}
		}
		return $out;
	}

	public function get_var( string $query ) {
		$this->reads[] = $query;
		if ( false !== strpos( $query, 'SUM(LENGTH' ) ) {
			return '4096';
		}
		return '3'; // canned COUNT(*) for cleaners + autoload
	}

	public function get_results( string $query ) {
		$this->reads[] = $query;
		if ( false !== strpos( $query, 'information_schema' ) ) {
			return array(
				(object) array( 'name' => 'wp_posts', 'data_len' => 8 * 1048576, 'index_len' => 0, 'data_free' => 1048576 ),
				(object) array( 'name' => 'wp_options', 'data_len' => 1048576, 'index_len' => 0, 'data_free' => 0 ),
			);
		}
		if ( false !== strpos( $query, 'option_name' ) ) {
			return array( (object) array( 'name' => 'cron', 'sz' => 100 * 1024 ) );
		}
		return array();
	}

	public function query( string $query ) {
		$this->writes[] = $query;
		return 4; // rows affected
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

$DBC_NOW = 70000000;

function iwsl_dbc_clock( int $now ): callable {
	return static function () use ( $now ): int {
		return $now;
	};
}

/**
 * A plugin over a memory store seeded active + fresh heartbeat + the given
 * entitlement flags. Returns [ $store, $plugin ] so the store can be inspected.
 */
function iwsl_dbc_plugin( array $flags, int $now, array $switches = array() ): array {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array( 'plus' => true ) + $flags );
	if ( array() !== $switches ) {
		$store->set( IWSL_Feature_Switches::OPTION, $switches );
	}
	return array( $store, new IWSL_Plugin( $store, iwsl_dbc_clock( $now ) ) );
}

/** The private §7 command registry (fresh map; runners take the plugin as arg). */
$dbc_registry_ref = new ReflectionMethod( 'IWSL_Plugin', 'command_handlers' );
$dbc_registry_ref->setAccessible( true );
$registry = $dbc_registry_ref->invoke( null );

/** Build an envelope carrying the given params object. */
function iwsl_dbc_env( $params ): stdClass {
	$env         = new stdClass();
	$env->params = $params;
	return $env;
}

$GRANT_BOTH = array( 'db_optimization' => true, 'scheduled_db_cleanup' => true );

// ── 1. The three methods are registered + on the verifier allow-list ──────────

foreach ( array( 'db.analyze', 'db.cleanup', 'db.schedule' ) as $m ) {
	iwsl_assert( isset( $registry[ $m ] ), "registry: {$m} is registered as a signed command" );
	// array_key_exists, not isset: db.analyze's validator is null (empty-params).
	iwsl_assert( array_key_exists( $m, IWSL_Plugin::allowed_methods() ), "allow-list: {$m} is on the verifier allow-list" );
}

// ── 2. db.analyze — locked (no entitlement) returns {locked,gate}, ZERO DB touch ─

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store2, $plugin2 ) = iwsl_dbc_plugin( array(), $DBC_NOW ); // no db_optimization
list( $ok2, $res2 )       = $registry['db.analyze']->run( $plugin2, iwsl_dbc_env( new stdClass() ) );
iwsl_assert_same( true, $ok2, 'db.analyze: read command answers ok=true even when locked' );
iwsl_assert_same( true, $res2['locked'], 'db.analyze locked: locked=true' );
iwsl_assert( isset( $res2['gate'] ) && isset( $res2['caps'] ), 'db.analyze locked: carries gate + caps for the console card' );
iwsl_assert( ! isset( $res2['tables'] ), 'db.analyze locked: no sizes leaked' );
iwsl_assert_same( 0, count( $GLOBALS['wpdb']->reads ), 'db.analyze locked: ZERO database reads issued' );

// ── 3. db.analyze — switched OFF locally is locked, gate.switched_off true ─────

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store3, $plugin3 ) = iwsl_dbc_plugin( $GRANT_BOTH, $DBC_NOW, array( 'db_optimization' => false ) );
list( $ok3, $res3 )       = $registry['db.analyze']->run( $plugin3, iwsl_dbc_env( new stdClass() ) );
iwsl_assert_same( true, $res3['locked'], 'db.analyze switched-off: locked=true' );
iwsl_assert_same( true, $res3['gate']['switched_off'], 'db.analyze switched-off: gate.switched_off=true' );
iwsl_assert_same( 0, count( $GLOBALS['wpdb']->reads ), 'db.analyze switched-off: ZERO database reads issued' );

// ── 4. db.analyze — unlocked assembles the full cockpit ───────────────────────

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store4, $plugin4 ) = iwsl_dbc_plugin( $GRANT_BOTH, $DBC_NOW );
list( $ok4, $res4 )       = $registry['db.analyze']->run( $plugin4, iwsl_dbc_env( new stdClass() ) );
iwsl_assert_same( false, $res4['locked'], 'db.analyze unlocked: locked=false' );
iwsl_assert_same( 1000, $res4['caps']['max_rows'], 'db.analyze: caps.max_rows = MAX_ROWS (1000)' );
iwsl_assert_same( 9, count( $res4['caps']['categories'] ), 'db.analyze: caps.categories lists all 9 cleaner ids' );
iwsl_assert_same( 9.0, $res4['totals']['db_mb'], 'db.analyze: totals.db_mb summed from information_schema' );
iwsl_assert_same( 1.0, $res4['totals']['overhead_mb'], 'db.analyze: totals.overhead_mb from DATA_FREE' );
iwsl_assert_same( 9, count( $res4['categories'] ), 'db.analyze: 9 cleanup categories with live counts' );
iwsl_assert( isset( $res4['categories'][0]['count'] ), 'db.analyze: category rows carry a count (preview path)' );
iwsl_assert(
	array_key_exists( 'enabled', $res4['schedule'] ) && array_key_exists( 'frequency', $res4['schedule'] )
		&& array_key_exists( 'next_run', $res4['schedule'] ) && array_key_exists( 'last_run', $res4['schedule'] )
		&& array_key_exists( 'categories', $res4['schedule'] ) && array_key_exists( 'unlocked', $res4['schedule'] ),
	'db.analyze: schedule snapshot present (all keys)'
);
iwsl_assert( is_array( $res4['history'] ), 'db.analyze: history is an array' );
iwsl_assert( isset( $res4['autoload']['top'] ), 'db.analyze: autoload drill-down present' );
// The whole read path is SELECT-only — no write verb ever issued.
iwsl_assert_same( 0, count( $GLOBALS['wpdb']->writes ), 'db.analyze: issues ZERO writes (read-only)' );

// ── 5. db.cleanup — dry_run:true previews and issues ZERO deletes over the wire ─

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store5, $plugin5 ) = iwsl_dbc_plugin( $GRANT_BOTH, $DBC_NOW );
list( $ok5, $res5 )       = $registry['db.cleanup']->run( $plugin5, iwsl_dbc_env( (object) array( 'categories' => array(), 'dry_run' => true ) ) );
iwsl_assert_same( true, $ok5, 'db.cleanup preview: ok=true' );
iwsl_assert_same( 'preview', $res5['mode'], 'db.cleanup preview: mode=preview' );
iwsl_assert_same( 0, count( $GLOBALS['wpdb']->writes ), 'db.cleanup preview: ZERO DELETE/OPTIMIZE writes issued' );
iwsl_assert_same( 0, count( ( new IWSL_DB_History( $store5, iwsl_dbc_clock( $DBC_NOW ) ) )->all() ), 'db.cleanup preview: nothing recorded in history' );

// ── 6. db.cleanup — dry_run:false deletes through the engine + records history ─

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store6, $plugin6 ) = iwsl_dbc_plugin( $GRANT_BOTH, $DBC_NOW );
list( $ok6, $res6 )       = $registry['db.cleanup']->run( $plugin6, iwsl_dbc_env( (object) array( 'categories' => array( 'spam_comments' ), 'dry_run' => false ) ) );
iwsl_assert_same( true, $ok6, 'db.cleanup run: ok=true' );
iwsl_assert_same( 'run', $res6['mode'], 'db.cleanup run: mode=run' );
iwsl_assert_same( 1, count( $GLOBALS['wpdb']->writes ), 'db.cleanup run: one DELETE issued for the one category' );
iwsl_assert( false !== strpos( $GLOBALS['wpdb']->writes[0], 'DELETE' ), 'db.cleanup run: the write is a DELETE' );
$hist6 = ( new IWSL_DB_History( $store6, iwsl_dbc_clock( $DBC_NOW ) ) )->all();
iwsl_assert_same( 1, count( $hist6 ), 'db.cleanup run: a history entry is recorded' );
iwsl_assert_same( 'console', $hist6[0]['source'], 'db.cleanup run: history source is console' );

// ── 7. db.cleanup — max_rows only lowers; 999999 still LIMITs to 1000 ──────────

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store7, $plugin7 ) = iwsl_dbc_plugin( $GRANT_BOTH, $DBC_NOW );
list( $ok7, $res7 )       = $registry['db.cleanup']->run( $plugin7, iwsl_dbc_env( (object) array( 'categories' => array( 'spam_comments' ), 'dry_run' => false, 'max_rows' => 999999 ) ) );
iwsl_assert( false !== strpos( $GLOBALS['wpdb']->writes[0], 'LIMIT ' . IWSL_DB_Optimizer::MAX_ROWS ) && false === strpos( $GLOBALS['wpdb']->writes[0], '999999' ), 'db.cleanup: max_rows 999999 still issues LIMIT 1000 over the wire' );
iwsl_assert_same( 1000, $res7['cap'], 'db.cleanup: reported cap is the clamped 1000' );

// ── 8. db.cleanup — switched-off refuses without touching the engine ──────────

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store8, $plugin8 ) = iwsl_dbc_plugin( $GRANT_BOTH, $DBC_NOW, array( 'db_optimization' => false ) );
list( $ok8, $res8 )       = $registry['db.cleanup']->run( $plugin8, iwsl_dbc_env( (object) array( 'categories' => array( 'spam_comments' ), 'dry_run' => false ) ) );
iwsl_assert_same( false, $ok8, 'db.cleanup switched-off: ok=false' );
iwsl_assert_same( 'switched-off', $res8['reason'], 'db.cleanup switched-off: reason surfaced' );
iwsl_assert_same( 0, count( $GLOBALS['wpdb']->writes ), 'db.cleanup switched-off: engine NEVER touched (no writes)' );

// ── 9. db.cleanup — entitlement-locked refuses, engine STATEMENT 1 ─────────────

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store9, $plugin9 ) = iwsl_dbc_plugin( array(), $DBC_NOW ); // no db_optimization
list( $ok9, $res9 )       = $registry['db.cleanup']->run( $plugin9, iwsl_dbc_env( (object) array( 'categories' => array( 'spam_comments' ), 'dry_run' => false ) ) );
iwsl_assert_same( false, $ok9, 'db.cleanup locked: ok=false' );
iwsl_assert_same( true, $res9['locked'], 'db.cleanup locked: locked=true' );
iwsl_assert_same( 0, count( $GLOBALS['wpdb']->writes ), 'db.cleanup locked: zero writes' );

// ── 10. db.cleanup — unknown category ids select nothing (re-asserted at wire) ─

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store10, $plugin10 ) = iwsl_dbc_plugin( $GRANT_BOTH, $DBC_NOW );
list( $ok10, $res10 )       = $registry['db.cleanup']->run( $plugin10, iwsl_dbc_env( (object) array( 'categories' => array( 'evil_table' ), 'dry_run' => false ) ) );
iwsl_assert_same( 0, count( $res10['cleaners'] ), 'db.cleanup: an unknown category selects nothing' );
iwsl_assert_same( 0, count( $GLOBALS['wpdb']->writes ), 'db.cleanup: unknown category issues no write' );

// ── 11. db.schedule — saves through the SAME store WP-admin uses ──────────────

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store11, $plugin11 ) = iwsl_dbc_plugin( $GRANT_BOTH, $DBC_NOW );
list( $ok11, $res11 )       = $registry['db.schedule']->run( $plugin11, iwsl_dbc_env( (object) array( 'enabled' => true, 'frequency' => 'weekly', 'categories' => array( 'spam_comments', 'evil_id' ) ) ) );
iwsl_assert_same( true, $ok11, 'db.schedule: ok=true' );
iwsl_assert_same( true, $res11['settings']['enabled'], 'db.schedule: enabled stored' );
iwsl_assert_same( 'weekly', $res11['settings']['frequency'], 'db.schedule: frequency stored' );
iwsl_assert_same( array( 'spam_comments' ), $res11['settings']['categories'], 'db.schedule: category subset sanitized (unknown dropped)' );
// Reading through a fresh scheduler over the SAME store sees the saved settings.
$sched11 = new IWSL_Scheduled_DB_Cleanup( $plugin11->entitlements(), $store11, null, iwsl_dbc_clock( $DBC_NOW ) );
iwsl_assert_same( true, $sched11->settings()['enabled'], 'db.schedule: WP-admin surface reads the same stored setting (no drift)' );

// ── 12. db.schedule — switched-off refuses ────────────────────────────────────

$GLOBALS['wpdb'] = new IWSL_DBC_Fake_WPDB();
list( $store12, $plugin12 ) = iwsl_dbc_plugin( $GRANT_BOTH, $DBC_NOW, array( 'scheduled_db_cleanup' => false ) );
list( $ok12, $res12 )       = $registry['db.schedule']->run( $plugin12, iwsl_dbc_env( (object) array( 'enabled' => true, 'frequency' => 'daily' ) ) );
iwsl_assert_same( false, $ok12, 'db.schedule switched-off: ok=false' );
iwsl_assert_same( 'switched-off', $res12['reason'], 'db.schedule switched-off: reason surfaced' );
iwsl_assert_same( null, $store12->get( IWSL_Scheduled_DB_Cleanup::SETTINGS_KEY ), 'db.schedule switched-off: nothing stored' );

// ── 13. Strict validators reject malformed params, accept valid ones ──────────

$cleanup_validator  = $registry['db.cleanup']->validator;
$schedule_validator = $registry['db.schedule']->validator;

iwsl_assert_same( true, $cleanup_validator( (object) array( 'categories' => array( 'spam_comments' ), 'dry_run' => false ) ), 'validator db.cleanup: a well-formed request passes' );
iwsl_assert_same( true, $cleanup_validator( (object) array( 'categories' => array(), 'dry_run' => true, 'max_rows' => 100 ) ), 'validator db.cleanup: optional max_rows int passes' );
iwsl_assert_same( false, $cleanup_validator( (object) array( 'categories' => array( 'spam_comments' ), 'dry_run' => 1 ) ), 'validator db.cleanup: dry_run must be a real bool (1 rejected)' );
iwsl_assert_same( false, $cleanup_validator( (object) array( 'categories' => array( 'spam_comments' ) ) ), 'validator db.cleanup: dry_run is required' );
iwsl_assert_same( false, $cleanup_validator( (object) array( 'categories' => 'spam_comments', 'dry_run' => false ) ), 'validator db.cleanup: categories must be an array' );
iwsl_assert_same( false, $cleanup_validator( (object) array( 'categories' => array( 'a b' ), 'dry_run' => false ) ), 'validator db.cleanup: a non-id-shaped category is rejected' );
iwsl_assert_same( false, $cleanup_validator( (object) array( 'categories' => array(), 'dry_run' => false, 'max_rows' => '10' ) ), 'validator db.cleanup: max_rows must be an int' );
iwsl_assert_same( false, $cleanup_validator( (object) array( 'categories' => array(), 'dry_run' => false, 'stray' => 1 ) ), 'validator db.cleanup: a stray key is rejected' );

iwsl_assert_same( true, $schedule_validator( (object) array( 'enabled' => true, 'frequency' => 'daily' ) ), 'validator db.schedule: a well-formed request passes' );
iwsl_assert_same( true, $schedule_validator( (object) array( 'enabled' => false, 'frequency' => 'weekly', 'categories' => array( 'spam_comments' ) ) ), 'validator db.schedule: optional categories subset passes' );
iwsl_assert_same( false, $schedule_validator( (object) array( 'enabled' => true, 'frequency' => 'hourly' ) ), 'validator db.schedule: frequency must be in the allow-list' );
iwsl_assert_same( false, $schedule_validator( (object) array( 'enabled' => 'yes', 'frequency' => 'daily' ) ), 'validator db.schedule: enabled must be a real bool' );
iwsl_assert_same( false, $schedule_validator( (object) array( 'enabled' => true, 'frequency' => 'daily', 'categories' => array( 5 ) ) ), 'validator db.schedule: a non-string category is rejected' );

// ── clean up the global handle so no sibling process inherits it ──────────────

unset( $GLOBALS['wpdb'] );
