<?php
/**
 * IWSL_Media_Library — the fused per-asset READ-MODEL for the media surface.
 *
 * Three orthogonal metadata surfaces already live over the SAME attachments:
 *   - the folders taxonomy   (iwsl_media_folder / iwsl_media_tag)
 *   - the optimizer marker   (_iwsl_media_optimizer  → lossless/optimized state)
 *   - the offload marker     (_iwsl_offload          → offloaded / "on CDN" state)
 * They have never been queried together. This class is the JOIN: one row per
 * asset carrying folder + optimization + offload state at once, so the console
 * can answer "what folder / is it lossless / is it on the CDN" from ONE call.
 *
 * It REIMPLEMENTS NOTHING. It only reads what the engines store and classifies it.
 * Every mutation stays in the engines (optimizer / offload / folders); this
 * read-model never writes and registers no hooks. It also owns the strict param
 * validators for the seven signed `media.*` commands (a single cohesive home).
 *
 * Bounds (signed-envelope safety): `per_page` clamps to PER_PAGE_MAX; the optional
 * matching-id list (`include_ids`, the honest server-side select-all-matching
 * mechanism) caps at MATCH_IDS_MAX so the signed result stays well inside the
 * ~64 KB command ceiling; bulk id-lists are capped by the validators
 * (optimize ≤ REQUEST_MAX, offload/restore ≤ BULK_MAX, folder ≤ FOLDER_IDS_MAX).
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Media_Library {

	/** Optimization/offload columns require this flag (Media Offload shares it). */
	const FEATURE_OPT = 'image_optimization';
	/** Folder/tag column + the folder tree require this flag. */
	const FEATURE_FOLDERS = 'media_folders';
	/** Site-wide CDN host-swap — a banner flag, never a per-asset column. */
	const FEATURE_CDN = 'cdn_rewrite';

	/** Per-page list bounds (mirror the folders engine so the two never diverge). */
	const PER_PAGE_MAX     = 100;
	const PER_PAGE_DEFAULT = 60;

	/** Upper bound on ids returned for server-side select-all-matching. */
	const MATCH_IDS_MAX = 1500;

	/** Bulk id-list caps by command (the console loops for larger sets). */
	const REQUEST_MAX    = 200; // media.optimize (run() itself batches ≤ MAX_BATCH)
	const BULK_MAX       = 50;  // media.offload / media.restore
	const FOLDER_IDS_MAX = 200; // media.folder assign/tag
	const TAG_IDS_MAX    = 100; // list filter tag_ids
	const NAME_MAX       = 100;
	const SEARCH_MAX     = 200;
	const TAG_NAME_MAX   = 100;

	/** Postmeta keys we JOIN on (the engines' own state, read-only). */
	const OPT_META     = '_iwsl_media_optimizer';
	const OFFLOAD_META = '_iwsl_offload';

	/** Accepted enum vocabularies. First entry is the safe default. */
	const MIME_GROUPS = array( 'all', 'image', 'video', 'audio', 'document' );
	const OPT_FILTERS = array( 'all', 'optimized', 'unoptimized' );
	const OFF_FILTERS = array( 'all', 'offloaded', 'local' );
	const ORDERBYS    = array( 'date', 'title', 'filename', 'size' );
	const ORDERS      = array( 'desc', 'asc' );
	const FOLDER_OPS  = array( 'create', 'rename', 'move', 'delete', 'assign', 'tag' );

	/** @var IWSL_Entitlements */
	private $entitlements;

	public function __construct( IWSL_Entitlements $entitlements ) {
		$this->entitlements = $entitlements;
	}

	// ── read-model: the fused, filtered, paginated asset list ────────────────────

	/**
	 * One filtered, paginated page of fused asset rows. The surface is visible when
	 * EITHER folders OR optimization is unlocked; each column is blanked independently
	 * when its own feature is locked (so a Pro site without the optimizer still sees
	 * folders, with the optimization/offload columns null). A site with neither gets
	 * a `locked` envelope carrying the gate reason.
	 *
	 * @param array<string,mixed> $args page, per_page, folder_id, search, mime_group,
	 *   tag_ids, orderby, order, optimization, offload, include_ids.
	 * @return array<string,mixed>
	 */
	public function list_assets( array $args ): array {
		$folders_on = $this->unlocked( self::FEATURE_FOLDERS );
		$opt_on     = $this->unlocked( self::FEATURE_OPT );

		$page     = isset( $args['page'] ) ? max( 1, (int) $args['page'] ) : 1;
		$per_page = self::clamp_per_page( isset( $args['per_page'] ) ? (int) $args['per_page'] : self::PER_PAGE_DEFAULT );
		$opt_f    = self::norm_enum( $args['optimization'] ?? 'all', self::OPT_FILTERS );
		$off_f    = self::norm_enum( $args['offload'] ?? 'all', self::OFF_FILTERS );

		$features = array(
			'media_folders'      => $folders_on,
			'image_optimization' => $opt_on,
			'cdn_rewrite'        => $this->unlocked( self::FEATURE_CDN ),
		);
		$envelope = array(
			'page'     => $page,
			'per_page' => $per_page,
			'features' => $features,
			'filters'  => array( 'optimization' => $opt_f, 'offload' => $off_f ),
		);

		if ( ! $folders_on && ! $opt_on ) {
			return array_merge(
				$envelope,
				array(
					'items'  => array(),
					'total'  => 0,
					'pages'  => 0,
					'locked' => true,
					'gate'   => $this->entitlements->evaluate( self::FEATURE_OPT ),
				)
			);
		}

		$query_args = $this->build_query_args( $args, $page, $per_page, $opt_f, $off_f );
		$run        = $this->run_query( $query_args );

		$items = array();
		foreach ( $run['ids'] as $id ) {
			$items[] = $this->row( (int) $id, $folders_on, $opt_on );
		}
		$total = (int) $run['total'];

		$out = array_merge(
			$envelope,
			array(
				'items'  => $items,
				'total'  => $total,
				'pages'  => (int) ceil( $total / max( 1, $per_page ) ),
				'locked' => false,
			)
		);

		if ( ! empty( $args['include_ids'] ) ) {
			$match          = $this->match_ids( $query_args );
			$out['ids']     = $match['ids'];
			$out['ids_capped'] = $match['capped'];
		}
		return $out;
	}

	// ── read-model: query building ───────────────────────────────────────────────

	/**
	 * Translate the request into WP_Query args, mirroring the folders engine's
	 * folder/tag/mime/search/order semantics and adding the two meta predicates the
	 * fusion needs (optimization + offload). Doing both server-side is what makes the
	 * matching count — and therefore select-all — honest.
	 *
	 * @param array<string,mixed> $args
	 * @return array<string,mixed>
	 */
	private function build_query_args( array $args, int $page, int $per_page, string $opt_f, string $off_f ): array {
		$q = array(
			'post_type'   => 'attachment',
			'post_status' => 'inherit',
			'fields'      => 'ids',
			'paged'       => $page,
			'posts_per_page' => $per_page,
		);

		$orderby      = self::norm_enum( $args['orderby'] ?? 'date', self::ORDERBYS );
		$q['orderby'] = ( 'title' === $orderby ) ? 'title' : ( ( 'filename' === $orderby ) ? 'name' : 'date' );
		$q['order']   = ( isset( $args['order'] ) && 'asc' === strtolower( (string) $args['order'] ) ) ? 'ASC' : 'DESC';

		$mime_group = self::norm_enum( $args['mime_group'] ?? 'all', self::MIME_GROUPS );
		$mime       = $this->mime_for_group( $mime_group );
		if ( '' !== $mime && array() !== $mime ) {
			$q['post_mime_type'] = $mime;
		}

		if ( isset( $args['search'] ) && is_string( $args['search'] ) && '' !== $args['search'] ) {
			$q['s'] = substr( $args['search'], 0, self::SEARCH_MAX );
		}

		$tax       = array();
		$folder_id = isset( $args['folder_id'] ) ? (int) $args['folder_id'] : -1;
		if ( 0 === $folder_id ) {
			$tax[] = array( 'taxonomy' => self::tax_folder(), 'operator' => 'NOT EXISTS' );
		} elseif ( $folder_id > 0 ) {
			$tax[] = array( 'taxonomy' => self::tax_folder(), 'field' => 'term_id', 'terms' => array( $folder_id ), 'operator' => 'IN' );
		}
		$tag_ids = self::int_list( $args['tag_ids'] ?? array(), self::TAG_IDS_MAX );
		if ( array() !== $tag_ids ) {
			$tax[] = array( 'taxonomy' => self::tax_tag(), 'field' => 'term_id', 'terms' => $tag_ids, 'operator' => 'IN' );
		}
		if ( array() !== $tax ) {
			if ( count( $tax ) > 1 ) {
				$tax['relation'] = 'AND';
			}
			$q['tax_query'] = $tax; // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_tax_query
		}

		$meta = array();
		if ( 'optimized' === $opt_f ) {
			$meta[] = array( 'key' => self::OPT_META, 'compare' => 'EXISTS' );
		} elseif ( 'unoptimized' === $opt_f ) {
			// notLossless = ELIGIBLE and not yet optimized. Constraining the MIME to
			// the optimizer's own accept-list keeps ineligible files out of a
			// "make lossless" selection, so bulk optimize never targets a non-image.
			$meta[]              = array( 'key' => self::OPT_META, 'compare' => 'NOT EXISTS' );
			$q['post_mime_type'] = $this->unoptimized_mimes( $mime_group );
		}
		if ( 'offloaded' === $off_f ) {
			$meta[] = array( 'key' => self::OFFLOAD_META, 'compare' => 'EXISTS' );
		} elseif ( 'local' === $off_f ) {
			$meta[] = array( 'key' => self::OFFLOAD_META, 'compare' => 'NOT EXISTS' );
		}
		if ( array() !== $meta ) {
			if ( count( $meta ) > 1 ) {
				$meta['relation'] = 'AND';
			}
			$q['meta_query'] = $meta; // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
		}

		return $q;
	}

	/** Run a paginated WP_Query → { ids:int[], total:int }. Empty outside WordPress. */
	private function run_query( array $args ): array {
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

	/**
	 * The full matching id set for select-all-matching, capped at MATCH_IDS_MAX so
	 * the signed response stays bounded. `capped` is true when more matched than fit,
	 * telling the console to paginate the filter for the overflow.
	 *
	 * @return array{ ids:int[], capped:bool }
	 */
	private function match_ids( array $query_args ): array {
		$args                   = $query_args;
		$args['paged']          = 1;
		$args['posts_per_page'] = self::MATCH_IDS_MAX;
		$run                    = $this->run_query( $args );
		return array(
			'ids'    => array_map( 'intval', $run['ids'] ),
			'capped' => (int) $run['total'] > self::MATCH_IDS_MAX,
		);
	}

	// ── read-model: per-asset row (the JOIN) ─────────────────────────────────────

	/**
	 * One fused row. Base fields mirror the folders engine's item shape; the folder,
	 * optimization and offload columns are each null/empty when their feature is off.
	 *
	 * @return array<string,mixed>
	 */
	private function row( int $id, bool $folders_on, bool $opt_on ): array {
		$file     = ( $id > 0 && function_exists( 'get_attached_file' ) ) ? (string) get_attached_file( $id ) : '';
		$filesize = ( '' !== $file && is_file( $file ) ) ? (int) filesize( $file ) : 0;

		$width  = 0;
		$height = 0;
		if ( function_exists( 'wp_get_attachment_metadata' ) ) {
			$meta = wp_get_attachment_metadata( $id );
			if ( is_array( $meta ) ) {
				$width  = isset( $meta['width'] ) ? (int) $meta['width'] : 0;
				$height = isset( $meta['height'] ) ? (int) $meta['height'] : 0;
			}
		}
		$mime = function_exists( 'get_post_mime_type' ) ? (string) get_post_mime_type( $id ) : '';

		return array(
			'id'           => $id,
			'title'        => function_exists( 'get_the_title' ) ? (string) get_the_title( $id ) : '',
			'filename'     => '' !== $file ? basename( $file ) : '',
			'mime'         => $mime,
			'url'          => function_exists( 'wp_get_attachment_url' ) ? (string) ( wp_get_attachment_url( $id ) ?: '' ) : '',
			'thumb'        => function_exists( 'wp_get_attachment_image_url' ) ? (string) ( wp_get_attachment_image_url( $id, 'thumbnail' ) ?: '' ) : '',
			'date'         => function_exists( 'get_the_date' ) ? (string) ( get_the_date( 'c', $id ) ?: '' ) : '',
			'filesize'     => max( 0, $filesize ),
			'width'        => $width,
			'height'       => $height,
			'folder'       => $folders_on ? $this->folder_of( $id ) : null,
			'tags'         => $folders_on ? $this->tags_of( $id ) : array(),
			'optimization' => $opt_on ? $this->optimization_of( $id, $mime, $file ) : null,
			'offload'      => $opt_on ? $this->offload_of( $id ) : null,
		);
	}

	/** {id,name} of the attachment's single folder term, or null (unfiled/locked). */
	private function folder_of( int $id ): ?array {
		foreach ( $this->object_terms( $id, self::tax_folder() ) as $t ) {
			if ( is_object( $t ) && isset( $t->term_id, $t->name ) ) {
				return array( 'id' => (int) $t->term_id, 'name' => (string) $t->name );
			}
		}
		return null;
	}

	/** @return array<int,array{id:int,name:string}> */
	private function tags_of( int $id ): array {
		$out = array();
		foreach ( $this->object_terms( $id, self::tax_tag() ) as $t ) {
			if ( is_object( $t ) && isset( $t->term_id, $t->name ) ) {
				$out[] = array( 'id' => (int) $t->term_id, 'name' => (string) $t->name );
			}
		}
		return $out;
	}

	/**
	 * Optimization state from the optimizer's own `_iwsl_media_optimizer` meta.
	 *   optimized  → the marker exists (converter/bytes carried through).
	 *   original   → eligible MIME, not yet optimized.
	 *   ineligible → the optimizer can't convert this MIME.
	 * `restorable` is true only when an optimized asset's ORIGINAL file still exists
	 * on disk (copy-mode keeps it; a replace-mode asset whose original is gone is
	 * marked non-restorable rather than silently failing a restore).
	 *
	 * @return array<string,mixed>
	 */
	private function optimization_of( int $id, string $mime, string $file ): array {
		$raw = $this->post_meta( $id, self::OPT_META );
		if ( is_array( $raw ) ) {
			$bytes_in  = isset( $raw['bytes_in'] ) ? (int) $raw['bytes_in'] : null;
			$bytes_out = isset( $raw['bytes_out'] ) ? (int) $raw['bytes_out'] : null;
			$saved     = ( null !== $bytes_in && $bytes_in > 0 && null !== $bytes_out )
				? round( ( 1 - ( $bytes_out / $bytes_in ) ) * 100, 1 )
				: null;
			return array(
				'status'     => 'optimized',
				'converter'  => isset( $raw['converter'] ) ? (string) $raw['converter'] : null,
				'bytes_in'   => $bytes_in,
				'bytes_out'  => $bytes_out,
				'saved_pct'  => $saved,
				'restorable' => ( '' !== $file && is_file( $file ) ),
			);
		}
		$eligible = in_array( $mime, $this->optimizable_mimes(), true );
		return array(
			'status'     => $eligible ? 'original' : 'ineligible',
			'converter'  => null,
			'bytes_in'   => null,
			'bytes_out'  => null,
			'saved_pct'  => null,
			'restorable' => false,
		);
	}

	/**
	 * Offload ("on CDN") state from the offload engine's `_iwsl_offload` meta. A
	 * non-empty `key` means the asset is served from the bucket.
	 *
	 * @return array<string,mixed>
	 */
	private function offload_of( int $id ): array {
		$raw = $this->post_meta( $id, self::OFFLOAD_META );
		if ( is_array( $raw ) && isset( $raw['key'] ) && '' !== (string) $raw['key'] ) {
			$variant = ( isset( $raw['variant'] ) && 'original' === (string) $raw['variant'] ) ? 'original' : 'derivative';
			return array(
				'status'  => 'offloaded',
				'variant' => $variant,
				'url'     => isset( $raw['url'] ) ? (string) $raw['url'] : null,
			);
		}
		return array( 'status' => 'local', 'variant' => null, 'url' => null );
	}

	// ── param validators for the seven signed media.* commands ───────────────────

	/**
	 * `media.list` params. Every field is optional (an empty object = defaults), but
	 * stray keys, out-of-vocabulary enums, an over-long search, or an over-cap
	 * tag-id list are refused — a signed-but-ignored field is padding.
	 *
	 * @param mixed $params
	 */
	public static function validate_list_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars    = get_object_vars( $params );
		$allowed = array(
			'page' => 1, 'per_page' => 1, 'folder_id' => 1, 'search' => 1, 'mime_group' => 1,
			'tag_ids' => 1, 'orderby' => 1, 'order' => 1, 'optimization' => 1, 'offload' => 1, 'include_ids' => 1,
		);
		if ( array() !== array_diff_key( $vars, $allowed ) ) {
			return false;
		}
		if ( isset( $vars['page'] ) && ( ! is_int( $vars['page'] ) || $vars['page'] < 1 ) ) {
			return false;
		}
		if ( isset( $vars['per_page'] ) && ( ! is_int( $vars['per_page'] ) || $vars['per_page'] < 1 || $vars['per_page'] > self::PER_PAGE_MAX ) ) {
			return false;
		}
		if ( isset( $vars['folder_id'] ) && ( ! is_int( $vars['folder_id'] ) || $vars['folder_id'] < -1 ) ) {
			return false;
		}
		if ( isset( $vars['search'] ) && ( ! is_string( $vars['search'] ) || strlen( $vars['search'] ) > self::SEARCH_MAX ) ) {
			return false;
		}
		if ( isset( $vars['mime_group'] ) && ! self::enum_ok( $vars['mime_group'], self::MIME_GROUPS ) ) {
			return false;
		}
		if ( isset( $vars['orderby'] ) && ! self::enum_ok( $vars['orderby'], self::ORDERBYS ) ) {
			return false;
		}
		if ( isset( $vars['order'] ) && ! self::enum_ok( $vars['order'], self::ORDERS ) ) {
			return false;
		}
		if ( isset( $vars['optimization'] ) && ! self::enum_ok( $vars['optimization'], self::OPT_FILTERS ) ) {
			return false;
		}
		if ( isset( $vars['offload'] ) && ! self::enum_ok( $vars['offload'], self::OFF_FILTERS ) ) {
			return false;
		}
		if ( isset( $vars['include_ids'] ) && ! is_bool( $vars['include_ids'] ) ) {
			return false;
		}
		if ( isset( $vars['tag_ids'] ) && ! self::id_array_ok( $vars['tag_ids'], self::TAG_IDS_MAX, true ) ) {
			return false;
		}
		return true;
	}

	/**
	 * `media.optimize` params: { ids:int[] (1..REQUEST_MAX), converter_id?, mode?,
	 * rewrite?, skip_optimized? }.
	 *
	 * @param mixed $params
	 */
	public static function validate_optimize_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars    = get_object_vars( $params );
		$allowed = array( 'ids' => 1, 'converter_id' => 1, 'mode' => 1, 'rewrite' => 1, 'skip_optimized' => 1 );
		if ( array() !== array_diff_key( $vars, $allowed ) ) {
			return false;
		}
		if ( ! isset( $vars['ids'] ) || ! self::id_array_ok( $vars['ids'], self::REQUEST_MAX, false ) ) {
			return false;
		}
		if ( isset( $vars['converter_id'] ) && ( ! is_string( $vars['converter_id'] ) || ! preg_match( '/^[a-z0-9_]{1,64}$/', $vars['converter_id'] ) ) ) {
			return false;
		}
		if ( isset( $vars['mode'] ) && ! self::enum_ok( $vars['mode'], array( 'copy', 'replace' ) ) ) {
			return false;
		}
		if ( isset( $vars['rewrite'] ) && ! is_bool( $vars['rewrite'] ) ) {
			return false;
		}
		if ( isset( $vars['skip_optimized'] ) && ! is_bool( $vars['skip_optimized'] ) ) {
			return false;
		}
		return true;
	}

	/**
	 * `media.offload` params: { op: offload|unoffload, ids:int[] (1..BULK_MAX) }.
	 *
	 * @param mixed $params
	 */
	public static function validate_offload_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( array() !== array_diff_key( $vars, array( 'op' => 1, 'ids' => 1 ) ) ) {
			return false;
		}
		if ( ! isset( $vars['op'] ) || ! self::enum_ok( $vars['op'], array( 'offload', 'unoffload' ) ) ) {
			return false;
		}
		return isset( $vars['ids'] ) && self::id_array_ok( $vars['ids'], self::BULK_MAX, false );
	}

	/**
	 * `media.restore` params: { ids:int[] (1..BULK_MAX) }.
	 *
	 * @param mixed $params
	 */
	public static function validate_restore_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( array() !== array_diff_key( $vars, array( 'ids' => 1 ) ) ) {
			return false;
		}
		return isset( $vars['ids'] ) && self::id_array_ok( $vars['ids'], self::BULK_MAX, false );
	}

	/**
	 * `media.folder` params, discriminated by `op` (create|rename|move|delete|assign
	 * |tag). Each op fixes its own exact key set; strays, over-cap id-lists and
	 * over-long names are refused. Terms only — the runner never touches attachments.
	 *
	 * @param mixed $params
	 */
	public static function validate_folder_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( ! isset( $vars['op'] ) || ! self::enum_ok( $vars['op'], self::FOLDER_OPS ) ) {
			return false;
		}
		$op = (string) $vars['op'];
		switch ( $op ) {
			case 'create':
				return self::keys_exact( $vars, array( 'op', 'name' ), array( 'parent' ) )
					&& self::name_ok( $vars['name'] )
					&& ( ! isset( $vars['parent'] ) || ( is_int( $vars['parent'] ) && $vars['parent'] >= 0 ) );
			case 'rename':
				return self::keys_exact( $vars, array( 'op', 'id', 'name' ), array() )
					&& is_int( $vars['id'] ) && $vars['id'] > 0 && self::name_ok( $vars['name'] );
			case 'move':
				return self::keys_exact( $vars, array( 'op', 'id', 'parent' ), array( 'order' ) )
					&& is_int( $vars['id'] ) && $vars['id'] > 0
					&& is_int( $vars['parent'] ) && $vars['parent'] >= 0
					&& ( ! isset( $vars['order'] ) || is_int( $vars['order'] ) );
			case 'delete':
				return self::keys_exact( $vars, array( 'op', 'id' ), array() )
					&& is_int( $vars['id'] ) && $vars['id'] > 0;
			case 'assign':
				return self::keys_exact( $vars, array( 'op', 'ids', 'folder_id' ), array() )
					&& self::id_array_ok( $vars['ids'], self::FOLDER_IDS_MAX, false )
					&& is_int( $vars['folder_id'] ) && $vars['folder_id'] >= 0;
			case 'tag':
				return self::keys_exact( $vars, array( 'op', 'ids' ), array( 'add', 'remove' ) )
					&& self::id_array_ok( $vars['ids'], self::FOLDER_IDS_MAX, false )
					&& ( ! isset( $vars['add'] ) || self::name_array_ok( $vars['add'] ) )
					&& ( ! isset( $vars['remove'] ) || self::id_array_ok( $vars['remove'], self::FOLDER_IDS_MAX, true ) );
		}
		return false;
	}

	// ── shared runner helpers (used by the signed handlers in IWSL_Plugin) ───────

	/**
	 * De-duplicate + positive-filter an id list into clean ints, capped at $max.
	 *
	 * @param mixed $ids
	 * @return int[]
	 */
	public static function int_list( $ids, int $max ): array {
		if ( ! is_array( $ids ) ) {
			return array();
		}
		$clean = array();
		foreach ( $ids as $v ) {
			$iv = (int) $v;
			if ( $iv > 0 && ! in_array( $iv, $clean, true ) ) {
				$clean[] = $iv;
				if ( count( $clean ) >= $max ) {
					break;
				}
			}
		}
		return $clean;
	}

	/**
	 * Sanitize + bound a list of tag names into non-empty strings.
	 *
	 * @param mixed $names
	 * @return string[]
	 */
	public static function str_list( $names ): array {
		if ( ! is_array( $names ) ) {
			return array();
		}
		$out = array();
		foreach ( $names as $n ) {
			if ( is_string( $n ) && '' !== trim( $n ) ) {
				$out[] = substr( trim( $n ), 0, self::TAG_NAME_MAX );
			}
			if ( count( $out ) >= self::FOLDER_IDS_MAX ) {
				break;
			}
		}
		return $out;
	}

	// ── private: WordPress-boundary reads (all guarded for the harness) ──────────

	/** True when a feature's client-side gate is currently unlocked. */
	private function unlocked( string $feature ): bool {
		$gate = $this->entitlements->evaluate( $feature );
		return ! empty( $gate['unlocked'] );
	}

	/** @return array<int,object> the attachment's terms in a taxonomy (empty on error). */
	private function object_terms( int $id, string $taxonomy ): array {
		if ( $id <= 0 || ! function_exists( 'wp_get_object_terms' ) ) {
			return array();
		}
		$terms = wp_get_object_terms( $id, $taxonomy );
		if ( ( function_exists( 'is_wp_error' ) && is_wp_error( $terms ) ) || ! is_array( $terms ) ) {
			return array();
		}
		return $terms;
	}

	/** Raw postmeta read (single value), or null outside WordPress / when absent. */
	private function post_meta( int $id, string $key ) {
		if ( $id <= 0 || ! function_exists( 'get_post_meta' ) ) {
			return null;
		}
		$v = get_post_meta( $id, $key, true );
		return ( '' === $v ) ? null : $v;
	}

	// ── private: MIME + taxonomy resolution ──────────────────────────────────────

	/** WP_Query `post_mime_type` value for a MIME group ('' = no constraint). */
	private function mime_for_group( string $group ) {
		switch ( $group ) {
			case 'image':
			case 'video':
			case 'audio':
				return $group;
			case 'document':
				return self::doc_mimes();
			default:
				return '';
		}
	}

	/** The optimizer accept-list, optionally narrowed to a chosen MIME group. @return string[] */
	private function unoptimized_mimes( string $group ) {
		$opt = $this->optimizable_mimes();
		if ( 'all' === $group || 'image' === $group ) {
			return $opt;
		}
		return array_values( array_intersect( $opt, (array) $this->mime_for_group( $group ) ) );
	}

	/**
	 * The union of every registered converter's accepted MIME types — the single
	 * source of eligibility, read live from the optimizer so a new converter widens
	 * it automatically. Falls back to the WebP-lossless set outside WordPress.
	 *
	 * @return string[]
	 */
	private function optimizable_mimes(): array {
		$out = array();
		if ( class_exists( 'IWSL_Media_Optimizer' ) ) {
			foreach ( IWSL_Media_Optimizer::converters() as $converter ) {
				if ( $converter instanceof IWSL_Media_Converter ) {
					foreach ( $converter->accepts() as $mime ) {
						if ( is_string( $mime ) && '' !== $mime && ! in_array( $mime, $out, true ) ) {
							$out[] = $mime;
						}
					}
				}
			}
		}
		if ( array() === $out ) {
			$out = array( 'image/png', 'image/gif', 'image/bmp', 'image/tiff', 'image/jpeg' );
		}
		return $out;
	}

	/** Document MIME list — reuse the folders engine's canonical set when present. */
	private static function doc_mimes(): array {
		if ( class_exists( 'IWSL_Media_Folders' ) && defined( 'IWSL_Media_Folders::DOC_MIMES' ) ) {
			return IWSL_Media_Folders::DOC_MIMES;
		}
		return array( 'application/pdf', 'text/plain', 'text/csv' );
	}

	private static function tax_folder(): string {
		return class_exists( 'IWSL_Media_Folders' ) ? IWSL_Media_Folders::TAX_FOLDER : 'iwsl_media_folder';
	}

	private static function tax_tag(): string {
		return class_exists( 'IWSL_Media_Folders' ) ? IWSL_Media_Folders::TAX_TAG : 'iwsl_media_tag';
	}

	// ── private: validator + clamp primitives ────────────────────────────────────

	/** Clamp a requested per-page into [1, PER_PAGE_MAX], defaulting sensibly. */
	private static function clamp_per_page( int $per_page ): int {
		if ( $per_page <= 0 ) {
			return self::PER_PAGE_DEFAULT;
		}
		return min( $per_page, self::PER_PAGE_MAX );
	}

	/** Return $value when it is in $allowed, else the safe default ($allowed[0]). */
	private static function norm_enum( $value, array $allowed ) {
		return ( is_string( $value ) && in_array( $value, $allowed, true ) ) ? $value : $allowed[0];
	}

	/** True when $value is a string in the $allowed vocabulary. */
	private static function enum_ok( $value, array $allowed ): bool {
		return is_string( $value ) && in_array( $value, $allowed, true );
	}

	/**
	 * True when $ids is an array of positive ints within [min,$max]. `$allow_empty`
	 * governs whether an empty list passes (list filter: yes; bulk target: no).
	 *
	 * @param mixed $ids
	 */
	private static function id_array_ok( $ids, int $max, bool $allow_empty ): bool {
		if ( ! is_array( $ids ) ) {
			return false;
		}
		$n = count( $ids );
		if ( 0 === $n ) {
			return $allow_empty;
		}
		if ( $n > $max ) {
			return false;
		}
		foreach ( $ids as $v ) {
			if ( ! is_int( $v ) || $v <= 0 ) {
				return false;
			}
		}
		return true;
	}

	/** True when $names is an array of non-empty, bounded strings. @param mixed $names */
	private static function name_array_ok( $names ): bool {
		if ( ! is_array( $names ) || count( $names ) > self::FOLDER_IDS_MAX ) {
			return false;
		}
		foreach ( $names as $n ) {
			if ( ! is_string( $n ) || '' === trim( $n ) || strlen( $n ) > self::TAG_NAME_MAX ) {
				return false;
			}
		}
		return true;
	}

	/** True when a single folder/tag name is a bounded non-empty string. @param mixed $name */
	private static function name_ok( $name ): bool {
		return is_string( $name ) && '' !== trim( $name ) && strlen( $name ) <= self::NAME_MAX;
	}

	/**
	 * True when $vars contains exactly the $required keys and only $required∪$optional
	 * keys (no strays). The discriminated-union guard for media.folder.
	 *
	 * @param array<string,mixed> $vars
	 * @param string[]            $required
	 * @param string[]            $optional
	 */
	private static function keys_exact( array $vars, array $required, array $optional ): bool {
		foreach ( $required as $k ) {
			if ( ! array_key_exists( $k, $vars ) ) {
				return false;
			}
		}
		$permitted = array_fill_keys( array_merge( $required, $optional ), 1 );
		return array() === array_diff_key( $vars, $permitted );
	}
}
