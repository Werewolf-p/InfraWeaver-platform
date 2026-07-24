<?php
/**
 * Media Folders (gate flag `media_folders`): the IWSL_Media_Folders engine —
 * Windows-Explorer-style nestable folders + flat tags for the Media Library,
 * stored purely as WordPress taxonomy terms (no custom table, no attachment ever
 * touched).
 *
 * Runs under the zero-dependency harness. This suite defines its OWN guarded,
 * $GLOBALS-backed fakes for the WordPress TERM + attachment functions the engine
 * calls, backed by an in-memory term database we control end-to-end:
 *
 *   iwsl_mf_terms       term_id  => ['term_id','name','slug','taxonomy','parent']
 *   iwsl_mf_term_meta   term_id  => [ key => value ]
 *   iwsl_mf_rel         obj_id   => [ taxonomy => [ term_id, ... ] ]   (object↔term)
 *   iwsl_mf_att         obj_id   => attachment RECORD (the SACRED array — folders/
 *                                   tags are metadata only; this must be BYTE-IDENTICAL
 *                                   across delete_folder / purge)
 *   iwsl_mf_posttype    obj_id   => post_type   (for non-attachment ids)
 *   iwsl_mf_no_edit     [ obj_id, ... ]         (edit_post cap → false)
 *
 * Term counts are always DERIVED from the relationship store, so a folder's `count`
 * can never drift from the objects actually filed in it. Because the engine wraps
 * every WP call in function_exists(), any function this suite does not stub is simply
 * skipped by the engine (it falls back to a default) — so we stub the term surface
 * faithfully and assert on the contract-fixed engine return shapes + observable
 * side-effects, NOT on internal reason strings (which the frozen contract §3 leaves
 * to the implementer, pinning only the gate reason `entitlement-locked`).
 */

require_once __DIR__ . '/../includes/class-iwsl-store.php';
require_once __DIR__ . '/../includes/class-iwsl-entitlements.php';
$iwsl_mf_engine_file = __DIR__ . '/../includes/class-iwsl-media-folders.php';
if ( file_exists( $iwsl_mf_engine_file ) ) {
	require_once $iwsl_mf_engine_file;
}

// ── in-memory term database ───────────────────────────────────────────────────

$GLOBALS['iwsl_mf_terms']     = array();
$GLOBALS['iwsl_mf_term_meta'] = array();
$GLOBALS['iwsl_mf_rel']       = array();
$GLOBALS['iwsl_mf_att']       = array();
$GLOBALS['iwsl_mf_posttype']  = array();
$GLOBALS['iwsl_mf_no_edit']   = array();
$GLOBALS['iwsl_mf_registered'] = array();
$GLOBALS['iwsl_mf_next_term'] = 100;
$GLOBALS['iwsl_mf_can']       = true;

/** Wipe every mutable global so each section starts from a clean slate. */
function iwsl_mf_reset(): void {
	$GLOBALS['iwsl_mf_terms']      = array();
	$GLOBALS['iwsl_mf_term_meta']  = array();
	$GLOBALS['iwsl_mf_rel']        = array();
	$GLOBALS['iwsl_mf_att']        = array();
	$GLOBALS['iwsl_mf_posttype']   = array();
	$GLOBALS['iwsl_mf_no_edit']    = array();
	$GLOBALS['iwsl_mf_registered'] = array();
	$GLOBALS['iwsl_mf_next_term']  = 100;
	$GLOBALS['iwsl_mf_can']        = true;
}

// ── fake WP_Error + is_wp_error ───────────────────────────────────────────────

if ( ! class_exists( 'IWSL_MF_Fake_Error' ) ) {
	final class IWSL_MF_Fake_Error {
		/** @var string */ public $code;
		public function __construct( string $code = 'error' ) {
			$this->code = $code;
		}
	}
}
if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ) {
		return $thing instanceof IWSL_MF_Fake_Error;
	}
}

// ── WP_Term value object (default get_term output is an OBJECT) ────────────────

if ( ! class_exists( 'WP_Term' ) ) {
	class WP_Term {
		/** @var int */    public $term_id;
		/** @var string */ public $name;
		/** @var string */ public $slug;
		/** @var string */ public $taxonomy;
		/** @var int */    public $parent;
		/** @var int */    public $count;
		/** @var int */    public $term_taxonomy_id;
		public function __construct( array $row ) {
			$this->term_id          = (int) $row['term_id'];
			$this->name             = (string) $row['name'];
			$this->slug             = (string) ( $row['slug'] ?? '' );
			$this->taxonomy         = (string) $row['taxonomy'];
			$this->parent           = (int) ( $row['parent'] ?? 0 );
			$this->term_taxonomy_id = (int) $row['term_id'];
			$this->count            = iwsl_mf_term_count( (int) $row['term_id'], (string) $row['taxonomy'] );
		}
	}
}

// ── term-DB primitives (used by both the WP stubs and the seed helpers) ───────

/** Objects currently filed under a term = the term's live count. */
function iwsl_mf_term_count( int $term_id, string $taxonomy ): int {
	$n = 0;
	foreach ( $GLOBALS['iwsl_mf_rel'] as $obj => $by_tax ) {
		$ids = $by_tax[ $taxonomy ] ?? array();
		if ( in_array( $term_id, array_map( 'intval', $ids ), true ) ) {
			$n++;
		}
	}
	return $n;
}

/** Insert a raw term row and return its id (find-or-create keyed on name+tax+parent). */
function iwsl_mf_insert_row( string $name, string $taxonomy, int $parent = 0 ): int {
	$id = ++$GLOBALS['iwsl_mf_next_term'];
	$GLOBALS['iwsl_mf_terms'][ $id ] = array(
		'term_id'  => $id,
		'name'     => $name,
		'slug'     => strtolower( preg_replace( '/[^a-z0-9]+/i', '-', $name ) ) . '-' . $id,
		'taxonomy' => $taxonomy,
		'parent'   => $parent,
	);
	return $id;
}

/** Find an existing term id by exact name within a taxonomy (tags reuse terms). */
function iwsl_mf_find_by_name( string $name, string $taxonomy, int $parent = 0 ): int {
	foreach ( $GLOBALS['iwsl_mf_terms'] as $id => $row ) {
		if ( $row['taxonomy'] === $taxonomy && $row['name'] === $name && (int) $row['parent'] === $parent ) {
			return (int) $id;
		}
	}
	return 0;
}

/** All descendant term ids (children, grandchildren, …) of $term_id — recursive. */
function iwsl_mf_descendants( int $term_id ): array {
	$out = array();
	foreach ( $GLOBALS['iwsl_mf_terms'] as $id => $row ) {
		if ( (int) $row['parent'] === $term_id ) {
			$out[] = (int) $id;
			foreach ( iwsl_mf_descendants( (int) $id ) as $g ) {
				$out[] = $g;
			}
		}
	}
	return array_values( array_unique( $out ) );
}

function iwsl_mf_term( array $row ): WP_Term {
	return new WP_Term( $row );
}

// ── WP TERM functions (guarded; child-process isolation makes this safe) ──────

