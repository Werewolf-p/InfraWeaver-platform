<?php
/**
 * Database Cleanup & Optimization (gate flag `db_optimization`): the generic
 * engine (IWSL_DB_Optimizer) + the pluggable cleaners.
 *
 * Runs under the zero-dependency harness: the entitlement gate reads an in-memory
 * IWSL_Memory_Store with an injected clock, and a RECORDING FAKE $wpdb records
 * every prepare()/get_var()/query() and returns canned counts — so we can prove
 * the gate blocks BEFORE the database is ever touched, that preview issues ZERO
 * DELETE, that every mutation is a prepared, LIMIT-bounded DELETE, that no table
 * name is ever taken from input, and that OPTIMIZE only targets the core-table
 * allow-list. No WordPress and no real database are required.
 */

// ── recording fake $wpdb (records every call; returns canned scalars) ─────────

final class IWSL_DB_Fake_WPDB {

	/** Core-table properties — the ONLY legitimate identifiers a cleaner may use. */
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

	/** @var int number of prepare() calls. */
	public $prepare_calls = 0;
	/** @var array<int, array{query:string, args:array}> recorded prepare() invocations. */
	public $prepared = array();
	/** @var string[] strings passed to get_var(). */
	public $selects = array();
	/** @var string[] strings passed to query(). */
	public $writes = array();

	/** @var int canned COUNT(*) value. */
	private $count_value;
	/** @var int canned rows-affected value for query(). */
	private $deleted_value;

	public function __construct( int $count = 0, int $deleted = 0 ) {
		$this->count_value   = $count;
		$this->deleted_value = $deleted;
	}

	public function esc_like( string $text ): string {
		return addcslashes( $text, '_%\\' );
	}

	public function prepare( string $query, ...$args ): string {
		$this->prepare_calls++;
		$this->prepared[] = array(
			'query' => $query,
			'args'  => $args,
		);
		// Interpolate %s/%d left-to-right with no regex backreference hazards.
		$out = $query;
		foreach ( $args as $a ) {
			$repl  = is_int( $a ) ? (string) $a : "'" . str_replace( "'", "''", (string) $a ) . "'";
			$pos_s = strpos( $out, '%s' );
			$pos_d = strpos( $out, '%d' );
			if ( false !== $pos_s && ( false === $pos_d || $pos_s < $pos_d ) ) {
				$pos = $pos_s;
			} elseif ( false !== $pos_d ) {
				$pos = $pos_d;
			} else {
				$pos = false;
			}
			if ( false !== $pos ) {
				$out = substr( $out, 0, $pos ) . $repl . substr( $out, $pos + 2 );
			}
		}
		return $out;
	}

	public function get_var( string $query ) {
		$this->selects[] = $query;
		return (string) $this->count_value; // $wpdb->get_var returns string|null
	}

	public function query( string $query ) {
		$this->writes[] = $query;
		return $this->deleted_value;
	}

	/** The full set of hardcoded table-name identifiers this fake exposes. @return string[] */
	public function table_names(): array {
		return array(
			$this->posts,
			$this->postmeta,
			$this->comments,
			$this->commentmeta,
			$this->options,
			$this->terms,
			$this->termmeta,
			$this->term_relationships,
			$this->term_taxonomy,
			$this->users,
			$this->usermeta,
			$this->links,
		);
	}
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function iwsl_db_clock( int $now ): callable {
	return static function () use ( $now ): int {
		return $now;
	};
}

/** Unlocked gate: active + fresh heartbeat + db_optimization flag. */
function iwsl_db_unlocked_entitlements( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'plus' => true, 'db_optimization' => true ) );
	return new IWSL_Entitlements( $store, iwsl_db_clock( $now ) );
}

/** Entitlements over an explicit store shape — one knob per leg. */
function iwsl_db_entitlements( string $state, int $last_verified_at, bool $flag, int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $last_verified_at );
	$store->set( 'entitlements', array( 'plus' => true, 'db_optimization' => $flag ) );
	return new IWSL_Entitlements( $store, iwsl_db_clock( $now ) );
}

