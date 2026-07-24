<?php
/**
 * IWSL_Media_Detail — the viewer's per-asset read-model + safe mutations (Agent A).
 * This suite pins: the full-detail JOIN (fused row + native panel fields), the
 * locked/absent degenerate envelopes, the optimistic-concurrency refusal (a stale
 * `expect_modified` returns CURRENT values and writes NOTHING), the sanitizer matrix
 * (caption scripts stripped, alt text-cleaned), the bounded/capped where-used scan,
 * the confirm-fenced REAL attachment delete (bucket-removed reporting), and every
 * strict validator (exact keys, at-least-one-field, literal confirm:true).
 *
 * Zero-dependency harness: guarded $GLOBALS-backed fakes for the WP attachment /
 * post-field / meta / metadata / $wpdb surface (subprocess isolation keeps them safe).
 */

require_once __DIR__ . '/../includes/class-iwsl-store.php';
require_once __DIR__ . '/../includes/class-iwsl-entitlements.php';

// ── in-memory attachment DB + mutation spies ──────────────────────────────────
$GLOBALS['md_att']            = array();
$GLOBALS['md_post_updates']   = array();  // every wp_update_post payload.
$GLOBALS['md_meta_writes']    = array();   // every update_post_meta [id,key,value].
$GLOBALS['md_meta_deletes']   = array();   // every delete_post_meta [id,key].
$GLOBALS['md_deleted_att']    = array();   // every wp_delete_attachment id.
$GLOBALS['md_usage_rows']     = array( 'thumbnail' => array(), 'content' => array() );

$md_tmp = tempnam( sys_get_temp_dir(), 'iwsl_md_' );
file_put_contents( $md_tmp, str_repeat( 'x', 256 ) );

function md_seed(): void {
	global $md_tmp;
	$GLOBALS['md_att'] = array(
		7 => array(
			'mime'        => 'image/png',
			'title'       => 'Sunset',
			'file'        => $md_tmp,
			'w'           => 1200,
			'h'           => 800,
			'author'      => 3,
			'author_name' => 'Ada Photographer',
			'excerpt'     => 'A caption',
			'content'     => 'A long description',
			'modified'    => '2026-01-02 03:04:05',
			'alt'         => 'sunset over the sea',
			'opt'         => array( 'converter' => 'webp_lossless', 'bytes_in' => 1000, 'bytes_out' => 700 ),
			'off'         => array( 'key' => 'obj/sunset.webp', 'url' => 'https://cdn.test/sunset.webp', 'variant' => 'derivative' ),
			'protected'   => '1',
			'sizes'       => array(
				'thumbnail' => array( 'file' => 'sunset-150x150.png', 'width' => 150, 'height' => 150 ),
				'medium'    => array( 'file' => 'sunset-300x200.png', 'width' => 300, 'height' => 200 ),
			),
			'image_meta'  => array( 'camera' => 'Canon EOS', 'aperture' => '2.8', 'iso' => '100', 'focal_length' => '50', 'shutter_speed' => '0.005', 'created_timestamp' => '1700000000', 'credit' => '', 'title' => 'ignored-non-whitelisted' ),
		),
	);
}
md_seed();

