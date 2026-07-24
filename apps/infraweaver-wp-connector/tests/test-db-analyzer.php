<?php
/**
 * IWSL_DB_Analyzer — read-only size/overhead/autoload analysis for `db.analyze`.
 *
 * Runs under the zero-dependency harness with a recording fake $wpdb that also
 * implements get_results(). Proves: the gate blocks before any DB touch; sizes
 * sum and sort largest-first; a restricted information_schema reads as UNKNOWN
 * (null totals) never zero; the autoload read selects LENGTH(option_value) —
 * never the value itself — and is LIMIT-capped; a hostile prefix issues no
 * information_schema query.
 */

// ── recording fake $wpdb (records every read; returns canned datasets) ─────────

final class IWSL_DBA_Fake_WPDB {

	public $prefix  = 'wp_';
	public $options = 'wp_options';

	/** @var array<int,string> every query string handed to get_var()/get_results(). */
	public $reads = array();
	/** @var int prepare() call count. */
	public $prepare_calls = 0;

	/** @var array<int,object> canned information_schema rows. */
	private $table_rows;
	/** @var array<int,object> canned autoload top rows. */
	private $autoload_top;
	private $autoload_count;
	private $autoload_bytes;

	public function __construct( array $table_rows = array(), array $autoload_top = array(), int $count = 0, $bytes = null ) {
		$this->table_rows     = $table_rows;
		$this->autoload_top   = $autoload_top;
		$this->autoload_count = $count;
		$this->autoload_bytes = $bytes;
	}

	public function esc_like( string $text ): string {
		return addcslashes( $text, '_%\\' );
	}

	public function prepare( string $query, ...$args ): string {
		$this->prepare_calls++;
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
		if ( false !== strpos( $query, 'COUNT(*)' ) ) {
			return (string) $this->autoload_count;
		}
		if ( false !== strpos( $query, 'SUM(LENGTH' ) ) {
			return null === $this->autoload_bytes ? null : (string) $this->autoload_bytes;
		}
		return null;
	}

	public function get_results( string $query ) {
		$this->reads[] = $query;
		if ( false !== strpos( $query, 'information_schema' ) ) {
			return $this->table_rows;
		}
		if ( false !== strpos( $query, 'option_name' ) ) {
			return $this->autoload_top;
		}
		return array();
	}
}

function iwsl_dba_clock( int $now ): callable {
	return static function () use ( $now ): int {
		return $now;
	};
}

function iwsl_dba_entitlements( bool $flag, int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array( 'plus' => true, 'db_optimization' => $flag ) );
	return new IWSL_Entitlements( $store, iwsl_dba_clock( $now ) );
}

function iwsl_dba_row( string $name, int $data, int $index, int $free ): object {
	return (object) array( 'name' => $name, 'data_len' => $data, 'index_len' => $index, 'data_free' => $free );
}

$A_NOW = 40000000;

// ── 1. Gate blocks: the database is NEVER touched ─────────────────────────────

$fake1 = new IWSL_DBA_Fake_WPDB( array( iwsl_dba_row( 'wp_posts', 1048576, 0, 0 ) ) );
$a1    = new IWSL_DB_Analyzer( iwsl_dba_entitlements( false, $A_NOW ), $fake1, iwsl_dba_clock( $A_NOW ) );
$r1    = $a1->analyze();
iwsl_assert_same( false, $r1['unlocked'], 'gate blocks: unlocked=false' );
iwsl_assert_same( null, $r1['totals']['db_mb'], 'gate blocks: db_mb unknown (null), never a fake zero' );
iwsl_assert_same( false, $r1['schema_available'], 'gate blocks: schema_available false' );
iwsl_assert_same( 0, $fake1->prepare_calls, 'gate blocks: prepare NEVER called' );
iwsl_assert_same( 0, count( $fake1->reads ), 'gate blocks: no get_var/get_results issued' );

// ── 2. Unlocked: sizes sum, tables sort largest-first, overhead totals ────────

$rows2 = array(
	iwsl_dba_row( 'wp_options', 2 * 1048576, 1048576, 512 * 1024 ),  // 3 MB, 0.5 MB overhead
	iwsl_dba_row( 'wp_posts', 8 * 1048576, 2 * 1048576, 0 ),          // 10 MB, 0 overhead
	iwsl_dba_row( 'wp_postmeta', 1048576, 0, 1048576 ),               // 1 MB, 1 MB overhead
);
$fake2 = new IWSL_DBA_Fake_WPDB( $rows2, array(), 120, 700 * 1024 );
$a2    = new IWSL_DB_Analyzer( iwsl_dba_entitlements( true, $A_NOW ), $fake2, iwsl_dba_clock( $A_NOW ) );
$r2    = $a2->analyze();
iwsl_assert_same( true, $r2['unlocked'], 'unlocked: unlocked=true' );
iwsl_assert_same( true, $r2['schema_available'], 'unlocked: schema_available true (rows present)' );
iwsl_assert_same( 14.0, $r2['totals']['db_mb'], 'unlocked: db_mb = sum of size (10+3+1)' );
iwsl_assert_same( 1.5, $r2['totals']['overhead_mb'], 'unlocked: overhead_mb = sum of DATA_FREE (0.5+1)' );
iwsl_assert_same( 3, count( $r2['tables'] ), 'unlocked: all tables reported' );
iwsl_assert_same( 'wp_posts', $r2['tables'][0]['name'], 'unlocked: largest table first' );
iwsl_assert_same( 10.0, $r2['tables'][0]['size_mb'], 'unlocked: largest table size correct' );
iwsl_assert_same( 'wp_postmeta', $r2['tables'][2]['name'], 'unlocked: smallest table last' );
// Only SELECTs — no write/DDL verbs anywhere.
$no_write2 = true;
foreach ( $fake2->reads as $q ) {
	if ( preg_match( '/\b(DELETE|DROP|TRUNCATE|ALTER|OPTIMIZE|UPDATE|INSERT)\b/i', $q ) ) {
		$no_write2 = false;
	}
}
iwsl_assert( true === $no_write2, 'unlocked: analyzer issues SELECT reads only (no write/DDL verbs)' );

