<?php
/**
 * Media Gallery by tag (gate flag `media_folders`): the IWSL_Media_Gallery engine —
 * ONE shared render_gallery() behind a shortcode, a dynamic Gutenberg block and a
 * lazily-loaded Elementor widget, looping every published image carrying a chosen
 * `iwsl_media_tag` term into a bounded, cached, escaped grid.
 *
 * Runs under the zero-dependency harness with its OWN guarded, $GLOBALS-backed fakes
 * for the WordPress functions the engine touches: an in-memory term + attachment +
 * relationship DB, a WP_Query stub that honours post_mime_type=image + a TAX_TAG
 * tax_query + posts_per_page, a transient store, a controllable last-changed marker,
 * and enqueue recorders. The assertions pin the load-bearing contract:
 *   - the entitlement gate is STATEMENT 1 (a locked site renders '' and never reads
 *     or writes the cache);
 *   - the query is BOUNDED (posts_per_page clamped to GALLERY_MAX, never -1);
 *   - the fragment is CACHED and self-invalidates on a last-changed bump;
 *   - the PUBLIC FENCE holds — output carries only front-end-safe fields (image URL /
 *     alt / caption) and no admin datum, and the lightbox script enqueues only when
 *     lightbox is on;
 *   - term resolution works by id / slug / name; the three surfaces share one path.
 */

require_once __DIR__ . '/../includes/class-iwsl-store.php';
require_once __DIR__ . '/../includes/class-iwsl-entitlements.php';
$iwsl_gal_engine_file = __DIR__ . '/../includes/class-iwsl-media-gallery.php';
if ( file_exists( $iwsl_gal_engine_file ) ) {
	require_once $iwsl_gal_engine_file;
}

// ── in-memory DB + recorders ──────────────────────────────────────────────────

$GLOBALS['iwsl_gal_terms']        = array(); // term_id => { term_id, name, slug, taxonomy }
$GLOBALS['iwsl_gal_att']          = array(); // id => { mime, url, alt, caption }
$GLOBALS['iwsl_gal_rel']          = array(); // obj_id => [ taxonomy => [ term_id, ... ] ]
$GLOBALS['iwsl_gal_transients']   = array();
$GLOBALS['iwsl_gal_enq_scripts']  = array();
$GLOBALS['iwsl_gal_enq_styles']   = array();
$GLOBALS['iwsl_gal_shortcodes']   = array();
$GLOBALS['iwsl_gal_query_count']  = 0;
$GLOBALS['iwsl_gal_last_args']    = array();
$GLOBALS['iwsl_gal_lc_terms']     = 'lc-terms-1';
$GLOBALS['iwsl_gal_lc_posts']     = 'lc-posts-1';

function iwsl_gal_reset(): void {
	$GLOBALS['iwsl_gal_terms']       = array();
	$GLOBALS['iwsl_gal_att']         = array();
	$GLOBALS['iwsl_gal_rel']         = array();
	$GLOBALS['iwsl_gal_transients']  = array();
	$GLOBALS['iwsl_gal_enq_scripts'] = array();
	$GLOBALS['iwsl_gal_enq_styles']  = array();
	$GLOBALS['iwsl_gal_shortcodes']  = array();
	$GLOBALS['iwsl_gal_query_count'] = 0;
	$GLOBALS['iwsl_gal_last_args']   = array();
	$GLOBALS['iwsl_gal_lc_terms']    = 'lc-terms-1';
	$GLOBALS['iwsl_gal_lc_posts']    = 'lc-posts-1';
}

// ── fake WP_Error ─────────────────────────────────────────────────────────────

if ( ! class_exists( 'IWSL_GAL_Fake_Error' ) ) {
	final class IWSL_GAL_Fake_Error {}
}
if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ) {
		return $thing instanceof IWSL_GAL_Fake_Error;
	}
}

// ── term store + WP term lookups ──────────────────────────────────────────────