$DB_NOW = 30000000;

// Clear any leftover lock from a prior suite's shared transient stub.
if ( isset( $GLOBALS['iwsl_mo_transients'] ) ) {
	$GLOBALS['iwsl_mo_transients'] = array();
}

// ── 1. Gate blocks a lower tier: the database is NEVER touched ─────────────────

// (a) db_optimization flag ABSENT.
$fake1 = new IWSL_DB_Fake_WPDB( 9, 3 );
$ent1  = iwsl_db_entitlements( 'active', $DB_NOW - 60000, false, $DB_NOW );
$opt1  = new IWSL_DB_Optimizer( $ent1, $fake1, iwsl_db_clock( $DB_NOW ) );
$r1    = $opt1->run( 'run' ); // even a mutating request must be blocked
iwsl_assert_same( false, $r1['ok'], 'gate blocks (absent flag): ok=false' );
iwsl_assert_same( 'entitlement-locked', $r1['reason'], 'gate blocks (absent flag): entitlement-locked' );
iwsl_assert_same( 0, $r1['total'], 'gate blocks (absent flag): total=0' );
iwsl_assert_same( array(), $r1['cleaners'], 'gate blocks (absent flag): no cleaners ran' );
iwsl_assert_same( 0, $fake1->prepare_calls, 'gate blocks (absent flag): $wpdb->prepare NEVER called' );
iwsl_assert_same( 0, count( $fake1->selects ), 'gate blocks (absent flag): $wpdb->get_var NEVER called' );
iwsl_assert_same( 0, count( $fake1->writes ), 'gate blocks (absent flag): $wpdb->query NEVER called' );

// (b) state != active, even WITH the flag true.
$fake1b = new IWSL_DB_Fake_WPDB( 9, 3 );
$ent1b  = iwsl_db_entitlements( 'pending', $DB_NOW - 60000, true, $DB_NOW );
$opt1b  = new IWSL_DB_Optimizer( $ent1b, $fake1b, iwsl_db_clock( $DB_NOW ) );
$r1b    = $opt1b->run( 'run' );
iwsl_assert_same( 'entitlement-locked', $r1b['reason'], 'gate blocks (not active): entitlement-locked despite flag' );
iwsl_assert_same( 0, $fake1b->prepare_calls, 'gate blocks (not active): $wpdb never touched' );
iwsl_assert_same( 0, count( $fake1b->writes ), 'gate blocks (not active): no query issued' );

// (c) stale heartbeat, even WITH the flag true.
$fake1c = new IWSL_DB_Fake_WPDB( 9, 3 );
$ent1c  = iwsl_db_entitlements( 'active', $DB_NOW - 10800000, true, $DB_NOW ); // 3h ago — stale
$opt1c  = new IWSL_DB_Optimizer( $ent1c, $fake1c, iwsl_db_clock( $DB_NOW ) );
$r1c    = $opt1c->run( 'run' );
iwsl_assert_same( 'entitlement-locked', $r1c['reason'], 'gate blocks (stale heartbeat): entitlement-locked despite flag' );
iwsl_assert_same( 0, $fake1c->prepare_calls, 'gate blocks (stale heartbeat): $wpdb never touched' );
iwsl_assert_same( 0, count( $fake1c->writes ), 'gate blocks (stale heartbeat): no query issued' );

// ── 2. Preview returns counts and issues ZERO DELETE ──────────────────────────

