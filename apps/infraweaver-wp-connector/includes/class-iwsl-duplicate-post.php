<?php
/**
 * Gated "One-Click Duplicate" feature (gate flag `duplicate_post`, Pro tier).
 *
 * Adds a "Duplicate" row action to the Posts and Pages list tables that clones
 * an entry — title (+ " (copy)"), content, excerpt, taxonomies and custom fields
 * — into a fresh DRAFT the operator can edit freely. The original is never
 * touched. Mirrors the IWSL_Redirects / IWSL_Media_Optimizer pattern: the engine
 * (this class) is kept separate from the gate (IWSL_Entitlements) so each can be
 * reasoned about — and tested — in isolation.
 *
 * TRUST MODEL. Console-authoritative: the `duplicate_post` flag is written ONLY
 * by the dual-signed `entitlements.set` runner (§7). There is no self-set path,
 * REST route, AJAX endpoint, cron or nopriv surface here — this is a purely-local
 * admin action. The gate is re-checked at three layers (the admin page's
 * render_section(), the admin-post handler, and here as STATEMENT 1 of duplicate()
 * and every hook callback). The innermost check is authoritative: it survives any
 * future caller that forgets the outer two.
 *
 * RESIDUAL RISK (honest statement). A site owner with direct database write
 * access can flip the local entitlement option and unlock this without the
 * console — the accepted threat model of the existing `plus` gate — bounded by
 * heartbeat staleness (evaluate() requires state==active AND a fresh signed
 * contact within HEARTBEAT_FRESH_MS, not merely the flag).
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network. Exactly one
 * post is duplicated per request (bounded). Internal bookkeeping meta
 * (`_edit_lock` / `_edit_last`) is never copied. Taxonomy and meta copies run in
 * bounded loops. WordPress calls are function_exists-guarded so the engine loads
 * under the zero-dependency test harness; duplicate() accepts an already-resolved
 * post object (or an id it resolves via get_post) so the core is exercised with no
 * WordPress present.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Duplicate_Post {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'duplicate_post';

	/** admin-post action + nonce action (single state-changing verb). */
	const ACTION = 'iwsl_duplicate_post';
	const NONCE  = 'iwsl_duplicate_post';

	/** Per-user PRG result transient prefix + TTL (seconds). */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_dup_result_';
	const RESULT_TTL              = 60;

	/** Appended to the cloned title. */
	const COPY_SUFFIX = ' (copy)';

	/** Bookkeeping meta that must never be carried onto the copy. */
	const SKIP_META = array( '_edit_lock', '_edit_last' );

	/** Bounded-loop ceilings. */
	const MAX_TAXONOMIES = 100;
	const MAX_META_ROWS  = 2000;

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_WP_Store|null Reserved store seam (mirrors the gated-feature ctor). */
	private $store;

	/**
	 * @param IWSL_Entitlements   $entitlements The gate.
	 * @param IWSL_WP_Store|null  $store        Reserved persistence seam; unused today.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_WP_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->store        = $store;
	}

	/**
	 * Wire the row actions + the admin-post handler. Guarded so the harness can
	 * call it harmlessly. Each callback re-checks the gate as its first statement.
	 */
	public function register(): void {
		if ( function_exists( 'add_filter' ) ) {
			add_filter( 'post_row_actions', array( $this, 'add_row_action' ), 10, 2 );
			add_filter( 'page_row_actions', array( $this, 'add_row_action' ), 10, 2 );
		}
		if ( function_exists( 'add_action' ) ) {
			add_action( 'admin_post_' . self::ACTION, array( $this, 'handle_duplicate' ) );
		}
	}

	// ── list-table row action (STATEMENT 1 is the gate) ────────────────────────

	/**
	 * Append a "Duplicate" action to a Posts/Pages row. STATEMENT 1 is the gate:
	 * a locked site gets the row actions back untouched. Only an editable post
	 * gets the link, and the link is a nonce-signed admin-post URL.
	 *
	 * @param array $actions Existing row actions.
	 * @param mixed $post    The row's post (object with ->ID).
	 * @return array
	 */
	public function add_row_action( $actions, $post ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) || ! is_array( $actions ) ) {
			return $actions;
		}
		$id = is_object( $post ) && isset( $post->ID ) ? (int) $post->ID : 0;
		if ( $id <= 0 ) {
			return $actions;
		}
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'edit_post', $id ) ) {
			return $actions;
		}
		$url = $this->duplicate_url( $id );
		if ( '' === $url ) {
			return $actions;
		}
		// Immutable append — never mutate the array WordPress handed us.
		return array_merge(
			$actions,
			array(
				'iwsl_duplicate' => '<a href="' . esc_url( $url ) . '">'
					. esc_html__( 'Duplicate', 'infraweaver-connector' ) . '</a>',
			)
		);
	}

	/** The nonce-signed admin-post URL for duplicating a post, '' outside WP. */
	private function duplicate_url( int $post_id ): string {
		if ( ! function_exists( 'admin_url' ) || ! function_exists( 'add_query_arg' ) || ! function_exists( 'wp_nonce_url' ) ) {
			return '';
		}
		$url = add_query_arg(
			array(
				'action' => self::ACTION,
				'post'   => $post_id,
			),
			admin_url( 'admin-post.php' )
		);
		return (string) wp_nonce_url( $url, self::NONCE );
	}

	// ── the core (STATEMENT 1 is the authoritative gate) ───────────────────────

	/**
	 * Duplicate ONE post into a fresh draft. STATEMENT 1 is the authoritative
	 * entitlement gate — nothing below it runs for a locked site. The source is
	 * validated as a real, editable, non-revision post; a new draft is inserted
	 * copying the safe fields; then taxonomies and custom fields are copied in
	 * bounded loops (internal `_edit_lock` / `_edit_last` skipped). The original is
	 * never modified.
	 *
	 * @param int|object|array $source Post id (resolved via get_post) or an
	 *                                 already-resolved post object/array.
	 * @return array{ ok:bool, reason?:string, source_id?:int, new_id?:int, terms_copied?:int, meta_copied?:int, gate?:array }
	 */
	public function duplicate( $source ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		if ( ! function_exists( 'wp_insert_post' ) ) {
			return array( 'ok' => false, 'reason' => 'no-wp-context' );
		}

		$post = $this->resolve_post( $source );
		if ( ! self::is_duplicable( $post ) ) {
			return array( 'ok' => false, 'reason' => 'unknown-post' );
		}
		$source_id = (int) $post->ID;

		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'edit_post', $source_id ) ) {
			return array( 'ok' => false, 'reason' => 'forbidden' );
		}

		$new = array(
			'post_title'     => ( isset( $post->post_title ) ? (string) $post->post_title : '' ) . self::COPY_SUFFIX,
			'post_content'   => isset( $post->post_content ) ? (string) $post->post_content : '',
			'post_excerpt'   => isset( $post->post_excerpt ) ? (string) $post->post_excerpt : '',
			'post_status'    => 'draft',
			'post_type'      => isset( $post->post_type ) ? (string) $post->post_type : 'post',
			'post_parent'    => isset( $post->post_parent ) ? (int) $post->post_parent : 0,
			'menu_order'     => isset( $post->menu_order ) ? (int) $post->menu_order : 0,
			'comment_status' => isset( $post->comment_status ) ? (string) $post->comment_status : 'closed',
			'ping_status'    => isset( $post->ping_status ) ? (string) $post->ping_status : 'closed',
		);
		if ( function_exists( 'get_current_user_id' ) ) {
			$uid = (int) get_current_user_id();
			if ( $uid > 0 ) {
				$new['post_author'] = $uid;
			}
		}

		$payload = function_exists( 'wp_slash' ) ? wp_slash( $new ) : $new;
		$new_id  = wp_insert_post( $payload, true );
		if ( ( function_exists( 'is_wp_error' ) && is_wp_error( $new_id ) ) || ! is_int( $new_id ) || $new_id <= 0 ) {
			return array( 'ok' => false, 'reason' => 'insert-failed' );
		}

		$terms = $this->copy_terms( $source_id, $new_id, (string) $new['post_type'] );
		$meta  = $this->copy_meta( $source_id, $new_id );

		return array(
			'ok'           => true,
			'source_id'    => $source_id,
			'new_id'       => $new_id,
			'terms_copied' => $terms,
			'meta_copied'  => $meta,
		);
	}

	/** Resolve the source into a post object: id → get_post, object/array used directly. @return object|null */
	private function resolve_post( $source ) {
		if ( is_object( $source ) ) {
			return $source;
		}
		if ( is_array( $source ) ) {
			return (object) $source;
		}
		if ( is_int( $source ) || ( is_string( $source ) && ctype_digit( $source ) ) ) {
			$id = (int) $source;
			if ( $id > 0 && function_exists( 'get_post' ) ) {
				$p = get_post( $id );
				return is_object( $p ) ? $p : null;
			}
		}
		return null;
	}

	/** Whether a resolved post may be duplicated: real, non-revision, not an auto-draft. */
	private static function is_duplicable( $post ): bool {
		if ( ! is_object( $post ) ) {
			return false;
		}
		$id = isset( $post->ID ) ? (int) $post->ID : 0;
		if ( $id <= 0 ) {
			return false;
		}
		$type = isset( $post->post_type ) ? (string) $post->post_type : '';
		if ( '' === $type || 'revision' === $type ) {
			return false;
		}
		$status = isset( $post->post_status ) ? (string) $post->post_status : '';
		return 'auto-draft' !== $status;
	}

	/** Copy every taxonomy's terms from source to the new draft. Bounded. */
	private function copy_terms( int $source_id, int $new_id, string $type ): int {
		if ( ! function_exists( 'get_object_taxonomies' )
			|| ! function_exists( 'wp_get_object_terms' )
			|| ! function_exists( 'wp_set_object_terms' ) ) {
			return 0;
		}
		$taxes = get_object_taxonomies( '' !== $type ? $type : 'post' );
		if ( ! is_array( $taxes ) ) {
			return 0;
		}
		$copied = 0;
		$seen   = 0;
		foreach ( $taxes as $tax ) {
			if ( $seen >= self::MAX_TAXONOMIES ) {
				break;
			}
			$seen++;
			if ( ! is_string( $tax ) || '' === $tax ) {
				continue;
			}
			$terms = wp_get_object_terms( $source_id, $tax, array( 'fields' => 'ids' ) );
			if ( function_exists( 'is_wp_error' ) && is_wp_error( $terms ) ) {
				continue;
			}
			if ( ! is_array( $terms ) || array() === $terms ) {
				continue;
			}
			wp_set_object_terms( $new_id, array_map( 'intval', $terms ), $tax );
			$copied++;
		}
		return $copied;
	}

	/** Copy custom fields from source to the new draft, skipping internal keys. Bounded. */
	private function copy_meta( int $source_id, int $new_id ): int {
		if ( ! function_exists( 'get_post_custom' ) || ! function_exists( 'add_post_meta' ) ) {
			return 0;
		}
		$all = get_post_custom( $source_id );
		if ( ! is_array( $all ) ) {
			return 0;
		}
		$copied = 0;
		$rows   = 0;
		foreach ( $all as $key => $values ) {
			if ( ! is_string( $key ) || in_array( $key, self::SKIP_META, true ) ) {
				continue;
			}
			$values = is_array( $values ) ? $values : array( $values );
			foreach ( $values as $value ) {
				if ( $rows >= self::MAX_META_ROWS ) {
					return $copied;
				}
				$rows++;
				$v = function_exists( 'maybe_unserialize' ) ? maybe_unserialize( $value ) : $value;
				add_post_meta( $new_id, $key, function_exists( 'wp_slash' ) ? wp_slash( $v ) : $v );
				$copied++;
			}
		}
		return $copied;
	}

	// ── admin-post handler (capability + nonce + LAYER-2 gate) ─────────────────

	/**
	 * admin-post handler. Capability + nonce + gate re-check, then duplicate()
	 * (the authoritative LAYER-3 gate is inside). POST-redirect-GET: a fresh draft
	 * opens in the editor; a refusal stashes its reason in a per-user transient and
	 * returns to the Plus page.
	 */
	public function handle_duplicate(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::NONCE );

		$plus_url = iwsl_plus_redirect_base();

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_dup_locked', '1', $plus_url ) );
			exit;
		}

		$post_id = isset( $_GET['post'] ) ? (int) $_GET['post'] : 0; // nonce already verified above.
		$result  = $this->duplicate( $post_id );

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id(), $result, self::RESULT_TTL );
		}

		if ( ! empty( $result['ok'] ) && ! empty( $result['new_id'] ) ) {
			wp_safe_redirect( admin_url( 'post.php?action=edit&post=' . (int) $result['new_id'] ) );
			exit;
		}

		wp_safe_redirect( add_query_arg( 'iwsl_dup_failed', '1', $plus_url ) );
		exit;
	}

	// ── admin render (presentation only; gate LAYER 1) ─────────────────────────

	/**
	 * Render the Plus-page section. Locked → reasons only. Unlocked → a short
	 * explanation, the per-user PRG result notice, and shortcuts into the lists
	 * where the Duplicate action now appears.
	 */
	public function render_section(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'One-Click Duplicate', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Clone any post or page — its content, excerpt, taxonomies and custom fields — into a fresh draft with a single click. The original is never changed.', 'infraweaver-connector' ) . '</p>';

		if ( isset( $_GET['iwsl_dup_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>'
				. esc_html__( 'The One-Click Duplicate entitlement is not granted.', 'infraweaver-connector' )
				. '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_locked_notice( $gate );
			return;
		}

		$this->render_result_notice();

		// Informational section: duplication is a per-row action on the Posts and
		// Pages lists, so there is no submit form here (no fake primary). Present the
		// guidance and the two existing navigation buttons cleanly in one action row.
		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html__( 'A “Duplicate” action now appears beneath each entry in the Posts and Pages lists. Selecting it creates a draft copy you can edit freely.', 'infraweaver-connector' ) . '</span>';
		if ( function_exists( 'admin_url' ) ) {
			echo '<a class="button" href="' . esc_url( admin_url( 'edit.php' ) ) . '">'
				. esc_html__( 'Go to Posts', 'infraweaver-connector' ) . '</a>' . iwsl_field_help( 'Open your posts list, where each row has a Duplicate link.' ) . ' ';
			echo '<a class="button" href="' . esc_url( admin_url( 'edit.php?post_type=page' ) ) . '">'
				. esc_html__( 'Go to Pages', 'infraweaver-connector' ) . '</a>' . iwsl_field_help( 'Open your pages list, where each row has a Duplicate link.' );
		}
		echo '</div>';
	}

	/** Reason lines for a locked gate (no actions). */
	private static function render_locked_notice( array $gate ): void {
		// NOTE: `requires-plus` is a HISTORICAL reason token that fires for ANY
		// flag; here it maps to the duplicate-specific message (Pro tier).
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The One-Click Duplicate entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 One-Click Duplicate is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) ( $gate['reasons'] ?? array() ) as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>'
				. esc_html__( 'Draft copy created.', 'infraweaver-connector' ) . '</p></div>';
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>'
				. esc_html( sprintf( 'Duplicate refused: %s', (string) ( $result['reason'] ?? 'unknown' ) ) )
				. '</p></div>';
		}
	}
}