if ( ! class_exists( 'IWSL_GAL_Term' ) ) {
	final class IWSL_GAL_Term {
		public $term_id;
		public $name;
		public $slug;
		public $taxonomy;
		public $count = 0;
		public function __construct( array $row ) {
			$this->term_id  = (int) $row['term_id'];
			$this->name     = (string) $row['name'];
			$this->slug     = (string) $row['slug'];
			$this->taxonomy = (string) $row['taxonomy'];
		}
	}
}
function iwsl_gal_add_tag( int $id, string $name, string $slug ): void {
	$GLOBALS['iwsl_gal_terms'][ $id ] = array( 'term_id' => $id, 'name' => $name, 'slug' => $slug, 'taxonomy' => IWSL_Media_Gallery::TAX_TAG );
}
if ( ! function_exists( 'get_term' ) ) {
	function get_term( $term, $taxonomy = '', ...$rest ) {
		$id  = (int) $term;
		$row = $GLOBALS['iwsl_gal_terms'][ $id ] ?? null;
		if ( null === $row ) {
			return null;
		}
		if ( '' !== (string) $taxonomy && $row['taxonomy'] !== (string) $taxonomy ) {
			return null;
		}
		return new IWSL_GAL_Term( $row );
	}
}
if ( ! function_exists( 'get_term_by' ) ) {
	function get_term_by( $field, $value, $taxonomy = '' ) {
		foreach ( $GLOBALS['iwsl_gal_terms'] as $row ) {
			if ( (string) $taxonomy !== '' && $row['taxonomy'] !== (string) $taxonomy ) {
				continue;
			}
			if ( 'slug' === $field && $row['slug'] === (string) $value ) {
				return new IWSL_GAL_Term( $row );
			}
			if ( 'name' === $field && $row['name'] === (string) $value ) {
				return new IWSL_GAL_Term( $row );
			}
		}
		return false;
	}
}
if ( ! function_exists( 'get_terms' ) ) {
	function get_terms( $args = array() ) {
		$tax = is_array( $args ) ? ( $args['taxonomy'] ?? '' ) : (string) $args;
		$out = array();
		foreach ( $GLOBALS['iwsl_gal_terms'] as $row ) {
			if ( $row['taxonomy'] === $tax ) {
				$out[] = new IWSL_GAL_Term( $row );
			}
		}
		return $out;
	}
}

// ── attachment store + image helpers ──────────────────────────────────────────

function iwsl_gal_add_image( int $id, ?int $tag = null, string $mime = 'image/jpeg', array $extra = array() ): void {
	$GLOBALS['iwsl_gal_att'][ $id ] = array_merge(
		array(
			'mime'    => $mime,
			'url'     => 'https://site.test/wp-content/uploads/img' . $id . '.jpg',
			'alt'     => 'Alt for ' . $id,
			'caption' => 'Caption ' . $id,
		),
		$extra
	);
	if ( null !== $tag ) {
		$GLOBALS['iwsl_gal_rel'][ $id ][ IWSL_Media_Gallery::TAX_TAG ][] = $tag;
	}
}
if ( ! function_exists( 'wp_get_attachment_image_url' ) ) {
	function wp_get_attachment_image_url( $id, $size = 'thumbnail' ) {
		return (string) ( $GLOBALS['iwsl_gal_att'][ (int) $id ]['url'] ?? '' );
	}
}
if ( ! function_exists( 'wp_get_attachment_url' ) ) {
	function wp_get_attachment_url( $id ) {
		return (string) ( $GLOBALS['iwsl_gal_att'][ (int) $id ]['url'] ?? '' );
	}
}
if ( ! function_exists( 'wp_get_attachment_caption' ) ) {
	function wp_get_attachment_caption( $id ) {
		return (string) ( $GLOBALS['iwsl_gal_att'][ (int) $id ]['caption'] ?? '' );
	}
}
if ( ! function_exists( 'get_post_meta' ) ) {
	function get_post_meta( $id, $key = '', $single = false ) {
		if ( '_wp_attachment_image_alt' === $key ) {
			return (string) ( $GLOBALS['iwsl_gal_att'][ (int) $id ]['alt'] ?? '' );
		}
		return $single ? '' : array();
	}
}
if ( ! function_exists( 'wp_get_attachment_image' ) ) {
	function wp_get_attachment_image( $id, $size = 'thumbnail', $icon = false, $attr = array() ) {
		$url = (string) ( $GLOBALS['iwsl_gal_att'][ (int) $id ]['url'] ?? '' );
		return '<img data-iwsl-core-img="1" src="' . htmlspecialchars( $url, ENT_QUOTES ) . '" alt="" />';
	}
}