// ── WP fakes ──────────────────────────────────────────────────────────────────
if ( ! class_exists( 'MD_Fake_Error' ) ) {
	final class MD_Fake_Error {}
}
if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $t ) {
		return $t instanceof MD_Fake_Error;
	}
}
if ( ! function_exists( 'get_post' ) ) {
	function get_post( $id ) {
		$rec = $GLOBALS['md_att'][ (int) $id ] ?? null;
		if ( null === $rec ) {
			return null;
		}
		return (object) array( 'ID' => (int) $id, 'post_type' => 'attachment' );
	}
}
if ( ! function_exists( 'get_post_field' ) ) {
	function get_post_field( $field, $id ) {
		$rec = $GLOBALS['md_att'][ (int) $id ] ?? null;
		if ( null === $rec ) {
			return '';
		}
		switch ( $field ) {
			case 'post_author':
				return (string) $rec['author'];
			case 'post_excerpt':
				return (string) $rec['excerpt'];
			case 'post_content':
				return (string) $rec['content'];
			case 'post_modified_gmt':
				return (string) $rec['modified'];
			case 'post_title':
				return (string) $rec['title'];
		}
		return '';
	}
}
if ( ! function_exists( 'get_the_title' ) ) {
	function get_the_title( $id = 0 ) {
		return (string) ( $GLOBALS['md_att'][ (int) $id ]['title'] ?? '' );
	}
}
if ( ! function_exists( 'get_post_mime_type' ) ) {
	function get_post_mime_type( $id = null ) {
		return (string) ( $GLOBALS['md_att'][ (int) $id ]['mime'] ?? '' );
	}
}
if ( ! function_exists( 'get_attached_file' ) ) {
	function get_attached_file( $id, $u = false ) {
		return (string) ( $GLOBALS['md_att'][ (int) $id ]['file'] ?? '' );
	}
}
if ( ! function_exists( 'wp_get_attachment_url' ) ) {
	function wp_get_attachment_url( $id = 0 ) {
		return 'https://site.test/uploads/sunset.png';
	}
}
if ( ! function_exists( 'wp_get_attachment_image_url' ) ) {
	function wp_get_attachment_image_url( $id, $size = 'thumbnail' ) {
		return 'https://site.test/uploads/sunset-' . (string) $size . '.png';
	}
}
if ( ! function_exists( 'get_the_date' ) ) {
	function get_the_date( $f = '', $id = 0 ) {
		return '2026-01-02T03:04:05+00:00';
	}
}
if ( ! function_exists( 'get_the_author_meta' ) ) {
	function get_the_author_meta( $field, $id ) {
		foreach ( $GLOBALS['md_att'] as $rec ) {
			if ( (int) $rec['author'] === (int) $id ) {
				return (string) $rec['author_name'];
			}
		}
		return '';
	}
}
if ( ! function_exists( 'wp_get_attachment_metadata' ) ) {
	function wp_get_attachment_metadata( $id = 0, $u = false ) {
		$rec = $GLOBALS['md_att'][ (int) $id ] ?? null;
		if ( null === $rec ) {
			return array();
		}
		return array( 'width' => (int) $rec['w'], 'height' => (int) $rec['h'], 'sizes' => $rec['sizes'], 'image_meta' => $rec['image_meta'] );
	}
}
if ( ! function_exists( 'wp_get_object_terms' ) ) {
	function wp_get_object_terms( $id, $tax, $args = array() ) {
		return array();
	}
}
if ( ! function_exists( 'get_post_meta' ) ) {
	function get_post_meta( $id, $key, $single = false ) {
		$rec = $GLOBALS['md_att'][ (int) $id ] ?? null;
		if ( null === $rec ) {
			return '';
		}
		if ( '_iwsl_media_optimizer' === $key ) {
			return null === $rec['opt'] ? '' : $rec['opt'];
		}
		if ( '_iwsl_offload' === $key ) {
			return null === $rec['off'] ? '' : $rec['off'];
		}
		if ( '_wp_attachment_image_alt' === $key ) {
			return (string) $rec['alt'];
		}
		if ( '_iwsl_protected' === $key ) {
			return (string) $rec['protected'];
		}
		return '';
	}
}
if ( ! function_exists( 'wp_update_post' ) ) {
	function wp_update_post( $arr ) {
		$GLOBALS['md_post_updates'][] = $arr;
		$id                           = (int) ( $arr['ID'] ?? 0 );
		if ( isset( $GLOBALS['md_att'][ $id ] ) ) {
			if ( array_key_exists( 'post_excerpt', $arr ) ) {
				$GLOBALS['md_att'][ $id ]['excerpt'] = (string) $arr['post_excerpt'];
			}
			if ( array_key_exists( 'post_content', $arr ) ) {
				$GLOBALS['md_att'][ $id ]['content'] = (string) $arr['post_content'];
			}
			if ( array_key_exists( 'post_title', $arr ) ) {
				$GLOBALS['md_att'][ $id ]['title'] = (string) $arr['post_title'];
			}
			$GLOBALS['md_att'][ $id ]['modified'] = '2026-01-02 09:09:09'; // bumped by the "save".
		}
		return $id;
	}
}
if ( ! function_exists( 'update_post_meta' ) ) {
	function update_post_meta( $id, $key, $value ) {
		$GLOBALS['md_meta_writes'][] = array( (int) $id, $key, $value );
		if ( isset( $GLOBALS['md_att'][ (int) $id ] ) && '_wp_attachment_image_alt' === $key ) {
			$GLOBALS['md_att'][ (int) $id ]['alt'] = (string) $value;
		}
		return true;
	}
}
if ( ! function_exists( 'delete_post_meta' ) ) {
	function delete_post_meta( $id, $key ) {
		$GLOBALS['md_meta_deletes'][] = array( (int) $id, $key );
		return true;
	}
}
if ( ! function_exists( 'wp_delete_attachment' ) ) {
	function wp_delete_attachment( $id, $force = false ) {
		$GLOBALS['md_deleted_att'][] = (int) $id;
		unset( $GLOBALS['md_att'][ (int) $id ] );
		return (object) array( 'ID' => (int) $id );
	}
}
if ( ! function_exists( 'get_permalink' ) ) {
	function get_permalink( $id = 0 ) {
		return 'https://site.test/?p=' . (int) $id;
	}
}
if ( ! function_exists( 'sanitize_text_field' ) ) {
	function sanitize_text_field( $s ) {
		return trim( preg_replace( '/[\r\n\t]+/', ' ', strip_tags( (string) $s ) ) );
	}
}
if ( ! function_exists( 'wp_kses_post' ) ) {
	function wp_kses_post( $s ) {
		// Minimal: drop <script>…</script> but keep other markup (like the real kses does for scripts).
		return preg_replace( '#<script\b[^>]*>.*?</script>#is', '', (string) $s );
	}
}
if ( ! function_exists( 'wp_json_encode' ) ) {
	function wp_json_encode( $v ) {
		return json_encode( $v );
	}
}