$fake2 = new IWSL_DB_Fake_WPDB( 5, 0 );
$opt2  = new IWSL_DB_Optimizer( iwsl_db_unlocked_entitlements( $DB_NOW ), $fake2, iwsl_db_clock( $DB_NOW ) );
$r2    = $opt2->run( 'preview' );
iwsl_assert_same( true, $r2['ok'], 'preview: ok=true' );
iwsl_assert_same( 'preview', $r2['mode'], 'preview: mode=preview' );
iwsl_assert_same( 9, count( $r2['cleaners'] ), 'preview: all 9 cleaners reported' );
iwsl_assert_same( 0, count( $fake2->writes ), 'preview: ZERO write/DELETE queries issued' );
// 8 count-based cleaners × 5 + optimize_tables (12 allow-listed tables) = 52.
iwsl_assert_same( 52, $r2['total'], 'preview: total = sum of per-cleaner counts' );
$preview_shape_ok = true;
foreach ( $r2['cleaners'] as $row ) {
	if ( ! array_key_exists( 'count', $row ) || array_key_exists( 'deleted', $row ) ) {
		$preview_shape_ok = false;
	}
}
iwsl_assert( true === $preview_shape_ok, 'preview: every row carries a count (never a deleted) field' );
// prepare() is used for every value-bearing COUNT (6); the two orphan COUNTs are
// value-less hardcoded identifiers, so they legitimately skip prepare.
iwsl_assert_same( 6, $fake2->prepare_calls, 'preview: 6 value-bearing counts go through prepare()' );
iwsl_assert_same( 8, count( $fake2->selects ), 'preview: 8 SELECT COUNT reads issued (optimize needs none)' );

// ── 3. A real run: every DELETE is prepared and LIMIT-bounded to MAX_ROWS ──────

$fake3 = new IWSL_DB_Fake_WPDB( 5, 4 ); // query() reports 4 rows removed
$opt3  = new IWSL_DB_Optimizer( iwsl_db_unlocked_entitlements( $DB_NOW ), $fake3, iwsl_db_clock( $DB_NOW ) );
$r3    = $opt3->run( 'run' );
iwsl_assert_same( true, $r3['ok'], 'run: ok=true' );
iwsl_assert_same( 'run', $r3['mode'], 'run: mode=run' );
iwsl_assert_same( 9, count( $fake3->writes ), 'run: 9 write queries (8 DELETE + 1 OPTIMIZE)' );
// 8 DELETE cleaners × 4 removed + optimize_tables (12 tables) = 44.
iwsl_assert_same( 44, $r3['total'], 'run: total = rows removed + tables optimized' );

$max          = (string) IWSL_DB_Optimizer::MAX_ROWS; // '1000'
$delete_count = 0;
$all_bounded  = true;
$all_prepared = true;
$prepared_set = array();
foreach ( $fake3->prepared as $p ) {
	$prepared_set[] = $p['query'];
}
foreach ( $fake3->writes as $w ) {
	if ( false !== strpos( $w, 'DELETE' ) ) {
		$delete_count++;
		if ( false === stripos( $w, 'LIMIT' ) || false === strpos( $w, $max ) ) {
			$all_bounded = false;
		}
	}
}
iwsl_assert_same( 8, $delete_count, 'run: exactly 8 bounded DELETE statements' );
iwsl_assert( true === $all_bounded, 'run: every DELETE is LIMIT-bounded to MAX_ROWS (1000)' );
iwsl_assert_same( 8, $fake3->prepare_calls, 'run: all 8 DELETE statements go through prepare()' );
// No DELETE ever DROPs/TRUNCATEs/ALTERs.
$no_ddl = true;
foreach ( $fake3->writes as $w ) {
	if ( false !== strpos( $w, 'DROP' ) || false !== strpos( $w, 'TRUNCATE' ) || false !== strpos( $w, 'ALTER' ) ) {
		$no_ddl = false;
	}
}
iwsl_assert( true === $no_ddl, 'run: no DROP/TRUNCATE/ALTER anywhere in the issued SQL' );

// Every issued query references ONLY the fake $wpdb's hardcoded table names — no
// identifier is ever assembled from anything but a $db table property.
$known = $fake3->table_names();
$only_known_tables = true;
foreach ( array_merge( $fake3->selects, $fake3->writes ) as $q ) {
	if ( preg_match_all( '/\bwp_[a-z_]+/', $q, $m ) ) {
		foreach ( $m[0] as $ident ) {
			if ( ! in_array( $ident, $known, true ) ) {
				$only_known_tables = false;
			}
		}
	}
}
iwsl_assert( true === $only_known_tables, 'run: every table identifier in every query is a hardcoded $wpdb property' );