// ── WP_Query stub (image + TAX_TAG term IN + bounded per_page) ─────────────────

if ( ! class_exists( 'WP_Query' ) ) {
	class WP_Query {
		public $posts = array();
		public function __construct( array $args = array() ) {
			$GLOBALS['iwsl_gal_query_count']++;
			$GLOBALS['iwsl_gal_last_args'] = $args;

			$mime = (string) ( $args['post_mime_type'] ?? '' );
			$tq   = isset( $args['tax_query'] ) && is_array( $args['tax_query'] ) ? $args['tax_query'] : array();
			$want = array();
			foreach ( $tq as $c ) {
				if ( is_array( $c ) && ( $c['taxonomy'] ?? '' ) === IWSL_Media_Gallery::TAX_TAG ) {
					$want = array_map( 'intval', (array) ( $c['terms'] ?? array() ) );
				}
			}

			$matched = array();
			foreach ( $GLOBALS['iwsl_gal_att'] as $id => $rec ) {
				$id = (int) $id;
				if ( 'image' === $mime && 0 !== strpos( (string) ( $rec['mime'] ?? '' ), 'image/' ) ) {
					continue;
				}
				$terms = array_map( 'intval', $GLOBALS['iwsl_gal_rel'][ $id ][ IWSL_Media_Gallery::TAX_TAG ] ?? array() );
				if ( $want && ! array_intersect( $terms, $want ) ) {
					continue;
				}
				$matched[] = $id;
			}
			sort( $matched );
			if ( 'ASC' !== strtoupper( (string) ( $args['order'] ?? 'DESC' ) ) ) {
				$matched = array_reverse( $matched );
			}
			$per         = (int) ( $args['posts_per_page'] ?? 10 );
			$this->posts = $per > 0 ? array_slice( $matched, 0, $per ) : $matched;
		}
	}
}

// ── transients, last-changed, enqueue recorders, escaping, shortcode ──────────

if ( ! function_exists( 'get_transient' ) ) {
	function get_transient( $key ) {
		return $GLOBALS['iwsl_gal_transients'][ (string) $key ] ?? false;
	}
}
if ( ! function_exists( 'set_transient' ) ) {
	function set_transient( $key, $value, $ttl = 0 ) {
		$GLOBALS['iwsl_gal_transients'][ (string) $key ] = $value;
		return true;
	}
}
if ( ! function_exists( 'wp_get_last_changed' ) ) {
	function wp_get_last_changed( $group ) {
		return 'terms' === $group ? $GLOBALS['iwsl_gal_lc_terms'] : $GLOBALS['iwsl_gal_lc_posts'];
	}
}
if ( ! function_exists( 'wp_enqueue_script' ) ) {
	function wp_enqueue_script( $handle, ...$rest ) {
		$GLOBALS['iwsl_gal_enq_scripts'][] = (string) $handle;
	}
}
if ( ! function_exists( 'wp_enqueue_style' ) ) {
	function wp_enqueue_style( $handle, ...$rest ) {
		$GLOBALS['iwsl_gal_enq_styles'][] = (string) $handle;
	}
}
if ( ! function_exists( 'add_shortcode' ) ) {
	function add_shortcode( $tag, $cb ) {
		$GLOBALS['iwsl_gal_shortcodes'][] = (string) $tag;
	}
}
if ( ! function_exists( 'esc_url' ) ) {
	function esc_url( $u ) {
		return htmlspecialchars( (string) $u, ENT_QUOTES );
	}
}
if ( ! function_exists( 'esc_attr' ) ) {
	function esc_attr( $t ) {
		return htmlspecialchars( (string) $t, ENT_QUOTES );
	}
}
if ( ! function_exists( 'esc_html' ) ) {
	function esc_html( $t ) {
		return htmlspecialchars( (string) $t, ENT_QUOTES );
	}
}