// ── a $wpdb stub for the where-used scan ──────────────────────────────────────
if ( ! class_exists( 'MD_WPDB' ) ) {
	class MD_WPDB {
		public $posts    = 'wp_posts';
		public $postmeta = 'wp_postmeta';
		public function prepare( $q, ...$a ) {
			return $q; // the stub keys off the query shape, not the bound args.
		}
		public function esc_like( $s ) {
			return (string) $s;
		}
		public function get_results( $q ) {
			if ( false !== strpos( $q, '_thumbnail_id' ) ) {
				return $GLOBALS['md_usage_rows']['thumbnail'];
			}
			if ( false !== strpos( $q, 'post_content LIKE' ) ) {
				return $GLOBALS['md_usage_rows']['content'];
			}
			return array();
		}
	}
}
$GLOBALS['wpdb'] = new MD_WPDB();

require_once __DIR__ . '/../includes/class-iwsl-media-converter.php';
require_once __DIR__ . '/../includes/class-iwsl-webp-lossless-converter.php';
require_once __DIR__ . '/../includes/class-iwsl-media-optimizer.php';
require_once __DIR__ . '/../includes/class-iwsl-media-protection.php';
require_once __DIR__ . '/../includes/class-iwsl-media-folders.php';
require_once __DIR__ . '/../includes/class-iwsl-media-library.php';
require_once __DIR__ . '/../includes/class-iwsl-media-detail.php';

$MD_NOW = 1900000000000;
/** @param array<string,bool> $flags */
function md_ent( int $now, array $flags ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array_merge( array( 'plus' => true ), $flags ) );
	return new IWSL_Entitlements( $store, static function () use ( $now ): int {
		return $now;
	} );
}

$FULL = array( 'media_folders' => true, 'image_optimization' => true, 'cdn_rewrite' => true );

// ── 1. get_asset — full detail JOIN ────────────────────────────────────────────
$detail = new IWSL_Media_Detail( md_ent( $MD_NOW, $FULL ) );
$got    = $detail->get_asset( 7 );

iwsl_assert_same( false, $got['locked'], 'get: unlocked surface is not locked' );
iwsl_assert_same( true, $got['found'], 'get: existing attachment is found' );
$a = $got['asset'];
iwsl_assert_same( 7, $a['id'], 'get: id carried from fused row' );
iwsl_assert_same( 'Sunset', $a['title'], 'get: title from fused row' );
iwsl_assert_same( 'optimized', $a['optimization']['status'], 'get: fused optimization column present (single-source)' );
iwsl_assert_same( 'offloaded', $a['offload']['status'], 'get: fused offload column present' );
iwsl_assert_same( 'sunset over the sea', $a['alt'], 'get: alt text detail field' );
iwsl_assert_same( 'A caption', $a['caption'], 'get: caption = post_excerpt' );
iwsl_assert_same( 'A long description', $a['description'], 'get: description = post_content' );
iwsl_assert_same( 3, $a['uploader']['id'], 'get: uploader id' );
iwsl_assert_same( 'Ada Photographer', $a['uploader']['name'], 'get: uploader display name' );
iwsl_assert_same( '2026-01-02 03:04:05', $a['modified'], 'get: modified token = post_modified_gmt (concurrency)' );
iwsl_assert_same( 2, count( $a['sizes'] ), 'get: registered sub-sizes surfaced' );
iwsl_assert_same( 'Canon EOS', $a['exif']['camera'], 'get: EXIF camera from image_meta (no new scan)' );
iwsl_assert( ! array_key_exists( 'title', $a['exif'] ), 'get: non-whitelisted EXIF field dropped' );
iwsl_assert_same( true, $a['protected'], 'get: protected mark read from _iwsl_protected' );
iwsl_assert_same( true, $a['edit']['editable'], 'get: image is editable' );

