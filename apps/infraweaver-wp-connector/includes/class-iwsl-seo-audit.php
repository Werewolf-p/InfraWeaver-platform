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

	/** Per-user result transient prefix + TTL (seconds). */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_seo_result_';
	const RESULT_TTL              = 60;

	/** Hard cap on items scanned per run — bounds per-request cost. */
	const MAX_ITEMS = 200;

	/** Title length thresholds (characters). */
	const TITLE_MAX = 60;
	const TITLE_MIN = 20;

	/** Below this many words a post is "thin content". */
	const THIN_CONTENT_WORDS = 300;

	/** Post types the audit scans. */
	const POST_TYPES = array( 'post', 'page' );

	/** Meta keys the common SEO plugins store a description under. */
	const META_DESC_KEYS = array( '_yoast_wpseo_metadesc', '_aioseo_description' );

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_WP_Store|null Reserved store seam (mirrors the gated-feature ctor). */
	private $store;

	/**
	 * @param IWSL_Entitlements  $entitlements The gate.
	 * @param IWSL_WP_Store|null $store        Reserved persistence seam; unused today.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_WP_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->store        = $store;
	}

	/** Wire the admin-post handler. Guarded so the harness can call it harmlessly. */
	public function register(): void {
		if ( function_exists( 'add_action' ) ) {
			add_action( 'admin_post_' . self::ACTION, array( $this, 'handle_run_audit' ) );
		}
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

		$list    = is_array( $posts ) ? $posts : $this->query_posts( $limit );
		$summary = self::empty_summary();

		$seen = 0;
		foreach ( $list as $post ) {
			if ( $seen >= $limit ) {
				$summary['partial'] = true;
				break;
			}
			$seen++;
			$fields  = $this->gather_fields( $post );
			$issues  = self::evaluate_item( $fields );
			$summary = self::fold_item( $summary, (int) $fields['id'], (string) $fields['title'], $issues );
		}

		return $summary;
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

		return array(
			'id'               => $id,
			'title'            => $title,
			'content'          => $content,
			'meta_description' => $meta,
			'has_featured'     => $has_featured,
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

		$plus_url = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_seo_locked', '1', $plus_url ) );
			exit;
		}

		$summary = $this->run_audit();
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
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'Run audit', 'infraweaver-connector' ) . '</button>';
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