// ── entitlement fixtures + engine builder ─────────────────────────────────────

$GAL_NOW = 1900000000000;

function iwsl_gal_unlocked( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array( 'plus' => true, 'media_folders' => true ) );
	return new IWSL_Entitlements( $store, static function () use ( $now ): int {
		return $now;
	} );
}
function iwsl_gal_locked( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array( 'plus' => true ) );
	return new IWSL_Entitlements( $store, static function () use ( $now ): int {
		return $now;
	} );
}
function iwsl_gal_engine( IWSL_Entitlements $ent ): IWSL_Media_Gallery {
	return new IWSL_Media_Gallery( $ent, new IWSL_Memory_Store() );
}

/** Seed a "paintings" tag (id 500) with three images (+ one video, +untagged image). */
function iwsl_gal_seed(): void {
	iwsl_gal_add_tag( 500, 'Paintings', 'paintings' );
	iwsl_gal_add_tag( 501, 'Sketches', 'sketches' );
	iwsl_gal_add_image( 10, 500 );
	iwsl_gal_add_image( 11, 500 );
	iwsl_gal_add_image( 12, 500 );
	iwsl_gal_add_image( 13, 501 );          // different tag
	iwsl_gal_add_image( 14, null );         // untagged
	iwsl_gal_add_image( 20, 500, 'video/mp4' ); // tagged but NOT an image
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. GATE — a locked site renders NOTHING and never touches the cache.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_gal_reset();
iwsl_gal_seed();
$locked = iwsl_gal_engine( iwsl_gal_locked( $GAL_NOW ) );

$g = $locked->render_gallery( array( 'tag' => 'paintings' ) );
iwsl_assert_same( '', $g, 'gate: locked render_gallery returns empty string' );
iwsl_assert_same( 0, $GLOBALS['iwsl_gal_query_count'], 'gate: locked never runs a WP_Query (gate is BEFORE the query)' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_gal_transients'] ), 'gate: locked never reads or writes the cache' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_gal_enq_scripts'] ), 'gate: locked enqueues no lightbox script' );

// ══════════════════════════════════════════════════════════════════════════════
// 2. normalize_args — clamp / whitelist / bool (pure).
// ══════════════════════════════════════════════════════════════════════════════

$n = IWSL_Media_Gallery::normalize_args( array( 'tag' => '  paintings ', 'columns' => 99, 'limit' => 100000, 'size' => 'bogus', 'orderby' => 'hack', 'order' => 'ASC', 'lightbox' => 'no', 'captions' => 'yes' ) );
iwsl_assert_same( 'paintings', $n['tag'], 'normalize: tag trimmed' );
iwsl_assert_same( IWSL_Media_Gallery::COLS_MAX, $n['columns'], 'normalize: columns clamped to COLS_MAX' );
iwsl_assert_same( IWSL_Media_Gallery::GALLERY_MAX, $n['limit'], 'normalize: limit clamped to GALLERY_MAX (never unbounded)' );
iwsl_assert_same( 'medium', $n['size'], 'normalize: unknown size falls back to default' );
iwsl_assert_same( 'date', $n['orderby'], 'normalize: unknown orderby falls back to default' );
iwsl_assert_same( 'asc', $n['order'], 'normalize: order lowercased + whitelisted' );
iwsl_assert_same( false, $n['lightbox'], "normalize: lightbox='no' → false" );
iwsl_assert_same( true, $n['captions'], "normalize: captions='yes' → true" );