// ── 2. locked + absent degenerate envelopes ────────────────────────────────────
$locked = new IWSL_Media_Detail( md_ent( $MD_NOW, array() ) );
$lres   = $locked->get_asset( 7 );
iwsl_assert_same( true, $lres['locked'], 'get: no-tier returns locked envelope' );
iwsl_assert( isset( $lres['gate'] ) && is_array( $lres['gate'] ), 'get: locked envelope carries gate reason' );

$absent = $detail->get_asset( 4242 );
iwsl_assert_same( false, $absent['locked'], 'get: absent id is not a lock' );
iwsl_assert_same( false, $absent['found'], 'get: absent attachment reported found:false' );
iwsl_assert_same( null, $absent['asset'], 'get: absent attachment carries no asset' );

// ── 3. update_meta — CONFLICT returns current values, writes nothing ───────────
$GLOBALS['md_post_updates'] = array();
$GLOBALS['md_meta_writes']  = array();
$conflict = $detail->update_meta( 7, 'STALE-TOKEN', array( 'caption' => 'new caption' ) );
iwsl_assert_same( false, (bool) ( $conflict['ok'] ?? false ), 'updateMeta: stale token refused (ok=false)' );
iwsl_assert_same( true, (bool) ( $conflict['conflict'] ?? false ), 'updateMeta: conflict flagged' );
iwsl_assert_same( 'A caption', $conflict['current']['caption'], 'updateMeta: conflict returns CURRENT caption verbatim' );
iwsl_assert_same( '2026-01-02 03:04:05', $conflict['current']['modified'], 'updateMeta: conflict returns current modified token' );
iwsl_assert_same( array(), $GLOBALS['md_post_updates'], 'updateMeta: conflict wrote NOTHING (no wp_update_post)' );
iwsl_assert_same( array(), $GLOBALS['md_meta_writes'], 'updateMeta: conflict wrote NOTHING (no update_post_meta)' );

// ── 4. update_meta — success sanitizes + only changed fields sent ──────────────
md_seed();
$GLOBALS['md_post_updates'] = array();
$GLOBALS['md_meta_writes']  = array();
$ok = $detail->update_meta( 7, '2026-01-02 03:04:05', array(
	'caption' => 'clean<script>alert(1)</script>tail',
	'alt'     => "  alt <b>bold</b>\nline  ",
) );
iwsl_assert_same( true, (bool) $ok['ok'], 'updateMeta: matching token accepted' );
iwsl_assert_same( '2026-01-02 09:09:09', $ok['asset']['modified'], 'updateMeta: success echoes the fresh modified token' );
$last_update = end( $GLOBALS['md_post_updates'] );
iwsl_assert_same( 'cleantail', $last_update['post_excerpt'], 'updateMeta: caption script stripped by wp_kses_post' );
iwsl_assert( ! array_key_exists( 'post_title', $last_update ), 'updateMeta: unchanged title NOT sent (only changed fields)' );
iwsl_assert( ! array_key_exists( 'post_content', $last_update ), 'updateMeta: unchanged description NOT sent' );
$alt_write = end( $GLOBALS['md_meta_writes'] );
iwsl_assert_same( 'alt bold line', $alt_write[2], 'updateMeta: alt sanitize_text_field (tags stripped, ws collapsed)' );

// ── 5. usage — bounded + capped ────────────────────────────────────────────────
$GLOBALS['md_usage_rows']['thumbnail'] = array(
	(object) array( 'ID' => 11, 'post_title' => 'Page A', 'post_type' => 'page', 'post_status' => 'publish' ),
	(object) array( 'ID' => 12, 'post_title' => 'Post B', 'post_type' => 'post', 'post_status' => 'publish' ),
);
$GLOBALS['md_usage_rows']['content'] = array(
	(object) array( 'ID' => 12, 'post_title' => 'Post B', 'post_type' => 'post', 'post_status' => 'publish' ), // dup id → deduped.
	(object) array( 'ID' => 13, 'post_title' => 'Post C', 'post_type' => 'post', 'post_status' => 'publish' ),
);
$usage = $detail->usage( 7, 1 );
iwsl_assert_same( false, $usage['locked'], 'usage: unlocked surface' );
iwsl_assert_same( 3, $usage['total'], 'usage: deduped references (11,12,13) — not 4' );
iwsl_assert_same( false, $usage['capped'], 'usage: small set not capped' );
iwsl_assert_same( 'https://site.test/?p=11', $usage['items'][0]['link'], 'usage: item carries permalink' );

