<?php
/**
 * Read-only database sizing for the gated "Database" feature: per-table size and
 * reclaimable overhead (`DATA_FREE`), the whole-DB totals, and the heaviest
 * autoloaded options. This is the read half that fuses with the cleanup engine
 * in the console's one Database cockpit — it measures the bloat the cleaners
 * remove, without ever mutating a thing.
 *
 * TRUST MODEL. Same as IWSL_DB_Optimizer: the `db_optimization` gate is
 * re-checked here as STATEMENT 1, and it returns BEFORE the database handle is
 * ever touched — a locked site performs zero queries. No console-invocable
 * surface of its own; it is only ever reached through the signed `db.analyze`
 * command's runner (which gates again).
 *
 * SAFETY. SELECT-ONLY — it never issues a write, DDL, DELETE, or OPTIMIZE.
 * Identifiers are hardcoded (`information_schema.TABLES`, its columns, and the
 * `$wpdb` core-table properties); the ONLY value that ever reaches a query is the
 * validated table prefix, bound through prepare() as an escaped LIKE. Option
 * VALUES NEVER cross the wire: the autoload read selects `LENGTH(option_value)`,
 * never `option_value` itself, so a secret stored in an autoloaded option cannot
 * leak into the signed response.
 *
 * UNKNOWN, NEVER ZERO. Hardened hosts restrict `information_schema`; when the
 * size read returns nothing, sizes are reported as `null` ("unknown") with
 * `schema_available => false` — never as a misleading zero (the degenerate-
 * snapshot lesson). WordPress calls are absent (pure `$wpdb`), so it runs under
 * the zero-dependency harness with an injected recording fake.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_DB_Analyzer {

	/** The entitlement flag this read gates on — the same one the optimizer uses. */
	const FEATURE = 'db_optimization';

	/** Bytes per mebibyte, for the MB projection. */
	const BYTES_PER_MB = 1048576;

	/** Bytes per kibibyte, for the autoload KB projection. */
	const BYTES_PER_KB = 1024;

	/** Cap on the autoload top-offenders list returned in the signed response. */
	const AUTOLOAD_TOP_N = 20;

	/**
	 * The autoloaded states, per WordPress 6.6+ (`wp_load_alloptions`). Hardcoded
	 * literals — no input ever reaches this predicate, so it interpolates safely.
	 */
	const AUTOLOAD_STATES = "'yes','on','auto','auto-on'";

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var object|null A `$wpdb`-like handle (prepare/get_var/get_results + table props). */
	private $db;

	/** @var callable():int current unix ms (unused today; kept for parity/injection). */
	private $now_ms;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param object|null       $db           A `$wpdb`-like handle; defaults to the global $wpdb.
	 * @param callable|null     $now_ms       Clock, mirrors the optimizer's constructor.
	 */
	public function __construct( IWSL_Entitlements $entitlements, $db = null, ?callable $now_ms = null ) {
		$this->entitlements = $entitlements;
		$this->db           = null !== $db ? $db : self::default_db();
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/** The global $wpdb under WordPress, or null outside it (harness). @return object|null */
	private static function default_db() {
		return isset( $GLOBALS['wpdb'] ) && is_object( $GLOBALS['wpdb'] ) ? $GLOBALS['wpdb'] : null;
	}

	/**
	 * The read-only size/overhead/autoload snapshot. STATEMENT 1 is the
	 * authoritative gate — a locked site touches the database not at all. On an
	 * unlocked site with a restricted `information_schema`, sizes are `null`
	 * (unknown), never zero.
	 *
	 * @return array{
	 *   unlocked:bool,
	 *   totals:array{ db_mb:float|null, overhead_mb:float|null },
	 *   tables:array<int, array{ name:string, size_mb:float, overhead_mb:float }>,
	 *   autoload:array{ count:int, kb:float|null, top:array<int, array{ name:string, kb:float }> },
	 *   schema_available:bool
	 * }
	 */
	public function analyze(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) || ! is_object( $this->db ) ) {
			return self::unknown( ! empty( $gate['unlocked'] ) );
		}

		$sizes = $this->read_sizes();
		$auto  = $this->read_autoload();

		return array(
			'unlocked'         => true,
			'totals'           => $sizes['totals'],
			'tables'           => $sizes['tables'],
			'autoload'         => $auto,
			'schema_available' => $sizes['schema_available'],
		);
	}

	/**
	 * Per-table size + overhead from `information_schema`, this site's tables only
	 * (prefix-filtered), largest first. Empty result ⇒ restricted schema ⇒ unknown
	 * sizes (`null` totals, empty list, schema_available false).
	 *
	 * @return array{ totals:array{db_mb:float|null,overhead_mb:float|null}, tables:array, schema_available:bool }
	 */
	private function read_sizes(): array {
		$prefix = isset( $this->db->prefix ) ? (string) $this->db->prefix : '';
		if ( '' === $prefix || ! preg_match( '/^[a-z0-9_]+$/', $prefix )
			|| ! method_exists( $this->db, 'get_results' ) || ! method_exists( $this->db, 'prepare' ) ) {
			return array( 'totals' => array( 'db_mb' => null, 'overhead_mb' => null ), 'tables' => array(), 'schema_available' => false );
		}

		$like = $this->db->esc_like( $prefix ) . '%';
		$sql  = $this->db->prepare(
			'SELECT TABLE_NAME AS name, DATA_LENGTH AS data_len, INDEX_LENGTH AS index_len, DATA_FREE AS data_free
			 FROM information_schema.TABLES
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE %s',
			$like
		);
		$rows = $this->db->get_results( $sql );
		if ( ! is_array( $rows ) || array() === $rows ) {
			return array( 'totals' => array( 'db_mb' => null, 'overhead_mb' => null ), 'tables' => array(), 'schema_available' => false );
		}

		$tables    = array();
		$total_len = 0;
		$total_ovh = 0;
		foreach ( $rows as $row ) {
			$name = isset( $row->name ) ? (string) $row->name : '';
			if ( '' === $name ) {
				continue;
			}
			$len = (int) ( $row->data_len ?? 0 ) + (int) ( $row->index_len ?? 0 );
			$ovh = (int) ( $row->data_free ?? 0 );
			$tables[] = array(
				'name'        => $name,
				'size_mb'     => round( $len / self::BYTES_PER_MB, 2 ),
				'overhead_mb' => round( $ovh / self::BYTES_PER_MB, 2 ),
			);
			$total_len += $len;
			$total_ovh += $ovh;
		}
		usort(
			$tables,
			static function ( array $a, array $b ): int {
				return $b['size_mb'] <=> $a['size_mb'];
			}
		);

		return array(
			'totals'           => array(
				'db_mb'       => round( $total_len / self::BYTES_PER_MB, 2 ),
				'overhead_mb' => round( $total_ovh / self::BYTES_PER_MB, 2 ),
			),
			'tables'           => $tables,
			'schema_available' => true,
		);
	}

	/**
	 * The autoload weight: count, total KB, and the top-N heaviest options by
	 * value length — NAMES and BYTE SIZES only, never the values. The options
	 * table is core (always readable), so a zero count here is a true zero.
	 *
	 * @return array{ count:int, kb:float|null, top:array<int, array{ name:string, kb:float }> }
	 */
	private function read_autoload(): array {
		if ( ! isset( $this->db->options ) || ! method_exists( $this->db, 'get_var' )
			|| ! method_exists( $this->db, 'get_results' ) || ! method_exists( $this->db, 'prepare' ) ) {
			return array( 'count' => 0, 'kb' => null, 'top' => array() );
		}
		$options = $this->db->options;
		$states  = self::AUTOLOAD_STATES;

		$count = (int) $this->db->get_var( "SELECT COUNT(*) FROM {$options} WHERE autoload IN ({$states})" );
		$bytes = $this->db->get_var( "SELECT SUM(LENGTH(option_value)) FROM {$options} WHERE autoload IN ({$states})" );
		$kb    = null === $bytes ? 0.0 : round( ( (float) $bytes ) / self::BYTES_PER_KB, 2 );

		$top_sql = $this->db->prepare(
			"SELECT option_name AS name, LENGTH(option_value) AS sz
			 FROM {$options} WHERE autoload IN ({$states})
			 ORDER BY sz DESC LIMIT %d",
			self::AUTOLOAD_TOP_N
		);
		$rows = $this->db->get_results( $top_sql );
		$top  = array();
		if ( is_array( $rows ) ) {
			foreach ( $rows as $row ) {
				$name = isset( $row->name ) ? (string) $row->name : '';
				if ( '' === $name ) {
					continue;
				}
				$top[] = array(
					'name' => $name,
					'kb'   => round( ( (int) ( $row->sz ?? 0 ) ) / self::BYTES_PER_KB, 2 ),
				);
			}
		}
		return array( 'count' => $count, 'kb' => $kb, 'top' => $top );
	}

	/**
	 * The "no signal" snapshot: locked, or unlocked-but-no-handle. Sizes are
	 * `null` (unknown), never zero. $unlocked distinguishes a locked site (false)
	 * from an unlocked one that simply has no `$wpdb` handle.
	 */
	private static function unknown( bool $unlocked ): array {
		return array(
			'unlocked'         => $unlocked,
			'totals'           => array( 'db_mb' => null, 'overhead_mb' => null ),
			'tables'           => array(),
			'autoload'         => array( 'count' => 0, 'kb' => null, 'top' => array() ),
			'schema_available' => false,
		);
	}
}
