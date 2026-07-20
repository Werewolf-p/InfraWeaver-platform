<?php
/**
 * The concrete cleaners behind the gated "Database Cleanup & Optimization"
 * feature (IWSL_DB_Cleaner implementations). Each is a single FIXED, allow-listed
 * database task. Every value-bearing query goes through $db->prepare(); table
 * names come ONLY from the handle's hardcoded core-table properties, never from
 * input; every DELETE is LIMIT-bounded; nothing here DROPs, TRUNCATEs or ALTERs.
 *
 * Adding a task is one class here plus one line in IWSL_DB_Optimizer::cleaners().
 */

defined( 'ABSPATH' ) || exit;

/**
 * Expired transients — the `_transient_timeout_*` / `_site_transient_timeout_*`
 * option rows whose stored expiry is in the past. Bounded delete of the timeout
 * rows; WordPress overwrites any paired value row on the next set_transient().
 */
final class IWSL_DB_Expired_Transients_Cleaner implements IWSL_DB_Cleaner {

	public function id(): string {
		return 'expired_transients';
	}

	public function label(): string {
		return 'Expired transients';
	}

	public function count( $db ): int {
		$sql = $db->prepare(
			"SELECT COUNT(*) FROM {$db->options}
			 WHERE ( option_name LIKE %s OR option_name LIKE %s ) AND option_value < %d",
			$db->esc_like( '_transient_timeout_' ) . '%',
			$db->esc_like( '_site_transient_timeout_' ) . '%',
			$this->now()
		);
		return (int) $db->get_var( $sql );
	}

	public function clean( $db, int $limit ): int {
		$sql = $db->prepare(
			"DELETE FROM {$db->options}
			 WHERE ( option_name LIKE %s OR option_name LIKE %s ) AND option_value < %d
			 LIMIT %d",
			$db->esc_like( '_transient_timeout_' ) . '%',
			$db->esc_like( '_site_transient_timeout_' ) . '%',
			$this->now(),
			$limit
		);
		return (int) $db->query( $sql );
	}

	/** Current UTC unix seconds — the unit WordPress stores transient timeouts in. */
	private function now(): int {
		return time();
	}
}

/**
 * Old post revisions — revisions beyond the newest N kept per parent post. The
 * correlated count of newer-or-equal revisions in the same parent selects "all
 * but the newest N"; the delete wraps that in a derived table so the LIMIT bounds
 * the batch without MySQL's self-reference restriction.
 */
final class IWSL_DB_Post_Revisions_Cleaner implements IWSL_DB_Cleaner {

	/** Revisions kept per post — the newest N are always preserved. */
	const DEFAULT_KEEP = 5;

	/** @var int */
	private $keep;

	public function __construct( int $keep = self::DEFAULT_KEEP ) {
		$this->keep = max( 0, $keep );
	}

	public function id(): string {
		return 'post_revisions';
	}

	public function label(): string {
		return 'Old post revisions';
	}

	public function count( $db ): int {
		$sql = $db->prepare(
			"SELECT COUNT(*) FROM {$db->posts} p
			 WHERE p.post_type = %s
			 AND ( SELECT COUNT(*) FROM {$db->posts} q
			       WHERE q.post_parent = p.post_parent AND q.post_type = %s AND q.ID >= p.ID ) > %d",
			'revision',
			'revision',
			$this->keep
		);
		return (int) $db->get_var( $sql );
	}

	public function clean( $db, int $limit ): int {
		$sql = $db->prepare(
			"DELETE FROM {$db->posts} WHERE ID IN (
				SELECT ID FROM (
					SELECT p.ID FROM {$db->posts} p
					WHERE p.post_type = %s
					AND ( SELECT COUNT(*) FROM {$db->posts} q
					      WHERE q.post_parent = p.post_parent AND q.post_type = %s AND q.ID >= p.ID ) > %d
					ORDER BY p.ID ASC
					LIMIT %d
				) t
			)",
			'revision',
			'revision',
			$this->keep,
			$limit
		);
		return (int) $db->query( $sql );
	}
}

