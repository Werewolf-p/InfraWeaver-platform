<?php
/**
 * Cleanup-strategy contract for the gated "Database Cleanup & Optimization"
 * feature. A cleaner is a pure, side-effect-scoped database task: given a
 * WordPress `$wpdb`-like handle it can COUNT the rows it would remove (a
 * side-effect-free dry run) and, separately, remove a bounded batch of them.
 *
 * The generic engine (IWSL_DB_Optimizer) owns the entitlement gate, the run
 * lock, mode selection (preview vs run) and the immutable summary. A cleaner
 * owns exactly one thing: one FIXED, allow-listed operation expressed as a
 * prepared SELECT COUNT and a bounded DELETE (or an OPTIMIZE TABLE over a
 * hardcoded core-table allow-list). Adding a task is therefore one class
 * implementing this interface plus one line in IWSL_DB_Optimizer::cleaners().
 *
 * SECURITY CONTRACT (every implementation MUST hold to it):
 *  - Table names come ONLY from the handle's hardcoded core-table properties
 *    ($db->posts, $db->postmeta, $db->comments, $db->options,
 *    $db->term_relationships, $db->termmeta, $db->terms, …) — NEVER from input.
 *  - Every value-bearing query is built with $db->prepare(); no caller-supplied
 *    SQL, table name, or column name is ever interpolated.
 *  - clean() is LIMIT-bounded: it removes at most $limit rows per call.
 *  - Only bounded DELETE and OPTIMIZE TABLE — NEVER DROP, TRUNCATE, or ALTER.
 */

defined( 'ABSPATH' ) || exit;

interface IWSL_DB_Cleaner {

	/** Stable id, shape `[a-z0-9_]{1,32}`. Used as the registry key and wire token. */
	public function id(): string;

	/** Human label for the admin preview table. */
	public function label(): string;

	/**
	 * Dry-run preview: how many rows this cleaner WOULD remove right now. Reads
	 * only — issues a single prepared SELECT COUNT and mutates nothing. Safe to
	 * call on every admin render.
	 *
	 * @param object $db A `$wpdb`-like handle (prepare/get_var/query + table props).
	 */
	public function count( $db ): int;

	/**
	 * Remove at most $limit rows in one bounded batch. Issues a prepared,
	 * LIMIT-bounded DELETE (or an OPTIMIZE TABLE over the hardcoded core-table
	 * allow-list). Returns the number of rows removed (or, for OPTIMIZE, the
	 * number of tables operated on).
	 *
	 * @param object $db    A `$wpdb`-like handle.
	 * @param int    $limit Per-call upper bound on rows removed.
	 */
	public function clean( $db, int $limit ): int;
}
