<?php
/**
 * Engine behind the gated "Media Folders / Explorer" feature (flag `media_folders`,
 * Pro + Ultimate). Adds Windows-Explorer-style, nestable folders and flat tags to the
 * WordPress Media Library — a two-pane explorer, drag-drop filing, tag filtering and
 * sorting — implemented ENTIRELY as WordPress taxonomy terms on the `attachment` post
 * type. No custom table, no new files on disk.
 *
 * DATA-SAFETY PROMISE (the whole point of this feature). Folders and tags are
 * ORGANIZATIONAL METADATA only: taxonomy terms in `iwsl_media_folder` (hierarchical)
 * and `iwsl_media_tag` (flat). Deleting a folder, disabling the feature, or uninstalling
 * NEVER deletes an attachment or its file — it only removes the term (and the file quietly
 * becomes "unfiled"). Every mutator here calls term functions (`wp_delete_term`,
 * `wp_set_object_terms`, `wp_remove_object_terms`) that touch the term/relationship rows,
 * never the attachment post or the media file. `purge()` removes ONLY the two taxonomies'
 * terms, matching what IWSL_Teardown::engine_for() calls on an operator disable / uninstall.
 *
 * TRUST MODEL. wp-admin only. Every entry point requires a logged-in `manage_options`
 * user, a valid nonce, AND an unlocked entitlement — checked as STATEMENT 1 of every hook
 * callback and every public model/query/mutator method, so a locked / revoked /
 * heartbeat-stale site behaves byte-identically to stock WordPress (the taxonomies are not
 * even registered). There is ZERO new public REST surface and ZERO new signed-channel
 * method: the console↔WP signed channel is untouched. AJAX handlers are logged-in only
 * (`wp_ajax_*`) with NO nopriv twins.
 *
 * SECURITY. Folder/tag names are sanitized (strip tags + sanitize_text_field + trim,
 * bounded to MAX_NAME_LEN); every term id is validated to belong to OUR taxonomy before it
 * is mutated/deleted; every attachment id is validated as a real `attachment` the current
 * user `edit_post`-can before it is filed/tagged; all ints are cast; bulk arrays are capped
 * (BULK_MAX); folder depth + count are bounded (MAX_DEPTH / MAX_FOLDERS); folder moves are
 * cycle-guarded (a folder can never be moved into its own descendant). No raw SQL — only
 * the taxonomy API and WP_Query. All server-rendered output is escaped.
 *
 * DEFENSIVE. Every WordPress function is `function_exists()`-guarded and persistence goes
 * through the injected IWSL_Store, so the class instantiates and its pure logic runs under
 * the zero-dependency PHP test harness (which stubs the term functions per test). Harness-
 * safe escaping mirrors IWSL_Media_Offload's esc_*_safe wrappers.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Media_Folders {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'media_folders';

	/** Hierarchical (nestable) folder taxonomy on `attachment`. */
	const TAX_FOLDER = 'iwsl_media_folder';
	/** Flat (non-hierarchical) tag taxonomy on `attachment`. */
	const TAX_TAG = 'iwsl_media_tag';

	/** Term meta key holding a folder's integer sibling-ordering. */
	const ORDER_META = 'iwsl_folder_order';

	/** Shared AJAX nonce name; the posted field is always 'nonce'. */
	const NONCE = 'iwsl_media_folders';

	/** Logged-in AJAX actions (no nopriv twins). */
	const AJAX_TREE          = 'iwsl_mf_tree';
	const AJAX_LIST          = 'iwsl_mf_list';
	const AJAX_FOLDER_CREATE = 'iwsl_mf_folder_create';
	const AJAX_FOLDER_RENAME = 'iwsl_mf_folder_rename';
	const AJAX_FOLDER_DELETE = 'iwsl_mf_folder_delete';
	const AJAX_FOLDER_MOVE   = 'iwsl_mf_folder_move';
	const AJAX_ASSIGN        = 'iwsl_mf_assign';
	const AJAX_TAG           = 'iwsl_mf_tag';

	/** DoS / sanity bounds (root folder = depth 0). */
	const MAX_DEPTH           = 10;
	const MAX_FOLDERS         = 2000;
	const MAX_NAME_LEN        = 100;
	const BULK_MAX            = 200;
	const LIST_PER_PAGE_MAX   = 100;
	const LIST_PER_PAGE_DEFAULT = 60;
	const MAX_TAGS_PER_FILE   = 50;

	/** Native Media-Library list-mode folder filter — the `<select>` field name. */
	const LIBRARY_FILTER_ARG = 'iwsl_folder';
	/** Attachment-detail compat field names (attachments[<id>][…]). */
	const FIELD_FOLDER = 'iwsl_media_folder';
	const FIELD_TAGS   = 'iwsl_media_tags';

	/** Document mime types the `document` mime-group filter matches. */
	const DOC_MIMES = array(
		'application/pdf',
		'application/msword',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'application/vnd.ms-excel',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		'application/vnd.ms-powerpoint',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		'application/rtf',
		'text/plain',
		'text/csv',
	);

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store */
	private $store;

	/**
	 * @param IWSL_Entitlements $entitlements The gate (media_folders).
	 * @param IWSL_Store|null   $store        Persistence; production injects IWSL_WP_Store.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
	}

	// ── registration ───────────────────────────────────────────────────────────────

	/**
	 * Wire the taxonomy registration (gated inside its own callback so a locked site
	 * exposes no taxonomy), the logged-in AJAX handlers, and the native Media-Library
	 * integration hooks. Hooks may be attached unconditionally because every callback
	 * re-gates as STATEMENT 1 — a locked site behaves like stock WordPress.
	 */
	public function register(): void {
		if ( function_exists( 'add_action' ) ) {
			add_action( 'init', array( $this, 'register_taxonomies' ) );

			add_action( 'wp_ajax_' . self::AJAX_TREE, array( $this, 'handle_tree_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_LIST, array( $this, 'handle_list_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_FOLDER_CREATE, array( $this, 'handle_folder_create_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_FOLDER_RENAME, array( $this, 'handle_folder_rename_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_FOLDER_DELETE, array( $this, 'handle_folder_delete_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_FOLDER_MOVE, array( $this, 'handle_folder_move_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_ASSIGN, array( $this, 'handle_assign_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_TAG, array( $this, 'handle_tag_ajax' ) );

			// Native library (list mode): a folder filter + query constraint.
			add_action( 'restrict_manage_posts', array( $this, 'render_library_folder_filter' ) );
			add_action( 'pre_get_posts', array( $this, 'filter_library_query' ) );
		}

		if ( function_exists( 'add_filter' ) ) {
			// Native library (attachment detail modal / edit screen): folder + tags fields.
			add_filter( 'attachment_fields_to_edit', array( $this, 'attachment_fields' ), 10, 2 );
			add_filter( 'attachment_fields_to_save', array( $this, 'save_attachment_fields' ), 10, 2 );
		}
	}

	/**
	 * Register both taxonomies on `attachment`. STATEMENT 1 is the gate: a locked site
	 * registers NOTHING (so it stays byte-identical to stock WP and no orphan taxonomy is
	 * ever exposed). Both are private + UI-less + REST-less + rewrite-less — this engine
	 * renders its own explorer UI.
	 */
	public function register_taxonomies(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( ! function_exists( 'register_taxonomy' ) ) {
			return;
		}

		$common = array(
			'public'            => false,
			'show_ui'           => false,
			'show_in_menu'      => false,
			'show_in_nav_menus' => false,
			'show_in_rest'      => false,
			'show_tagcloud'     => false,
			'show_admin_column' => false,
			'query_var'         => false,
			'rewrite'           => false,
		);

		register_taxonomy(
			self::TAX_FOLDER,
			'attachment',
			array_merge(
				$common,
				array(
					'labels'       => array(
						'name'          => $this->tx( 'Media Folders' ),
						'singular_name' => $this->tx( 'Media Folder' ),
					),
					'hierarchical' => true,
				)
			)
		);

		register_taxonomy(
			self::TAX_TAG,
			'attachment',
			array_merge(
				$common,
				array(
					'labels'       => array(
						'name'          => $this->tx( 'Media Tags' ),
						'singular_name' => $this->tx( 'Media Tag' ),
					),
					'hierarchical' => false,
				)
			)
		);
	}

	// ── model: read ─────────────────────────────────────────────────────────────────

	/**
	 * The full folder + tag tree for the explorer. Locked → an empty tree. `count` is the
	 * attachments filed DIRECTLY in a folder; `depth` is 0-based (root = 0). Folders are
	 * sorted by (parent, order, name) so a client can render them in a stable pre-order.
	 *
	 * @return array{ folders:array<int,array{id:int,name:string,parent:int,count:int,order:int,depth:int}>, counts:array{all:int,unfiled:int}, tags:array<int,array{id:int,name:string,count:int}> }
	 */
	public function folder_tree(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'folders' => array(), 'counts' => array( 'all' => 0, 'unfiled' => 0 ), 'tags' => array() );
		}

		$terms   = $this->folder_terms();
		$pmap    = self::parent_map( $terms );
		$folders = array();
		foreach ( $terms as $t ) {
			if ( is_object( $t ) && isset( $t->term_id ) ) {
				$folders[] = $this->folder_dto( $t, $pmap );
			}
		}
		usort(
			$folders,
			static function ( array $a, array $b ): int {
				if ( $a['parent'] !== $b['parent'] ) {
					return $a['parent'] <=> $b['parent'];
				}
				if ( $a['order'] !== $b['order'] ) {
					return $a['order'] <=> $b['order'];
				}
				return strcasecmp( $a['name'], $b['name'] );
			}
		);

		$tags = array();
		foreach ( $this->tag_terms() as $t ) {
			if ( is_object( $t ) && isset( $t->term_id, $t->name ) ) {
				$tags[] = array(
					'id'    => (int) $t->term_id,
					'name'  => (string) $t->name,
					'count' => isset( $t->count ) ? (int) $t->count : 0,
				);
			}
		}

		return array(
			'folders' => $folders,
			'counts'  => array(
				'all'     => $this->count_attachments( array() ),
				'unfiled' => $this->count_attachments( array( array( 'taxonomy' => self::TAX_FOLDER, 'operator' => 'NOT EXISTS' ) ) ),
			),
			'tags'    => $tags,
		);
	}

	/**
	 * A filtered, paginated page of the media library. Locked → an empty result shape.
	 *
	 * Args: `folder_id` (int; 0 = unfiled, -1 = all), `search` (str), `mime_group`
	 * (image|video|audio|document|all), `tag_ids` (int[]), `orderby` (date|title|filename|size),
	 * `order` (asc|desc), `page` (>=1), `per_page` (clamped to LIST_PER_PAGE_MAX).
	 *
	 * @param array<string,mixed> $args
	 * @return array{ items:array<int,array<string,mixed>>, total:int, page:int, per_page:int, pages:int }
	 */
	public function query_media( array $args ): array {
		$gate     = $this->entitlements->evaluate( self::FEATURE );
		$page     = isset( $args['page'] ) ? max( 1, (int) $args['page'] ) : 1;
		$per_page = self::clamp_per_page( isset( $args['per_page'] ) ? (int) $args['per_page'] : self::LIST_PER_PAGE_DEFAULT );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'items' => array(), 'total' => 0, 'page' => $page, 'per_page' => $per_page, 'pages' => 0 );
		}

		$query_args = $this->list_query_args( $args, $page, $per_page );
		$result     = $this->run_attachment_query( $query_args );

		$items = array();
		foreach ( $result['ids'] as $id ) {
			$items[] = $this->media_item( (int) $id );
		}

		$total = (int) $result['total'];
		return array(
			'items'    => $items,
			'total'    => $total,
			'page'     => $page,
			'per_page' => $per_page,
			'pages'    => (int) ceil( $total / max( 1, $per_page ) ),
		);
	}

	// ── model: folder CRUD ──────────────────────────────────────────────────────────

	/**
	 * Create a folder. Validates the sanitized name (1..MAX_NAME_LEN), an existing parent
	 * within depth, and the MAX_FOLDERS ceiling, then inserts the term and records its
	 * sibling order.
	 *
	 * @return array{ ok:bool, reason?:string, folder?:array<string,mixed> }
	 */
	public function create_folder( string $name, int $parent = 0 ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}

		$name   = self::sanitize_name( $name );
		$reason = self::validate_name( $name );
		if ( '' !== $reason ) {
			return array( 'ok' => false, 'reason' => $reason );
		}

		$terms = $this->folder_terms();
		if ( count( $terms ) >= self::MAX_FOLDERS ) {
			return array( 'ok' => false, 'reason' => 'max-folders' );
		}

		$parent = max( 0, $parent );
		$depth  = 0;
		if ( $parent > 0 ) {
			if ( null === $this->our_term( $parent, self::TAX_FOLDER ) ) {
				return array( 'ok' => false, 'reason' => 'bad-parent' );
			}
			$parent_depth = self::depth_of( $parent, self::parent_map( $terms ) );
			if ( $parent_depth + 1 > self::MAX_DEPTH ) {
				return array( 'ok' => false, 'reason' => 'max-depth' );
			}
			$depth = $parent_depth + 1;
		}

		if ( ! function_exists( 'wp_insert_term' ) ) {
			return array( 'ok' => false, 'reason' => 'no-wp' );
		}
		$res = wp_insert_term( $name, self::TAX_FOLDER, array( 'parent' => $parent ) );
		if ( self::is_error( $res ) || ! is_array( $res ) || empty( $res['term_id'] ) ) {
			return array( 'ok' => false, 'reason' => 'insert-failed' );
		}

		$id    = (int) $res['term_id'];
		$order = $this->next_sibling_order( $parent, $id );
		if ( function_exists( 'update_term_meta' ) ) {
			update_term_meta( $id, self::ORDER_META, $order );
		}

		return array(
			'ok'     => true,
			'folder' => array(
				'id'     => $id,
				'name'   => $name,
				'parent' => $parent,
				'count'  => 0,
				'order'  => $order,
				'depth'  => $depth,
			),
		);
	}

	/**
	 * Rename a folder (validated to be ours). Sanitizes the new name.
	 *
	 * @return array{ ok:bool, reason?:string, folder?:array<string,mixed> }
	 */
	public function rename_folder( int $id, string $name ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		if ( $id <= 0 || null === $this->our_term( $id, self::TAX_FOLDER ) ) {
			return array( 'ok' => false, 'reason' => 'not-found' );
		}

		$name   = self::sanitize_name( $name );
		$reason = self::validate_name( $name );
		if ( '' !== $reason ) {
			return array( 'ok' => false, 'reason' => $reason );
		}

		if ( ! function_exists( 'wp_update_term' ) ) {
			return array( 'ok' => false, 'reason' => 'no-wp' );
		}
		$res = wp_update_term( $id, self::TAX_FOLDER, array( 'name' => $name ) );
		if ( self::is_error( $res ) ) {
			return array( 'ok' => false, 'reason' => 'update-failed' );
		}

		return array( 'ok' => true, 'folder' => $this->folder_dto_by_id( $id ) );
	}

	/**
	 * Delete a folder and ALL its descendant folders. Files filed in any removed folder
	 * simply become unfiled — NO attachment or file is ever deleted (wp_delete_term removes
	 * only the term + relationship rows).
	 *
	 * @return array{ ok:bool, reason?:string, folders_removed?:int, files_unfiled?:int }
	 */
	public function delete_folder( int $id ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		if ( $id <= 0 || null === $this->our_term( $id, self::TAX_FOLDER ) ) {
			return array( 'ok' => false, 'reason' => 'not-found' );
		}

		$terms     = $this->folder_terms();
		$pmap      = self::parent_map( $terms );
		$count_map = array();
		foreach ( $terms as $t ) {
			if ( is_object( $t ) && isset( $t->term_id ) ) {
				$count_map[ (int) $t->term_id ] = isset( $t->count ) ? (int) $t->count : 0;
			}
		}

		$remove   = self::descendants_of( $id, $pmap );
		$remove[] = $id;
		// Delete deepest-first so WP never reparents a child we are about to remove anyway.
		usort(
			$remove,
			static function ( int $a, int $b ) use ( $pmap ): int {
				return self::depth_of( $b, $pmap ) <=> self::depth_of( $a, $pmap );
			}
		);

		$files_unfiled = 0;
		$removed       = 0;
		foreach ( $remove as $tid ) {
			$tid            = (int) $tid;
			$files_unfiled += $count_map[ $tid ] ?? 0;
			if ( function_exists( 'wp_delete_term' ) ) {
				$res = wp_delete_term( $tid, self::TAX_FOLDER );
				if ( ! self::is_error( $res ) && false !== $res ) {
					++$removed;
				}
			}
		}

		return array( 'ok' => true, 'folders_removed' => $removed, 'files_unfiled' => $files_unfiled );
	}

	/**
	 * Reparent a folder (and optionally reorder it). Cycle-guarded: a folder can never be
	 * moved into itself or one of its own descendants. Depth-guarded: the deepest node of
	 * the moved subtree must still satisfy MAX_DEPTH.
	 *
	 * @return array{ ok:bool, reason?:string, folder?:array<string,mixed> }
	 */
	public function move_folder( int $id, int $parent, ?int $order = null ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		if ( $id <= 0 || null === $this->our_term( $id, self::TAX_FOLDER ) ) {
			return array( 'ok' => false, 'reason' => 'not-found' );
		}

		$parent = max( 0, $parent );
		if ( $parent === $id ) {
			return array( 'ok' => false, 'reason' => 'cycle' );
		}

		$terms = $this->folder_terms();
		$pmap  = self::parent_map( $terms );
		$desc  = array_map( 'intval', self::descendants_of( $id, $pmap ) );

		if ( $parent > 0 ) {
			if ( null === $this->our_term( $parent, self::TAX_FOLDER ) ) {
				return array( 'ok' => false, 'reason' => 'bad-parent' );
			}
			if ( in_array( $parent, $desc, true ) ) {
				return array( 'ok' => false, 'reason' => 'cycle' );
			}
		}

		// Deepest new depth = new depth of $id + the height of its subtree.
		$id_depth = self::depth_of( $id, $pmap );
		$height   = 0;
		foreach ( $desc as $d ) {
			$rel = self::depth_of( $d, $pmap ) - $id_depth;
			if ( $rel > $height ) {
				$height = $rel;
			}
		}
		$new_id_depth = $parent > 0 ? self::depth_of( $parent, $pmap ) + 1 : 0;
		if ( $new_id_depth + $height > self::MAX_DEPTH ) {
			return array( 'ok' => false, 'reason' => 'max-depth' );
		}

		if ( ! function_exists( 'wp_update_term' ) ) {
			return array( 'ok' => false, 'reason' => 'no-wp' );
		}
		$res = wp_update_term( $id, self::TAX_FOLDER, array( 'parent' => $parent ) );
		if ( self::is_error( $res ) ) {
			return array( 'ok' => false, 'reason' => 'update-failed' );
		}

		$new_order = null !== $order ? max( 0, (int) $order ) : $this->next_sibling_order( $parent, $id );
		if ( function_exists( 'update_term_meta' ) ) {
			update_term_meta( $id, self::ORDER_META, $new_order );
		}

		return array( 'ok' => true, 'folder' => $this->folder_dto_by_id( $id ) );
	}

	// ── model: file filing + tagging ────────────────────────────────────────────────

	/**
	 * File a set of attachments into a folder (single-folder-per-file: this REPLACES any
	 * existing folder). `folder_id` 0 = unfiled (remove the folder term). Each id must be a
	 * real `attachment` the current user can edit — others are skipped, not failed. Bulk is
	 * capped at BULK_MAX distinct ids.
	 *
	 * @param array<int,mixed> $ids
	 * @return array{ ok:bool, reason?:string, moved?:int, skipped?:int, folder_id?:int }
	 */
	public function assign( array $ids, int $folder_id ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		if ( $folder_id < 0 ) {
			return array( 'ok' => false, 'reason' => 'bad-folder' );
		}

		$clean = self::clean_ids( $ids );
		if ( null === $clean ) {
			return array( 'ok' => false, 'reason' => 'too-many' );
		}
		if ( $folder_id > 0 && null === $this->our_term( $folder_id, self::TAX_FOLDER ) ) {
			return array( 'ok' => false, 'reason' => 'bad-folder' );
		}

		$terms   = $folder_id > 0 ? array( $folder_id ) : array();
		$moved   = 0;
		$skipped = 0;
		foreach ( $clean as $aid ) {
			if ( ! $this->can_edit_attachment( $aid ) || ! function_exists( 'wp_set_object_terms' ) ) {
				++$skipped;
				continue;
			}
			$res = wp_set_object_terms( $aid, $terms, self::TAX_FOLDER, false );
			if ( self::is_error( $res ) ) {
				++$skipped;
				continue;
			}
			++$moved;
		}

		return array( 'ok' => true, 'moved' => $moved, 'skipped' => $skipped, 'folder_id' => $folder_id );
	}

	/**
	 * Add and/or remove tags across a set of attachments. Add names are sanitized (append
	 * semantics — WordPress creates missing tag terms); per file the total tag count is
	 * bounded to MAX_TAGS_PER_FILE. Remove ids are validated to be OUR tag terms. Each id
	 * must be an editable attachment. Bulk capped at BULK_MAX.
	 *
	 * @param array<int,mixed> $ids
	 * @param array<int,mixed> $add_names
	 * @param array<int,mixed> $remove_term_ids
	 * @return array{ ok:bool, reason?:string, updated?:int, skipped?:int, added?:string[], removed?:int[] }
	 */
	public function tag( array $ids, array $add_names, array $remove_term_ids ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}

		$clean = self::clean_ids( $ids );
		if ( null === $clean ) {
			return array( 'ok' => false, 'reason' => 'too-many' );
		}

		$add = array();
		foreach ( $add_names as $n ) {
			$s = self::sanitize_name( is_scalar( $n ) ? (string) $n : '' );
			if ( '' !== $s && '' === self::validate_name( $s ) && ! in_array( $s, $add, true ) ) {
				$add[] = $s;
			}
			if ( count( $add ) >= self::MAX_TAGS_PER_FILE ) {
				break;
			}
		}

		$remove = array();
		foreach ( $remove_term_ids as $rid ) {
			$r = (int) $rid;
			if ( $r > 0 && ! in_array( $r, $remove, true ) && null !== $this->our_term( $r, self::TAX_TAG ) ) {
				$remove[] = $r;
			}
		}

		$updated = 0;
		$skipped = 0;
		foreach ( $clean as $aid ) {
			if ( ! $this->can_edit_attachment( $aid ) ) {
				++$skipped;
				continue;
			}
			$changed = false;
			if ( $add && function_exists( 'wp_set_object_terms' ) ) {
				$capacity = max( 0, self::MAX_TAGS_PER_FILE - $this->count_file_tags( $aid ) );
				$names    = array_slice( $add, 0, $capacity );
				if ( $names ) {
					$res = wp_set_object_terms( $aid, $names, self::TAX_TAG, true );
					if ( ! self::is_error( $res ) ) {
						$changed = true;
					}
				}
			}
			if ( $remove && function_exists( 'wp_remove_object_terms' ) ) {
				$res = wp_remove_object_terms( $aid, $remove, self::TAX_TAG );
				if ( ! self::is_error( $res ) ) {
					$changed = true;
				}
			}
			if ( $changed ) {
				++$updated;
			} else {
				++$skipped;
			}
		}

		return array( 'ok' => true, 'updated' => $updated, 'skipped' => $skipped, 'added' => $add, 'removed' => $remove );
	}

	// ── tag vocabulary CRUD (TERMS ONLY — attachments are never touched) ──────────────

	/**
	 * Rename a tag term (validated to be ours). Attachments keep the term — only the
	 * term row's name changes — so every file tagged with it is byte-identical after.
	 *
	 * @return array{ ok:bool, reason?:string, tag?:array<string,mixed> }
	 */
	public function rename_tag( int $id, string $name ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		if ( $id <= 0 || null === $this->our_term( $id, self::TAX_TAG ) ) {
			return array( 'ok' => false, 'reason' => 'not-found' );
		}
		$name   = self::sanitize_name( $name );
		$reason = self::validate_name( $name );
		if ( '' !== $reason ) {
			return array( 'ok' => false, 'reason' => $reason );
		}
		if ( ! function_exists( 'wp_update_term' ) ) {
			return array( 'ok' => false, 'reason' => 'no-wp' );
		}
		$res = wp_update_term( $id, self::TAX_TAG, array( 'name' => $name ) );
		if ( self::is_error( $res ) ) {
			return array( 'ok' => false, 'reason' => 'update-failed' );
		}
		return array( 'ok' => true, 'tag' => $this->tag_dto_by_id( $id ) );
	}

	/**
	 * Delete a tag term. `wp_delete_term` removes the term row + its object
	 * relationships (the affected files simply lose the tag); NO attachment or file is
	 * ever deleted. `files_untagged` reports how many files carried it.
	 *
	 * @return array{ ok:bool, reason?:string, files_untagged?:int }
	 */
	public function delete_tag( int $id ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		if ( $id <= 0 || null === $this->our_term( $id, self::TAX_TAG ) ) {
			return array( 'ok' => false, 'reason' => 'not-found' );
		}
		$count = count( $this->objects_in_tag( $id ) );
		if ( ! function_exists( 'wp_delete_term' ) ) {
			return array( 'ok' => false, 'reason' => 'no-wp' );
		}
		$res = wp_delete_term( $id, self::TAX_TAG );
		if ( self::is_error( $res ) || false === $res ) {
			return array( 'ok' => false, 'reason' => 'delete-failed' );
		}
		return array( 'ok' => true, 'files_untagged' => $count );
	}

	/**
	 * Merge tag $from into tag $into: every file carrying $from gains $into, then $from
	 * is deleted. TERMS ONLY — only term relationships change; attachment records stay
	 * byte-identical. Refuses a merge into itself (a no-op that would delete the term).
	 *
	 * @return array{ ok:bool, reason?:string, moved?:int, into?:array<string,mixed> }
	 */
	public function merge_tags( int $from, int $into ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		if ( $from <= 0 || $into <= 0 ) {
			return array( 'ok' => false, 'reason' => 'bad-id' );
		}
		if ( $from === $into ) {
			return array( 'ok' => false, 'reason' => 'merge-into-self' );
		}
		if ( null === $this->our_term( $from, self::TAX_TAG ) || null === $this->our_term( $into, self::TAX_TAG ) ) {
			return array( 'ok' => false, 'reason' => 'not-found' );
		}

		$moved = 0;
		if ( function_exists( 'wp_set_object_terms' ) ) {
			foreach ( $this->objects_in_tag( $from ) as $aid ) {
				$res = wp_set_object_terms( (int) $aid, array( $into ), self::TAX_TAG, true );
				if ( ! self::is_error( $res ) ) {
					++$moved;
				}
			}
		}
		if ( function_exists( 'wp_delete_term' ) ) {
			wp_delete_term( $from, self::TAX_TAG );
		}
		return array( 'ok' => true, 'moved' => $moved, 'into' => $this->tag_dto_by_id( $into ) );
	}

	/** Object ids currently carrying a tag term (empty under the harness / on error). */
	private function objects_in_tag( int $id ): array {
		if ( $id <= 0 || ! function_exists( 'get_objects_in_term' ) ) {
			return array();
		}
		$objs = get_objects_in_term( $id, self::TAX_TAG );
		if ( self::is_error( $objs ) || ! is_array( $objs ) ) {
			return array();
		}
		return array_map( 'intval', $objs );
	}

	/** A tag DTO { id, name, count } re-read fresh after a mutation. */
	private function tag_dto_by_id( int $id ): array {
		$term = $this->our_term( $id, self::TAX_TAG );
		return array(
			'id'    => $id,
			'name'  => ( is_object( $term ) && isset( $term->name ) ) ? (string) $term->name : '',
			'count' => ( is_object( $term ) && isset( $term->count ) ) ? (int) $term->count : 0,
		);
	}

	// ── teardown ────────────────────────────────────────────────────────────────────

	/**
	 * Remove this feature's ENTIRE persistent footprint: every term in both taxonomies
	 * (wp_delete_term also drops each term's meta + object relationships). NEVER touches an
	 * attachment or a file. Deliberately NOT entitlement-gated — teardown runs on an
	 * operator disable / uninstall, exactly when the flag may already be gone (mirrors
	 * IWSL_Media_Protection::purge()). Idempotent + cheap when already clean.
	 *
	 * @return array{ ok:bool, folders:int, tags:int }
	 */
	public function purge(): array {
		$folders = $this->delete_all_terms( self::TAX_FOLDER );
		$tags    = $this->delete_all_terms( self::TAX_TAG );
		return array( 'ok' => true, 'folders' => $folders, 'tags' => $tags );
	}

	// ── AJAX handlers (ajax_guard → cast POST → delegate → ok) ───────────────────────

	/** AJAX: the folder + tag tree. */
	public function handle_tree_ajax(): void {
		$this->ajax_guard();
		$this->ok( $this->folder_tree() );
	}

	/** AJAX: a filtered, paginated media page. */
	public function handle_list_ajax(): void {
		$this->ajax_guard();
		$args = array(
			'folder_id'  => isset( $_POST['folder_id'] ) ? (int) $_POST['folder_id'] : -1,
			'search'     => isset( $_POST['search'] ) ? self::request_string( $_POST['search'] ) : '',
			'mime_group' => isset( $_POST['mime_group'] ) ? self::request_string( $_POST['mime_group'] ) : 'all',
			'tag_ids'    => self::post_int_array( 'tag_ids' ),
			'orderby'    => isset( $_POST['orderby'] ) ? self::request_string( $_POST['orderby'] ) : 'date',
			'order'      => isset( $_POST['order'] ) ? self::request_string( $_POST['order'] ) : 'desc',
			'page'       => isset( $_POST['page'] ) ? (int) $_POST['page'] : 1,
			'per_page'   => isset( $_POST['per_page'] ) ? (int) $_POST['per_page'] : self::LIST_PER_PAGE_DEFAULT,
		);
		$this->ok( $this->query_media( $args ) );
	}

	/** AJAX: create a folder. */
	public function handle_folder_create_ajax(): void {
		$this->ajax_guard();
		$name   = isset( $_POST['name'] ) ? self::request_string( $_POST['name'] ) : '';
		$parent = isset( $_POST['parent'] ) ? (int) $_POST['parent'] : 0;
		$this->ok( $this->create_folder( $name, $parent ) );
	}

	/** AJAX: rename a folder. */
	public function handle_folder_rename_ajax(): void {
		$this->ajax_guard();
		$id   = isset( $_POST['id'] ) ? (int) $_POST['id'] : 0;
		$name = isset( $_POST['name'] ) ? self::request_string( $_POST['name'] ) : '';
		$this->ok( $this->rename_folder( $id, $name ) );
	}

	/** AJAX: delete a folder (+ descendants). */
	public function handle_folder_delete_ajax(): void {
		$this->ajax_guard();
		$id = isset( $_POST['id'] ) ? (int) $_POST['id'] : 0;
		$this->ok( $this->delete_folder( $id ) );
	}

	/** AJAX: move (reparent / reorder) a folder. */
	public function handle_folder_move_ajax(): void {
		$this->ajax_guard();
		$id     = isset( $_POST['id'] ) ? (int) $_POST['id'] : 0;
		$parent = isset( $_POST['parent'] ) ? (int) $_POST['parent'] : 0;
		$order  = ( isset( $_POST['order'] ) && '' !== $_POST['order'] ) ? (int) $_POST['order'] : null;
		$this->ok( $this->move_folder( $id, $parent, $order ) );
	}

	/** AJAX: file attachments into a folder (or unfile with folder_id 0). */
	public function handle_assign_ajax(): void {
		$this->ajax_guard();
		$ids       = self::post_int_array( 'ids' );
		$folder_id = isset( $_POST['folder_id'] ) ? (int) $_POST['folder_id'] : 0;
		$this->ok( $this->assign( $ids, $folder_id ) );
	}

	/** AJAX: add/remove tags across attachments. */
	public function handle_tag_ajax(): void {
		$this->ajax_guard();
		$ids    = self::post_int_array( 'ids' );
		$add    = self::post_string_array( 'add' );
		$remove = self::post_int_array( 'remove' );
		$this->ok( $this->tag( $ids, $add, $remove ) );
	}

	// ── native library: list-mode folder filter ─────────────────────────────────────

	/**
	 * `restrict_manage_posts`: on the Media Library list table, echo a folder `<select
	 * name="iwsl_folder">` (All / Unfiled / each folder, indented by depth). STATEMENT 1
	 * is the gate. All output escaped.
	 *
	 * @param mixed $post_type The list-table post type (WordPress passes this).
	 */
	public function render_library_folder_filter( $post_type = '' ): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		$type = is_string( $post_type ) && '' !== $post_type
			? $post_type
			: (string) ( $GLOBALS['typenow'] ?? '' );
		if ( 'attachment' !== $type ) {
			return;
		}

		$current = isset( $_GET[ self::LIBRARY_FILTER_ARG ] ) ? self::request_string( $_GET[ self::LIBRARY_FILTER_ARG ] ) : '';

		echo '<select name="' . self::esc_attr_safe( self::LIBRARY_FILTER_ARG ) . '">';
		echo '<option value="">' . self::esc_html_safe( $this->tx( 'All folders' ) ) . '</option>';
		echo '<option value="0"' . ( '0' === $current ? ' selected="selected"' : '' ) . '>' . self::esc_html_safe( $this->tx( 'Unfiled' ) ) . '</option>';
		foreach ( $this->folder_tree()['folders'] as $f ) {
			$prefix = str_repeat( '— ', max( 0, (int) $f['depth'] ) );
			echo '<option value="' . self::esc_attr_safe( (string) $f['id'] ) . '"'
				. ( (string) $f['id'] === $current ? ' selected="selected"' : '' ) . '>'
				. self::esc_html_safe( $prefix . (string) $f['name'] ) . '</option>';
		}
		echo '</select>';
	}

	/**
	 * `pre_get_posts`: constrain the Media Library MAIN query to the selected folder.
	 * STATEMENT 1 is the gate; only the admin main attachment query with a valid
	 * `iwsl_folder` is touched (0 = unfiled, positive = that folder).
	 *
	 * @param mixed $query The WP_Query being prepared.
	 */
	public function filter_library_query( $query = null ): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( ! is_object( $query ) || ! method_exists( $query, 'is_main_query' ) || ! $query->is_main_query() ) {
			return;
		}
		if ( function_exists( 'is_admin' ) && ! is_admin() ) {
			return;
		}
		if ( ! method_exists( $query, 'get' ) || 'attachment' !== $query->get( 'post_type' ) ) {
			return;
		}
		if ( ! isset( $_GET[ self::LIBRARY_FILTER_ARG ] ) || '' === $_GET[ self::LIBRARY_FILTER_ARG ] ) {
			return;
		}

		$raw = self::request_string( $_GET[ self::LIBRARY_FILTER_ARG ] );
		if ( '0' === $raw ) {
			$clause = array( 'taxonomy' => self::TAX_FOLDER, 'operator' => 'NOT EXISTS' );
		} else {
			$fid = (int) $raw;
			if ( $fid <= 0 || null === $this->our_term( $fid, self::TAX_FOLDER ) ) {
				return;
			}
			$clause = array( 'taxonomy' => self::TAX_FOLDER, 'field' => 'term_id', 'terms' => array( $fid ), 'operator' => 'IN' );
		}

		$existing = $query->get( 'tax_query' );
		$tax      = is_array( $existing ) ? $existing : array();
		$tax[]    = $clause;
		if ( ! method_exists( $query, 'set' ) ) {
			return;
		}
		$query->set( 'tax_query', $tax );
	}

	// ── native library: attachment-detail fields ────────────────────────────────────

	/**
	 * `attachment_fields_to_edit`: add a Folder `<select>` and a comma-separated Tags field
	 * to the media modal / edit screen. STATEMENT 1 is the gate. All output escaped.
	 *
	 * @param mixed $fields Existing field defs.
	 * @param mixed $post   The attachment WP_Post.
	 * @return mixed
	 */
	public function attachment_fields( $fields, $post = null ) {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			return $fields;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $fields;
		}
		$fields = is_array( $fields ) ? $fields : array();
		$id     = is_object( $post ) && isset( $post->ID ) ? (int) $post->ID : 0;
		if ( $id <= 0 ) {
			return $fields;
		}

		$fields[ self::FIELD_FOLDER ] = array(
			'label' => $this->tx( 'Folder' ),
			'input' => 'html',
			'html'  => $this->folder_select_html( $id, $this->folder_of( $id ) ),
			'helps' => $this->tx( 'Media Explorer folder (a file is in at most one folder).' ),
		);

		$names = array();
		foreach ( $this->tags_of( $id ) as $t ) {
			$names[] = (string) $t['name'];
		}
		$fields[ self::FIELD_TAGS ] = array(
			'label' => $this->tx( 'Folder tags' ),
			'input' => 'html',
			'html'  => '<input type="text" name="attachments[' . $id . '][' . self::esc_attr_safe( self::FIELD_TAGS ) . ']" value="'
				. self::esc_attr_safe( implode( ', ', $names ) ) . '" autocomplete="off" style="width:100%;" />',
			'helps' => $this->tx( 'Comma-separated Media Explorer tags.' ),
		);

		return $fields;
	}

	/**
	 * `attachment_fields_to_save`: persist the Folder + Tags fields. STATEMENT 1 is the
	 * gate; additionally requires `edit_post` on the attachment. Delegates to the gated
	 * mutators so every id/name/cap invariant holds. Returns $post unchanged.
	 *
	 * @param mixed $post       The attachment post-data array (carries ID).
	 * @param mixed $attachment The posted compat-field values.
	 * @return mixed
	 */
	public function save_attachment_fields( $post, $attachment = null ) {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			return $post;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $post;
		}
		$id = is_array( $post ) && isset( $post['ID'] ) ? (int) $post['ID'] : 0;
		if ( $id <= 0 || ! is_array( $attachment ) ) {
			return $post;
		}
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'edit_post', $id ) ) {
			return $post;
		}

		if ( array_key_exists( self::FIELD_FOLDER, $attachment ) ) {
			$this->assign( array( $id ), (int) $attachment[ self::FIELD_FOLDER ] );
		}
		if ( array_key_exists( self::FIELD_TAGS, $attachment ) ) {
			$raw   = is_scalar( $attachment[ self::FIELD_TAGS ] ) ? (string) $attachment[ self::FIELD_TAGS ] : '';
			$parts = explode( ',', $raw );
			$this->replace_file_tags( $id, is_array( $parts ) ? $parts : array() );
		}

		return $post;
	}

	// ── private: term helpers ────────────────────────────────────────────────────────

	/** All folder terms (WP_Term objects), or an empty array under the harness / on error. */
	private function folder_terms(): array {
		return $this->all_terms( self::TAX_FOLDER );
	}

	/** All tag terms (WP_Term objects), or an empty array. */
	private function tag_terms(): array {
		return $this->all_terms( self::TAX_TAG );
	}

	/** Every term in a taxonomy (hide_empty off), guarded for the harness. */
	private function all_terms( string $taxonomy ): array {
		if ( ! function_exists( 'get_terms' ) ) {
			return array();
		}
		$terms = get_terms( array( 'taxonomy' => $taxonomy, 'hide_empty' => false ) );
		if ( self::is_error( $terms ) || ! is_array( $terms ) ) {
			return array();
		}
		return $terms;
	}

	/** The term if it exists AND belongs to $taxonomy, else null (foreign / missing id). */
	private function our_term( int $id, string $taxonomy ) {
		if ( $id <= 0 || ! function_exists( 'get_term' ) ) {
			return null;
		}
		$term = get_term( $id, $taxonomy );
		if ( self::is_error( $term ) || ! is_object( $term ) || ! isset( $term->term_id ) ) {
			return null;
		}
		if ( isset( $term->taxonomy ) && $taxonomy !== $term->taxonomy ) {
			return null;
		}
		return $term;
	}

	/** Delete every term in a taxonomy; returns the count removed. Attachments untouched. */
	private function delete_all_terms( string $taxonomy ): int {
		if ( ! function_exists( 'get_terms' ) || ! function_exists( 'wp_delete_term' ) ) {
			return 0;
		}
		$ids = get_terms( array( 'taxonomy' => $taxonomy, 'hide_empty' => false, 'fields' => 'ids' ) );
		if ( self::is_error( $ids ) || ! is_array( $ids ) ) {
			return 0;
		}
		$removed = 0;
		foreach ( $ids as $id ) {
			$res = wp_delete_term( (int) $id, $taxonomy );
			if ( ! self::is_error( $res ) && false !== $res ) {
				++$removed;
			}
		}
		return $removed;
	}

	/** A folder DTO { id, name, parent, count, order, depth } from a WP_Term + parent map. */
	private function folder_dto( $term, array $pmap ): array {
		$id = (int) $term->term_id;
		return array(
			'id'     => $id,
			'name'   => isset( $term->name ) ? (string) $term->name : '',
			'parent' => isset( $term->parent ) ? (int) $term->parent : 0,
			'count'  => isset( $term->count ) ? (int) $term->count : 0,
			'order'  => $this->term_order( $id ),
			'depth'  => self::depth_of( $id, $pmap ),
		);
	}

	/** Re-fetch a folder DTO by id (fresh name/parent after a mutation). */
	private function folder_dto_by_id( int $id ): array {
		$terms = $this->folder_terms();
		$pmap  = self::parent_map( $terms );
		foreach ( $terms as $t ) {
			if ( is_object( $t ) && isset( $t->term_id ) && (int) $t->term_id === $id ) {
				return $this->folder_dto( $t, $pmap );
			}
		}
		return array( 'id' => $id, 'name' => '', 'parent' => 0, 'count' => 0, 'order' => $this->term_order( $id ), 'depth' => 0 );
	}

	/** A folder's sibling-ordering value (term meta), or 0. */
	private function term_order( int $id ): int {
		if ( ! function_exists( 'get_term_meta' ) ) {
			return 0;
		}
		$v = get_term_meta( $id, self::ORDER_META, true );
		return is_numeric( $v ) ? (int) $v : 0;
	}

	/** The next free sibling order under $parent (max + 1), excluding $exclude. */
	private function next_sibling_order( int $parent, int $exclude = 0 ): int {
		$max = -1;
		foreach ( $this->folder_terms() as $t ) {
			if ( ! is_object( $t ) || ! isset( $t->term_id, $t->parent ) ) {
				continue;
			}
			$tid = (int) $t->term_id;
			if ( $tid === $exclude || (int) $t->parent !== $parent ) {
				continue;
			}
			$o = $this->term_order( $tid );
			if ( $o > $max ) {
				$max = $o;
			}
		}
		return $max + 1;
	}

	/** How many tags an attachment already carries. */
	private function count_file_tags( int $id ): int {
		if ( ! function_exists( 'wp_get_object_terms' ) ) {
			return 0;
		}
		$t = wp_get_object_terms( $id, self::TAX_TAG, array( 'fields' => 'ids' ) );
		return ( self::is_error( $t ) || ! is_array( $t ) ) ? 0 : count( $t );
	}

	/** The single folder id an attachment is filed in, or 0 (unfiled). */
	private function folder_of( int $id ): int {
		if ( $id <= 0 || ! function_exists( 'wp_get_object_terms' ) ) {
			return 0;
		}
		$terms = wp_get_object_terms( $id, self::TAX_FOLDER, array( 'fields' => 'ids' ) );
		if ( self::is_error( $terms ) || ! is_array( $terms ) || empty( $terms ) ) {
			return 0;
		}
		return (int) $terms[0];
	}

	/** An attachment's tags as [{id,name}]. */
	private function tags_of( int $id ): array {
		if ( $id <= 0 || ! function_exists( 'wp_get_object_terms' ) ) {
			return array();
		}
		$terms = wp_get_object_terms( $id, self::TAX_TAG );
		if ( self::is_error( $terms ) || ! is_array( $terms ) ) {
			return array();
		}
		$out = array();
		foreach ( $terms as $t ) {
			if ( is_object( $t ) && isset( $t->term_id, $t->name ) ) {
				$out[] = array( 'id' => (int) $t->term_id, 'name' => (string) $t->name );
			}
		}
		return $out;
	}

	/** Replace an attachment's tag set (modal save). Sanitized + capped; gated by caller. */
	private function replace_file_tags( int $id, array $names ): void {
		if ( ! function_exists( 'wp_set_object_terms' ) ) {
			return;
		}
		$clean = array();
		foreach ( $names as $n ) {
			$s = self::sanitize_name( is_scalar( $n ) ? (string) $n : '' );
			if ( '' !== $s && '' === self::validate_name( $s ) && ! in_array( $s, $clean, true ) ) {
				$clean[] = $s;
			}
			if ( count( $clean ) >= self::MAX_TAGS_PER_FILE ) {
				break;
			}
		}
		wp_set_object_terms( $id, $clean, self::TAX_TAG, false );
	}

	// ── private: tree math (pure, static — harness-testable) ─────────────────────────

	/** Build a term_id => parent_id map from a term list. */
	private static function parent_map( array $terms ): array {
		$map = array();
		foreach ( $terms as $t ) {
			if ( is_object( $t ) && isset( $t->term_id ) ) {
				$map[ (int) $t->term_id ] = isset( $t->parent ) ? (int) $t->parent : 0;
			}
		}
		return $map;
	}

	/** The 0-based depth of a term (root = 0), walking the parent chain with a guard. */
	private static function depth_of( int $id, array $pmap ): int {
		$depth = 0;
		$cur   = $id;
		$guard = 0;
		while ( isset( $pmap[ $cur ] ) && $pmap[ $cur ] > 0 && $guard <= self::MAX_DEPTH + 2 ) {
			$cur = (int) $pmap[ $cur ];
			++$depth;
			++$guard;
		}
		return $depth;
	}

	/** Every descendant term id strictly below $id (iterative; bounded by MAX_FOLDERS). */
	private static function descendants_of( int $id, array $pmap ): array {
		$children = array();
		foreach ( $pmap as $cid => $pid ) {
			$children[ (int) $pid ][] = (int) $cid;
		}
		$out   = array();
		$stack = $children[ $id ] ?? array();
		$guard = 0;
		while ( $stack && $guard <= self::MAX_FOLDERS + 1 ) {
			$node = (int) array_pop( $stack );
			++$guard;
			if ( isset( $out[ $node ] ) ) {
				continue;
			}
			$out[ $node ] = true;
			foreach ( $children[ $node ] ?? array() as $gc ) {
				$stack[] = (int) $gc;
			}
		}
		return array_keys( $out );
	}

	// ── private: query building + item shaping ───────────────────────────────────────

	/**
	 * Build the WP_Query args for a media page from the (already-parsed) filter args.
	 * folder_id 0 = unfiled (NOT EXISTS), -1 = all (no folder clause), >0 = that folder.
	 */
	private function list_query_args( array $args, int $page, int $per_page ): array {
		$folder_id = isset( $args['folder_id'] ) ? (int) $args['folder_id'] : -1;
		$search    = isset( $args['search'] ) ? self::request_string( $args['search'] ) : '';
		$mime      = isset( $args['mime_group'] ) ? (string) $args['mime_group'] : 'all';
		$tag_ids   = array();
		if ( isset( $args['tag_ids'] ) && is_array( $args['tag_ids'] ) ) {
			foreach ( $args['tag_ids'] as $tid ) {
				$iv = (int) $tid;
				if ( $iv > 0 && ! in_array( $iv, $tag_ids, true ) ) {
					$tag_ids[] = $iv;
				}
			}
		}

		$q = array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'fields'         => 'ids',
			'paged'          => $page,
			'posts_per_page' => $per_page,
			'orderby'        => self::orderby_for( isset( $args['orderby'] ) ? (string) $args['orderby'] : 'date' ),
			'order'          => ( isset( $args['order'] ) && 'asc' === strtolower( (string) $args['order'] ) ) ? 'ASC' : 'DESC',
			'no_found_rows'  => false,
		);

		$mime_filter = self::mime_query_for( $mime );
		if ( '' !== $mime_filter && array() !== $mime_filter ) {
			$q['post_mime_type'] = $mime_filter;
		}
		if ( '' !== $search ) {
			$q['s'] = $search;
		}

		$tax = array();
		if ( 0 === $folder_id ) {
			$tax[] = array( 'taxonomy' => self::TAX_FOLDER, 'operator' => 'NOT EXISTS' );
		} elseif ( $folder_id > 0 ) {
			$tax[] = array( 'taxonomy' => self::TAX_FOLDER, 'field' => 'term_id', 'terms' => array( $folder_id ), 'operator' => 'IN' );
		}
		if ( $tag_ids ) {
			$tax[] = array( 'taxonomy' => self::TAX_TAG, 'field' => 'term_id', 'terms' => $tag_ids, 'operator' => 'IN' );
		}
		if ( count( $tax ) > 1 ) {
			$tax = array_merge( array( 'relation' => 'AND' ), $tax );
		}
		if ( $tax ) {
			$q['tax_query'] = $tax;
		}

		return $q;
	}

	/** Run a WP_Query, returning { ids:int[], total:int }. Empty when WP_Query is absent. */
	private function run_attachment_query( array $args ): array {
		if ( ! class_exists( 'WP_Query' ) ) {
			return array( 'ids' => array(), 'total' => 0 );
		}
		$q     = new WP_Query( $args );
		$posts = isset( $q->posts ) && is_array( $q->posts ) ? $q->posts : array();
		$ids   = array();
		foreach ( $posts as $p ) {
			$ids[] = (int) ( is_object( $p ) && isset( $p->ID ) ? $p->ID : $p );
		}
		$total = isset( $q->found_posts ) ? (int) $q->found_posts : count( $ids );
		return array( 'ids' => $ids, 'total' => $total );
	}

	/** Count attachments matching an optional tax_query. 0 under the harness (no WP_Query). */
	private function count_attachments( array $tax_query ): int {
		$args = array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'fields'         => 'ids',
			'paged'          => 1,
			'posts_per_page' => 1,
			'no_found_rows'  => false,
		);
		if ( array() !== $tax_query ) {
			$args['tax_query'] = $tax_query;
		}
		return $this->run_attachment_query( $args )['total'];
	}

	/**
	 * Build one media grid item.
	 *
	 * @return array{ id:int, title:string, filename:string, mime:string, url:string, thumb:string, folder_id:int, tags:array<int,array{id:int,name:string}>, date:string, filesize:int, width:int, height:int }
	 */
	private function media_item( int $id ): array {
		$file = ( $id > 0 && function_exists( 'get_attached_file' ) ) ? get_attached_file( $id ) : '';
		$file = is_string( $file ) ? $file : '';

		$filesize = 0;
		if ( '' !== $file && is_file( $file ) ) {
			$sz = filesize( $file );
			$filesize = ( is_int( $sz ) && $sz > 0 ) ? $sz : 0;
		}

		$width  = 0;
		$height = 0;
		if ( function_exists( 'wp_get_attachment_metadata' ) ) {
			$meta = wp_get_attachment_metadata( $id );
			if ( is_array( $meta ) ) {
				$width  = isset( $meta['width'] ) ? (int) $meta['width'] : 0;
				$height = isset( $meta['height'] ) ? (int) $meta['height'] : 0;
			}
		}

		return array(
			'id'        => $id,
			'title'     => function_exists( 'get_the_title' ) ? (string) get_the_title( $id ) : '',
			'filename'  => '' !== $file ? basename( $file ) : '',
			'mime'      => function_exists( 'get_post_mime_type' ) ? (string) get_post_mime_type( $id ) : '',
			'url'       => function_exists( 'wp_get_attachment_url' ) ? (string) ( wp_get_attachment_url( $id ) ?: '' ) : '',
			'thumb'     => function_exists( 'wp_get_attachment_image_url' ) ? (string) ( wp_get_attachment_image_url( $id, 'thumbnail' ) ?: '' ) : '',
			'folder_id' => $this->folder_of( $id ),
			'tags'      => $this->tags_of( $id ),
			'date'      => function_exists( 'get_the_date' ) ? (string) ( get_the_date( 'c', $id ) ?: '' ) : '',
			'filesize'  => $filesize,
			'width'     => $width,
			'height'    => $height,
		);
	}

	// ── private: attachment / capability validation ──────────────────────────────────

	/** True only for a real `attachment` the current user may edit. Fails closed. */
	private function can_edit_attachment( int $id ): bool {
		if ( $id <= 0 || ! function_exists( 'get_post_type' ) ) {
			return false;
		}
		if ( 'attachment' !== get_post_type( $id ) ) {
			return false;
		}
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'edit_post', $id ) ) {
			return false;
		}
		return true;
	}

	// ── private: input parsing / normalization ───────────────────────────────────────

	/**
	 * De-duplicate + positive-filter an id list. Returns null when the DISTINCT id count
	 * exceeds BULK_MAX (the DoS guard), else the cleaned int list.
	 *
	 * @param array<int,mixed> $ids
	 * @return int[]|null
	 */
	private static function clean_ids( array $ids ): ?array {
		$clean = array();
		foreach ( $ids as $v ) {
			$iv = (int) $v;
			if ( $iv > 0 && ! in_array( $iv, $clean, true ) ) {
				$clean[] = $iv;
				if ( count( $clean ) > self::BULK_MAX ) {
					return null;
				}
			}
		}
		return $clean;
	}

	/**
	 * Sanitize a folder/tag name: unslash, strip ALL tags (script/style content removed
	 * outright), collapse to a single-line safe string, trim. Harness-safe fallbacks mirror
	 * wp_strip_all_tags + sanitize_text_field so an `<script>` payload reduces to '' even
	 * without WordPress loaded.
	 *
	 * @param mixed $raw
	 */
	private static function sanitize_name( $raw ): string {
		$name = is_scalar( $raw ) ? (string) $raw : '';
		if ( function_exists( 'wp_unslash' ) ) {
			$name = (string) wp_unslash( $name );
		}
		if ( function_exists( 'wp_strip_all_tags' ) ) {
			$name = (string) wp_strip_all_tags( $name );
		} else {
			$name = (string) preg_replace( '#<(script|style)\b[^>]*>.*?</\1>#is', '', $name );
			$name = (string) preg_replace( '#<[^>]*>#', '', $name );
		}
		if ( function_exists( 'sanitize_text_field' ) ) {
			$name = (string) sanitize_text_field( $name );
		} else {
			$name = (string) preg_replace( '/[\r\n\t]+/', ' ', $name );
			$name = (string) preg_replace( '/[\x00-\x1f\x7f]/', '', $name );
			$name = (string) preg_replace( '/\s{2,}/', ' ', $name );
		}
		return trim( $name );
	}

	/** '' when a sanitized name is valid, else the rejection reason. */
	private static function validate_name( string $name ): string {
		if ( '' === $name ) {
			return 'bad-name';
		}
		$len = function_exists( 'mb_strlen' ) ? mb_strlen( $name ) : strlen( $name );
		if ( $len > self::MAX_NAME_LEN ) {
			return 'name-too-long';
		}
		return '';
	}

	/** Clamp a requested per-page size into [1, LIST_PER_PAGE_MAX], defaulting sensibly. */
	private static function clamp_per_page( int $per_page ): int {
		if ( $per_page <= 0 ) {
			return self::LIST_PER_PAGE_DEFAULT;
		}
		return min( $per_page, self::LIST_PER_PAGE_MAX );
	}

	/**
	 * Map a requested orderby to a WP_Query orderby (whitelist). `filename` → post name
	 * (the sanitized filename slug). `size` has no DB column, so it falls back to `date`
	 * for stable global ordering; the per-item `filesize` is returned so a client can sort
	 * the visible page if it wants.
	 */
	private static function orderby_for( string $orderby ): string {
		switch ( $orderby ) {
			case 'title':
				return 'title';
			case 'filename':
				return 'name';
			case 'size':
			case 'date':
			default:
				return 'date';
		}
	}

	/** Map a mime-group to a WP_Query `post_mime_type` value (or '' for all). */
	private static function mime_query_for( string $group ) {
		switch ( $group ) {
			case 'image':
				return 'image';
			case 'video':
				return 'video';
			case 'audio':
				return 'audio';
			case 'document':
				return self::DOC_MIMES;
			case 'all':
			default:
				return '';
		}
	}

	/** Read a scalar request value as a trimmed, unslashed string. */
	private static function request_string( $value ): string {
		if ( ! is_scalar( $value ) ) {
			return '';
		}
		$str = (string) $value;
		if ( function_exists( 'wp_unslash' ) ) {
			$str = (string) wp_unslash( $str );
		}
		return trim( $str );
	}

	/** Positive-int list from $_POST[$key] (an array), de-duplicated. */
	private static function post_int_array( string $key ): array {
		if ( ! isset( $_POST[ $key ] ) || ! is_array( $_POST[ $key ] ) ) {
			return array();
		}
		$out = array();
		foreach ( $_POST[ $key ] as $v ) {
			$iv = (int) $v;
			if ( $iv > 0 && ! in_array( $iv, $out, true ) ) {
				$out[] = $iv;
			}
		}
		return $out;
	}

	/** String list from $_POST[$key] (an array); raw values (callers sanitize). */
	private static function post_string_array( string $key ): array {
		if ( ! isset( $_POST[ $key ] ) || ! is_array( $_POST[ $key ] ) ) {
			return array();
		}
		$out = array();
		foreach ( $_POST[ $key ] as $v ) {
			if ( is_scalar( $v ) ) {
				$out[] = (string) $v;
			}
		}
		return $out;
	}

	// ── private: UI + AJAX plumbing ──────────────────────────────────────────────────

	/** Build the Folder `<select>` for the attachment modal (indented by depth, escaped). */
	private function folder_select_html( int $attachment_id, int $current ): string {
		$name = 'attachments[' . $attachment_id . '][' . self::FIELD_FOLDER . ']';
		$html = '<select name="' . self::esc_attr_safe( $name ) . '" style="width:100%;">';
		$html .= '<option value="0"' . ( 0 === $current ? ' selected="selected"' : '' ) . '>' . self::esc_html_safe( $this->tx( '— Unfiled —' ) ) . '</option>';
		foreach ( $this->folder_tree()['folders'] as $f ) {
			$prefix = str_repeat( '— ', max( 0, (int) $f['depth'] ) );
			$html  .= '<option value="' . self::esc_attr_safe( (string) $f['id'] ) . '"'
				. ( (int) $f['id'] === $current ? ' selected="selected"' : '' ) . '>'
				. self::esc_html_safe( $prefix . (string) $f['name'] ) . '</option>';
		}
		$html .= '</select>';
		return $html;
	}

	/**
	 * The shared AJAX gate — manage_options → nonce → entitlement, in that exact order.
	 * Emits a JSON error and stops on any failure. NO nopriv twin is ever registered.
	 */
	private function ajax_guard(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			$this->err( 'forbidden', 403 );
		}
		if ( function_exists( 'check_ajax_referer' ) ) {
			check_ajax_referer( self::NONCE, 'nonce' );
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->err( 'entitlement-locked', 403 );
		}
	}

	/** Emit a JSON success envelope (wp_send_json_success in WP; echo under the harness). */
	private function ok( array $data ): void {
		if ( function_exists( 'wp_send_json_success' ) ) {
			wp_send_json_success( $data );
		}
		echo function_exists( 'wp_json_encode' )
			? wp_json_encode( array( 'success' => true, 'data' => $data ) )
			: json_encode( array( 'success' => true, 'data' => $data ) );
	}

	/** Emit a JSON error envelope + stop. */
	private function err( string $reason, int $status = 400 ): void {
		if ( function_exists( 'wp_send_json_error' ) ) {
			wp_send_json_error( array( 'reason' => $reason ), $status );
		}
		echo function_exists( 'wp_json_encode' )
			? wp_json_encode( array( 'success' => false, 'data' => array( 'reason' => $reason ) ) )
			: json_encode( array( 'success' => false, 'data' => array( 'reason' => $reason ) ) );
	}

	// ── private: harness-safe wrappers ───────────────────────────────────────────────

	/** Translate a UI string (guarded — returns the literal under the harness). */
	private function tx( string $text ): string {
		return function_exists( '__' ) ? (string) __( $text, 'infraweaver-connector' ) : $text;
	}

	/** True only for a real WP_Error (guarded). */
	private static function is_error( $thing ): bool {
		return function_exists( 'is_wp_error' ) && is_wp_error( $thing );
	}

	private static function esc_html_safe( string $value ): string {
		return function_exists( 'esc_html' ) ? esc_html( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_attr_safe( string $value ): string {
		return function_exists( 'esc_attr' ) ? esc_attr( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}