$big = array();
for ( $i = 1; $i <= 250; $i++ ) {
	$big[] = (object) array( 'ID' => 1000 + $i, 'post_title' => 'P' . $i, 'post_type' => 'post', 'post_status' => 'publish' );
}
$GLOBALS['md_usage_rows']['thumbnail'] = $big;
$GLOBALS['md_usage_rows']['content']   = array();
$capped = $detail->usage( 7, 1 );
iwsl_assert_same( 200, $capped['total'], 'usage: scan window capped at USAGE_MAX_SCAN (200)' );
iwsl_assert_same( true, $capped['capped'], 'usage: capped flag set when window is full' );
iwsl_assert_same( 20, count( $capped['items'] ), 'usage: page size = USAGE_PER_PAGE (20)' );

// ── 6. delete — confirm fence + bucket-removed reporting ───────────────────────
md_seed();
$GLOBALS['md_deleted_att'] = array();
$noconfirm = $detail->delete( 7, false );
iwsl_assert_same( false, (bool) $noconfirm['ok'], 'delete: engine refuses without confirm' );
iwsl_assert_same( 'confirm-required', $noconfirm['reason'], 'delete: refusal reason is confirm-required' );
iwsl_assert_same( array(), $GLOBALS['md_deleted_att'], 'delete: NO attachment deleted without confirm' );

$del = $detail->delete( 7, true );
iwsl_assert_same( true, (bool) $del['ok'], 'delete: confirmed delete succeeds' );
iwsl_assert_same( true, $del['deleted'], 'delete: reports deleted' );
iwsl_assert_same( true, $del['bucket_removed'], 'delete: offloaded asset reports bucket_removed' );
iwsl_assert_same( array( 7 ), $GLOBALS['md_deleted_att'], 'delete: wp_delete_attachment(7,true) called exactly once' );

// ── 7. validators — exact keys, at-least-one-field, LITERAL confirm ────────────
$D = 'IWSL_Media_Detail';
iwsl_assert( $D::validate_get_params( (object) array( 'id' => 7 ) ), 'get validator: {id} accepted' );
iwsl_assert( ! $D::validate_get_params( (object) array( 'id' => 7, 'foo' => 1 ) ), 'get validator: stray key refused' );
iwsl_assert( ! $D::validate_get_params( (object) array( 'id' => 0 ) ), 'get validator: id < 1 refused' );

iwsl_assert( $D::validate_update_params( (object) array( 'id' => 7, 'expect_modified' => 't', 'alt' => 'x' ) ), 'update validator: {id,expect_modified,alt} accepted' );
iwsl_assert( ! $D::validate_update_params( (object) array( 'id' => 7, 'expect_modified' => 't' ) ), 'update validator: no editable field refused' );
iwsl_assert( ! $D::validate_update_params( (object) array( 'id' => 7, 'alt' => 'x' ) ), 'update validator: missing expect_modified refused' );
iwsl_assert( ! $D::validate_update_params( (object) array( 'id' => 7, 'expect_modified' => 't', 'alt' => str_repeat( 'a', 501 ) ) ), 'update validator: over-cap alt refused' );
iwsl_assert( ! $D::validate_update_params( (object) array( 'id' => 7, 'expect_modified' => 't', 'foo' => 'x' ) ), 'update validator: stray field refused' );

iwsl_assert( $D::validate_usage_params( (object) array( 'id' => 7 ) ), 'usage validator: {id} accepted' );
iwsl_assert( $D::validate_usage_params( (object) array( 'id' => 7, 'page' => 2 ) ), 'usage validator: {id,page} accepted' );
iwsl_assert( ! $D::validate_usage_params( (object) array( 'id' => 7, 'page' => 0 ) ), 'usage validator: page < 1 refused' );

iwsl_assert( $D::validate_delete_params( (object) array( 'id' => 7, 'confirm' => true ) ), 'delete validator: {id,confirm:true} accepted' );
iwsl_assert( ! $D::validate_delete_params( (object) array( 'id' => 7 ) ), 'delete validator: missing confirm refused' );
iwsl_assert( ! $D::validate_delete_params( (object) array( 'id' => 7, 'confirm' => false ) ), 'delete validator: confirm:false refused' );
iwsl_assert( ! $D::validate_delete_params( (object) array( 'id' => 7, 'confirm' => 1 ) ), 'delete validator: truthy 1 (not literal true) refused' );
iwsl_assert( ! $D::validate_delete_params( (object) array( 'id' => 7, 'confirm' => true, 'foo' => 1 ) ), 'delete validator: stray key refused' );

@unlink( $md_tmp );