/** Auto-draft posts — the placeholder rows WordPress creates for unsaved posts. */
final class IWSL_DB_Auto_Drafts_Cleaner implements IWSL_DB_Cleaner {

	public function id(): string {
		return 'auto_drafts';
	}

	public function label(): string {
		return 'Auto-draft posts';
	}

	public function count( $db ): int {
		$sql = $db->prepare(
			"SELECT COUNT(*) FROM {$db->posts} WHERE post_status = %s",
			'auto-draft'
		);
		return (int) $db->get_var( $sql );
	}

	public function clean( $db, int $limit ): int {
		$sql = $db->prepare(
			"DELETE FROM {$db->posts} WHERE post_status = %s LIMIT %d",
			'auto-draft',
			$limit
		);
		return (int) $db->query( $sql );
	}
}

/** Trashed posts — posts sitting in the trash (post_status = 'trash'). */
final class IWSL_DB_Trashed_Posts_Cleaner implements IWSL_DB_Cleaner {

	public function id(): string {
		return 'trashed_posts';
	}

	public function label(): string {
		return 'Trashed posts';
	}

	public function count( $db ): int {
		$sql = $db->prepare(
			"SELECT COUNT(*) FROM {$db->posts} WHERE post_status = %s",
			'trash'
		);
		return (int) $db->get_var( $sql );
	}

	public function clean( $db, int $limit ): int {
		$sql = $db->prepare(
			"DELETE FROM {$db->posts} WHERE post_status = %s LIMIT %d",
			'trash',
			$limit
		);
		return (int) $db->query( $sql );
	}
}

/** Spam comments — comments flagged as spam (comment_approved = 'spam'). */
final class IWSL_DB_Spam_Comments_Cleaner implements IWSL_DB_Cleaner {

	public function id(): string {
		return 'spam_comments';
	}

	public function label(): string {
		return 'Spam comments';
	}

	public function count( $db ): int {
		$sql = $db->prepare(
			"SELECT COUNT(*) FROM {$db->comments} WHERE comment_approved = %s",
			'spam'
		);
		return (int) $db->get_var( $sql );
	}

	public function clean( $db, int $limit ): int {
		$sql = $db->prepare(
			"DELETE FROM {$db->comments} WHERE comment_approved = %s LIMIT %d",
			'spam',
			$limit
		);
		return (int) $db->query( $sql );
	}
}

/** Trashed comments — comments in the trash (comment_approved = 'trash'). */
final class IWSL_DB_Trashed_Comments_Cleaner implements IWSL_DB_Cleaner {

	public function id(): string {
		return 'trashed_comments';
	}

	public function label(): string {
		return 'Trashed comments';
	}

	public function count( $db ): int {
		$sql = $db->prepare(
			"SELECT COUNT(*) FROM {$db->comments} WHERE comment_approved = %s",
			'trash'
		);
		return (int) $db->get_var( $sql );
	}

	public function clean( $db, int $limit ): int {
		$sql = $db->prepare(
			"DELETE FROM {$db->comments} WHERE comment_approved = %s LIMIT %d",
			'trash',
			$limit
		);
		return (int) $db->query( $sql );
	}
}

/**
 * Orphaned post meta — postmeta rows whose post_id no longer names a post. The
 * COUNT carries no value (pure hardcoded identifiers, no injection surface); the
 * DELETE is bounded via a derived table so the LIMIT stands even though MySQL
 * forbids a bare LIMIT on a multi-table DELETE.
 */
final class IWSL_DB_Orphaned_Postmeta_Cleaner implements IWSL_DB_Cleaner {

	public function id(): string {
		return 'orphaned_postmeta';
	}

	public function label(): string {
		return 'Orphaned post metadata';
	}

	public function count( $db ): int {
		// No bound values — hardcoded identifiers only, so prepare() is unnecessary
		// (and would _doing_it_wrong in modern WordPress). No injection surface.
		$sql = "SELECT COUNT(*) FROM {$db->postmeta} pm
		        LEFT JOIN {$db->posts} p ON pm.post_id = p.ID
		        WHERE p.ID IS NULL";
		return (int) $db->get_var( $sql );
	}