$nlow = IWSL_Media_Gallery::normalize_args( array( 'columns' => 0, 'limit' => -5 ) );
iwsl_assert_same( IWSL_Media_Gallery::COLS_MIN, $nlow['columns'], 'normalize: columns clamped up to COLS_MIN' );
iwsl_assert( $nlow['limit'] >= 1, 'normalize: limit clamped to at least 1 (never 0 or negative)' );

// ══════════════════════════════════════════════════════════════════════════════
// 3. render_gallery — happy path, term resolution, bounded, image-only, escaping.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_gal_reset();
iwsl_gal_seed();
$eng = iwsl_gal_engine( iwsl_gal_unlocked( $GAL_NOW ) );

$html = $eng->render_gallery( array( 'tag' => 'paintings', 'columns' => 3, 'captions' => true ) );
iwsl_assert( '' !== $html, 'render: a tag with images produces non-empty HTML' );
iwsl_assert_same( 3, substr_count( $html, 'iwsl-gallery__item' ), 'render: exactly the 3 images with that tag (video + other-tag + untagged excluded)' );
iwsl_assert( false !== strpos( $html, 'iwsl-gallery--cols-3' ), 'render: column class reflects the columns arg' );
iwsl_assert( false !== strpos( $html, 'data-iwsl-lightbox="1"' ), 'render: lightbox marker present when lightbox on' );
iwsl_assert( false !== strpos( $html, 'data-iwsl-full=' ), 'render: each item exposes its full image URL for the lightbox' );
iwsl_assert( false !== strpos( $html, 'data-iwsl-caption=' ), 'render: caption data-attr present' );
iwsl_assert( false !== strpos( $html, 'data-iwsl-alt=' ), 'render: alt data-attr present' );
iwsl_assert( false !== strpos( $html, 'iwsl-gallery__caption' ), 'render: figcaption rendered when captions on' );
iwsl_assert( false !== strpos( $html, 'data-iwsl-core-img' ), 'render: uses wp_get_attachment_image (srcset-capable) for the <img>' );

// Resolution by slug, name, and numeric id all resolve the same term (same 3 items).
iwsl_assert_same( 3, substr_count( $eng->render_gallery( array( 'tag' => 'Paintings' ) ), 'iwsl-gallery__item' ), 'render: tag resolvable by NAME' );
iwsl_assert_same( 3, substr_count( $eng->render_gallery( array( 'tag' => '500' ) ), 'iwsl-gallery__item' ), 'render: tag resolvable by numeric term id' );

// Unknown / empty tag → nothing on the public page.
iwsl_assert_same( '', $eng->render_gallery( array( 'tag' => 'does-not-exist' ) ), 'render: unknown tag renders nothing' );
iwsl_assert_same( '', $eng->render_gallery( array( 'tag' => '' ) ), 'render: empty tag renders nothing' );
iwsl_assert_same( 1, substr_count( $eng->render_gallery( array( 'tag' => 'sketches' ) ), 'iwsl-gallery__item' ), 'render: a different tag (sketches) loops only its own 1 image' );

// size default: an absent/invalid size falls back to medium (matches block/widget defaults).
iwsl_assert_same( 'medium', IWSL_Media_Gallery::normalize_args( array() )['size'], 'render: default image size is medium' );