if ( ! function_exists( 'register_taxonomy' ) ) {
	function register_taxonomy( $taxonomy, $object_type, $args = array() ) {
		$GLOBALS['iwsl_mf_registered'][ (string) $taxonomy ] = array(
			'object_type' => $object_type,
			'args'        => $args,
		);
		return true;
	}
}
if ( ! function_exists( 'taxonomy_exists' ) ) {
	function taxonomy_exists( $taxonomy ) {
		return isset( $GLOBALS['iwsl_mf_registered'][ (string) $taxonomy ] );
	}
}
if ( ! function_exists( 'wp_insert_term' ) ) {
	function wp_insert_term( $term, $taxonomy, $args = array() ) {
		$name   = (string) $term;
		$parent = (int) ( ( is_array( $args ) && isset( $args['parent'] ) ) ? $args['parent'] : 0 );
		if ( '' === $name ) {
			return new IWSL_MF_Fake_Error( 'empty_term_name' );
		}
		$id = iwsl_mf_insert_row( $name, (string) $taxonomy, $parent );
		return array( 'term_id' => $id, 'term_taxonomy_id' => $id );
	}
}
if ( ! function_exists( 'wp_update_term' ) ) {
	function wp_update_term( $term_id, $taxonomy, $args = array() ) {
		$id = (int) $term_id;
		if ( ! isset( $GLOBALS['iwsl_mf_terms'][ $id ] ) ) {
			return new IWSL_MF_Fake_Error( 'invalid_term' );
		}
		if ( isset( $args['name'] ) ) {
			$GLOBALS['iwsl_mf_terms'][ $id ]['name'] = (string) $args['name'];
		}
		if ( array_key_exists( 'parent', $args ) ) {
			$GLOBALS['iwsl_mf_terms'][ $id ]['parent'] = (int) $args['parent'];
		}
		return array( 'term_id' => $id, 'term_taxonomy_id' => $id );
	}
}
if ( ! function_exists( 'wp_delete_term' ) ) {
	function wp_delete_term( $term_id, $taxonomy = '' ) {
		$id = (int) $term_id;
		if ( ! isset( $GLOBALS['iwsl_mf_terms'][ $id ] ) ) {
			return false;
		}
		unset( $GLOBALS['iwsl_mf_terms'][ $id ] );
		unset( $GLOBALS['iwsl_mf_term_meta'][ $id ] );
		// Detach the term from every object it was filed on (files → unfiled).
		foreach ( $GLOBALS['iwsl_mf_rel'] as $obj => $by_tax ) {
			foreach ( $by_tax as $tx => $ids ) {
				$kept = array_values( array_filter( array_map( 'intval', $ids ), static function ( $t ) use ( $id ) {
					return $t !== $id;
				} ) );
				$GLOBALS['iwsl_mf_rel'][ $obj ][ $tx ] = $kept;
			}
		}
		return true;
	}
}
if ( ! function_exists( 'get_term' ) ) {
	function get_term( $term, $taxonomy = '', ...$rest ) {
		$id  = (int) $term;
		$row = $GLOBALS['iwsl_mf_terms'][ $id ] ?? null;
		if ( null === $row ) {
			return null;
		}
		if ( '' !== (string) $taxonomy && $row['taxonomy'] !== (string) $taxonomy ) {
			return null;
		}
		return iwsl_mf_term( $row );
	}
}
if ( ! function_exists( 'term_exists' ) ) {
	function term_exists( $term, $taxonomy = '', $parent = null ) {
		if ( is_int( $term ) || ctype_digit( (string) $term ) ) {
			$id  = (int) $term;
			$row = $GLOBALS['iwsl_mf_terms'][ $id ] ?? null;
			if ( null === $row ) {
				return null;
			}
			if ( '' !== (string) $taxonomy && $row['taxonomy'] !== (string) $taxonomy ) {
				return null;
			}
			return array( 'term_id' => $id, 'term_taxonomy_id' => $id );
		}
		$p  = null === $parent ? 0 : (int) $parent;
		$id = iwsl_mf_find_by_name( (string) $term, (string) $taxonomy, $p );
		return $id > 0 ? array( 'term_id' => $id, 'term_taxonomy_id' => $id ) : null;
	}
}
if ( ! function_exists( 'get_term_children' ) ) {
	function get_term_children( $term_id, $taxonomy ) {
		return iwsl_mf_descendants( (int) $term_id );
	}
}
if ( ! function_exists( 'get_ancestors' ) ) {
	function get_ancestors( $object_id, $object_type = '', $resource_type = '' ) {
		$out    = array();
		$cursor = (int) $object_id;
		$guard  = 0;
		while ( $guard++ < 100 ) {
			$row = $GLOBALS['iwsl_mf_terms'][ $cursor ] ?? null;
			if ( null === $row || 0 === (int) $row['parent'] ) {
				break;
			}
			$out[]  = (int) $row['parent'];
			$cursor = (int) $row['parent'];
		}
		return $out;
	}
}
if ( ! function_exists( 'get_terms' ) ) {
	function get_terms( $args = array(), $deprecated = '' ) {
		if ( is_string( $args ) ) {
			$args = array( 'taxonomy' => $args );
		}
		$tax     = $args['taxonomy'] ?? '';
		$taxes   = is_array( $tax ) ? $tax : array( $tax );
		$fields  = (string) ( $args['fields'] ?? 'all' );
		$parent  = array_key_exists( 'parent', $args ) ? (int) $args['parent'] : null;
		$child   = isset( $args['child_of'] ) ? (int) $args['child_of'] : 0;
		$include = isset( $args['include'] ) ? array_map( 'intval', (array) $args['include'] ) : null;
		$exclude = isset( $args['exclude'] ) ? array_map( 'intval', (array) $args['exclude'] ) : array();
		$hide    = array_key_exists( 'hide_empty', $args ) ? (bool) $args['hide_empty'] : true;
		$kids    = $child > 0 ? iwsl_mf_descendants( $child ) : array();

		$rows = array();
		foreach ( $GLOBALS['iwsl_mf_terms'] as $id => $row ) {
			if ( ! in_array( $row['taxonomy'], $taxes, true ) ) {
				continue;
			}
			if ( null !== $parent && (int) $row['parent'] !== $parent ) {
				continue;
			}
			if ( null !== $include && ! in_array( (int) $id, $include, true ) ) {
				continue;
			}
			if ( in_array( (int) $id, $exclude, true ) ) {
				continue;
			}
			if ( $child > 0 && ! in_array( (int) $id, $kids, true ) ) {
				continue;
			}
			if ( $hide && iwsl_mf_term_count( (int) $id, (string) $row['taxonomy'] ) < 1 ) {
				continue;
			}
			$rows[ (int) $id ] = $row;
		}
		if ( 'ids' === $fields ) {
			return array_map( 'intval', array_keys( $rows ) );
		}
		if ( 'count' === $fields ) {
			return count( $rows );
		}
		if ( 'names' === $fields ) {
			return array_values( array_map( static function ( $r ) {
				return (string) $r['name'];
			}, $rows ) );
		}
		return array_values( array_map( 'iwsl_mf_term', $rows ) );
	}
}
if ( ! function_exists( 'wp_count_terms' ) ) {
	function wp_count_terms( $args = array(), $deprecated = array() ) {
		if ( is_string( $args ) ) {
			$args = array( 'taxonomy' => $args );
		}
		$tax = (string) ( $args['taxonomy'] ?? '' );
		$n   = 0;
		foreach ( $GLOBALS['iwsl_mf_terms'] as $row ) {
			if ( $row['taxonomy'] === $tax ) {
				$n++;
			}
		}
		return $n;
	}
}
if ( ! function_exists( 'wp_set_object_terms' ) ) {
	function wp_set_object_terms( $object_id, $terms, $taxonomy, $append = false ) {
		$obj    = (int) $object_id;
		$tax    = (string) $taxonomy;
		$terms  = is_array( $terms ) ? $terms : ( null === $terms ? array() : array( $terms ) );
		$ids    = array();
		foreach ( $terms as $t ) {
			if ( is_int( $t ) || ( is_string( $t ) && ctype_digit( $t ) ) ) {
				$id = (int) $t;
				if ( isset( $GLOBALS['iwsl_mf_terms'][ $id ] ) ) {
					$ids[] = $id;
				}
			} else {
				$name = (string) $t;
				$id   = iwsl_mf_find_by_name( $name, $tax, 0 );
				if ( 0 === $id ) {
					$id = iwsl_mf_insert_row( $name, $tax, 0 );
				}
				$ids[] = $id;
			}
		}
		if ( $append ) {
			$existing = $GLOBALS['iwsl_mf_rel'][ $obj ][ $tax ] ?? array();
			$ids      = array_merge( array_map( 'intval', $existing ), $ids );
		}
		$GLOBALS['iwsl_mf_rel'][ $obj ][ $tax ] = array_values( array_unique( array_map( 'intval', $ids ) ) );
		return $GLOBALS['iwsl_mf_rel'][ $obj ][ $tax ];
	}
}
if ( ! function_exists( 'wp_remove_object_terms' ) ) {
	function wp_remove_object_terms( $object_id, $terms, $taxonomy ) {
		$obj   = (int) $object_id;
		$tax   = (string) $taxonomy;
		$drop  = array_map( 'intval', is_array( $terms ) ? $terms : array( $terms ) );
		$have  = array_map( 'intval', $GLOBALS['iwsl_mf_rel'][ $obj ][ $tax ] ?? array() );
		$GLOBALS['iwsl_mf_rel'][ $obj ][ $tax ] = array_values( array_diff( $have, $drop ) );
		return true;
	}
}
if ( ! function_exists( 'wp_get_object_terms' ) ) {
	function wp_get_object_terms( $object_ids, $taxonomies, $args = array() ) {
		$objs   = array_map( 'intval', is_array( $object_ids ) ? $object_ids : array( $object_ids ) );
		$taxes  = is_array( $taxonomies ) ? $taxonomies : array( $taxonomies );
		$fields = (string) ( $args['fields'] ?? 'all' );
		$ids    = array();
		foreach ( $objs as $o ) {
			foreach ( $taxes as $tx ) {
				foreach ( $GLOBALS['iwsl_mf_rel'][ $o ][ (string) $tx ] ?? array() as $tid ) {
					$ids[ (int) $tid ] = true;
				}
			}
		}
		$ids = array_keys( $ids );
		if ( 'ids' === $fields ) {
			return array_map( 'intval', $ids );
		}
		if ( 'names' === $fields ) {
			return array_values( array_map( static function ( $id ) {
				return (string) ( $GLOBALS['iwsl_mf_terms'][ $id ]['name'] ?? '' );
			}, $ids ) );
		}
		$out = array();
		foreach ( $ids as $id ) {
			if ( isset( $GLOBALS['iwsl_mf_terms'][ $id ] ) ) {
				$out[] = iwsl_mf_term( $GLOBALS['iwsl_mf_terms'][ $id ] );
			}
		}
		return $out;
	}
}
if ( ! function_exists( 'get_objects_in_term' ) ) {
	function get_objects_in_term( $term_ids, $taxonomies, $args = array() ) {
		$wanted = array_map( 'intval', is_array( $term_ids ) ? $term_ids : array( $term_ids ) );
		$taxes  = is_array( $taxonomies ) ? $taxonomies : array( $taxonomies );
		$out    = array();
		foreach ( $GLOBALS['iwsl_mf_rel'] as $obj => $by_tax ) {
			foreach ( $taxes as $tx ) {
				$ids = array_map( 'intval', $by_tax[ (string) $tx ] ?? array() );
				if ( array_intersect( $ids, $wanted ) ) {
					$out[] = (int) $obj;
				}
			}
		}
		return array_values( array_unique( $out ) );
	}
}
if ( ! function_exists( 'get_term_meta' ) ) {
	function get_term_meta( $term_id, $key = '', $single = false ) {
		$all = $GLOBALS['iwsl_mf_term_meta'][ (int) $term_id ] ?? array();
		if ( '' === $key ) {
			return $all;
		}
		if ( ! array_key_exists( $key, $all ) ) {
			return $single ? '' : array();
		}
		return $single ? $all[ $key ] : array( $all[ $key ] );
	}
}
if ( ! function_exists( 'update_term_meta' ) ) {
	function update_term_meta( $term_id, $key, $value, $prev = '' ) {
		$GLOBALS['iwsl_mf_term_meta'][ (int) $term_id ][ (string) $key ] = $value;
		return true;
	}
}
if ( ! function_exists( 'delete_term_meta' ) ) {
	function delete_term_meta( $term_id, $key, $value = '' ) {
		unset( $GLOBALS['iwsl_mf_term_meta'][ (int) $term_id ][ (string) $key ] );
		return true;
	}
}

