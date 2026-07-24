<?php
/**
 * IWSL_Media_Library — the fused per-asset READ-MODEL. This suite proves the JOIN
 * over the three orthogonal metadata surfaces (folder terms, optimizer meta
 * `_iwsl_media_optimizer`, offload meta `_iwsl_offload`) yields one honest row per
 * asset, that the two new server-side filters (notLossless / notOnCdn) and their
 * matching-id set are exact, that eligibility + restorability classify correctly,
 * and that locked features blank their own columns without hiding the others.
 *
 * Zero-dependency harness: this suite owns guarded, $GLOBALS-backed fakes for the
 * WordPress attachment / term / meta / WP_Query surface, backed by an in-memory
 * attachment DB we control end-to-end. (Subprocess isolation makes the stubs safe.)
 */

require_once __DIR__ . '/../includes/class-iwsl-store.php';
require_once __DIR__ . '/../includes/class-iwsl-entitlements.php';

// ── in-memory attachment DB ───────────────────────────────────────────────────
// Each record: mime,title,filename,file(path on disk or missing),w,h,
//   folder => ['id','name']|null, tags => [['id','name'],...],
//   opt => optimizer meta array|null, off => offload meta array|null.

$GLOBALS['ml_att'] = array();

/** Real temp files so is_file()/filesize() are honest for "exists" cases. */
$ml_tmp_a = tempnam( sys_get_temp_dir(), 'iwsl_ml_' );
$ml_tmp_b = tempnam( sys_get_temp_dir(), 'iwsl_ml_' );
file_put_contents( $ml_tmp_a, str_repeat( 'a', 128 ) );
file_put_contents( $ml_tmp_b, str_repeat( 'b', 64 ) );
$ml_missing = sys_get_temp_dir() . '/iwsl_ml_definitely_absent_' . uniqid() . '.png';

function ml_seed(): void {
	global $ml_tmp_a, $ml_tmp_b, $ml_missing;
	$GLOBALS['ml_att'] = array(
		// eligible PNG, untouched → original / local.
		1  => array( 'mime' => 'image/png', 'title' => 'Alpha', 'filename' => 'alpha.png', 'file' => $ml_tmp_a, 'w' => 800, 'h' => 600, 'folder' => null, 'tags' => array(), 'opt' => null, 'off' => null ),
		// optimized (40% saved) AND offloaded derivative, in folder Products, tag hero.
		2  => array( 'mime' => 'image/png', 'title' => 'Beta', 'filename' => 'beta.png', 'file' => $ml_tmp_a, 'w' => 1024, 'h' => 768, 'folder' => array( 'id' => 900, 'name' => 'Products' ), 'tags' => array( array( 'id' => 800, 'name' => 'hero' ) ), 'opt' => array( 'converter' => 'webp_lossless', 'bytes_in' => 1000, 'bytes_out' => 600 ), 'off' => array( 'key' => 'obj/beta.webp', 'url' => 'https://cdn.test/beta.webp', 'variant' => 'derivative' ) ),
		// optimized JPEG, still local, in folder Products.
		3  => array( 'mime' => 'image/jpeg', 'title' => 'Gamma', 'filename' => 'gamma.jpg', 'file' => $ml_tmp_b, 'w' => 640, 'h' => 480, 'folder' => array( 'id' => 900, 'name' => 'Products' ), 'tags' => array(), 'opt' => array( 'converter' => 'webp_lossless', 'bytes_in' => 500, 'bytes_out' => 500 ), 'off' => null ),
		// WEBP: an image the optimizer can't convert → ineligible.
		4  => array( 'mime' => 'image/webp', 'title' => 'Delta', 'filename' => 'delta.webp', 'file' => $ml_tmp_b, 'w' => 300, 'h' => 300, 'folder' => null, 'tags' => array(), 'opt' => null, 'off' => null ),
		// video → ineligible for optimization.
		5  => array( 'mime' => 'video/mp4', 'title' => 'Epsilon', 'filename' => 'epsilon.mp4', 'file' => $ml_tmp_b, 'w' => 0, 'h' => 0, 'folder' => null, 'tags' => array(), 'opt' => null, 'off' => null ),
		// PDF (document), offloaded as ORIGINAL.
		6  => array( 'mime' => 'application/pdf', 'title' => 'Zeta', 'filename' => 'zeta.pdf', 'file' => $ml_tmp_b, 'w' => 0, 'h' => 0, 'folder' => null, 'tags' => array(), 'opt' => null, 'off' => array( 'key' => 'obj/zeta.pdf', 'url' => 'https://cdn.test/zeta.pdf', 'variant' => 'original' ) ),
		// optimized PNG whose ORIGINAL file is GONE (replace-mode) → non-restorable.
		7  => array( 'mime' => 'image/png', 'title' => 'Eta', 'filename' => 'eta.png', 'file' => $ml_missing, 'w' => 100, 'h' => 100, 'folder' => null, 'tags' => array(), 'opt' => array( 'converter' => 'webp_lossless', 'bytes_in' => 900, 'bytes_out' => 300 ), 'off' => null ),
		// another eligible-not-optimized image (GIF).
		10 => array( 'mime' => 'image/gif', 'title' => 'Iota', 'filename' => 'iota.gif', 'file' => $ml_tmp_a, 'w' => 50, 'h' => 50, 'folder' => null, 'tags' => array(), 'opt' => null, 'off' => null ),
	);
}
ml_seed();