// ══════════════════════════════════════════════════════════════════════════════
// 4. BOUNDED — posts_per_page is clamped to GALLERY_MAX and is NEVER -1.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_gal_reset();
iwsl_gal_add_tag( 500, 'Paintings', 'paintings' );
for ( $i = 1; $i <= 400; $i++ ) {
	iwsl_gal_add_image( 1000 + $i, 500 );
}
$eng = iwsl_gal_engine( iwsl_gal_unlocked( $GAL_NOW ) );
$eng->render_gallery( array( 'tag' => 'paintings', 'limit' => 10000 ) );
$pp = (int) ( $GLOBALS['iwsl_gal_last_args']['posts_per_page'] ?? 0 );
iwsl_assert( $pp > 0, 'bounded: posts_per_page is positive (never -1)' );
iwsl_assert( $pp <= IWSL_Media_Gallery::GALLERY_MAX, 'bounded: a limit of 10000 is capped to GALLERY_MAX' );
iwsl_assert_same( true, (bool) ( $GLOBALS['iwsl_gal_last_args']['no_found_rows'] ?? false ), 'bounded: no_found_rows set (cheap query)' );
iwsl_assert_same( 'ids', (string) ( $GLOBALS['iwsl_gal_last_args']['fields'] ?? '' ), 'bounded: fields=ids (cheap query)' );

// ══════════════════════════════════════════════════════════════════════════════
// 5. CACHE — a repeat render is a cache hit; a last-changed bump invalidates it.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_gal_reset();
iwsl_gal_seed();
$eng = iwsl_gal_engine( iwsl_gal_unlocked( $GAL_NOW ) );

$eng->render_gallery( array( 'tag' => 'paintings' ) );
$after_first = $GLOBALS['iwsl_gal_query_count'];
iwsl_assert_same( 1, $after_first, 'cache: first render is a miss (one WP_Query)' );

$eng->render_gallery( array( 'tag' => 'paintings' ) );
iwsl_assert_same( $after_first, $GLOBALS['iwsl_gal_query_count'], 'cache: identical second render is a HIT (no new WP_Query)' );

// A term mutation bumps the terms last-changed marker → new key → rebuild.
$GLOBALS['iwsl_gal_lc_terms'] = 'lc-terms-2';
$eng->render_gallery( array( 'tag' => 'paintings' ) );
iwsl_assert_same( $after_first + 1, $GLOBALS['iwsl_gal_query_count'], 'cache: a terms last-changed bump invalidates the cache (rebuild)' );

// A different args set is a different key (its own miss).
$before = $GLOBALS['iwsl_gal_query_count'];
$eng->render_gallery( array( 'tag' => 'paintings', 'columns' => 5 ) );
iwsl_assert_same( $before + 1, $GLOBALS['iwsl_gal_query_count'], 'cache: different args → different key → its own miss' );

// ══════════════════════════════════════════════════════════════════════════════
// 6. PUBLIC FENCE — output carries only front-end-safe fields; no admin datum.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_gal_reset();
iwsl_gal_seed();
$eng  = iwsl_gal_engine( iwsl_gal_unlocked( $GAL_NOW ) );
$html = $eng->render_gallery( array( 'tag' => 'paintings', 'captions' => true ) );

$leaks = array( 'folder', 'optimization', 'optimizer', 'offload', 'uploader', 'manage_options', '_iwsl', 'media.', 'nonce', 'adapter', 'createAdminViewer' );
$leaked = '';
foreach ( $leaks as $needle ) {
	if ( false !== stripos( $html, $needle ) ) {
		$leaked = $needle;
		break;
	}
}
iwsl_assert_same( '', $leaked, 'FENCE: public gallery output contains no admin token (folder/optimization/offload/uploader/signed method/nonce/adapter)' );

// ══════════════════════════════════════════════════════════════════════════════
// 7. ENQUEUE — lightbox on enqueues the module; lightbox off does not; style always.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_gal_reset();
iwsl_gal_seed();
$eng_on = iwsl_gal_engine( iwsl_gal_unlocked( $GAL_NOW ) );
$eng_on->render_gallery( array( 'tag' => 'paintings', 'lightbox' => true ) );
iwsl_assert( in_array( IWSL_Media_Gallery::SCRIPT_HANDLE, $GLOBALS['iwsl_gal_enq_scripts'], true ), 'enqueue: lightbox ON enqueues the presentation-core module' );
iwsl_assert( in_array( IWSL_Media_Gallery::STYLE_HANDLE, $GLOBALS['iwsl_gal_enq_styles'], true ), 'enqueue: grid style enqueued when a gallery renders' );