// ── attachment / capability / sanitize surface ────────────────────────────────

if ( ! function_exists( 'get_post_type' ) ) {
	function get_post_type( $post = null ) {
		$id = (int) ( is_object( $post ) ? ( $post->ID ?? 0 ) : $post );
		if ( isset( $GLOBALS['iwsl_mf_att'][ $id ] ) ) {
			return 'attachment';
		}
		return $GLOBALS['iwsl_mf_posttype'][ $id ] ?? false;
	}
}
if ( ! function_exists( 'get_post_mime_type' ) ) {
	function get_post_mime_type( $post = null ) {
		$id = (int) ( is_object( $post ) ? ( $post->ID ?? 0 ) : $post );
		return $GLOBALS['iwsl_mf_att'][ $id ]['mime'] ?? '';
	}
}
if ( ! function_exists( 'get_the_title' ) ) {
	function get_the_title( $post = 0 ) {
		$id = (int) ( is_object( $post ) ? ( $post->ID ?? 0 ) : $post );
		return (string) ( $GLOBALS['iwsl_mf_att'][ $id ]['title'] ?? '' );
	}
}
if ( ! function_exists( 'wp_get_attachment_url' ) ) {
	function wp_get_attachment_url( $post_id = 0 ) {
		return 'https://site.test/wp-content/uploads/' . (string) ( $GLOBALS['iwsl_mf_att'][ (int) $post_id ]['filename'] ?? '' );
	}
}
if ( ! function_exists( 'wp_get_attachment_image_src' ) ) {
	function wp_get_attachment_image_src( $attachment_id, $size = 'thumbnail', $icon = false ) {
		return array( wp_get_attachment_url( (int) $attachment_id ), 150, 150, true );
	}
}
if ( ! function_exists( 'wp_get_attachment_metadata' ) ) {
	function wp_get_attachment_metadata( $post_id = 0, $unfiltered = false ) {
		return $GLOBALS['iwsl_mf_att'][ (int) $post_id ]['meta'] ?? array();
	}
}
if ( ! function_exists( 'get_attached_file' ) ) {
	function get_attached_file( $attachment_id, $unfiltered = false ) {
		return (string) ( $GLOBALS['iwsl_mf_att'][ (int) $attachment_id ]['file'] ?? '' );
	}
}
if ( ! function_exists( 'current_user_can' ) ) {
	function current_user_can( $capability, ...$args ) {
		if ( 'edit_post' === $capability || 'edit_posts' === $capability ) {
			$id = (int) ( $args[0] ?? 0 );
			return ! in_array( $id, $GLOBALS['iwsl_mf_no_edit'], true );
		}
		return ! empty( $GLOBALS['iwsl_mf_can'] );
	}
}
if ( ! function_exists( 'sanitize_text_field' ) ) {
	function sanitize_text_field( $str ) {
		$s = strip_tags( (string) $str );
		$s = preg_replace( '/[\r\n\t ]+/', ' ', $s );
		return trim( (string) $s );
	}
}
if ( ! function_exists( 'wp_strip_all_tags' ) ) {
	function wp_strip_all_tags( $str, $remove_breaks = false ) {
		$s = strip_tags( (string) $str );
		$s = preg_replace( '/[\r\n\t ]+/', ' ', $s );
		return trim( (string) $s );
	}
}
if ( ! function_exists( 'sanitize_key' ) ) {
	function sanitize_key( $key ) {
		return strtolower( preg_replace( '/[^a-z0-9_\-]/', '', (string) $key ) );
	}
}
if ( ! function_exists( 'absint' ) ) {
	function absint( $n ) {
		return abs( (int) $n );
	}
}
if ( ! function_exists( 'wp_unslash' ) ) {
	function wp_unslash( $value ) {
		return is_string( $value ) ? stripslashes( $value ) : $value;
	}
}
if ( ! function_exists( '__' ) ) {
	function __( $text, $domain = 'default' ) {
		return (string) $text;
	}
}
if ( ! function_exists( 'esc_html' ) ) {
	function esc_html( $text ) {
		return htmlspecialchars( (string) $text, ENT_QUOTES );
	}
}
if ( ! function_exists( 'esc_attr' ) ) {
	function esc_attr( $text ) {
		return htmlspecialchars( (string) $text, ENT_QUOTES );
	}
}