// ── term value object + WP fakes ──────────────────────────────────────────────

if ( ! class_exists( 'ML_Term' ) ) {
	final class ML_Term {
		public $term_id;
		public $name;
		public function __construct( int $id, string $name ) {
			$this->term_id = $id;
			$this->name    = $name;
		}
	}
}
if ( ! class_exists( 'ML_Fake_Error' ) ) {
	final class ML_Fake_Error {}
}
if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ) {
		return $thing instanceof ML_Fake_Error;
	}
}
if ( ! function_exists( 'get_attached_file' ) ) {
	function get_attached_file( $id, $unfiltered = false ) {
		return (string) ( $GLOBALS['ml_att'][ (int) $id ]['file'] ?? '' );
	}
}
if ( ! function_exists( 'get_the_title' ) ) {
	function get_the_title( $id = 0 ) {
		return (string) ( $GLOBALS['ml_att'][ (int) $id ]['title'] ?? '' );
	}
}
if ( ! function_exists( 'get_post_mime_type' ) ) {
	function get_post_mime_type( $id = null ) {
		return (string) ( $GLOBALS['ml_att'][ (int) $id ]['mime'] ?? '' );
	}
}
if ( ! function_exists( 'wp_get_attachment_url' ) ) {
	function wp_get_attachment_url( $id = 0 ) {
		return 'https://site.test/uploads/' . (string) ( $GLOBALS['ml_att'][ (int) $id ]['filename'] ?? '' );
	}
}
if ( ! function_exists( 'wp_get_attachment_image_url' ) ) {
	function wp_get_attachment_image_url( $id, $size = 'thumbnail' ) {
		return 'https://site.test/uploads/thumb-' . (string) ( $GLOBALS['ml_att'][ (int) $id ]['filename'] ?? '' );
	}
}
if ( ! function_exists( 'wp_get_attachment_metadata' ) ) {
	function wp_get_attachment_metadata( $id = 0, $unfiltered = false ) {
		$r = $GLOBALS['ml_att'][ (int) $id ] ?? null;
		return null === $r ? array() : array( 'width' => (int) $r['w'], 'height' => (int) $r['h'] );
	}
}
if ( ! function_exists( 'get_the_date' ) ) {
	function get_the_date( $format = '', $id = 0 ) {
		return '2026-07-24T00:00:00+00:00';
	}
}
if ( ! function_exists( 'wp_get_object_terms' ) ) {
	function wp_get_object_terms( $id, $taxonomy, $args = array() ) {
		$rec = $GLOBALS['ml_att'][ (int) $id ] ?? null;
		if ( null === $rec ) {
			return array();
		}
		if ( 'iwsl_media_folder' === $taxonomy ) {
			return null === $rec['folder'] ? array() : array( new ML_Term( (int) $rec['folder']['id'], (string) $rec['folder']['name'] ) );
		}
		if ( 'iwsl_media_tag' === $taxonomy ) {
			$out = array();
			foreach ( $rec['tags'] as $t ) {
				$out[] = new ML_Term( (int) $t['id'], (string) $t['name'] );
			}
			return $out;
		}
		return array();
	}
}
if ( ! function_exists( 'get_post_meta' ) ) {
	function get_post_meta( $id, $key, $single = false ) {
		$rec = $GLOBALS['ml_att'][ (int) $id ] ?? null;
		if ( null === $rec ) {
			return '';
		}
		if ( '_iwsl_media_optimizer' === $key ) {
			return null === $rec['opt'] ? '' : $rec['opt'];
		}
		if ( '_iwsl_offload' === $key ) {
			return null === $rec['off'] ? '' : $rec['off'];
		}
		return '';
	}
}