// ── 4. Idempotent second run (no cross-run state; lock released) ───────────────

$r3b = $opt3->run( 'run' );
iwsl_assert_same( true, $r3b['ok'], 'idempotent: second run also ok (lock was released)' );
iwsl_assert_same( $r3['total'], $r3b['total'], 'idempotent: second run is deterministic (engine holds no state)' );

// ── 5. No table name is ever taken from input (unknown ids select nothing) ─────

$fake5 = new IWSL_DB_Fake_WPDB( 5, 0 );
$opt5  = new IWSL_DB_Optimizer( iwsl_db_unlocked_entitlements( $DB_NOW ), $fake5, iwsl_db_clock( $DB_NOW ) );
$r5    = $opt5->run( 'preview', array( 'wp_users; DROP TABLE wp_posts', 'evil_table', '' ) );
iwsl_assert_same( 0, count( $r5['cleaners'] ), 'input ids: malicious/unknown ids select NOTHING' );
iwsl_assert_same( 0, $fake5->prepare_calls, 'input ids: no query built for unknown ids' );
iwsl_assert_same( 0, count( $fake5->selects ), 'input ids: no SELECT issued for unknown ids' );
iwsl_assert_same( 0, count( $fake5->writes ), 'input ids: no write issued for unknown ids' );

// A valid subset id selects exactly that cleaner (allow-listed against the registry).
$fake5b = new IWSL_DB_Fake_WPDB( 5, 0 );
$opt5b  = new IWSL_DB_Optimizer( iwsl_db_unlocked_entitlements( $DB_NOW ), $fake5b, iwsl_db_clock( $DB_NOW ) );
$r5b    = $opt5b->run( 'preview', array( 'spam_comments' ) );
iwsl_assert_same( 1, count( $r5b['cleaners'] ), 'input ids: a valid id selects exactly one cleaner' );
iwsl_assert_same( 'spam_comments', $r5b['cleaners'][0]['id'], 'input ids: the selected cleaner is the requested one' );

// ── 6. OPTIMIZE only targets the allow-listed core tables ─────────────────────

$fake6 = new IWSL_DB_Fake_WPDB( 0, 0 );
$opt6  = new IWSL_DB_Optimizer(
	iwsl_db_unlocked_entitlements( $DB_NOW ),
	$fake6,
	iwsl_db_clock( $DB_NOW ),
	array( 'optimize_tables' => new IWSL_DB_Optimize_Tables_Cleaner() )
);
$r6 = $opt6->run( 'run' );
iwsl_assert_same( 1, count( $fake6->writes ), 'optimize: exactly one OPTIMIZE statement' );
$optimize_sql = $fake6->writes[0];
iwsl_assert( 0 === strpos( $optimize_sql, 'OPTIMIZE TABLE ' ), 'optimize: statement is OPTIMIZE TABLE …' );
iwsl_assert(
	false === strpos( $optimize_sql, 'DROP' ) && false === strpos( $optimize_sql, 'TRUNCATE' ) && false === strpos( $optimize_sql, 'ALTER' ),
	'optimize: never DROP/TRUNCATE/ALTER'
);
$allow = array();
foreach ( IWSL_DB_Optimize_Tables_Cleaner::CORE_TABLES as $t ) {
	$allow[] = 'wp_' . $t;
}
$listed      = array_map( 'trim', explode( ',', trim( substr( $optimize_sql, strlen( 'OPTIMIZE TABLE ' ) ) ) ) );
$all_allowed = true;
foreach ( $listed as $t ) {
	if ( ! in_array( $t, $allow, true ) ) {
		$all_allowed = false;
	}
}
iwsl_assert( true === $all_allowed, 'optimize: every optimized table is on the hardcoded core allow-list under the prefix' );
iwsl_assert_same( count( $allow ), count( $listed ), 'optimize: all allow-listed core tables are covered' );
iwsl_assert_same( count( $allow ), $r6['cleaners'][0]['deleted'], 'optimize run: reports the number of tables optimized' );