// ── a WP_Query stub that reads the same in-memory attachment + relationship DB ──
// Models exactly the args §3 says query_media builds: post_type=attachment,
// post_status=inherit, posts_per_page/paged, a free `s`, post_mime_type, and a
// tax_query of folder EXISTS/NOT EXISTS/IN + tag IN. Exposes ->posts + ->found_posts.

if ( ! class_exists( 'WP_Query' ) ) {
	class WP_Query {
		/** @var int[] */ public $posts = array();
		/** @var int */   public $found_posts = 0;
		/** @var int */   public $post_count = 0;

		public function __construct( array $args = array() ) {
			$mime   = isset( $args['post_mime_type'] ) ? $args['post_mime_type'] : '';
			$search = isset( $args['s'] ) ? (string) $args['s'] : '';
			$tq     = isset( $args['tax_query'] ) && is_array( $args['tax_query'] ) ? $args['tax_query'] : array();

			$matched = array();
			foreach ( $GLOBALS['iwsl_mf_att'] as $id => $rec ) {
				$id    = (int) $id;
				$rmime = (string) ( $rec['mime'] ?? '' );
				if ( ! self::mime_match( $rmime, $mime ) ) {
					continue;
				}
				if ( '' !== $search ) {
					$hay = (string) ( $rec['title'] ?? '' ) . ' ' . (string) ( $rec['filename'] ?? '' );
					if ( false === stripos( $hay, $search ) ) {
						continue;
					}
				}
				if ( ! self::tax_match( $id, $tq ) ) {
					continue;
				}
				$matched[] = $id;
			}
			sort( $matched );
			$this->found_posts = count( $matched );

			$per   = (int) ( $args['posts_per_page'] ?? 10 );
			$paged = max( 1, (int) ( $args['paged'] ?? 1 ) );
			$this->posts      = $per > 0 ? array_slice( $matched, ( $paged - 1 ) * $per, $per ) : $matched;
			$this->post_count = count( $this->posts );
		}

		private static function mime_match( string $rmime, $filter ): bool {
			if ( '' === $filter || array() === $filter ) {
				return true;
			}
			foreach ( (array) $filter as $f ) {
				$f = (string) $f;
				if ( '' === $f ) {
					continue;
				}
				if ( false !== strpos( $f, '/' ) ) {
					if ( $rmime === $f ) {
						return true;
					}
				} elseif ( 0 === strpos( $rmime, $f . '/' ) ) {
					return true;
				}
			}
			return false;
		}

		private static function tax_match( int $obj, array $tq ): bool {
			$relation = 'AND';
			$clauses  = array();
			foreach ( $tq as $k => $clause ) {
				if ( 'relation' === $k ) {
					$relation = strtoupper( (string) $clause );
					continue;
				}
				if ( is_array( $clause ) && isset( $clause['taxonomy'] ) ) {
					$clauses[] = $clause;
				}
			}
			if ( ! $clauses ) {
				return true;
			}
			$results = array();
			foreach ( $clauses as $c ) {
				$tax     = (string) $c['taxonomy'];
				$op      = strtoupper( (string) ( $c['operator'] ?? 'IN' ) );
				$objterm = array_map( 'intval', $GLOBALS['iwsl_mf_rel'][ $obj ][ $tax ] ?? array() );
				if ( 'NOT EXISTS' === $op ) {
					$results[] = ( array() === $objterm );
					continue;
				}
				if ( 'EXISTS' === $op ) {
					$results[] = ( array() !== $objterm );
					continue;
				}
				$terms = array_map( 'intval', (array) ( $c['terms'] ?? array() ) );
				$inter = array_intersect( $objterm, $terms );
				$results[] = ( 'NOT IN' === $op ) ? ( array() === $inter ) : ( array() !== $inter );
			}
			if ( 'OR' === $relation ) {
				return in_array( true, $results, true );
			}
			return ! in_array( false, $results, true );
		}
	}
}

// ── entitlement fixtures + engine builder ─────────────────────────────────────

$MF_NOW = 1900000000000;

/** Unlocked gate: active + fresh heartbeat + the media_folders flag. */
function iwsl_mf_unlocked( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array( 'plus' => true, 'media_folders' => true ) );
	return new IWSL_Entitlements( $store, static function () use ( $now ): int {
		return $now;
	} );
}

/** Locked gate: active + fresh heartbeat but the media_folders flag ABSENT. */
function iwsl_mf_locked( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array( 'plus' => true ) );
	return new IWSL_Entitlements( $store, static function () use ( $now ): int {
		return $now;
	} );
}

/** Instantiate the engine — an explicit memory store keeps IWSL_WP_Store out of the harness. */
function iwsl_mf_engine( IWSL_Entitlements $ent ): IWSL_Media_Folders {
	return new IWSL_Media_Folders( $ent, new IWSL_Memory_Store() );
}

/** Register an attachment RECORD (the sacred array) — this is what must never be deleted. */
function iwsl_mf_add_attachment( int $id, string $mime = 'image/jpeg', array $extra = array() ): void {
	$GLOBALS['iwsl_mf_att'][ $id ] = array_merge(
		array(
			'id'       => $id,
			'mime'     => $mime,
			'title'    => 'Photo ' . $id,
			'filename' => 'photo' . $id . '.jpg',
			'date'     => '2024-05-01 10:00:00',
			'meta'     => array( 'width' => 800, 'height' => 600, 'filesize' => 12345 ),
		),
		$extra
	);
}

/** Register a NON-attachment post id (for the "skips non-attachment" assertions). */
function iwsl_mf_add_post( int $id, string $type = 'post' ): void {
	$GLOBALS['iwsl_mf_posttype'][ $id ] = $type;
}

/** Convenience: the folder id an attachment is currently filed under (0 = unfiled). */
function iwsl_mf_folder_of( int $obj ): int {
	$ids = $GLOBALS['iwsl_mf_rel'][ $obj ][ IWSL_Media_Folders::TAX_FOLDER ] ?? array();
	return $ids ? (int) $ids[0] : 0;
}