// ── 3. Restricted information_schema → UNKNOWN, never zero ─────────────────────

$fake3 = new IWSL_DBA_Fake_WPDB( array(), array(), 10, 4096 ); // empty table rows = restricted
$a3    = new IWSL_DB_Analyzer( iwsl_dba_entitlements( true, $A_NOW ), $fake3, iwsl_dba_clock( $A_NOW ) );
$r3    = $a3->analyze();
iwsl_assert_same( false, $r3['schema_available'], 'restricted: schema_available false' );
iwsl_assert_same( null, $r3['totals']['db_mb'], 'restricted: db_mb null (unknown), NOT zero' );
iwsl_assert_same( null, $r3['totals']['overhead_mb'], 'restricted: overhead_mb null (unknown), NOT zero' );
iwsl_assert_same( array(), $r3['tables'], 'restricted: no tables listed' );
iwsl_assert_same( 10, $r3['autoload']['count'], 'restricted: autoload (options table) still read — it is core' );

// ── 4. Autoload: names + KB only, LIMIT-capped, option_value NEVER selected ───

$top4 = array(
	(object) array( 'name' => 'cron', 'sz' => 200 * 1024 ),
	(object) array( 'name' => 'rewrite_rules', 'sz' => 100 * 1024 ),
);
$fake4 = new IWSL_DBA_Fake_WPDB( array( iwsl_dba_row( 'wp_options', 1048576, 0, 0 ) ), $top4, 340, 512 * 1024 );
$a4    = new IWSL_DB_Analyzer( iwsl_dba_entitlements( true, $A_NOW ), $fake4, iwsl_dba_clock( $A_NOW ) );
$r4    = $a4->analyze();
iwsl_assert_same( 340, $r4['autoload']['count'], 'autoload: count reported' );
iwsl_assert_same( 512.0, $r4['autoload']['kb'], 'autoload: total KB from SUM(LENGTH)/1024' );
iwsl_assert_same( 2, count( $r4['autoload']['top'] ), 'autoload: top offenders returned' );
iwsl_assert_same( 'cron', $r4['autoload']['top'][0]['name'], 'autoload: heaviest option first (name only)' );
iwsl_assert_same( 200.0, $r4['autoload']['top'][0]['kb'], 'autoload: option KB reported' );
$top_keys_ok = true;
foreach ( $r4['autoload']['top'] as $entry ) {
	if ( array( 'name', 'kb' ) !== array_keys( $entry ) ) {
		$top_keys_ok = false;
	}
}
iwsl_assert( true === $top_keys_ok, 'autoload: each top entry carries ONLY name + kb (no value key)' );
// The wire invariant: no query ever SELECTs the option_value itself, only its LENGTH.
$leaks_value = false;
$has_limit   = false;
foreach ( $fake4->reads as $q ) {
	if ( preg_match( '/(SELECT|,)\s*option_value\b/i', $q ) ) {
		$leaks_value = true; // bare option_value selected — forbidden
	}
	if ( false !== strpos( $q, 'option_name' ) && false !== stripos( $q, 'LIMIT' ) && false !== strpos( $q, (string) IWSL_DB_Analyzer::AUTOLOAD_TOP_N ) ) {
		$has_limit = true;
	}
}
iwsl_assert( false === $leaks_value, 'autoload: option_value is NEVER selected — only LENGTH(option_value)' );
iwsl_assert( true === $has_limit, 'autoload: the top query is LIMIT-capped to AUTOLOAD_TOP_N (20)' );

// ── 5. Hostile prefix → no information_schema query, still no crash ────────────

$fake5         = new IWSL_DBA_Fake_WPDB( array( iwsl_dba_row( 'wp_posts', 1048576, 0, 0 ) ), array(), 5, 1024 );
$fake5->prefix = 'wp_; DROP TABLE x;--';
$a5            = new IWSL_DB_Analyzer( iwsl_dba_entitlements( true, $A_NOW ), $fake5, iwsl_dba_clock( $A_NOW ) );
$r5            = $a5->analyze();
iwsl_assert_same( false, $r5['schema_available'], 'hostile prefix: schema treated as unknown' );
iwsl_assert_same( null, $r5['totals']['db_mb'], 'hostile prefix: db_mb unknown (null)' );
$hit_infoschema = false;
foreach ( $fake5->reads as $q ) {
	if ( false !== strpos( $q, 'information_schema' ) ) {
		$hit_infoschema = true;
	}
}
iwsl_assert( false === $hit_infoschema, 'hostile prefix: NO information_schema query is ever issued' );

// ── 6. Unlocked but no db handle → unknown, unlocked=true, zero size ──────────

$a6 = new IWSL_DB_Analyzer( iwsl_dba_entitlements( true, $A_NOW ), null, iwsl_dba_clock( $A_NOW ) );
$r6 = $a6->analyze();
iwsl_assert_same( true, $r6['unlocked'], 'no-handle: unlocked=true (tier grants it)' );
iwsl_assert_same( false, $r6['schema_available'], 'no-handle: schema_available false' );
iwsl_assert_same( null, $r6['totals']['db_mb'], 'no-handle: db_mb unknown (null)' );