// A hostile $wpdb->prefix collapses the allow-list to empty — no OPTIMIZE issued.
$fake6b         = new IWSL_DB_Fake_WPDB( 0, 0 );
$fake6b->prefix = 'wp_; DROP TABLE x;--';
$opt6b          = new IWSL_DB_Optimizer(
	iwsl_db_unlocked_entitlements( $DB_NOW ),
	$fake6b,
	iwsl_db_clock( $DB_NOW ),
	array( 'optimize_tables' => new IWSL_DB_Optimize_Tables_Cleaner() )
);
$r6b = $opt6b->run( 'run' );
iwsl_assert_same( 0, count( $fake6b->writes ), 'optimize: hostile prefix → allow-list empty, no OPTIMIZE issued' );
iwsl_assert_same( 0, $r6b['total'], 'optimize: hostile prefix → nothing optimized' );

// ── 7. Registry + capabilities sanity ─────────────────────────────────────────

$registry = IWSL_DB_Optimizer::cleaners();
$expected = array(
	'expired_transients',
	'post_revisions',
	'auto_drafts',
	'trashed_posts',
	'spam_comments',
	'trashed_comments',
	'orphaned_postmeta',
	'orphaned_termmeta',
	'optimize_tables',
);
iwsl_assert_same( $expected, array_keys( $registry ), 'registry: the nine cleaners are registered in order' );
$all_impl   = true;
$id_shape   = true;
foreach ( $registry as $key => $cleaner ) {
	if ( ! $cleaner instanceof IWSL_DB_Cleaner ) {
		$all_impl = false;
	}
	if ( $cleaner->id() !== $key || ! preg_match( '/^[a-z0-9_]{1,32}$/', $cleaner->id() ) ) {
		$id_shape = false;
	}
}
iwsl_assert( true === $all_impl, 'registry: every entry implements IWSL_DB_Cleaner' );
iwsl_assert( true === $id_shape, 'registry: every id matches [a-z0-9_]{1,32} and keys its own entry' );

// ── 8. Run lock prevents overlap (busy refusal) ───────────────────────────────

if ( function_exists( 'set_transient' ) && function_exists( 'get_transient' ) && function_exists( 'delete_transient' ) ) {
	set_transient( 'iwsl_db_optimizer_lock', 12345, 60 ); // simulate a run already in flight
	$fake8 = new IWSL_DB_Fake_WPDB( 5, 0 );
	$opt8  = new IWSL_DB_Optimizer( iwsl_db_unlocked_entitlements( $DB_NOW ), $fake8, iwsl_db_clock( $DB_NOW ) );
	$r8    = $opt8->run( 'preview' );
	iwsl_assert_same( 'busy', $r8['reason'], 'lock: a run while the lock is held is refused as busy' );
	iwsl_assert_same( 0, $fake8->prepare_calls, 'lock: busy refusal touches the database not at all' );
	delete_transient( 'iwsl_db_optimizer_lock' );
} else {
	echo "  [skip] run-lock busy refusal — no transient stub in this run\n";
}

// ── 9. No-database refusal (unlocked but no handle) mutates nothing ────────────

$opt9 = new IWSL_DB_Optimizer( iwsl_db_unlocked_entitlements( $DB_NOW ), null, iwsl_db_clock( $DB_NOW ) );
$r9   = $opt9->run( 'run' );
iwsl_assert_same( false, $r9['ok'], 'no-database: ok=false' );
iwsl_assert_same( 'no-database', $r9['reason'], 'no-database: refused with reason no-database' );
iwsl_assert_same( 0, $r9['total'], 'no-database: nothing done' );
