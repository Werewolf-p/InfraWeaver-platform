<?php
/**
 * Gated "SEO Meta Audit" feature (gate flag `seo_audit`, Pro tier).
 *
 * A READ-ONLY scan of up to MAX_ITEMS published posts/pages that flags common
 * on-page SEO issues per item (missing/short/long title, missing meta
 * description, thin content, missing featured image, no heading). It NEVER writes
 * to a post. Mirrors the IWSL_Redirects / IWSL_Media_Optimizer pattern: the engine
 * (this class) is kept separate from the gate (IWSL_Entitlements) so each can be
 * reasoned about — and tested — in isolation.
 *
 * TRUST MODEL. Console-authoritative: the `seo_audit` flag is written ONLY by the
 * dual-signed `entitlements.set` runner (§7). There is no self-set path, REST
 * route, AJAX endpoint, cron or nopriv surface here — this is a purely-local admin
 * action. The gate is re-checked at three layers (render_section(), the admin-post
 * handler, and here as STATEMENT 1 of run_audit()). The innermost check is
 * authoritative: it survives any future caller that forgets the outer two.
 *
 * RESIDUAL RISK (honest statement). A site owner with direct database write access
 * can flip the local entitlement option and unlock this without the console — the
 * accepted threat model of the existing `plus` gate — bounded by heartbeat
 * staleness (evaluate() requires state==active AND a fresh signed contact).
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network, no writes.
 * The scan is bounded by MAX_ITEMS; the per-item judgement is a pure function over
 * already-gathered fields (unit-testable with no WordPress present). WordPress
 * calls on the gather path are function_exists-guarded so the engine loads under
 * the zero-dependency test harness; run_audit() accepts an already-resolved post
 * list so the core is exercised with no WordPress present.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_SEO_Audit {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'seo_audit';

	/** admin-post action + nonce action (single "run audit" verb). */
	const ACTION = 'iwsl_seo_audit';
	const NONCE  = 'iwsl_seo_audit';

	/**
	 * Per-user result transient prefix + TTL (seconds). The transient is the
	 * POST-redirect-GET render cache for the WP Plus page. It is NOT the source of
	 * truth any more: the DURABLE last-audit (LAST_AUDIT_OPTION) is what survives for
	 * cross-surface reads (the signed `seo.status` snapshot, other users, the fleet
	 * chip). The old 60s TTL evaporated the on-page result before a reload — bumped
	 * to a week so a returning admin still sees their last run.
	 */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_seo_result_';
	const RESULT_TTL              = 604800; // 7 days (was 60s).

	/**
	 * Durable last-audit store key (via IWSL_Store → option `iwsl_seo_audit_last`).
	 * A compact summary (counts + generated_at + capped items) is written here on
	 * every run so the result is retrievable long after the per-user transient, and
	 * readable by the signed channel (IWSL_SEO_Console::status). Scrubbed by purge().
	 */
	const LAST_AUDIT_OPTION = 'seo_audit_last';

	/** Cap on items kept in the durable last-audit summary. */
	const LAST_AUDIT_MAX_ITEMS = 50;

	/** Hard cap on items scanned per run — bounds per-request cost. */
	const MAX_ITEMS = 200;

	/** Title length thresholds (characters). */
	const TITLE_MAX = 60;
	const TITLE_MIN = 20;

	/** Below this many words a post is "thin content". */
	const THIN_CONTENT_WORDS = 300;

	/** Post types the audit scans. */
	const POST_TYPES = array( 'post', 'page' );

	/**
	 * Meta keys a meta description may live under, in resolution order. `_iwseo_desc`
	 * (our own SEO Suite's key) is FIRST and cheapest: without it, an Ultimate site
	 * using the built-in suite was falsely flagged "missing meta description" by our
	 * own Pro audit. Yoast + AIOSEO follow for sites running those engines instead.
	 */
	const META_DESC_KEYS = array( '_iwseo_desc', '_yoast_wpseo_metadesc', '_aioseo_description' );

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store|null Persistence seam (durable last-audit); any IWSL_Store. */
	private $store;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Persistence seam for the durable last-audit
	 *                                        (IWSL_WP_Store in prod, IWSL_Memory_Store in tests).
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->store        = $store;
	}

	/** Wire the admin-post handler. Guarded so the harness can call it harmlessly. */
	public function register(): void {
		if ( function_exists( 'add_action' ) ) {
			add_action( 'admin_post_' . self::ACTION, array( $this, 'handle_run_audit' ) );
		}
	}

	// ── teardown (idempotent, cheap-when-clean, returns what was removed) ─────────

	/**
	 * Delete-time teardown scrub for the SEO Meta Audit. This engine is READ-ONLY: it
	 * writes no post meta, keeps no durable option, and schedules no cron. Its only
	 * persisted footprint is the per-user last-audit summary held in a self-expiring
	 * transient (`iwsl_seo_result_<user-id>`), so purge drops those plugin-owned
	 * transient rows from the options table with a single bounded, prepared DELETE
	 * matched on the plugin transient prefix — never any core or non-plugin option.
	 * Every $wpdb call is guarded so this is a harmless no-op under the zero-WP
	 * harness (and cheap when there is nothing to remove).
	 *
	 * @return array{ ok:bool, options:string[], transients:int, cron:string[] }
	 */
	public function purge(): array {
		$removed = array( 'ok' => true, 'options' => array(), 'transients' => 0, 'cron' => array() );

		$wpdb = isset( $GLOBALS['wpdb'] ) && is_object( $GLOBALS['wpdb'] ) ? $GLOBALS['wpdb'] : null;
		if ( null !== $wpdb && isset( $wpdb->options )
			&& method_exists( $wpdb, 'query' ) && method_exists( $wpdb, 'prepare' ) ) {
			$prefix = method_exists( $wpdb, 'esc_like' )
				? $wpdb->esc_like( self::RESULT_TRANSIENT_PREFIX )
				: self::RESULT_TRANSIENT_PREFIX;
			$sql = $wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
				'_transient_' . $prefix . '%',
				'_transient_timeout_' . $prefix . '%'
			);
			$rows                  = $wpdb->query( $sql );
			$removed['transients'] = is_int( $rows ) ? $rows : 0;
		}

		// Durable last-audit option (LAST_AUDIT_OPTION). Persisted only when a store
		// is wired (bootstrap + teardown always wire one), so this scrub runs on real
		// teardown. The read-only purge unit test constructs the engine WITHOUT a
		// store, so this stays a no-op there — the durable-store test covers removal.
		if ( null !== $this->store && null !== $this->store->get( self::LAST_AUDIT_OPTION, null ) ) {
			$this->store->delete( self::LAST_AUDIT_OPTION );
			$removed['options'][] = self::LAST_AUDIT_OPTION;
		}

		return $removed;
	}

	// ── durable last-audit (retrievable long after the per-user transient) ────────

	/**
	 * Persist a COMPACT copy of a successful audit summary as the durable last-audit,
	 * so the result survives past the per-user render transient and is readable by any
	 * other surface (the signed `seo.status` snapshot, the fleet chip, another admin).
	 * Bounded: counts + generated_at + up to LAST_AUDIT_MAX_ITEMS items. A locked/failed
	 * summary is never persisted. No-op when no store is wired; returns the compact copy
	 * either way so callers can reuse it.
	 *
	 * @return array the compact copy.
	 */
	public function persist_summary( array $summary ): array {
		$compact = self::compact_summary( $summary );
		if ( null !== $this->store && ! empty( $summary['ok'] ) ) {
			$this->store->set( self::LAST_AUDIT_OPTION, $compact );
		}
		return $compact;
	}

	/** The durable last-audit summary, or null when none is stored / no store wired. @return array|null */
	public function last_summary() {
		if ( null === $this->store ) {
			return null;
		}
		$value = $this->store->get( self::LAST_AUDIT_OPTION, null );
		return is_array( $value ) ? $value : null;
	}

	/**
	 * Compact a full audit summary for durable/cross-surface use: keep the aggregate
	 * counts + generated_at, cap the items list to LAST_AUDIT_MAX_ITEMS. Pure; returns
	 * a NEW array (never mutates the input).
	 */
	public static function compact_summary( array $summary ): array {
		$items  = isset( $summary['items'] ) && is_array( $summary['items'] ) ? array_values( $summary['items'] ) : array();
		$capped = array_slice( $items, 0, self::LAST_AUDIT_MAX_ITEMS );
		return array(
			'ok'           => ! empty( $summary['ok'] ),
			'generated_at' => isset( $summary['generated_at'] ) ? (string) $summary['generated_at'] : '',
			'scanned'      => isset( $summary['scanned'] ) ? (int) $summary['scanned'] : 0,
			'with_issues'  => isset( $summary['with_issues'] ) ? (int) $summary['with_issues'] : 0,
			'issue_counts' => isset( $summary['issue_counts'] ) && is_array( $summary['issue_counts'] ) ? $summary['issue_counts'] : array(),
			'items'        => $capped,
			'partial'      => ! empty( $summary['partial'] ),
			'item_capped'  => count( $items ) > self::LAST_AUDIT_MAX_ITEMS,
			'max'          => isset( $summary['max'] ) ? (int) $summary['max'] : self::MAX_ITEMS,
		);
	}

	// ── the core (STATEMENT 1 is the authoritative gate) ───────────────────────

	/**
	 * Run one bounded, read-only audit. STATEMENT 1 is the authoritative
	 * entitlement gate — nothing below it runs for a locked site (it returns a
	 * locked summary with scanned=0 and no items, so no post is ever inspected).
	 * Each item is judged by the pure evaluate_item(); the summary is folded
	 * immutably.
	 *
	 * @param array|null $posts Optional already-resolved post objects; null queries
	 *                          the site's own published posts/pages via WordPress.
	 * @param int        $limit Item ceiling (clamped to MAX_ITEMS).
	 * @return array Immutable audit summary.
	 */
	public function run_audit( ?array $posts = null, int $limit = self::MAX_ITEMS ): array {
		$limit = max( 1, min( self::MAX_ITEMS, $limit ) );

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array(
				'ok'           => false,
				'reason'       => 'entitlement-locked',
				'gate'         => $gate,
				'scanned'      => 0,
				'with_issues'  => 0,
				'issue_counts' => array(),
				'items'        => array(),
				'partial'      => false,
			);
		}

		$list = is_array( $posts ) ? $posts : $this->query_posts( $limit );

		// First pass: gather each item's fields + base (per-item) issues, bounded.
		$rows             = array();
		$titles_by_id     = array();
		$metas_by_id      = array();
		$content_by_id    = array();
		$permalinks_by_id = array();
		$partial          = false;

		$seen = 0;
		foreach ( $list as $post ) {
			if ( $seen >= $limit ) {
				$partial = true;
				break;
			}
			$seen++;
			$fields = $this->gather_fields( $post );
			$id     = (int) $fields['id'];
			$rows[] = array(
				'id'     => $id,
				'title'  => (string) $fields['title'],
				'issues' => self::evaluate_item( $fields ),
			);
			$titles_by_id[ $id ]     = (string) $fields['title'];
			$metas_by_id[ $id ]      = (string) $fields['meta_description'];
			$content_by_id[ $id ]    = (string) $fields['content'];
			$permalinks_by_id[ $id ] = (string) $fields['permalink'];
		}

		// Corpus pass (no extra queries): duplicate titles/metas + orphan pages.
		$dup_title_ids = self::ids_in_groups( self::find_duplicates( $titles_by_id ) );
		$dup_meta_ids  = self::ids_in_groups( self::find_duplicates( $metas_by_id ) );
		$orphan_ids    = array_fill_keys( self::compute_orphans( $content_by_id, $permalinks_by_id ), true );

		// Fold each item, appending the corpus-level issues after the per-item ones.
		$summary = self::empty_summary();
		foreach ( $rows as $row ) {
			$id     = (int) $row['id'];
			$issues = $row['issues'];
			if ( isset( $dup_title_ids[ $id ] ) ) {
				$issues[] = 'duplicate-title';
			}
			if ( isset( $dup_meta_ids[ $id ] ) ) {
				$issues[] = 'duplicate-meta-description';
			}
			if ( isset( $orphan_ids[ $id ] ) ) {
				$issues[] = 'orphan-page';
			}
			$summary = self::fold_item( $summary, $id, (string) $row['title'], $issues );
		}
		$summary['partial'] = $partial;

		return $summary;
	}

	/**
	 * Group ids by NORMALIZED (case/space-insensitive) value, returning only the
	 * groups that repeat — i.e. the duplicate sets. Empty values never count as
	 * duplicates. Pure; unit-testable with a plain id→value map.
	 *
	 * @param array<int|string, mixed> $values_by_id
	 * @return array<string, int[]> normalized value → ids that share it (size ≥ 2)
	 */
	public static function find_duplicates( array $values_by_id ): array {
		$groups = array();
		foreach ( $values_by_id as $id => $value ) {
			$norm = self::normalize_dup_value( (string) $value );
			if ( '' === $norm ) {
				continue;
			}
			$groups[ $norm ][] = (int) $id;
		}
		$out = array();
		foreach ( $groups as $norm => $ids ) {
			if ( count( $ids ) > 1 ) {
				$out[ $norm ] = $ids;
			}
		}
		return $out;
	}

	/**
	 * Flag orphan pages: those with a resolvable permalink that receive ZERO inbound
	 * internal links from any OTHER page in the corpus. Extracts <a href> targets
	 * from each page's content and matches them by normalized path. Pages without a
	 * permalink are not evaluated. Pure; unit-testable with plain arrays.
	 *
	 * @param array<int|string, mixed> $content_by_id
	 * @param array<int|string, mixed> $permalinks_by_id
	 * @return int[] orphan post ids
	 */
	public static function compute_orphans( array $content_by_id, array $permalinks_by_id ): array {
		$path_to_id = array();
		$inbound    = array();
		foreach ( $permalinks_by_id as $id => $permalink ) {
			$path = self::url_to_path( (string) $permalink );
			if ( '' === $path ) {
				continue;
			}
			$path_to_id[ $path ]  = (int) $id;
			$inbound[ (int) $id ] = 0;
		}

		foreach ( $content_by_id as $src_id => $content ) {
			$src_id = (int) $src_id;
			$seen   = array();
			foreach ( self::extract_internal_hrefs( (string) $content ) as $href ) {
				$path = self::url_to_path( $href );
				if ( '' === $path || ! isset( $path_to_id[ $path ] ) ) {
					continue;
				}
				$target_id = $path_to_id[ $path ];
				if ( $target_id === $src_id || isset( $seen[ $target_id ] ) ) {
					continue; // self-links and repeats count once, not at all.
				}
				$seen[ $target_id ]     = true;
				$inbound[ $target_id ] += 1;
			}
		}

		$orphans = array();
		foreach ( $inbound as $id => $count ) {
			if ( 0 === $count ) {
				$orphans[] = (int) $id;
			}
		}
		return $orphans;
	}

	/** Flatten find_duplicates() groups into an id→true membership set. */
	private static function ids_in_groups( array $groups ): array {
		$out = array();
		foreach ( $groups as $ids ) {
			foreach ( (array) $ids as $id ) {
				$out[ (int) $id ] = true;
			}
		}
		return $out;
	}

	/** Case/space-insensitive normalization for duplicate comparison. */
	private static function normalize_dup_value( string $v ): string {
		$v = preg_replace( '/\s+/u', ' ', trim( $v ) ) ?? trim( $v );
		return function_exists( 'mb_strtolower' ) ? (string) mb_strtolower( $v, 'UTF-8' ) : strtolower( $v );
	}

	/** The <a href> targets in a chunk of HTML (decoded, non-empty). @return string[] */
	private static function extract_internal_hrefs( string $html ): array {
		$out = array();
		if ( preg_match_all( '#<a\b[^>]*\bhref\s*=\s*("([^"]*)"|\'([^\']*)\')#i', $html, $m ) ) {
			foreach ( $m[2] as $i => $dq ) {
				$href = '' !== $dq ? $dq : ( isset( $m[3][ $i ] ) ? $m[3][ $i ] : '' );
				$href = trim( html_entity_decode( $href, ENT_QUOTES | ENT_HTML5, 'UTF-8' ) );
				if ( '' !== $href ) {
					$out[] = $href;
				}
			}
		}
		return $out;
	}

	/** Reduce a URL or path to a comparable normalized path, or '' when not on-site. */
	private static function url_to_path( string $url ): string {
		$url = trim( $url );
		if ( '' === $url || '#' === $url[0] ) {
			return '';
		}
		if ( preg_match( '#^(mailto:|tel:|javascript:|data:)#i', $url ) ) {
			return '';
		}
		$path = parse_url( $url, PHP_URL_PATH );
		if ( ! is_string( $path ) || '' === $path ) {
			return preg_match( '#^https?://[^/]+/?$#i', $url ) ? '/' : '';
		}
		$path = rtrim( $path, '/' );
		return '' === $path ? '/' : $path;
	}

	/**
	 * The pure per-item judgement over already-gathered fields — no WordPress, no
	 * I/O, no side effects. Returns the list of issue codes for one item.
	 *
	 * @param array{ title?:string, content?:string, meta_description?:string, has_featured?:bool } $fields
	 * @return string[]
	 */
	public static function evaluate_item( array $fields ): array {
		$title   = isset( $fields['title'] ) ? (string) $fields['title'] : '';
		$content = isset( $fields['content'] ) ? (string) $fields['content'] : '';
		$meta    = isset( $fields['meta_description'] ) ? (string) $fields['meta_description'] : '';
		$has_img = ! empty( $fields['has_featured'] );

		$issues = array();

		$title_trim = trim( $title );
		if ( '' === $title_trim ) {
			$issues[] = 'missing-title';
		} else {
			$len = function_exists( 'mb_strlen' ) ? mb_strlen( $title_trim ) : strlen( $title_trim );
			if ( $len > self::TITLE_MAX ) {
				$issues[] = 'title-too-long';
			} elseif ( $len < self::TITLE_MIN ) {
				$issues[] = 'title-too-short';
			}
		}

		if ( '' === trim( $meta ) ) {
			$issues[] = 'missing-meta-description';
		}

		if ( self::word_count( $content ) < self::THIN_CONTENT_WORDS ) {
			$issues[] = 'thin-content';
		}

		if ( ! $has_img ) {
			$issues[] = 'missing-featured-image';
		}

		if ( ! self::has_heading( $content ) ) {
			$issues[] = 'no-heading';
		}

		return $issues;
	}

	/** Whitespace-delimited word count of the visible text (tags stripped). */
	private static function word_count( string $content ): int {
		$text = trim( strip_tags( $content ) );
		if ( '' === $text ) {
			return 0;
		}
		$words = preg_split( '/\s+/', $text, -1, PREG_SPLIT_NO_EMPTY );
		return is_array( $words ) ? count( $words ) : 0;
	}

	/** Whether the content contains at least one HTML heading (h1–h6). */
	private static function has_heading( string $content ): bool {
		return 1 === preg_match( '/<h[1-6][\s>\/]/i', $content );
	}

	/**
	 * Gather the fields evaluate_item() needs for one post. Reads from the post
	 * object's own properties when present (the test/injection path), else from
	 * WordPress (guarded). Meta description resolves SEO-plugin keys first, then a
	 * short excerpt fallback. Read-only.
	 *
	 * @param mixed $post Post object or array.
	 * @return array{ id:int, title:string, content:string, meta_description:string, has_featured:bool }
	 */
	private function gather_fields( $post ): array {
		$o       = is_array( $post ) ? (object) $post : $post;
		$id      = is_object( $o ) && isset( $o->ID ) ? (int) $o->ID : 0;
		$title   = is_object( $o ) && isset( $o->post_title ) ? (string) $o->post_title : '';
		$content = is_object( $o ) && isset( $o->post_content ) ? (string) $o->post_content : '';
		$excerpt = is_object( $o ) && isset( $o->post_excerpt ) ? (string) $o->post_excerpt : '';

		$meta = '';
		if ( is_object( $o ) && isset( $o->meta_description ) ) {
			$meta = (string) $o->meta_description;
		} elseif ( $id > 0 && function_exists( 'get_post_meta' ) ) {
			foreach ( self::META_DESC_KEYS as $key ) {
				$value = get_post_meta( $id, $key, true );
				if ( is_string( $value ) && '' !== trim( $value ) ) {
					$meta = $value;
					break;
				}
			}
		}
		if ( '' === trim( $meta ) ) {
			$meta = $excerpt; // short excerpt fallback.
		}

		if ( is_object( $o ) && isset( $o->has_featured ) ) {
			$has_featured = (bool) $o->has_featured;
		} else {
			$has_featured = $id > 0 && function_exists( 'has_post_thumbnail' ) && has_post_thumbnail( $id );
		}

		$permalink = '';
		if ( is_object( $o ) && isset( $o->permalink ) ) {
			$permalink = (string) $o->permalink;
		} elseif ( $id > 0 && function_exists( 'get_permalink' ) ) {
			$permalink = (string) get_permalink( $id );
		}

		return array(
			'id'               => $id,
			'title'            => $title,
			'content'          => $content,
			'meta_description' => $meta,
			'has_featured'     => $has_featured,
			'permalink'        => $permalink,
		);
	}

	/** Query this site's own published posts/pages, oldest id first. Empty outside WP. @return array */
	private function query_posts( int $limit ): array {
		if ( ! function_exists( 'get_posts' ) ) {
			return array();
		}
		$ids = get_posts(
			array(
				'post_type'        => self::POST_TYPES,
				'post_status'      => 'publish',
				'fields'           => 'ids',
				'posts_per_page'   => max( 1, min( self::MAX_ITEMS, $limit ) ),
				'orderby'          => 'ID',
				'order'            => 'ASC',
				'suppress_filters' => true,
			)
		);
		if ( ! is_array( $ids ) ) {
			return array();
		}
		$out = array();
		foreach ( $ids as $id ) {
			if ( function_exists( 'get_post' ) ) {
				$p = get_post( (int) $id );
				if ( is_object( $p ) ) {
					$out[] = $p;
				}
			}
		}
		return $out;
	}

	// ── immutable summary builders ─────────────────────────────────────────────

	/** A fresh empty audit summary. */
	private static function empty_summary(): array {
		return array(
			'ok'           => true,
			'generated_at' => function_exists( 'current_time' ) ? (string) current_time( 'mysql' ) : gmdate( 'Y-m-d H:i:s' ),
			'scanned'      => 0,
			'with_issues'  => 0,
			'issue_counts' => array(),
			'items'        => array(),
			'partial'      => false,
			'max'          => self::MAX_ITEMS,
		);
	}

	/**
	 * Fold one audited item into the running summary, returning a NEW summary
	 * (never mutating the input). Items list is capped at MAX_ITEMS.
	 *
	 * @param string[] $issues
	 */
	private static function fold_item( array $summary, int $id, string $title, array $issues ): array {
		$next            = $summary;
		$next['scanned'] = (int) $summary['scanned'] + 1;
		if ( array() !== $issues ) {
			$next['with_issues'] = (int) $summary['with_issues'] + 1;
		}
		$counts = $summary['issue_counts'];
		foreach ( $issues as $code ) {
			$counts[ $code ] = isset( $counts[ $code ] ) ? (int) $counts[ $code ] + 1 : 1;
		}
		$next['issue_counts'] = $counts;
		if ( count( $next['items'] ) < self::MAX_ITEMS ) {
			$next['items'] = array_merge(
				$summary['items'],
				array(
					array(
						'id'     => $id,
						'title'  => $title,
						'issues' => array_values( $issues ),
					),
				)
			);
		}
		return $next;
	}

	/** Human labels for the issue codes (render only). @return array<string,string> */
	public static function labels(): array {
		return array(
			'missing-title'            => 'Missing title',
			'title-too-long'          => 'Title too long (> ' . self::TITLE_MAX . ' chars)',
			'title-too-short'         => 'Title too short (< ' . self::TITLE_MIN . ' chars)',
			'missing-meta-description' => 'Missing meta description',
			'thin-content'            => 'Thin content (< ' . self::THIN_CONTENT_WORDS . ' words)',
			'missing-featured-image'  => 'No featured image',
			'no-heading'              => 'No heading (h1–h6)',
			'duplicate-title'            => 'Duplicate title (shared with another page)',
			'duplicate-meta-description' => 'Duplicate meta description',
			'orphan-page'                => 'Orphan page (no internal links point here)',
		);
	}

	// ── admin-post handler (capability + nonce + LAYER-2 gate) ─────────────────

	/**
	 * admin-post handler. Capability + nonce + gate re-check, then run_audit()
	 * (the authoritative LAYER-3 gate is inside). The immutable summary is stashed
	 * in a per-user transient and rendered on the Plus page. POST-redirect-GET.
	 */
	public function handle_run_audit(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::NONCE );

		$plus_url = iwsl_plus_redirect_base();

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_seo_locked', '1', $plus_url ) );
			exit;
		}

		$summary = $this->run_audit();
		// Durable copy first (cross-surface source of truth), then the per-user
		// transient as the POST-redirect-GET render flash for this admin.
		$this->persist_summary( $summary );
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id(), $summary, self::RESULT_TTL );
		}
		wp_safe_redirect( $plus_url );
		exit;
	}

	// ── admin render (presentation only; gate LAYER 1) ─────────────────────────

	/**
	 * Render the Plus-page section. Locked → reasons only. Unlocked → a "Run audit"
	 * button and the last audit result (from the per-user transient) as a table.
	 */
	public function render_section(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'SEO Meta Audit', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Scan your published posts and pages for common on-page SEO issues — titles, meta descriptions, thin content, featured images and headings. Read-only: nothing is ever changed.', 'infraweaver-connector' ) . '</p>';

		if ( isset( $_GET['iwsl_seo_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>'
				. esc_html__( 'The SEO Meta Audit entitlement is not granted.', 'infraweaver-connector' )
				. '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_locked_notice( $gate );
			return;
		}

		// Progressive disclosure (additive): PRIMARY = the existing "Run audit"
		// button + a last-run status meta; the fixed scope/limits/thresholds move
		// into a collapsed Advanced block. Every control/form/nonce is preserved.
		$meta = 'Not run yet.';
		if ( function_exists( 'get_transient' ) && function_exists( 'get_current_user_id' ) ) {
			$last = get_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id() );
			if ( is_array( $last ) && ! empty( $last['ok'] ) ) {
				$meta = sprintf(
					'Last run: %d scanned, %d with issues%s.',
					isset( $last['scanned'] ) ? (int) $last['scanned'] : 0,
					isset( $last['with_issues'] ) ? (int) $last['with_issues'] : 0,
					( isset( $last['generated_at'] ) && '' !== (string) $last['generated_at'] )
						? ' · ' . (string) $last['generated_at'] : ''
				);
			}
		}

		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html( $meta ) . '</span>';
		$this->render_run_form();
		echo '</div>';

		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<p class="description">' . esc_html__( 'Scope and thresholds are fixed and read-only:', 'infraweaver-connector' ) . '</p>';
		echo '<ul style="list-style:disc;margin:0 0 0 18px;">';
		echo '<li>' . esc_html( sprintf( 'Scope: published posts and pages, up to %d items per run.', self::MAX_ITEMS ) ) . '</li>';
		echo '<li>' . esc_html( sprintf( 'Title length: %d–%d characters.', self::TITLE_MIN, self::TITLE_MAX ) ) . '</li>';
		echo '<li>' . esc_html( sprintf( 'Thin content flagged below %d words.', self::THIN_CONTENT_WORDS ) ) . '</li>';
		echo '<li>' . esc_html__( 'Also flags: missing meta description, missing featured image, no heading.', 'infraweaver-connector' ) . '</li>';
		echo '</ul>';
		echo '</div></details>';

		$this->render_last_result();
	}

	/** The nonce-protected "Run audit" button (POST → admin-post.php). */
	private function render_run_form(): void {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:8px;">';
		wp_nonce_field( self::NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::ACTION ) . '">';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'Run audit', 'infraweaver-connector' ) . '</button>' . iwsl_field_help( 'Check every post and page for common SEO problems now.' );
		echo ' <span class="description">' . esc_html( sprintf( 'Scans at most %d published posts and pages.', self::MAX_ITEMS ) ) . '</span>';
		echo '</form>';
	}

	/** Render the last stored audit summary as a table. Read-only; escapes everything. */
	private function render_last_result(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$result = get_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id() );
		if ( ! is_array( $result ) || empty( $result['ok'] ) ) {
			echo '<p style="margin-top:12px;">' . esc_html__( 'Run an audit to see results.', 'infraweaver-connector' ) . '</p>';
			return;
		}

		$scanned     = isset( $result['scanned'] ) ? (int) $result['scanned'] : 0;
		$with_issues = isset( $result['with_issues'] ) ? (int) $result['with_issues'] : 0;
		$generated   = isset( $result['generated_at'] ) ? (string) $result['generated_at'] : '';
		$items       = isset( $result['items'] ) && is_array( $result['items'] ) ? $result['items'] : array();
		$labels      = self::labels();

		echo '<p style="margin-top:12px;" class="description">'
			. esc_html( sprintf( 'Scanned %d items, %d with issues.', $scanned, $with_issues ) );
		if ( '' !== $generated ) {
			echo ' ' . esc_html( sprintf( 'Generated %s.', $generated ) );
		}
		echo '</p>';

		if ( array() === $items ) {
			echo '<p>' . esc_html__( 'No published posts or pages to audit.', 'infraweaver-connector' ) . '</p>';
			return;
		}

		echo '<table class="widefat striped" style="max-width:900px;margin-top:12px;"><thead><tr>';
		echo '<th>' . esc_html__( 'Title', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Issues', 'infraweaver-connector' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $items as $item ) {
			if ( ! is_array( $item ) ) {
				continue;
			}
			$title  = isset( $item['title'] ) ? (string) $item['title'] : '';
			$issues = isset( $item['issues'] ) && is_array( $item['issues'] ) ? $item['issues'] : array();
			echo '<tr><td>' . esc_html( '' !== $title ? $title : '(no title)' ) . '</td><td>';
			if ( array() === $issues ) {
				echo '<span style="color:#46803a;">' . esc_html__( 'No issues', 'infraweaver-connector' ) . '</span>';
			} else {
				echo '<ul style="list-style:disc;margin:0 0 0 18px;">';
				foreach ( $issues as $code ) {
					$text = isset( $labels[ $code ] ) ? $labels[ $code ] : (string) $code;
					echo '<li>' . esc_html( $text ) . '</li>';
				}
				echo '</ul>';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table>';
	}

	/** Reason lines for a locked gate (no actions). */
	private static function render_locked_notice( array $gate ): void {
		// NOTE: `requires-plus` is a HISTORICAL reason token that fires for ANY
		// flag; here it maps to the audit-specific message (Pro tier).
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The SEO Meta Audit entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 SEO Meta Audit is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) ( $gate['reasons'] ?? array() ) as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}
}