$GLOBALS['iwsl_gal_enq_scripts'] = array();
$eng_off = iwsl_gal_engine( iwsl_gal_unlocked( $GAL_NOW ) );
$eng_off->render_gallery( array( 'tag' => 'paintings', 'lightbox' => false ) );
iwsl_assert( ! in_array( IWSL_Media_Gallery::SCRIPT_HANDLE, $GLOBALS['iwsl_gal_enq_scripts'], true ), 'enqueue: lightbox OFF enqueues NO script' );

// ══════════════════════════════════════════════════════════════════════════════
// 8. SURFACES — shortcode + block funnel into the SAME renderer; register wiring.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_gal_reset();
iwsl_gal_seed();
$eng = iwsl_gal_engine( iwsl_gal_unlocked( $GAL_NOW ) );

$sc = $eng->shortcode( array( 'tag' => 'paintings' ) );
$bl = $eng->render_block( array( 'tag' => 'paintings' ) );
iwsl_assert_same( 3, substr_count( $sc, 'iwsl-gallery__item' ), 'surface: shortcode renders the 3-image gallery' );
iwsl_assert_same( $sc, $bl, 'surface: shortcode + block produce byte-identical output (one shared renderer + cache)' );

// register() on an unlocked site wires both shortcodes; a locked site wires none.
$GLOBALS['iwsl_gal_shortcodes'] = array();
$eng->register();
iwsl_assert( in_array( IWSL_Media_Gallery::SHORTCODE, $GLOBALS['iwsl_gal_shortcodes'], true ), 'register: primary shortcode [iwsl_media_gallery] registered' );
iwsl_assert( in_array( IWSL_Media_Gallery::SHORTCODE_ALIAS, $GLOBALS['iwsl_gal_shortcodes'], true ), 'register: alias shortcode [iwsl_gallery] registered' );

$GLOBALS['iwsl_gal_shortcodes'] = array();
$locked = iwsl_gal_engine( iwsl_gal_locked( $GAL_NOW ) );
$locked->register();
iwsl_assert_same( 0, count( $GLOBALS['iwsl_gal_shortcodes'] ), 'register: a locked site registers NO shortcode (statement-1 gate)' );

// ══════════════════════════════════════════════════════════════════════════════
// 9. PURE surface metadata — widget list + block attribute schema.
// ══════════════════════════════════════════════════════════════════════════════

iwsl_assert_same( array( 'IWSL_Widget_Media_Gallery' ), IWSL_Media_Gallery::widget_classes(), 'pure: widget_classes lists the gallery widget' );
$attrs = IWSL_Media_Gallery::block_attributes();
iwsl_assert( isset( $attrs['tag'], $attrs['columns'], $attrs['limit'], $attrs['lightbox'] ), 'pure: block attribute schema exposes tag/columns/limit/lightbox' );
iwsl_assert_same( IWSL_Media_Gallery::GALLERY_DEFAULT, (int) $attrs['limit']['default'], 'pure: block limit default = GALLERY_DEFAULT' );
iwsl_assert_same( true, (bool) $attrs['lightbox']['default'], 'pure: block lightbox default = true' );

// ══════════════════════════════════════════════════════════════════════════════
// 10. teardown parity — purge is a clean no-op (no persistent footprint).
// ══════════════════════════════════════════════════════════════════════════════

$pg = iwsl_gal_engine( iwsl_gal_unlocked( $GAL_NOW ) )->purge();
iwsl_assert_same( true, $pg['ok'], 'purge: ok=true' );
iwsl_assert_same( false, $pg['deleted'], 'purge: nothing to delete (galleries persist nothing of their own)' );