	public function clean( $db, int $limit ): int {
		$sql = $db->prepare(
			"DELETE FROM {$db->postmeta} WHERE meta_id IN (
				SELECT meta_id FROM (
					SELECT pm.meta_id FROM {$db->postmeta} pm
					LEFT JOIN {$db->posts} p ON pm.post_id = p.ID
					WHERE p.ID IS NULL
					LIMIT %d
				) t
			)",
			$limit
		);
		return (int) $db->query( $sql );
	}
}

/**
 * Orphaned term meta — termmeta rows whose term_id no longer names a term.
 * Mirrors the postmeta cleaner: value-less COUNT, derived-table bounded DELETE.
 */
final class IWSL_DB_Orphaned_Termmeta_Cleaner implements IWSL_DB_Cleaner {

	public function id(): string {
		return 'orphaned_termmeta';
	}

	public function label(): string {
		return 'Orphaned term metadata';
	}

	public function count( $db ): int {
		$sql = "SELECT COUNT(*) FROM {$db->termmeta} tm
		        LEFT JOIN {$db->terms} t ON tm.term_id = t.term_id
		        WHERE t.term_id IS NULL";
		return (int) $db->get_var( $sql );
	}

	public function clean( $db, int $limit ): int {
		$sql = $db->prepare(
			"DELETE FROM {$db->termmeta} WHERE meta_id IN (
				SELECT meta_id FROM (
					SELECT tm.meta_id FROM {$db->termmeta} tm
					LEFT JOIN {$db->terms} t ON tm.term_id = t.term_id
					WHERE t.term_id IS NULL
					LIMIT %d
				) x
			)",
			$limit
		);
		return (int) $db->query( $sql );
	}
}

/**
 * OPTIMIZE TABLE over a HARDCODED core-table allow-list under $db->prefix.
 * count() reports how many tables would be optimized; clean() issues the single
 * OPTIMIZE statement and returns the table count. There are NO values (nothing to
 * prepare) and NEVER a DROP/TRUNCATE/ALTER — only OPTIMIZE, only allow-listed
 * tables, each re-validated to a strict identifier shape under the prefix.
 */
final class IWSL_DB_Optimize_Tables_Cleaner implements IWSL_DB_Cleaner {

	/** The ONLY tables this cleaner may ever touch — WordPress core tables, unprefixed. */
	const CORE_TABLES = array(
		'posts',
		'postmeta',
		'comments',
		'commentmeta',
		'options',
		'terms',
		'termmeta',
		'term_relationships',
		'term_taxonomy',
		'users',
		'usermeta',
		'links',
	);

	public function id(): string {
		return 'optimize_tables';
	}

	public function label(): string {
		return 'Optimize core tables';
	}

	public function count( $db ): int {
		return count( $this->tables( $db ) );
	}

	public function clean( $db, int $limit ): int {
		$tables = $this->tables( $db );
		if ( array() === $tables ) {
			return 0;
		}
		// No user input anywhere: identifiers come only from the hardcoded core
		// allow-list under $db->prefix, each re-validated below. OPTIMIZE binds no
		// values, so there is nothing to prepare — and it is NOT a destructive DDL.
		$db->query( 'OPTIMIZE TABLE ' . implode( ', ', $tables ) );
		return count( $tables );
	}

	/**
	 * The prefixed, re-validated core-table names. Belt-and-braces: each candidate
	 * must be a strict `[a-z0-9_]+` identifier AND start with the live prefix, so a
	 * hostile $db->prefix can never smuggle anything past the allow-list.
	 *
	 * @return string[]
	 */
	private function tables( $db ): array {
		$prefix = isset( $db->prefix ) ? (string) $db->prefix : '';
		if ( '' === $prefix || ! preg_match( '/^[a-z0-9_]+$/', $prefix ) ) {
			return array();
		}
		$out = array();
		foreach ( self::CORE_TABLES as $name ) {
			$table = $prefix . $name;
			if ( preg_match( '/^[a-z0-9_]+$/', $table ) && 0 === strpos( $table, $prefix ) ) {
				$out[] = $table;
			}
		}
		return $out;
	}
}
