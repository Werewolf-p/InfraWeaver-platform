<?php
/**
 * A capped ring of recent REAL (non-dry) database-cleanup runs, backed by an
 * IWSL_Store. This is the "why did the DB shrink?" ledger the console and
 * WP-admin both read: every genuine cleanup — whether triggered from the
 * console (`db.cleanup`), the WP-admin tool, or the WP-Cron schedule — appends
 * one compact entry here; PREVIEWS (dry runs) never touch it, so a preview stays
 * truly side-effect-free down to the storage layer.
 *
 * BOUNDED BY CONSTRUCTION. The ring keeps at most MAX_ENTRIES newest-first; an
 * append evicts the oldest, so the key can never grow without bound (the same
 * discipline the whole DB feature is built on). Immutable: every write reads the
 * current ring, builds a FRESH array, and stores the copy — nothing is mutated
 * in place.
 *
 * SAFETY. Pure storage. It issues no SQL, holds no `$wpdb`, and normalizes every
 * value it stores (source clamped to the allow-list, ids to the registry id
 * shape, counts to non-negative ints) so a malformed summary can never smuggle a
 * table name or an unbounded blob into the option. `purge()` deletes the single
 * key on teardown. Every dependency is injected, so it runs unchanged under the
 * zero-dependency test harness.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_DB_History {

	/** Store key for the capped run ring (option `iwsl_db_cleanup_history`). */
	const STORE_KEY = 'db_cleanup_history';

	/** The ring keeps at most this many runs; the oldest is evicted on append. */
	const MAX_ENTRIES = 10;

	/** The only run sources an entry may carry — anything else is normalized to 'manual'. */
	const SOURCES = array( 'manual', 'scheduled', 'console' );

	/** Registry id shape — the only per-cleaner ids an entry may carry. */
	const ID_RE = '/^[a-z0-9_]{1,32}$/';

	/** @var IWSL_Store */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/**
	 * @param IWSL_Store    $store  Where the ring lives (memory in tests, options in WP).
	 * @param callable|null $now_ms Clock; defaults to wall-clock unix ms.
	 */
	public function __construct( IWSL_Store $store, ?callable $now_ms = null ) {
		$this->store  = $store;
		$this->now_ms = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/**
	 * Append one REAL-run entry from an engine run summary, newest first, capping
	 * the ring at MAX_ENTRIES. Immutable — reads the current ring, prepends a fresh
	 * normalized entry, writes the fresh copy. Callers only ever pass a `run`-mode
	 * summary; dry runs are never recorded (the optimizer enforces that upstream).
	 *
	 * @param array  $summary Engine run summary ({ cleaners:[{id,deleted}], total }).
	 * @param string $source  One of SOURCES; anything else clamps to 'manual'.
	 */
	public function record( array $summary, string $source ): void {
		$entry = array(
			'at'       => $this->now_seconds(),
			'source'   => in_array( $source, self::SOURCES, true ) ? $source : 'manual',
			'total'    => isset( $summary['total'] ) ? max( 0, (int) $summary['total'] ) : 0,
			'cleaners' => $this->normalize_cleaners( $summary['cleaners'] ?? array() ),
		);

		$ring = $this->all();
		array_unshift( $ring, $entry );
		if ( count( $ring ) > self::MAX_ENTRIES ) {
			$ring = array_slice( $ring, 0, self::MAX_ENTRIES );
		}
		$this->store->set( self::STORE_KEY, $ring );
	}

	/**
	 * The stored ring, newest first, every entry shape-validated on read. Returns
	 * an empty list before any run or when the stored value is malformed.
	 *
	 * @return array<int, array{ at:int, source:string, total:int, cleaners:array }>
	 */
	public function all(): array {
		$raw = $this->store->get( self::STORE_KEY, array() );
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$out = array();
		foreach ( $raw as $row ) {
			if ( ! is_array( $row ) ) {
				continue;
			}
			$out[] = array(
				'at'       => isset( $row['at'] ) ? (int) $row['at'] : 0,
				'source'   => isset( $row['source'] ) && in_array( $row['source'], self::SOURCES, true ) ? (string) $row['source'] : 'manual',
				'total'    => isset( $row['total'] ) ? max( 0, (int) $row['total'] ) : 0,
				'cleaners' => $this->normalize_cleaners( $row['cleaners'] ?? array() ),
			);
			if ( count( $out ) >= self::MAX_ENTRIES ) {
				break;
			}
		}
		return $out;
	}

	/**
	 * Teardown: delete the ring key. Returns 1 if a key existed (and was removed),
	 * 0 when already clean — the count the optimizer folds into its purge report.
	 */
	public function purge(): int {
		$had = null !== $this->store->get( self::STORE_KEY, null );
		if ( $had ) {
			$this->store->delete( self::STORE_KEY );
		}
		return $had ? 1 : 0;
	}

	/**
	 * Normalize a cleaners list to `[{ id, deleted }]`: keep only string ids of the
	 * registry shape, coerce `deleted` to a non-negative int, drop everything else.
	 * An id can therefore NEVER be an arbitrary string — only a registry-shaped
	 * token — so a stored entry can never carry a table name or injection payload.
	 *
	 * @param mixed $cleaners
	 * @return array<int, array{ id:string, deleted:int }>
	 */
	private function normalize_cleaners( $cleaners ): array {
		if ( ! is_array( $cleaners ) ) {
			return array();
		}
		$out = array();
		foreach ( $cleaners as $row ) {
			if ( ! is_array( $row ) || ! isset( $row['id'] ) || ! is_string( $row['id'] )
				|| ! preg_match( self::ID_RE, $row['id'] ) ) {
				continue;
			}
			$out[] = array(
				'id'      => $row['id'],
				'deleted' => isset( $row['deleted'] ) ? max( 0, (int) $row['deleted'] ) : 0,
			);
		}
		return $out;
	}

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}
}