/** Convenience: create a folder through the engine and return its id (asserts ok). */
function iwsl_mf_make( IWSL_Media_Folders $eng, string $name, int $parent = 0 ): int {
	$r = $eng->create_folder( $name, $parent );
	return ( isset( $r['ok'] ) && $r['ok'] && isset( $r['folder']['id'] ) ) ? (int) $r['folder']['id'] : 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. GATE — a locked site behaves byte-identically to stock WordPress.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_mf_reset();

// Arrange.
$locked = iwsl_mf_engine( iwsl_mf_locked( $MF_NOW ) );

// Act + Assert — create_folder refuses with the pinned gate reason, stores nothing.
$g_create = $locked->create_folder( 'Blocked' );
iwsl_assert_same( false, $g_create['ok'], 'gate: locked create_folder ok=false' );
iwsl_assert_same( 'entitlement-locked', $g_create['reason'], 'gate: locked create_folder reason=entitlement-locked' );
iwsl_assert_same( array(), get_terms( array( 'taxonomy' => IWSL_Media_Folders::TAX_FOLDER, 'hide_empty' => false ) ), 'gate: locked create_folder created no term' );

// assign refuses and files nothing.
iwsl_mf_add_attachment( 601 );
$g_assign = $locked->assign( array( 601 ), 5 );
iwsl_assert_same( false, $g_assign['ok'], 'gate: locked assign ok=false' );
iwsl_assert_same( 'entitlement-locked', $g_assign['reason'], 'gate: locked assign reason=entitlement-locked' );
iwsl_assert_same( 0, iwsl_mf_folder_of( 601 ), 'gate: locked assign filed nothing' );

// query_media returns an empty result set.
$g_query = $locked->query_media( array( 'folder_id' => -1 ) );
iwsl_assert_same( 0, $g_query['total'], 'gate: locked query_media total=0' );
iwsl_assert_same( array(), $g_query['items'], 'gate: locked query_media items empty' );

// register_taxonomies registers NOTHING on a locked site.
$locked->register_taxonomies();
iwsl_assert_same( 0, count( $GLOBALS['iwsl_mf_registered'] ), 'gate: locked register_taxonomies registers nothing' );

// …and an UNLOCKED site registers both taxonomies on `attachment`.
$GLOBALS['iwsl_mf_registered'] = array();
$unlocked_reg = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
$unlocked_reg->register_taxonomies();
iwsl_assert_same( true, isset( $GLOBALS['iwsl_mf_registered'][ IWSL_Media_Folders::TAX_FOLDER ] ), 'gate: unlocked registers the folder taxonomy' );
iwsl_assert_same( true, isset( $GLOBALS['iwsl_mf_registered'][ IWSL_Media_Folders::TAX_TAG ] ), 'gate: unlocked registers the tag taxonomy' );

// ══════════════════════════════════════════════════════════════════════════════
// 2. create_folder — happy path + every rejection.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );

// Happy path.
$c_ok = $eng->create_folder( 'Invoices' );
iwsl_assert_same( true, $c_ok['ok'], 'create: happy path ok=true' );
iwsl_assert_same( 'Invoices', $c_ok['folder']['name'], 'create: name stored verbatim' );
iwsl_assert_same( 0, (int) $c_ok['folder']['parent'], 'create: root folder parent=0' );
iwsl_assert_same( 0, (int) $c_ok['folder']['depth'], 'create: root folder depth=0' );
iwsl_assert( (int) $c_ok['folder']['id'] > 0, 'create: a real term id was assigned' );

// A nested child.
$parent_id = (int) $c_ok['folder']['id'];
$c_child   = $eng->create_folder( 'Paid', $parent_id );
iwsl_assert_same( true, $c_child['ok'], 'create: child under a valid parent ok' );
iwsl_assert_same( $parent_id, (int) $c_child['folder']['parent'], 'create: child parent recorded' );
iwsl_assert_same( 1, (int) $c_child['folder']['depth'], 'create: child depth=1' );

// Reject: empty / whitespace-only name.
iwsl_assert_same( false, $eng->create_folder( '' )['ok'], 'create: empty name rejected' );
iwsl_assert_same( false, $eng->create_folder( '    ' )['ok'], 'create: whitespace-only name rejected' );

// Reject: over-long name (> MAX_NAME_LEN).
$too_long = str_repeat( 'a', IWSL_Media_Folders::MAX_NAME_LEN + 50 );
iwsl_assert_same( false, $eng->create_folder( $too_long )['ok'], 'create: name over MAX_NAME_LEN rejected' );

// XSS payload name is SANITIZED (tags stripped) — not stored raw.
$c_xss = $eng->create_folder( '<script>alert(1)</script>' );
iwsl_assert_same( true, $c_xss['ok'], 'create: XSS payload sanitized to a usable name (not rejected outright)' );
iwsl_assert( false === strpos( (string) $c_xss['folder']['name'], '<' ), 'create: stored name carries no < (tag stripped)' );
iwsl_assert( false === strpos( (string) $c_xss['folder']['name'], '>' ), 'create: stored name carries no > (tag stripped)' );
iwsl_assert( false === stripos( (string) $c_xss['folder']['name'], 'script' ), 'create: stored name carries no script token' );

// Reject: non-existent parent.
iwsl_assert_same( false, $eng->create_folder( 'Orphan', 987654 )['ok'], 'create: non-existent parent rejected' );

// Reject: depth overflow (root=0 … MAX_DEPTH allowed; one deeper is refused).
iwsl_mf_reset();
$eng_depth = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
$chain     = 0;
$deepest   = true;
for ( $d = 0; $d <= IWSL_Media_Folders::MAX_DEPTH; $d++ ) {
	$res    = $eng_depth->create_folder( 'lvl' . $d, $chain );
	$deepest = $deepest && ! empty( $res['ok'] );
	$chain  = (int) ( $res['folder']['id'] ?? 0 );
}
iwsl_assert_same( true, $deepest, 'create: a full chain to MAX_DEPTH is allowed' );
iwsl_assert_same( false, $eng_depth->create_folder( 'too-deep', $chain )['ok'], 'create: one level past MAX_DEPTH rejected' );

// Reject: the MAX_FOLDERS ceiling.
iwsl_mf_reset();
$eng_cap = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
for ( $i = 0; $i < IWSL_Media_Folders::MAX_FOLDERS; $i++ ) {
	iwsl_mf_insert_row( 'seed' . $i, IWSL_Media_Folders::TAX_FOLDER, 0 );
}
iwsl_assert_same( IWSL_Media_Folders::MAX_FOLDERS, wp_count_terms( array( 'taxonomy' => IWSL_Media_Folders::TAX_FOLDER ) ), 'create: MAX_FOLDERS folders pre-seeded' );
iwsl_assert_same( false, $eng_cap->create_folder( 'one-too-many' )['ok'], 'create: MAX_FOLDERS ceiling rejects the next folder' );

// ══════════════════════════════════════════════════════════════════════════════
// 3. rename_folder — sanitizes + updates; rejects a foreign term id.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );

$fid = iwsl_mf_make( $eng, 'Draft' );
$r_ok = $eng->rename_folder( $fid, '  Final <b>Copy</b>  ' );
iwsl_assert_same( true, $r_ok['ok'], 'rename: ok=true on a real folder' );
iwsl_assert_same( 'Final Copy', get_term( $fid, IWSL_Media_Folders::TAX_FOLDER )->name, 'rename: name sanitized (tags stripped, trimmed) + persisted' );

// Reject: a term id that isn't in our taxonomy (a tag term).
$foreign_tag = iwsl_mf_insert_row( 'blue', IWSL_Media_Folders::TAX_TAG, 0 );
iwsl_assert_same( false, $eng->rename_folder( $foreign_tag, 'Nope' )['ok'], 'rename: a tag term id is rejected (not a folder)' );
// Reject: a wholly unknown id.
iwsl_assert_same( false, $eng->rename_folder( 555111, 'Nope' )['ok'], 'rename: an unknown term id is rejected' );
// The foreign term keeps its original name (never written to).
iwsl_assert_same( 'blue', get_term( $foreign_tag, IWSL_Media_Folders::TAX_TAG )->name, 'rename: the foreign tag term was never modified' );

// ══════════════════════════════════════════════════════════════════════════════
// 4. move_folder — reparents; rejects cycles + depth overflow.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );

$A = iwsl_mf_make( $eng, 'A' );
$B = iwsl_mf_make( $eng, 'B', $A );
$C = iwsl_mf_make( $eng, 'C', $B ); // A → B → C

// Reparent B to root.
$m_ok = $eng->move_folder( $B, 0 );
iwsl_assert_same( true, $m_ok['ok'], 'move: reparent to root ok' );
iwsl_assert_same( 0, get_term( $B, IWSL_Media_Folders::TAX_FOLDER )->parent, 'move: B now has parent 0' );

// Rebuild the chain and prove the cycle guard.
iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
$A = iwsl_mf_make( $eng, 'A' );
$B = iwsl_mf_make( $eng, 'B', $A );
$C = iwsl_mf_make( $eng, 'C', $B ); // A → B → C

iwsl_assert_same( false, $eng->move_folder( $A, $C )['ok'], 'move: reject moving a folder into its own descendant (cycle)' );
iwsl_assert_same( false, $eng->move_folder( $A, $A )['ok'], 'move: reject moving a folder into itself' );
iwsl_assert_same( 0, get_term( $A, IWSL_Media_Folders::TAX_FOLDER )->parent, 'move: A parent unchanged after a rejected cycle move' );

// Depth overflow: build a full chain to MAX_DEPTH, then move a standalone folder under its tip.
iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
$tip = 0;
for ( $d = 0; $d <= IWSL_Media_Folders::MAX_DEPTH; $d++ ) {
	$tip = iwsl_mf_make( $eng, 'lvl' . $d, $tip );
}
$standalone = iwsl_mf_make( $eng, 'standalone' );
iwsl_assert_same( false, $eng->move_folder( $standalone, $tip )['ok'], 'move: reject a move that would exceed MAX_DEPTH' );
iwsl_assert_same( 0, get_term( $standalone, IWSL_Media_Folders::TAX_FOLDER )->parent, 'move: standalone parent unchanged after a rejected depth-overflow move' );
// A legal shallow move still works.
iwsl_assert_same( true, $eng->move_folder( $standalone, $A = iwsl_mf_make( $eng, 'shallow' ) )['ok'], 'move: a within-depth reparent still succeeds' );

// ══════════════════════════════════════════════════════════════════════════════
// 5. delete_folder — removes folder + descendants; counts; NEVER deletes an attachment.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );

$root  = iwsl_mf_make( $eng, 'Root' );
$sub   = iwsl_mf_make( $eng, 'Sub', $root );
$leaf  = iwsl_mf_make( $eng, 'Leaf', $sub ); // Root → Sub → Leaf (3 folders)

iwsl_mf_add_attachment( 701 );
iwsl_mf_add_attachment( 702 );
iwsl_mf_add_attachment( 703 );
iwsl_mf_add_attachment( 999 ); // stays unfiled + wholly unrelated.
$eng->assign( array( 701 ), $root );
$eng->assign( array( 702 ), $sub );
$eng->assign( array( 703 ), $leaf );

$before = serialize( $GLOBALS['iwsl_mf_att'] );

$del = $eng->delete_folder( $root );
iwsl_assert_same( true, $del['ok'], 'delete: ok=true' );
iwsl_assert_same( 3, (int) $del['folders_removed'], 'delete: folder + both descendants removed (3)' );
iwsl_assert_same( 3, (int) $del['files_unfiled'], 'delete: all three filed attachments reported unfiled' );

// The taxonomy is now empty of these folders…
iwsl_assert_same( null, get_term( $root, IWSL_Media_Folders::TAX_FOLDER ), 'delete: root term gone' );
iwsl_assert_same( null, get_term( $sub, IWSL_Media_Folders::TAX_FOLDER ), 'delete: descendant term gone' );
iwsl_assert_same( null, get_term( $leaf, IWSL_Media_Folders::TAX_FOLDER ), 'delete: grandchild term gone' );
// …the files are now unfiled…
iwsl_assert_same( 0, iwsl_mf_folder_of( 701 ), 'delete: file 701 became unfiled' );
iwsl_assert_same( 0, iwsl_mf_folder_of( 703 ), 'delete: file 703 became unfiled' );
// …and — CRITICAL DATA-SAFETY — the attachment store is byte-identical.
iwsl_assert_same( $before, serialize( $GLOBALS['iwsl_mf_att'] ), 'delete: DATA-SAFETY — attachment records BYTE-IDENTICAL (no attachment deleted)' );
iwsl_assert_same( 'attachment', get_post_type( 701 ), 'delete: attachment 701 still exists as an attachment' );

// ══════════════════════════════════════════════════════════════════════════════
// 6. assign — single-folder replacement, unfile, BULK_MAX cap, skip invalid ids.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
$F1  = iwsl_mf_make( $eng, 'F1' );
$F2  = iwsl_mf_make( $eng, 'F2' );

iwsl_mf_add_attachment( 801 );
iwsl_mf_add_attachment( 802 );

$eng->assign( array( 801, 802 ), $F1 );
iwsl_assert_same( $F1, iwsl_mf_folder_of( 801 ), 'assign: 801 filed into F1' );
iwsl_assert_same( $F1, iwsl_mf_folder_of( 802 ), 'assign: 802 filed into F1' );

// Single-folder rule: a second assign REPLACES the first (never accumulates).
$eng->assign( array( 801 ), $F2 );
iwsl_assert_same( $F2, iwsl_mf_folder_of( 801 ), 'assign: single-folder — second assign moves 801 to F2' );
iwsl_assert_same( 1, count( $GLOBALS['iwsl_mf_rel'][801][ IWSL_Media_Folders::TAX_FOLDER ] ), 'assign: 801 is in EXACTLY one folder' );

// folder_id 0 unfiles.
$eng->assign( array( 802 ), 0 );
iwsl_assert_same( 0, iwsl_mf_folder_of( 802 ), 'assign: folder_id 0 unfiles 802' );

// Skip ids that are not attachments / not editable.
iwsl_mf_add_attachment( 803 );
iwsl_mf_add_post( 900, 'post' );      // a real post, NOT an attachment.
iwsl_mf_add_attachment( 804 );
$GLOBALS['iwsl_mf_no_edit'][] = 804;  // an attachment the user cannot edit.
$eng->assign( array( 803, 900, 804 ), $F1 );
iwsl_assert_same( $F1, iwsl_mf_folder_of( 803 ), 'assign: a valid editable attachment is filed' );
iwsl_assert_same( 0, iwsl_mf_folder_of( 900 ), 'assign: a non-attachment id is skipped' );
iwsl_assert_same( 0, iwsl_mf_folder_of( 804 ), 'assign: a non-editable attachment is skipped' );
iwsl_assert_same( array(), $GLOBALS['iwsl_mf_rel'][900][ IWSL_Media_Folders::TAX_FOLDER ] ?? array(), 'assign: the non-attachment never received a folder term' );

// BULK_MAX cap: hand it more than the cap; no more than BULK_MAX get filed.
iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
$FB  = iwsl_mf_make( $eng, 'Bulk' );
$bulk_ids = array();
for ( $i = 0; $i < IWSL_Media_Folders::BULK_MAX + 25; $i++ ) {
	$id = 3000 + $i;
	iwsl_mf_add_attachment( $id );
	$bulk_ids[] = $id;
}
$bulk_res = $eng->assign( $bulk_ids, $FB );
$filed    = get_objects_in_term( array( $FB ), IWSL_Media_Folders::TAX_FOLDER );
iwsl_assert( count( $filed ) <= IWSL_Media_Folders::BULK_MAX, 'assign: never files more than BULK_MAX attachments in one call' );
iwsl_assert( count( $filed ) < count( $bulk_ids ), 'assign: the over-cap batch is not fully filed (DoS guard)' );
iwsl_assert_same( false, $bulk_res['ok'], 'assign: an over-cap batch is refused (ok=false)' );

// ══════════════════════════════════════════════════════════════════════════════
// 7. tag — add + remove; MAX_TAGS_PER_FILE cap.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
iwsl_mf_add_attachment( 811 );

// Add two tags.
$eng->tag( array( 811 ), array( 'Red', 'Blue' ), array() );
$tags = wp_get_object_terms( 811, IWSL_Media_Folders::TAX_TAG, array( 'fields' => 'names' ) );
sort( $tags );
iwsl_assert_same( array( 'Blue', 'Red' ), $tags, 'tag: two tags added' );

// Append a third (many-per-file semantics).
$eng->tag( array( 811 ), array( 'Green' ), array() );
iwsl_assert_same( 3, count( wp_get_object_terms( 811, IWSL_Media_Folders::TAX_TAG, array( 'fields' => 'ids' ) ) ), 'tag: append adds a third tag (not replace)' );

// Remove the "Red" tag by term id.
$red = iwsl_mf_find_by_name( 'Red', IWSL_Media_Folders::TAX_TAG, 0 );
$eng->tag( array( 811 ), array(), array( $red ) );
$after = wp_get_object_terms( 811, IWSL_Media_Folders::TAX_TAG, array( 'fields' => 'names' ) );
iwsl_assert( ! in_array( 'Red', $after, true ), 'tag: Red removed by term id' );
iwsl_assert_same( 2, count( $after ), 'tag: two tags remain after removal' );

// MAX_TAGS_PER_FILE cap.
iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
iwsl_mf_add_attachment( 812 );
$many = array();
for ( $i = 0; $i < IWSL_Media_Folders::MAX_TAGS_PER_FILE + 10; $i++ ) {
	$many[] = 'tag' . $i;
}
$eng->tag( array( 812 ), $many, array() );
iwsl_assert( count( wp_get_object_terms( 812, IWSL_Media_Folders::TAX_TAG, array( 'fields' => 'ids' ) ) ) <= IWSL_Media_Folders::MAX_TAGS_PER_FILE, 'tag: a file never exceeds MAX_TAGS_PER_FILE' );

// ══════════════════════════════════════════════════════════════════════════════
// 8. query_media — folder / unfiled / all / tag / mime filters, paging + clamp.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
$FA  = iwsl_mf_make( $eng, 'Album' );

// 10 images + 3 videos = 13 attachments.
for ( $i = 1001; $i <= 1010; $i++ ) {
	iwsl_mf_add_attachment( $i, 'image/jpeg' );
}
for ( $i = 1011; $i <= 1013; $i++ ) {
	iwsl_mf_add_attachment( $i, 'video/mp4' );
}
// File four into the Album (three images + one video); tag two others.
$eng->assign( array( 1001, 1002, 1003, 1011 ), $FA );
$eng->tag( array( 1004, 1005 ), array( 'Featured' ), array() );
$feat = iwsl_mf_find_by_name( 'Featured', IWSL_Media_Folders::TAX_TAG, 0 );

// All media (folder_id = -1).
iwsl_assert_same( 13, $eng->query_media( array( 'folder_id' => -1 ) )['total'], 'query: all media total=13' );

// A specific folder.
iwsl_assert_same( 4, $eng->query_media( array( 'folder_id' => $FA ) )['total'], 'query: folder filter total=4' );

// Unfiled (folder_id = 0): 13 total − 4 filed = 9.
iwsl_assert_same( 9, $eng->query_media( array( 'folder_id' => 0 ) )['total'], 'query: unfiled total=9' );

// Tag filter.
iwsl_assert_same( 2, $eng->query_media( array( 'folder_id' => -1, 'tag_ids' => array( $feat ) ) )['total'], 'query: tag filter total=2' );

// Mime group.
iwsl_assert_same( 10, $eng->query_media( array( 'folder_id' => -1, 'mime_group' => 'image' ) )['total'], 'query: mime_group=image total=10' );
iwsl_assert_same( 3, $eng->query_media( array( 'folder_id' => -1, 'mime_group' => 'video' ) )['total'], 'query: mime_group=video total=3' );

// per_page clamp: an absurd per_page is clamped to LIST_PER_PAGE_MAX.
$clamped = $eng->query_media( array( 'folder_id' => -1, 'per_page' => 5000 ) );
iwsl_assert_same( IWSL_Media_Folders::LIST_PER_PAGE_MAX, (int) $clamped['per_page'], 'query: per_page clamped to LIST_PER_PAGE_MAX' );
iwsl_assert_same( 13, (int) $clamped['total'], 'query: clamp preserves the true total' );

// Pagination: 13 items @ 5/page → 3 pages; page 3 carries the final 3.
$p1 = $eng->query_media( array( 'folder_id' => -1, 'per_page' => 5, 'page' => 1 ) );
iwsl_assert_same( 3, (int) $p1['pages'], 'query: pages = ceil(13/5) = 3' );
iwsl_assert_same( 5, count( $p1['items'] ), 'query: page 1 carries 5 items' );
$p3 = $eng->query_media( array( 'folder_id' => -1, 'per_page' => 5, 'page' => 3 ) );
iwsl_assert_same( 3, (int) $p3['page'], 'query: page echoed back as 3' );
iwsl_assert_same( 3, count( $p3['items'] ), 'query: page 3 carries the trailing 3 items' );

// ══════════════════════════════════════════════════════════════════════════════
// 9. purge — deletes terms in BOTH taxonomies only; attachments untouched.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );

// Two folders (one filed, one empty) + tagged files.
$pf1 = iwsl_mf_make( $eng, 'Keep' );
$pf2 = iwsl_mf_make( $eng, 'EmptyFolder' );
iwsl_mf_add_attachment( 1101 );
iwsl_mf_add_attachment( 1102 );
$eng->assign( array( 1101 ), $pf1 );
$eng->tag( array( 1101, 1102 ), array( 'alpha', 'beta' ), array() ); // 2 tag terms.

$before_purge = serialize( $GLOBALS['iwsl_mf_att'] );

$pg = $eng->purge();
iwsl_assert_same( true, $pg['ok'], 'purge: ok=true' );
iwsl_assert_same( 2, (int) $pg['folders'], 'purge: both folder terms removed (incl. the empty one)' );
iwsl_assert_same( 2, (int) $pg['tags'], 'purge: both tag terms removed' );

// Every term in both taxonomies is gone.
iwsl_assert_same( 0, wp_count_terms( array( 'taxonomy' => IWSL_Media_Folders::TAX_FOLDER ) ), 'purge: zero folder terms remain' );
iwsl_assert_same( 0, wp_count_terms( array( 'taxonomy' => IWSL_Media_Folders::TAX_TAG ) ), 'purge: zero tag terms remain' );
// Attachments are byte-identical — purge keys on organizational metadata only.
iwsl_assert_same( $before_purge, serialize( $GLOBALS['iwsl_mf_att'] ), 'purge: DATA-SAFETY — attachment records BYTE-IDENTICAL' );
iwsl_assert_same( 'attachment', get_post_type( 1101 ), 'purge: attachment 1101 still present' );
iwsl_assert_same( 'attachment', get_post_type( 1102 ), 'purge: attachment 1102 still present' );

// ══════════════════════════════════════════════════════════════════════════════
// 10. TAG CRUD — rename / delete / merge the tag VOCABULARY (TERMS ONLY).
// ══════════════════════════════════════════════════════════════════════════════

// rename_tag — renames the term; attachments keep it; rejects a foreign / unknown id.
iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
iwsl_mf_add_attachment( 1201 );
$eng->tag( array( 1201 ), array( 'Landscpe' ), array() ); // deliberate typo to fix
$tag_id = iwsl_mf_find_by_name( 'Landscpe', IWSL_Media_Folders::TAX_TAG, 0 );
$before_rename = serialize( $GLOBALS['iwsl_mf_att'] );

$tr = $eng->rename_tag( $tag_id, 'Landscape' );
iwsl_assert_same( true, $tr['ok'], 'tag_rename: ok=true' );
iwsl_assert_same( 'Landscape', get_term( $tag_id, IWSL_Media_Folders::TAX_TAG )->name, 'tag_rename: term name updated' );
iwsl_assert( in_array( $tag_id, array_map( 'intval', $GLOBALS['iwsl_mf_rel'][1201][ IWSL_Media_Folders::TAX_TAG ] ?? array() ), true ), 'tag_rename: file KEEPS the (renamed) tag' );
iwsl_assert_same( $before_rename, serialize( $GLOBALS['iwsl_mf_att'] ), 'tag_rename: DATA-SAFETY — attachment records BYTE-IDENTICAL' );

// A folder term id is not a tag → rejected; unknown id → rejected.
$folder_term = iwsl_mf_make( $eng, 'RealFolder' );
iwsl_assert_same( false, $eng->rename_tag( $folder_term, 'Nope' )['ok'], 'tag_rename: a folder term id is rejected (not a tag)' );
iwsl_assert_same( false, $eng->rename_tag( 777333, 'Nope' )['ok'], 'tag_rename: an unknown term id is rejected' );
// Locked gate.
$locked_tag = iwsl_mf_engine( iwsl_mf_locked( $MF_NOW ) );
iwsl_assert_same( 'entitlement-locked', $locked_tag->rename_tag( $tag_id, 'X' )['reason'], 'tag_rename: locked site rejects with the gate reason' );

// delete_tag — removes the term + relationships; NO attachment touched.
iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
iwsl_mf_add_attachment( 1301 );
iwsl_mf_add_attachment( 1302 );
iwsl_mf_add_attachment( 1303 );
$eng->tag( array( 1301, 1302 ), array( 'Draft' ), array() ); // two files carry it; 1303 does not
$draft = iwsl_mf_find_by_name( 'Draft', IWSL_Media_Folders::TAX_TAG, 0 );
$before_deltag = serialize( $GLOBALS['iwsl_mf_att'] );

$dt = $eng->delete_tag( $draft );
iwsl_assert_same( true, $dt['ok'], 'tag_delete: ok=true' );
iwsl_assert_same( 2, (int) $dt['files_untagged'], 'tag_delete: reports the 2 files that carried the tag' );
iwsl_assert_same( null, get_term( $draft, IWSL_Media_Folders::TAX_TAG ), 'tag_delete: the tag term is gone' );
iwsl_assert_same( array(), $GLOBALS['iwsl_mf_rel'][1301][ IWSL_Media_Folders::TAX_TAG ] ?? array(), 'tag_delete: file 1301 no longer carries the tag' );
iwsl_assert_same( $before_deltag, serialize( $GLOBALS['iwsl_mf_att'] ), 'tag_delete: DATA-SAFETY — attachment records BYTE-IDENTICAL' );
iwsl_assert_same( 'attachment', get_post_type( 1301 ), 'tag_delete: attachment 1301 still exists' );
// Reject a folder term / unknown id.
$folder_term2 = iwsl_mf_make( $eng, 'FolderNotTag' );
iwsl_assert_same( false, $eng->delete_tag( $folder_term2 )['ok'], 'tag_delete: a folder term id is rejected' );

// merge_tags — files carrying `from` gain `into`; `from` removed; NO attachment touched.
iwsl_mf_reset();
$eng = iwsl_mf_engine( iwsl_mf_unlocked( $MF_NOW ) );
iwsl_mf_add_attachment( 1401 );
iwsl_mf_add_attachment( 1402 );
iwsl_mf_add_attachment( 1403 );
$eng->tag( array( 1401, 1402 ), array( 'Kitten' ), array() ); // synonym to fold in
$eng->tag( array( 1403 ), array( 'Cat' ), array() );          // canonical
$kitten = iwsl_mf_find_by_name( 'Kitten', IWSL_Media_Folders::TAX_TAG, 0 );
$cat    = iwsl_mf_find_by_name( 'Cat', IWSL_Media_Folders::TAX_TAG, 0 );
$before_merge = serialize( $GLOBALS['iwsl_mf_att'] );

$mg = $eng->merge_tags( $kitten, $cat );
iwsl_assert_same( true, $mg['ok'], 'tag_merge: ok=true' );
iwsl_assert_same( 2, (int) $mg['moved'], 'tag_merge: both files carrying the source tag are moved' );
iwsl_assert_same( null, get_term( $kitten, IWSL_Media_Folders::TAX_TAG ), 'tag_merge: the source tag term is deleted' );
iwsl_assert( in_array( $cat, array_map( 'intval', $GLOBALS['iwsl_mf_rel'][1401][ IWSL_Media_Folders::TAX_TAG ] ?? array() ), true ), 'tag_merge: file 1401 now carries the destination tag' );
iwsl_assert( in_array( $cat, array_map( 'intval', $GLOBALS['iwsl_mf_rel'][1402][ IWSL_Media_Folders::TAX_TAG ] ?? array() ), true ), 'tag_merge: file 1402 now carries the destination tag' );
iwsl_assert_same( $before_merge, serialize( $GLOBALS['iwsl_mf_att'] ), 'tag_merge: DATA-SAFETY — attachment records BYTE-IDENTICAL' );
// Refusals: merge-into-self, unknown ids, locked gate.
iwsl_assert_same( 'merge-into-self', $eng->merge_tags( $cat, $cat )['reason'], 'tag_merge: refuses merging a tag into itself' );
iwsl_assert_same( false, $eng->merge_tags( 999001, $cat )['ok'], 'tag_merge: unknown source id rejected' );
iwsl_assert_same( 'entitlement-locked', iwsl_mf_engine( iwsl_mf_locked( $MF_NOW ) )->merge_tags( $cat, $cat )['reason'], 'tag_merge: locked site rejects with the gate reason' );