// ── WP_Query stub over the same in-memory DB (tax + meta + mime + search) ──────

if ( ! class_exists( 'WP_Query' ) ) {
	class WP_Query {
		public $posts       = array();
		public $found_posts = 0;
		public function __construct( array $args = array() ) {
			$mime = $args['post_mime_type'] ?? '';
			$s    = isset( $args['s'] ) ? (string) $args['s'] : '';
			$tq   = ( isset( $args['tax_query'] ) && is_array( $args['tax_query'] ) ) ? $args['tax_query'] : array();
			$mq   = ( isset( $args['meta_query'] ) && is_array( $args['meta_query'] ) ) ? $args['meta_query'] : array();

			$matched = array();
			foreach ( $GLOBALS['ml_att'] as $id => $rec ) {
				$id = (int) $id;
				if ( ! self::mime_match( (string) $rec['mime'], $mime ) ) {
					continue;
				}
				if ( '' !== $s && false === stripos( $rec['title'] . ' ' . $rec['filename'], $s ) ) {
					continue;
				}
				if ( ! self::tax_match( $rec, $tq ) ) {
					continue;
				}
				if ( ! self::meta_match( $rec, $mq ) ) {
					continue;
				}
				$matched[] = $id;
			}
			sort( $matched );
			$this->found_posts = count( $matched );
			$per                = (int) ( $args['posts_per_page'] ?? 10 );
			$paged              = max( 1, (int) ( $args['paged'] ?? 1 ) );
			$this->posts        = $per > 0 ? array_slice( $matched, ( $paged - 1 ) * $per, $per ) : $matched;
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
		private static function tax_match( array $rec, array $tq ): bool {
			foreach ( $tq as $k => $clause ) {
				if ( 'relation' === $k || ! is_array( $clause ) || ! isset( $clause['taxonomy'] ) ) {
					continue;
				}
				$op = strtoupper( (string) ( $clause['operator'] ?? 'IN' ) );
				if ( 'iwsl_media_folder' === $clause['taxonomy'] ) {
					$has = null !== $rec['folder'];
					if ( 'NOT EXISTS' === $op && $has ) {
						return false;
					}
					if ( 'IN' === $op ) {
						$terms = array_map( 'intval', (array) ( $clause['terms'] ?? array() ) );
						if ( ! $has || ! in_array( (int) $rec['folder']['id'], $terms, true ) ) {
							return false;
						}
					}
				} elseif ( 'iwsl_media_tag' === $clause['taxonomy'] && 'IN' === $op ) {
					$terms = array_map( 'intval', (array) ( $clause['terms'] ?? array() ) );
					$ids   = array();
					foreach ( $rec['tags'] as $t ) {
						$ids[] = (int) $t['id'];
					}
					if ( array() === array_intersect( $ids, $terms ) ) {
						return false;
					}
				}
			}
			return true;
		}
		private static function meta_match( array $rec, array $mq ): bool {
			foreach ( $mq as $k => $clause ) {
				if ( 'relation' === $k || ! is_array( $clause ) || ! isset( $clause['key'] ) ) {
					continue;
				}
				$present = ( '_iwsl_media_optimizer' === $clause['key'] ) ? ( null !== $rec['opt'] )
					: ( ( '_iwsl_offload' === $clause['key'] ) ? ( null !== $rec['off'] ) : false );
				$cmp     = strtoupper( (string) ( $clause['compare'] ?? 'EXISTS' ) );
				if ( 'EXISTS' === $cmp && ! $present ) {
					return false;
				}
				if ( 'NOT EXISTS' === $cmp && $present ) {
					return false;
				}
			}
			return true;
		}
	}
}

require_once __DIR__ . '/../includes/class-iwsl-media-converter.php';
require_once __DIR__ . '/../includes/class-iwsl-webp-lossless-converter.php';
require_once __DIR__ . '/../includes/class-iwsl-media-optimizer.php';
require_once __DIR__ . '/../includes/class-iwsl-media-folders.php';
require_once __DIR__ . '/../includes/class-iwsl-media-library.php';

// ── entitlement builders ──────────────────────────────────────────────────────

$ML_NOW = 1900000000000;
/** @param array<string,bool> $flags */
function ml_ent( int $now, array $flags ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array_merge( array( 'plus' => true ), $flags ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

$full_flags = array( 'media_folders' => true, 'image_optimization' => true, 'cdn_rewrite' => true );

// ── 1. JOIN correctness — one row carries all three states ─────────────────────

$lib  = new IWSL_Media_Library( ml_ent( $ML_NOW, $full_flags ) );
$page = $lib->list_assets( array( 'folder_id' => -1, 'per_page' => 100 ) );

iwsl_assert_same( 8, $page['total'], 'list: all-media total counts every seeded attachment' );
iwsl_assert_same( false, $page['locked'], 'list: unlocked site is not locked' );
iwsl_assert_same( true, $page['features']['image_optimization'], 'list: features report optimization unlocked' );

$by_id = array();
foreach ( $page['items'] as $row ) {
	$by_id[ $row['id'] ] = $row;
}

iwsl_assert_same( 'optimized', $by_id[2]['optimization']['status'], 'row2: optimized status from optimizer meta' );
iwsl_assert_same( 40.0, $by_id[2]['optimization']['saved_pct'], 'row2: saved_pct computed from bytes_in/out' );
iwsl_assert_same( true, $by_id[2]['optimization']['restorable'], 'row2: optimized w/ original on disk is restorable' );
iwsl_assert_same( 'offloaded', $by_id[2]['offload']['status'], 'row2: offloaded status from offload meta' );
iwsl_assert_same( 'derivative', $by_id[2]['offload']['variant'], 'row2: offload variant is derivative' );
iwsl_assert_same( array( 'id' => 900, 'name' => 'Products' ), $by_id[2]['folder'], 'row2: folder joined from term' );
iwsl_assert_same( 'hero', $by_id[2]['tags'][0]['name'], 'row2: tag joined from term' );

iwsl_assert_same( 'original', $by_id[1]['optimization']['status'], 'row1: eligible+untouched = original' );
iwsl_assert_same( 'local', $by_id[1]['offload']['status'], 'row1: no offload meta = local' );
iwsl_assert_same( null, $by_id[1]['folder'], 'row1: unfiled folder is null' );

iwsl_assert_same( 'ineligible', $by_id[4]['optimization']['status'], 'row4: webp is ineligible for the optimizer' );
iwsl_assert_same( 'ineligible', $by_id[5]['optimization']['status'], 'row5: video is ineligible' );
iwsl_assert_same( 'original', $by_id[6]['offload']['variant'], 'row6: offloaded original variant surfaced' );

// ── 2. Restorability — replace-mode gone original is non-restorable ────────────

iwsl_assert_same( 'optimized', $by_id[7]['optimization']['status'], 'row7: still classified optimized' );
iwsl_assert_same( false, $by_id[7]['optimization']['restorable'], 'row7: missing original = non-restorable (not a silent fail)' );

// ── 3. notLossless filter (unoptimized) — eligible-not-done ONLY, honest total ─

$unopt = $lib->list_assets( array( 'folder_id' => -1, 'optimization' => 'unoptimized', 'per_page' => 100, 'include_ids' => true ) );
iwsl_assert_same( 2, $unopt['total'], 'filter unoptimized: only eligible-not-optimized (png#1 + gif#10)' );
iwsl_assert_same( array( 1, 10 ), $unopt['ids'], 'filter unoptimized: matching ids are the honest full set (select-all)' );
iwsl_assert_same( false, $unopt['ids_capped'], 'filter unoptimized: ids not capped at this size' );
$unopt_mimes = array();
foreach ( $unopt['items'] as $r ) {
	$unopt_mimes[] = $r['optimization']['status'];
}
iwsl_assert_same( array( 'original', 'original' ), $unopt_mimes, 'filter unoptimized: ineligible webp/video excluded from make-lossless set' );

// ── 4. notOnCdn / offloaded filters ───────────────────────────────────────────

iwsl_assert_same( 6, $lib->list_assets( array( 'folder_id' => -1, 'offload' => 'local', 'per_page' => 100 ) )['total'], 'filter local: everything without an offload record' );
iwsl_assert_same( 2, $lib->list_assets( array( 'folder_id' => -1, 'offload' => 'offloaded', 'per_page' => 100 ) )['total'], 'filter offloaded: the two with an offload record' );
iwsl_assert_same( 3, $lib->list_assets( array( 'folder_id' => -1, 'optimization' => 'optimized', 'per_page' => 100 ) )['total'], 'filter optimized: the three with optimizer meta' );

// ── 5. Folder + type filters ───────────────────────────────────────────────────

iwsl_assert_same( 2, $lib->list_assets( array( 'folder_id' => 900, 'per_page' => 100 ) )['total'], 'filter folder=Products: two assets' );
iwsl_assert_same( 6, $lib->list_assets( array( 'folder_id' => 0, 'per_page' => 100 ) )['total'], 'filter folder=unfiled: the six unfiled assets' );
iwsl_assert_same( 6, $lib->list_assets( array( 'folder_id' => -1, 'mime_group' => 'image', 'per_page' => 100 ) )['total'], 'filter type=image: the six images' );
iwsl_assert_same( 1, $lib->list_assets( array( 'folder_id' => -1, 'mime_group' => 'video', 'per_page' => 100 ) )['total'], 'filter type=video: the one video' );
iwsl_assert_same( 1, $lib->list_assets( array( 'folder_id' => -1, 'mime_group' => 'document', 'per_page' => 100 ) )['total'], 'filter type=document: the one pdf' );

// ── 6. Combined filter (folder ∩ optimized) stays honest ───────────────────────

iwsl_assert_same( 2, $lib->list_assets( array( 'folder_id' => 900, 'optimization' => 'optimized', 'per_page' => 100 ) )['total'], 'filter folder∩optimized: both Products assets are optimized' );

// ── 7. Paging clamp + degenerate empty library ─────────────────────────────────

$clamped = $lib->list_assets( array( 'folder_id' => -1, 'per_page' => 5000 ) );
iwsl_assert_same( 100, $clamped['per_page'], 'paging: per_page clamps to PER_PAGE_MAX' );

$p1 = $lib->list_assets( array( 'folder_id' => -1, 'per_page' => 5, 'page' => 1 ) );
iwsl_assert_same( 5, count( $p1['items'] ), 'paging: page 1 holds per_page items' );
iwsl_assert_same( 2, $p1['pages'], 'paging: 8 items / 5 per page = 2 pages' );

$GLOBALS['ml_att'] = array();
$empty             = $lib->list_assets( array( 'folder_id' => -1 ) );
iwsl_assert_same( 0, $empty['total'], 'degenerate: empty library reports total 0' );
iwsl_assert_same( array(), $empty['items'], 'degenerate: empty library reports no items' );
ml_seed();

// ── 8. Locked columns — folders-only tier blanks optimization/offload ──────────

$folders_only = new IWSL_Media_Library( ml_ent( $ML_NOW, array( 'media_folders' => true ) ) );
$fo           = $folders_only->list_assets( array( 'folder_id' => -1, 'per_page' => 100 ) );
iwsl_assert_same( false, $fo['locked'], 'folders-only: surface visible (folders unlocked)' );
iwsl_assert_same( false, $fo['features']['image_optimization'], 'folders-only: optimization feature reported locked' );
$fo_row = null;
foreach ( $fo['items'] as $r ) {
	if ( 2 === $r['id'] ) {
		$fo_row = $r;
	}
}
iwsl_assert_same( null, $fo_row['optimization'], 'folders-only: optimization column blanked' );
iwsl_assert_same( null, $fo_row['offload'], 'folders-only: offload column blanked' );
iwsl_assert_same( array( 'id' => 900, 'name' => 'Products' ), $fo_row['folder'], 'folders-only: folder column still present' );

// ── 9. Fully locked tier → locked envelope with gate reason ────────────────────

$none   = new IWSL_Media_Library( ml_ent( $ML_NOW, array() ) );
$locked = $none->list_assets( array( 'folder_id' => -1 ) );
iwsl_assert_same( true, $locked['locked'], 'no-tier: list returns a locked envelope' );
iwsl_assert_same( array(), $locked['items'], 'no-tier: locked envelope carries no rows' );
iwsl_assert( in_array( 'requires-plus', $locked['gate']['reasons'], true ), 'no-tier: gate reason surfaced for the console' );

@unlink( $ml_tmp_a );
@unlink( $ml_tmp_b );
