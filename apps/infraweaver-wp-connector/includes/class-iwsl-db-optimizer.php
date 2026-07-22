<?php
/**
 * Generic engine behind the gated "Database Cleanup & Optimization" feature.
 *
 * This is the payload behind the `db_optimization` entitlement, kept separate
 * from the gate (IWSL_Entitlements) and from the cleaners (IWSL_DB_Cleaner
 * implementations) so each can be reasoned about — and tested — in isolation.
 * It mirrors IWSL_Media_Optimizer exactly: an id-keyed pluggable registry, a
 * single-flight run lock, an immutable summary, and injectable dependencies so
 * the whole thing runs under the zero-dependency test harness.
 *
 * TRUST MODEL. Console-authoritative, like every other Plus feature: the
 * `db_optimization` flag is written ONLY by the dual-signed `entitlements.set`
 * runner (§7). There is deliberately NO self-set path, REST route, AJAX endpoint,
 * cron, or nopriv surface — this is a purely-local admin action. The gate is
 * re-checked at three layers (admin page, admin-post handler, and here in run()
 * as STATEMENT 1). run()'s check is the authoritative one: it survives any future
 * caller that forgets the other two, and it returns BEFORE the database handle is
 * ever touched — a locked site performs zero queries.
 *
 * SAFETY. Default DRY-RUN: run('preview') counts only and mutates nothing;
 * deletion requires the explicit run('run') that only the nonce-protected,
 * confirmed admin form issues. Every mutation is a bounded DELETE (per-DELETE
 * MAX_ROWS cap) or an OPTIMIZE TABLE over a hardcoded core-table allow-list —
 * NEVER a DROP/TRUNCATE/ALTER. No user-supplied SQL, table name or column name
 * ever reaches a cleaner; table names come only from the $wpdb handle's hardcoded
 * core-table properties. No exec/shell_exec — in-process $wpdb only. WordPress
 * calls (the lock transient) are function_exists-guarded so the engine never
 * fatals under the harness.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_DB_Optimizer {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'db_optimization';

	/** Hard per-DELETE row cap — every cleaner removes at most this many rows per run. */
	const MAX_ROWS = 1000;

	/** Per-run cleaner cap — an explicit id list can select at most this many cleaners. */
	const MAX_CLEANERS_PER_RUN = 32;

	/** Transient name for the single-flight run lock. */
	const LOCK_TRANSIENT = 'iwsl_db_optimizer_lock';

	/** Run-lock TTL (seconds). */
	const LOCK_TTL = 60;

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var object|null A `$wpdb`-like handle (prepare/get_var/query + table props). */
	private $db;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var array<string, IWSL_DB_Cleaner> id-keyed cleaner registry. */
	private $cleaners;

	/**
	 * @param IWSL_Entitlements                   $entitlements The gate.
	 * @param object|null                         $db           A `$wpdb`-like handle; defaults to the
	 *                                                           global $wpdb under WordPress. Injectable
	 *                                                           (a recording fake) for the no-WP harness.
	 * @param callable|null                       $now_ms       Clock, mirrors IWSL_Entitlements.
	 * @param array<string, IWSL_DB_Cleaner>|null $cleaners     Registry override (tests inject fakes);
	 *                                                           defaults to self::cleaners().
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		$db = null,
		?callable $now_ms = null,
		?array $cleaners = null
	) {
		$this->entitlements = $entitlements;
		$this->db           = null !== $db ? $db : self::default_db();
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		$this->cleaners = null !== $cleaners ? $cleaners : self::cleaners();
	}

	/** The global $wpdb under WordPress, or null outside it (harness). @return object|null */
	private static function default_db() {
		return isset( $GLOBALS['wpdb'] ) && is_object( $GLOBALS['wpdb'] ) ? $GLOBALS['wpdb'] : null;
	}

	/**
	 * The id-keyed cleaner registry. Adding a task is one class + one line here —
	 * this is the "generic solution" the IWSL_DB_Cleaner interface exists to enable.
	 *
	 * @return array<string, IWSL_DB_Cleaner>
	 */
	public static function cleaners(): array {
		return array(
			'expired_transients' => new IWSL_DB_Expired_Transients_Cleaner(),
			'post_revisions'     => new IWSL_DB_Post_Revisions_Cleaner(),
			'auto_drafts'        => new IWSL_DB_Auto_Drafts_Cleaner(),
			'trashed_posts'      => new IWSL_DB_Trashed_Posts_Cleaner(),
			'spam_comments'      => new IWSL_DB_Spam_Comments_Cleaner(),
			'trashed_comments'   => new IWSL_DB_Trashed_Comments_Cleaner(),
			'orphaned_postmeta'  => new IWSL_DB_Orphaned_Postmeta_Cleaner(),
			'orphaned_termmeta'  => new IWSL_DB_Orphaned_Termmeta_Cleaner(),
			'optimize_tables'    => new IWSL_DB_Optimize_Tables_Cleaner(),
		);
	}

	/**
	 * Per-cleaner id + label for the admin preview table skeleton. Side-effect
	 * free — no query is issued — so it is safe on every render.
	 *
	 * @return array<int, array{ id:string, label:string }>
	 */
	public function capabilities(): array {
		$out = array();
		foreach ( $this->cleaners as $cleaner ) {
			$out[] = array(
				'id'    => $cleaner->id(),
				'label' => $cleaner->label(),
			);
		}
		return $out;
	}

	/** Cleaner ids for the admin allow-list. @return string[] */
	public function cleaner_ids(): array {
		return array_keys( $this->cleaners );
	}

	/**
	 * Run the cleaners. STATEMENT 1 is the authoritative entitlement gate — nothing
	 * below it runs, and the database handle is never touched, for a locked site.
	 *
	 * mode 'preview' (the DEFAULT) counts only and mutates NOTHING. mode 'run'
	 * performs the bounded deletes. An empty $cleaner_ids selects ALL cleaners; a
	 * non-empty list is filtered against the registry keys (unknown ids dropped)
	 * and capped at MAX_CLEANERS_PER_RUN — no id ever names anything but a
	 * pre-registered cleaner.
	 *
	 * @param string   $mode        'preview' | 'run'.
	 * @param string[] $cleaner_ids Optional subset of registry ids (default: all).
	 * @return array Immutable run summary.
	 */
	public function run( string $mode = 'preview', array $cleaner_ids = array() ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return self::locked_summary( $mode, $gate );
		}

		$mode = ( 'run' === $mode ) ? 'run' : 'preview';

		if ( ! is_object( $this->db ) ) {
			return self::refusal( $mode, 'no-database' );
		}

		$selected = $this->select_cleaners( $cleaner_ids );

		if ( ! $this->acquire_lock() ) {
			return self::refusal( $mode, 'busy' );
		}

		$started = ( $this->now_ms )();
		$rows    = array();
		$total   = 0;

		try {
			foreach ( $selected as $cleaner ) {
				if ( 'run' === $mode ) {
					$deleted = max( 0, (int) $cleaner->clean( $this->db, self::MAX_ROWS ) );
					$rows[]  = array(
						'id'      => $cleaner->id(),
						'label'   => $cleaner->label(),
						'deleted' => $deleted,
					);
					$total  += $deleted;
				} else {
					$count  = max( 0, (int) $cleaner->count( $this->db ) );
					$rows[] = array(
						'id'    => $cleaner->id(),
						'label' => $cleaner->label(),
						'count' => $count,
					);
					$total += $count;
				}
			}
		} finally {
			$this->release_lock();
		}

		return array(
			'ok'         => true,
			'mode'       => $mode,
			'cleaners'   => $rows,
			'total'      => $total,
			'elapsed_ms' => max( 0, ( $this->now_ms )() - $started ),
		);
	}

	/**
	 * Teardown for an uninstall/unlink sweep. This engine keeps NO settings or log
	 * option of its own (it has no IWSL_Store — it counts/cleans the live site DB and
	 * persists nothing), so the ONLY plugin state it can leave behind is its
	 * single-flight run-lock transient. purge() removes that if it is held and NEVER
	 * runs any of the destructive cleaners — teardown removes THIS feature's own
	 * footprint, it does not clean the site database. Idempotent + cheap-when-clean: a
	 * held lock is one guarded delete, an absent one a no-op. Every WordPress call is
	 * function_exists-guarded so it is harmless under the zero-dependency harness.
	 *
	 * @return array{ ok:bool, options:int, locks:int }
	 */
	public function purge(): array {
		$locks = 0;
		if ( function_exists( 'get_transient' ) && function_exists( 'delete_transient' )
			&& false !== get_transient( self::LOCK_TRANSIENT ) ) {
			delete_transient( self::LOCK_TRANSIENT );
			$locks = 1;
		}
		// No settings/log option key exists for this engine — 'options' is always 0,
		// kept in the shape for uniformity with the other system engines.
		return array( 'ok' => true, 'options' => 0, 'locks' => $locks );
	}

	/**
	 * Resolve the cleaners to run. An empty request selects the full registry; a
	 * non-empty one is intersected with the registry (unknown/invalid ids dropped)
	 * and capped. NO id ever becomes a table name — ids only ever key the registry.
	 *
	 * @param string[] $cleaner_ids
	 * @return array<string, IWSL_DB_Cleaner>
	 */
	private function select_cleaners( array $cleaner_ids ): array {
		if ( array() === $cleaner_ids ) {
			$selected = $this->cleaners;
		} else {
			$selected = array();
			foreach ( $cleaner_ids as $id ) {
				$key = is_string( $id ) ? $id : '';
				if ( '' !== $key && isset( $this->cleaners[ $key ] ) ) {
					$selected[ $key ] = $this->cleaners[ $key ];
				}
			}
		}
		if ( count( $selected ) > self::MAX_CLEANERS_PER_RUN ) {
			$selected = array_slice( $selected, 0, self::MAX_CLEANERS_PER_RUN, true );
		}
		return $selected;
	}

	// ── lock helpers (all WordPress calls function_exists-guarded) ─────────────

	private function acquire_lock(): bool {
		if ( ! function_exists( 'set_transient' ) || ! function_exists( 'get_transient' ) ) {
			return true; // No transient API (test harness) — single-threaded, no lock needed.
		}
		if ( false !== get_transient( self::LOCK_TRANSIENT ) ) {
			return false;
		}
		set_transient( self::LOCK_TRANSIENT, ( $this->now_ms )(), self::LOCK_TTL );
		return true;
	}

	private function release_lock(): void {
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( self::LOCK_TRANSIENT );
		}
	}

	// ── immutable summary builders ─────────────────────────────────────────────

	/** A fresh locked summary (no side effects were taken to produce it). */
	private static function locked_summary( string $mode, array $gate ): array {
		return array(
			'ok'         => false,
			'mode'       => ( 'run' === $mode ) ? 'run' : 'preview',
			'reason'     => 'entitlement-locked',
			'gate'       => $gate,
			'cleaners'   => array(),
			'total'      => 0,
			'elapsed_ms' => 0,
		);
	}

	/** A fresh non-gate refusal summary (busy / no-database). */
	private static function refusal( string $mode, string $reason ): array {
		return array(
			'ok'         => false,
			'mode'       => ( 'run' === $mode ) ? 'run' : 'preview',
			'reason'     => $reason,
			'cleaners'   => array(),
			'total'      => 0,
			'elapsed_ms' => 0,
		);
	}
}
