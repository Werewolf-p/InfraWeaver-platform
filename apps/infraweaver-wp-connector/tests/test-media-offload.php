<?php
/**
 * Media Offload to S3 / Hetzner Object Storage (gate flag `image_optimization` —
 * shared with the optimizer, since offload only ships its WebP derivatives):
 * the self-contained engine IWSL_Media_Offload.
 *
 * Runs under the zero-dependency harness. This suite defines its own guarded
 * postmeta stubs (backed by $GLOBALS['iwsl_mo_meta']) and injects a FAKE S3 client,
 * a canned derivative resolver, a fixed uploads base dir, and a candidate list — so
 * NO real optimizer, no filesystem writes, and NO network are exercised. It proves:
 * the qualify rule (optimized-marker + rule ON ⇒ qualifies; manual deny overrides;
 * manual allow works WITHOUT the marker), that the offload mapping is recorded ONLY
 * after a successful HEAD verify (and NEVER on a put/verify failure), that the three
 * URL-rewrite filters return the bucket URL for an offloaded id and the original for
 * a non-offloaded id, that unoffload deletes + clears, and that the S3 secret_key
 * NEVER appears in settings_for_render() or any rendered output.
 */

require_once __DIR__ . '/../includes/class-iwsl-s3-client.php';
require_once __DIR__ . '/../includes/class-iwsl-media-offload.php';

// ── suite-local WP stubs (guarded; child-process isolation makes this safe) ───────

$GLOBALS['iwsl_mo_meta'] = array();

if ( ! function_exists( 'get_post_meta' ) ) {
	function get_post_meta( int $post_id, string $key = '', bool $single = false ) {
		return $GLOBALS['iwsl_mo_meta'][ $post_id ][ $key ] ?? '';
	}
}
if ( ! function_exists( 'update_post_meta' ) ) {
	function update_post_meta( int $post_id, string $key, $value ): bool {
		$GLOBALS['iwsl_mo_meta'][ $post_id ][ $key ] = $value;
		return true;
	}
}
if ( ! function_exists( 'delete_post_meta' ) ) {
	function delete_post_meta( int $post_id, string $key ): bool {
		unset( $GLOBALS['iwsl_mo_meta'][ $post_id ][ $key ] );
		return true;
	}
}
// Original-file seams (scope='all'): the attachment's own file, mime, and public URL.
if ( ! function_exists( 'get_attached_file' ) ) {
	function get_attached_file( int $post_id ) {
		return $GLOBALS['iwsl_mo_files'][ $post_id ] ?? '';
	}
}
if ( ! function_exists( 'get_post_mime_type' ) ) {
	function get_post_mime_type( $post_id = 0 ) {
		return $GLOBALS['iwsl_mo_mimes'][ (int) $post_id ] ?? '';
	}
}
if ( ! function_exists( 'wp_get_attachment_url' ) ) {
	function wp_get_attachment_url( int $post_id ) {
		return $GLOBALS['iwsl_mo_urls'][ $post_id ] ?? '';
	}
}
// Uploads base URL + attachment metadata seams — used by the management row builder.
if ( ! function_exists( 'wp_upload_dir' ) ) {
	function wp_upload_dir() {
		return array( 'basedir' => $GLOBALS['iwsl_mo_up'] ?? '', 'baseurl' => 'https://site.test/wp-content/uploads' );
	}
}
if ( ! function_exists( 'wp_get_attachment_metadata' ) ) {
	function wp_get_attachment_metadata( $post_id = 0 ) {
		return $GLOBALS['iwsl_mo_attmeta'][ (int) $post_id ] ?? array();
	}
}

/**
 * A minimal WP_Query stub backing the management list. Reads image attachment records
 * from $GLOBALS['iwsl_mo_list'] (id => [mime,file,title]); applies the post_mime_type
 * filter ('image' ⇒ image/*, else exact), the status meta_query (EXISTS / NOT EXISTS on
 * the offload meta, checked against $GLOBALS['iwsl_mo_meta']), a free `s` filename/title
 * search, then paging. Exposes ->posts (ids) and ->found_posts (pre-paging total).
 */
if ( ! class_exists( 'WP_Query' ) ) {
	class WP_Query {
		/** @var int[] */ public $posts = array();
		/** @var int */   public $found_posts = 0;

		public function __construct( array $args = array() ) {
			$list    = $GLOBALS['iwsl_mo_list'] ?? array();
			$mime    = isset( $args['post_mime_type'] ) ? (string) $args['post_mime_type'] : 'image';
			$search  = isset( $args['s'] ) ? (string) $args['s'] : '';
			$meta    = ( isset( $args['meta_query'][0] ) && is_array( $args['meta_query'][0] ) ) ? $args['meta_query'][0] : null;
			$matched = array();
			foreach ( $list as $id => $rec ) {
				$rmime = (string) ( $rec['mime'] ?? '' );
				if ( 'image' === $mime ) {
					if ( 0 !== strpos( $rmime, 'image/' ) ) {
						continue;
					}
				} elseif ( $rmime !== $mime ) {
					continue;
				}
				if ( null !== $meta ) {
					$has     = isset( $GLOBALS['iwsl_mo_meta'][ (int) $id ][ IWSL_Media_Offload::OFFLOAD_META ] );
					$compare = (string) ( $meta['compare'] ?? 'EXISTS' );
					if ( 'EXISTS' === $compare && ! $has ) {
						continue;
					}
					if ( 'NOT EXISTS' === $compare && $has ) {
						continue;
					}
				}
				if ( '' !== $search ) {
					$hay = (string) ( $rec['file'] ?? '' ) . ' ' . (string) ( $rec['title'] ?? '' );
					if ( false === stripos( $hay, $search ) ) {
						continue;
					}
				}
				$matched[] = (int) $id;
			}
			$this->found_posts = count( $matched );
			$per   = (int) ( $args['posts_per_page'] ?? 10 );
			$paged = max( 1, (int) ( $args['paged'] ?? 1 ) );
			$this->posts = $per > 0 ? array_slice( $matched, ( $paged - 1 ) * $per, $per ) : $matched;
		}
	}
}

// ── a fake S3 client (records every call; returns configurable results) ───────────

final class IWSL_MO_Fake_S3 {

	/** @var array<int,array> */
	public $puts = array();
	/** @var string[] */
	public $heads = array();
	/** @var string[] */
	public $deletes = array();
	/** @var array<int,array> every presigned_get_url call (key + expires). */
	public $presigns = array();
	/** @var string the acl the engine configured for this client (captured by the factory). */
	public $acl = '';

	public $put_ok      = true;
	public $head_ok     = true;
	public $head_exists = true;
	public $delete_ok   = true;
	public $etag        = 'deadbeef';

	public function put_object( string $key, string $body, string $content_type = 'application/octet-stream' ): array {
		$this->puts[] = array( 'key' => $key, 'content_type' => $content_type, 'bytes' => strlen( $body ) );
		return array( 'ok' => $this->put_ok, 'status' => $this->put_ok ? 200 : 500, 'etag' => $this->etag );
	}

	public function head_object( string $key ): array {
		$this->heads[] = $key;
		return array( 'ok' => $this->head_ok, 'exists' => $this->head_exists, 'status' => 200, 'etag' => $this->etag );
	}

	public function delete_object( string $key ): array {
		$this->deletes[] = $key;
		return array( 'ok' => $this->delete_ok, 'status' => 204 );
	}

	public function public_url( string $key ): string {
		return 'https://my-bucket.fsn1.your-objectstorage.com/' . $key;
	}

	public function presigned_get_url( string $key, int $expires = 3600 ): string {
		$this->presigns[] = array( 'key' => $key, 'expires' => $expires );
		return 'https://my-bucket.fsn1.your-objectstorage.com/' . $key
			. '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=' . $expires
			. '&X-Amz-Signature=' . str_repeat( 'a', 64 );
	}

	public function test_connection( ?string $probe_key = null ): array {
		return array( 'ok' => true, 'steps' => array() );
	}
}

// ── fixtures ──────────────────────────────────────────────────────────────────────

$MO_NOW = 1900000000;

// A real temp uploads root so the engine's actual read_file() + key derivation run
// against real bytes on disk (no file-read seam needed). Cleaned up at suite end.
$GLOBALS['iwsl_mo_up'] = sys_get_temp_dir() . '/iwsl-mo-' . getmypid();
@mkdir( $GLOBALS['iwsl_mo_up'], 0777, true );

/** Unlocked gate: active + fresh heartbeat + image_optimization flag. */
function iwsl_mo_unlocked( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array( 'plus' => true, 'image_optimization' => true ) );
	return new IWSL_Entitlements( $store, static function () use ( $now ): int {
		return $now;
	} );
}

/** A gate with an explicit state / flag set (for the blocked/locked cases). */
function iwsl_mo_gate( int $now, string $state, array $flags ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', $flags );
	return new IWSL_Entitlements( $store, static function () use ( $now ): int {
		return $now;
	} );
}

/** The canned derivative descriptor for id N; writes a REAL file when it exists. */
function iwsl_mo_derivative( int $id ): array {
	$exists = $GLOBALS['iwsl_mo_deriv_exists'][ $id ] ?? true;
	$path   = $GLOBALS['iwsl_mo_up'] . '/2024/05/photo' . $id . '.webp';
	if ( $exists ) {
		@mkdir( dirname( $path ), 0777, true );
		if ( ! is_file( $path ) ) {
			file_put_contents( $path, 'RIFF-fake-webp-bytes-' . $id );
		}
	}
	return array( 'path' => $path, 'url' => 'https://site.test/wp-content/uploads/2024/05/photo' . $id . '.webp', 'exists' => (bool) $exists );
}

/**
 * Build an offload engine over $store with the fake S3 client + injected seams. An optional
 * $http_get seam feeds the bring-back-to-disk download (default null ⇒ engine's own default,
 * never hit because those tests always inject one).
 */
function iwsl_mo_engine( IWSL_Store $store, int $now, IWSL_Entitlements $ent, IWSL_MO_Fake_S3 $fake, ?callable $http_get = null ): IWSL_Media_Offload {
	return new IWSL_Media_Offload(
		$ent,
		$store,
		static function () use ( $now ): int {
			return $now;
		},
		static function (): string {
			return 'iwsl-test-salt-material-000000000000000000000000';
		},
		static function ( array $config ) use ( $fake ): object {
			$fake->acl = isset( $config['acl'] ) ? (string) $config['acl'] : '';
			return $fake;
		},
		static function ( int $id ): array {
			return iwsl_mo_derivative( $id );
		},
		static function (): string {
			return $GLOBALS['iwsl_mo_up'];
		},
		static function ( int $limit ): array {
			return $GLOBALS['iwsl_mo_candidates'] ?? array();
		},
		$http_get
	);
}

/** Register an image attachment for the WP_Query-backed management list (writes a real file). */
function iwsl_mo_list_add( int $id, string $mime, string $rel, string $title = '' ): void {
	$path = $GLOBALS['iwsl_mo_up'] . '/' . $rel;
	@mkdir( dirname( $path ), 0777, true );
	if ( ! is_file( $path ) ) {
		file_put_contents( $path, 'list-bytes-' . $id );
	}
	$GLOBALS['iwsl_mo_files'][ $id ] = $path;
	$GLOBALS['iwsl_mo_mimes'][ $id ] = $mime;
	$GLOBALS['iwsl_mo_list'][ $id ]  = array( 'mime' => $mime, 'file' => $rel, 'title' => $title );
}

/** Seed a stored offload mapping directly (bypasses a live PUT) for list/bring-back setups. */
function iwsl_mo_seed_offload( int $id, string $key, string $variant = 'original', string $src_url = '' ): void {
	$GLOBALS['iwsl_mo_meta'][ $id ][ IWSL_Media_Offload::OFFLOAD_META ] = array(
		'key'     => $key,
		'url'     => 'https://my-bucket.fsn1.your-objectstorage.com/' . $key,
		'etag'    => 'seed-etag',
		'ts'      => 1,
		'variant' => $variant,
		'src_url' => $src_url,
	);
}

/** Mark attachment id as optimized (carries the optimizer META_KEY). */
function iwsl_mo_mark_optimized( int $id ): void {
	$GLOBALS['iwsl_mo_meta'][ $id ][ IWSL_Media_Optimizer::META_KEY ] = array( 'ok' => true );
}

/**
 * Seed an attachment with NO optimizer derivative but a REAL original file on disk
 * (under the temp uploads root) plus its mime + public URL — the scope='all' case.
 */
function iwsl_mo_make_original( int $id, string $mime, string $rel ): void {
	$path = $GLOBALS['iwsl_mo_up'] . '/' . $rel;
	@mkdir( dirname( $path ), 0777, true );
	if ( ! is_file( $path ) ) {
		file_put_contents( $path, 'ORIGINAL-image-bytes-' . $id );
	}
	$GLOBALS['iwsl_mo_files'][ $id ]        = $path;
	$GLOBALS['iwsl_mo_mimes'][ $id ]        = $mime;
	$GLOBALS['iwsl_mo_urls'][ $id ]         = 'https://site.test/wp-content/uploads/' . $rel;
	$GLOBALS['iwsl_mo_deriv_exists'][ $id ] = false; // no optimizer-produced derivative.
}

// Reset per-run globals.
$GLOBALS['iwsl_mo_meta']         = array();
$GLOBALS['iwsl_mo_deriv_exists'] = array();
$GLOBALS['iwsl_mo_candidates']   = array();
$GLOBALS['iwsl_mo_files']        = array();
$GLOBALS['iwsl_mo_mimes']        = array();
$GLOBALS['iwsl_mo_urls']         = array();
$GLOBALS['iwsl_mo_list']         = array();
$GLOBALS['iwsl_mo_attmeta']      = array();

// ── 1. Qualify rule: optimized + rule ON ⇒ yes; deny overrides; allow w/o marker ──

$store1 = new IWSL_Memory_Store();
$ent1   = iwsl_mo_unlocked( $MO_NOW );
$eng1   = iwsl_mo_engine( $store1, $MO_NOW, $ent1, new IWSL_MO_Fake_S3() );

// Rule ON.
$eng1->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true ) );

iwsl_mo_mark_optimized( 101 );
iwsl_assert_same( true, $eng1->qualifies( 101 ), 'qualify: optimized marker + rule ON ⇒ qualifies' );

iwsl_mo_mark_optimized( 105 ); // optimized but will be manual-denied below.
$eng1->set_manual( 105, 'deny' );
iwsl_assert_same( false, $eng1->qualifies( 105 ), 'qualify: manual DENY overrides the rule' );

$eng1->set_manual( 110, 'allow' ); // NOT optimized, but manually allowed.
iwsl_assert_same( true, $eng1->qualifies( 110 ), 'qualify: manual ALLOW works WITHOUT the optimized marker' );

iwsl_assert_same( false, $eng1->qualifies( 999 ), 'qualify: unmarked + no override ⇒ does NOT qualify' );

// Rule OFF ⇒ an optimized image no longer qualifies on the rule alone.
$eng1->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => '', 'enabled' => true, 'rule_all' => false ) );
iwsl_assert_same( false, $eng1->qualifies( 101 ), 'qualify: rule OFF ⇒ optimized image does not qualify on the rule' );
iwsl_assert_same( true, $eng1->qualifies( 110 ), 'qualify: rule OFF ⇒ manual ALLOW still qualifies' );

// ── 2. offload_one records the mapping ONLY after a HEAD-verify success ───────────

// (a) happy path: put ok + head ok/exists ⇒ mapping recorded.
$GLOBALS['iwsl_mo_meta'] = array();
$store2 = new IWSL_Memory_Store();
$fake2  = new IWSL_MO_Fake_S3();
$eng2   = iwsl_mo_engine( $store2, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake2 );
$eng2->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true ) );
iwsl_mo_mark_optimized( 201 );

$r2 = $eng2->offload_one( 201 );
iwsl_assert_same( true, $r2['ok'], 'offload: happy path ok=true' );
iwsl_assert_same( '2024/05/photo201.webp', $r2['key'], 'offload: key mirrors the uploads-relative path with .webp' );
iwsl_assert_same( 1, count( $fake2->puts ), 'offload: exactly one PUT' );
iwsl_assert_same( 'image/webp', $fake2->puts[0]['content_type'], 'offload: PUT content-type is image/webp' );
iwsl_assert_same( 1, count( $fake2->heads ), 'offload: HEAD-verify was performed' );
iwsl_assert_same( true, $eng2->is_offloaded( 201 ), 'offload: mapping recorded after verify' );
$m2 = $eng2->offload_meta( 201 );
iwsl_assert_same( '2024/05/photo201.webp', $m2['key'], 'offload: mapping key stored' );
iwsl_assert_same( 'https://my-bucket.fsn1.your-objectstorage.com/2024/05/photo201.webp', $m2['url'], 'offload: mapping public_url stored' );
iwsl_assert_same( 'deadbeef', $m2['etag'], 'offload: mapping etag stored' );
iwsl_assert_same( $MO_NOW, $m2['ts'], 'offload: mapping timestamp stored' );

// (b) put FAILURE ⇒ NO mapping, no HEAD.
$GLOBALS['iwsl_mo_meta'] = array();
$store2b = new IWSL_Memory_Store();
$fake2b  = new IWSL_MO_Fake_S3();
$fake2b->put_ok = false;
$eng2b   = iwsl_mo_engine( $store2b, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake2b );
$eng2b->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true ) );
iwsl_mo_mark_optimized( 202 );
$r2b = $eng2b->offload_one( 202 );
iwsl_assert_same( false, $r2b['ok'], 'offload(put-fail): ok=false' );
iwsl_assert_same( 'put-failed', $r2b['reason'], 'offload(put-fail): reason=put-failed' );
iwsl_assert_same( 0, count( $fake2b->heads ), 'offload(put-fail): NO HEAD attempted after a failed PUT' );
iwsl_assert_same( false, $eng2b->is_offloaded( 202 ), 'offload(put-fail): mapping NOT recorded (left for retry)' );

// (c) HEAD-verify FAILURE (object not found) ⇒ NO mapping.
$GLOBALS['iwsl_mo_meta'] = array();
$store2c = new IWSL_Memory_Store();
$fake2c  = new IWSL_MO_Fake_S3();
$fake2c->head_exists = false;
$eng2c   = iwsl_mo_engine( $store2c, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake2c );
$eng2c->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true ) );
iwsl_mo_mark_optimized( 203 );
$r2c = $eng2c->offload_one( 203 );
iwsl_assert_same( false, $r2c['ok'], 'offload(verify-fail): ok=false' );
iwsl_assert_same( 'verify-failed', $r2c['reason'], 'offload(verify-fail): reason=verify-failed' );
iwsl_assert_same( false, $eng2c->is_offloaded( 203 ), 'offload(verify-fail): mapping NOT recorded' );

// (d) derivative missing ⇒ refused, nothing uploaded.
$GLOBALS['iwsl_mo_meta']            = array();
$GLOBALS['iwsl_mo_deriv_exists'][204] = false;
$store2d = new IWSL_Memory_Store();
$fake2d  = new IWSL_MO_Fake_S3();
$eng2d   = iwsl_mo_engine( $store2d, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake2d );
$eng2d->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true ) );
iwsl_mo_mark_optimized( 204 );
$r2d = $eng2d->offload_one( 204 );
iwsl_assert_same( 'no-derivative', $r2d['reason'], 'offload(no-derivative): refused' );
iwsl_assert_same( 0, count( $fake2d->puts ), 'offload(no-derivative): nothing PUT' );
$GLOBALS['iwsl_mo_deriv_exists'] = array();

// ── 3. URL-rewrite filters: bucket URL for offloaded, original for non-offloaded ──

$GLOBALS['iwsl_mo_meta'] = array();
$store3 = new IWSL_Memory_Store();
$fake3  = new IWSL_MO_Fake_S3();
$eng3   = iwsl_mo_engine( $store3, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake3 );
$eng3->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true ) );
iwsl_mo_mark_optimized( 301 );
$eng3->offload_one( 301 ); // 301 becomes offloaded.

$bucket_url = 'https://my-bucket.fsn1.your-objectstorage.com/2024/05/photo301.webp';
$orig_url   = 'https://site.test/wp-content/uploads/2024/05/photo301.webp';

// wp_get_attachment_url.
iwsl_assert_same( $bucket_url, $eng3->filter_attachment_url( $orig_url, 301 ), 'rewrite(url): offloaded id ⇒ bucket URL' );
iwsl_assert_same( 'https://site.test/other.jpg', $eng3->filter_attachment_url( 'https://site.test/other.jpg', 302 ), 'rewrite(url): non-offloaded id ⇒ original URL untouched' );

// wp_get_attachment_image_src.
$src_in  = array( $orig_url, 800, 600, false );
$src_out = $eng3->filter_image_src( $src_in, 301, 'full', false );
iwsl_assert_same( $bucket_url, $src_out[0], 'rewrite(src): offloaded id ⇒ src[0] is the bucket URL' );
iwsl_assert_same( 600, $src_out[2], 'rewrite(src): dimensions preserved' );
$src_keep = $eng3->filter_image_src( $src_in, 302, 'full', false );
iwsl_assert_same( $orig_url, $src_keep[0], 'rewrite(src): non-offloaded id ⇒ src untouched' );

// wp_calculate_image_srcset.
$sources_in = array(
	800 => array( 'url' => $orig_url, 'descriptor' => 'w', 'value' => 800 ),
	400 => array( 'url' => 'https://site.test/wp-content/uploads/2024/05/photo301-400.webp', 'descriptor' => 'w', 'value' => 400 ),
);
$sources_out = $eng3->filter_srcset( $sources_in, array( 800, 600 ), $orig_url, array(), 301 );
iwsl_assert_same( $bucket_url, $sources_out[800]['url'], 'rewrite(srcset): offloaded id ⇒ each source URL is the bucket URL' );
iwsl_assert_same( $bucket_url, $sources_out[400]['url'], 'rewrite(srcset): every srcset entry points at the bucket object' );
$sources_keep = $eng3->filter_srcset( $sources_in, array( 800, 600 ), $orig_url, array(), 302 );
iwsl_assert_same( $orig_url, $sources_keep[800]['url'], 'rewrite(srcset): non-offloaded id ⇒ srcset untouched' );

// Locked gate ⇒ filters return the original even for an offloaded id.
$eng3_locked = iwsl_mo_engine( $store3, $MO_NOW, iwsl_mo_gate( $MO_NOW, 'active', array() ), $fake3 );
iwsl_assert_same( $orig_url, $eng3_locked->filter_attachment_url( $orig_url, 301 ), 'rewrite(locked): a locked site serves the original URL' );

// ── 4. Unoffload deletes the object + clears the mapping (local files kept) ───────

$GLOBALS['iwsl_mo_meta'] = array();
$store4 = new IWSL_Memory_Store();
$fake4  = new IWSL_MO_Fake_S3();
$eng4   = iwsl_mo_engine( $store4, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake4 );
$eng4->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true ) );
iwsl_mo_mark_optimized( 401 );
$eng4->offload_one( 401 );
iwsl_assert_same( true, $eng4->is_offloaded( 401 ), 'unoffload: precondition — 401 is offloaded' );

$r4 = $eng4->unoffload_one( 401 );
iwsl_assert_same( true, $r4['ok'], 'unoffload: ok=true' );
iwsl_assert_same( array( '2024/05/photo401.webp' ), $fake4->deletes, 'unoffload: DELETE called with the stored key' );
iwsl_assert_same( false, $eng4->is_offloaded( 401 ), 'unoffload: mapping meta cleared' );
// The optimized marker (a local-file concern) is untouched — nothing local is removed.
iwsl_assert_same( true, $eng4->is_optimized( 401 ), 'unoffload: local optimized marker preserved (no local deletion)' );

$r4b = $eng4->unoffload_one( 401 ); // idempotent.
iwsl_assert_same( 'not-offloaded', $r4b['reason'], 'unoffload: second call is a safe no-op' );

// ── 5. Locked mutators refuse (three-layer gate) ──────────────────────────────────

$store5 = new IWSL_Memory_Store();
$eng5   = iwsl_mo_engine( $store5, $MO_NOW, iwsl_mo_gate( $MO_NOW, 'active', array() ), new IWSL_MO_Fake_S3() );
iwsl_assert_same( 'entitlement-locked', $eng5->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'x' ) )['reason'], 'locked: save_settings refused' );
iwsl_assert_same( 'entitlement-locked', $eng5->offload_one( 501 )['reason'], 'locked: offload_one refused' );
iwsl_assert_same( 'entitlement-locked', $eng5->test_connection()['reason'], 'locked: test_connection refused' );

// Validation: bad location / bucket / access key are rejected.
iwsl_assert_same( 'bad-location', $eng1->save_settings( array( 'location' => 'zzz9', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890' ) )['reason'], 'validate: bad location rejected' );
iwsl_assert_same( 'bad-bucket', $eng1->save_settings( array( 'location' => 'fsn1', 'bucket' => 'A_B', 'access_key' => 'AK1234567890' ) )['reason'], 'validate: bad bucket rejected' );
iwsl_assert_same( 'bad-access-key', $eng1->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'no!' ) )['reason'], 'validate: bad access key rejected' );

// test_connection with no secret ⇒ incomplete-config (never a fatal).
$store5b = new IWSL_Memory_Store();
$eng5b   = iwsl_mo_engine( $store5b, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), new IWSL_MO_Fake_S3() );
$eng5b->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => '', 'enabled' => false, 'rule_all' => false ) );
iwsl_assert_same( 'incomplete-config', $eng5b->test_connection()['reason'], 'test_connection: no secret ⇒ incomplete-config' );

// ── 6. The secret_key NEVER leaks (settings_for_render / rendered output) ─────────

$SECRET = 'TOPSECRET-hetzner-key-abc123XYZ';
$store6 = new IWSL_Memory_Store();
$eng6   = iwsl_mo_engine( $store6, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), new IWSL_MO_Fake_S3() );
$sv6    = $eng6->save_settings( array( 'location' => 'nbg1', 'bucket' => 'secret-bucket', 'access_key' => 'AKSECRET0001', 'secret_key' => $SECRET, 'enabled' => true, 'rule_all' => true ) );
iwsl_assert_same( true, $sv6['ok'], 'secret: save ok' );

$view6 = $eng6->settings_for_render();
iwsl_assert_same( false, array_key_exists( 'secret', $view6 ), 'secret: settings_for_render() has NO secret key' );
iwsl_assert_same( true, $view6['has_secret'], 'secret: settings_for_render() reports has_secret=true' );
iwsl_assert( false === strpos( var_export( $view6, true ), $SECRET ), 'secret: plaintext secret absent from the render view' );

// The stored secret is ENCRYPTED at rest (marker present, plaintext absent).
$stored6 = $eng6->settings()['secret'];
iwsl_assert( 0 === strpos( $stored6, IWSL_Media_Offload::ENC_MARKER ), 'secret: stored value is AES-256-GCM encrypted (marker present)' );
iwsl_assert( false === strpos( $stored6, $SECRET ), 'secret: stored value does NOT contain the plaintext' );

// Rendered admin output never contains the secret.
$GLOBALS['iwsl_mo_candidates'] = array();
ob_start();
$eng6->render_section();
$html6 = ob_get_clean();
iwsl_assert( false !== strpos( $html6, 'Media Offload (S3)' ), 'render: heading present' );
iwsl_assert( false !== strpos( $html6, IWSL_Media_Offload::ACTION_SAVE ), 'render: the save form is wired' );
iwsl_assert( false !== strpos( $html6, 'Falkenstein (fsn1)' ), 'render: the Hetzner location dropdown is rendered' );
iwsl_assert( false === strpos( $html6, $SECRET ), 'render: the secret is NEVER echoed into the page' );

// Locked render shows the notice + gate reason, no form.
$eng6_locked = iwsl_mo_engine( new IWSL_Memory_Store(), $MO_NOW, iwsl_mo_gate( $MO_NOW, 'active', array() ), new IWSL_MO_Fake_S3() );
ob_start();
$eng6_locked->render_section();
$html6b = ob_get_clean();
iwsl_assert( false !== strpos( $html6b, 'locked' ), 'render(locked): shows the locked notice' );
iwsl_assert( false !== strpos( $html6b, 'requires-plus' ), 'render(locked): lists the gate reason' );

// ── 7. Manual override map: set + clear round-trip ────────────────────────────────

$store7 = new IWSL_Memory_Store();
$eng7   = iwsl_mo_engine( $store7, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), new IWSL_MO_Fake_S3() );
$eng7->set_manual( 701, 'deny' );
iwsl_assert_same( 'deny', $eng7->manual_map()[701], 'manual: deny stored' );
$eng7->set_manual( 701, 'clear' );
iwsl_assert_same( false, isset( $eng7->manual_map()[701] ), 'manual: clear removes the override' );
iwsl_assert_same( 'bad-mode', $eng7->set_manual( 701, 'bogus' )['reason'], 'manual: an unknown mode is rejected' );

// ── 8. Private access: the three rewrite filters mint presigned URLs ──────────────

$GLOBALS['iwsl_mo_meta'] = array();
$store8 = new IWSL_Memory_Store();
$fake8  = new IWSL_MO_Fake_S3();
$eng8   = iwsl_mo_engine( $store8, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake8 );
$eng8->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true, 'access' => 'private', 'private_url_ttl' => 1800 ) );
iwsl_mo_mark_optimized( 801 );

$r8 = $eng8->offload_one( 801 );
iwsl_assert_same( true, $r8['ok'], 'private: offload happy path succeeds' );
// A PRIVATE offload PUTs the object with acl='private' (captured via the factory).
iwsl_assert_same( 'private', $fake8->acl, 'private: the offload PUT uses acl=private' );

$orig8 = 'https://site.test/wp-content/uploads/2024/05/photo801.webp';

$u8 = $eng8->filter_attachment_url( $orig8, 801 );
iwsl_assert( false !== strpos( $u8, 'X-Amz-Signature=' ), 'private rewrite(url): returns a presigned URL (has X-Amz-Signature)' );
iwsl_assert( false !== strpos( $u8, '2024/05/photo801.webp' ), 'private rewrite(url): presigns the stored offload key' );

$src8 = $eng8->filter_image_src( array( $orig8, 800, 600, false ), 801, 'full', false );
iwsl_assert( false !== strpos( (string) $src8[0], 'X-Amz-Signature=' ), 'private rewrite(src): src[0] is a presigned URL' );

$sources8 = array( 800 => array( 'url' => $orig8, 'descriptor' => 'w', 'value' => 800 ) );
$out8     = $eng8->filter_srcset( $sources8, array( 800, 600 ), $orig8, array(), 801 );
iwsl_assert( false !== strpos( (string) $out8[800]['url'], 'X-Amz-Signature=' ), 'private rewrite(srcset): each source is a presigned URL' );

// The configured TTL is forwarded to the presigner (never persisted in meta).
$last8 = $fake8->presigns[ count( $fake8->presigns ) - 1 ];
iwsl_assert_same( 1800, $last8['expires'], 'private rewrite: the saved TTL is passed to presigned_get_url' );
iwsl_assert_same( '2024/05/photo801.webp', $last8['key'], 'private rewrite: presigns the stored key, not a persisted URL' );
// The stored meta URL is the plain public URL — the presigned URL is NEVER persisted.
iwsl_assert( false === strpos( $eng8->offload_meta( 801 )['url'], 'X-Amz-Signature=' ), 'private: no presigned URL is written to meta' );

// ── 9. Public access: rewrite returns the plain public URL (no signature) ─────────

$GLOBALS['iwsl_mo_meta'] = array();
$store9 = new IWSL_Memory_Store();
$fake9  = new IWSL_MO_Fake_S3();
$eng9   = iwsl_mo_engine( $store9, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake9 );
$eng9->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true, 'access' => 'public' ) );
iwsl_mo_mark_optimized( 901 );
$eng9->offload_one( 901 );

iwsl_assert_same( 'public-read', $fake9->acl, 'public: the offload PUT uses acl=public-read' );
$u9 = $eng9->filter_attachment_url( 'https://site.test/wp-content/uploads/2024/05/photo901.webp', 901 );
iwsl_assert_same( 'https://my-bucket.fsn1.your-objectstorage.com/2024/05/photo901.webp', $u9, 'public: rewrite returns the plain public bucket URL' );
iwsl_assert( false === strpos( $u9, 'X-Amz-Signature=' ), 'public: no signature appears in the public URL' );
iwsl_assert_same( 0, count( $fake9->presigns ), 'public: presigned_get_url is never called for public access' );

// ── 10. access/ttl settings: exposed to render (never the secret) + TTL clamping ──

$store10  = new IWSL_Memory_Store();
$eng10    = iwsl_mo_engine( $store10, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), new IWSL_MO_Fake_S3() );
$SECRET10 = 'TTL-secret-should-not-leak-777';
$eng10->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => $SECRET10, 'enabled' => true, 'rule_all' => true, 'access' => 'private', 'private_url_ttl' => 3600 ) );

$v10 = $eng10->settings_for_render();
iwsl_assert_same( 'private', $v10['access'], 'settings_for_render: access mode is exposed' );
iwsl_assert_same( 3600, $v10['private_url_ttl'], 'settings_for_render: private_url_ttl is exposed' );
iwsl_assert_same( false, array_key_exists( 'secret', $v10 ), 'settings_for_render: still carries NO secret key' );
iwsl_assert( false === strpos( var_export( $v10, true ), $SECRET10 ), 'settings_for_render: the secret plaintext is absent' );

// TTL clamping: below 300 ⇒ 300; above 604800 ⇒ 604800.
$eng10->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => '', 'access' => 'private', 'private_url_ttl' => 5 ) );
iwsl_assert_same( 300, $eng10->settings()['private_url_ttl'], 'ttl: a below-min lifetime clamps up to 300 (5 minutes)' );
$eng10->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => '', 'access' => 'private', 'private_url_ttl' => 99999999 ) );
iwsl_assert_same( 604800, $eng10->settings()['private_url_ttl'], 'ttl: an above-max lifetime clamps down to 604800 (7 days)' );

// Defaults: access is public; TTL is 86400 (one day).
$store10b = new IWSL_Memory_Store();
$eng10b   = iwsl_mo_engine( $store10b, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), new IWSL_MO_Fake_S3() );
iwsl_assert_same( 'public', $eng10b->settings()['access'], 'default: access mode is public' );
iwsl_assert_same( 86400, $eng10b->settings()['private_url_ttl'], 'default: private_url_ttl is 86400 (1 day)' );

// A private render surfaces the Bucket-access control, the TTL field, and the cache warning.
$GLOBALS['iwsl_mo_candidates'] = array();
$store10c = new IWSL_Memory_Store();
$eng10c   = iwsl_mo_engine( $store10c, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), new IWSL_MO_Fake_S3() );
$eng10c->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'zzz', 'access' => 'private', 'private_url_ttl' => 3600 ) );
ob_start();
$eng10c->render_section();
$html10 = ob_get_clean();
iwsl_assert( false !== strpos( $html10, 'Bucket access' ), 'render: the Bucket access control is present' );
iwsl_assert( false !== strpos( $html10, 'private_url_ttl' ), 'render: the signed-link lifetime field is present' );
iwsl_assert( false !== strpos( $html10, '403' ), 'render: the page-cache 403 warning is present' );

// ── 11. Buckets AJAX: per-location aggregation + owner + stored-secret fallback ────
// A fake S3 client that ONLY answers list_buckets() with a canned per-location result.

final class IWSL_MO_Fake_Lister {

	/** @var bool */    private $ok;
	/** @var string[] */ private $names;
	/** @var string */  private $owner;
	/** @var string */  private $error;

	public function __construct( bool $ok, array $names, string $owner, string $error ) {
		$this->ok    = $ok;
		$this->names = $names;
		$this->owner = $owner;
		$this->error = $error;
	}

	public function list_buckets(): array {
		return array(
			'ok'      => $this->ok,
			'buckets' => $this->names,
			'owner'   => $this->owner,
			'status'  => $this->ok ? 200 : 403,
			'error'   => $this->error,
		);
	}
}

/**
 * An offload engine whose s3 factory returns a per-location IWSL_MO_Fake_Lister from
 * $map (keyed by region) and records every secret_key it is handed (into
 * $GLOBALS['iwsl_mo_seen_secrets']) so the stored-secret fallback can be proven.
 */
function iwsl_mo_lister_engine( IWSL_Store $store, int $now, IWSL_Entitlements $ent, array $map ): IWSL_Media_Offload {
	return new IWSL_Media_Offload(
		$ent,
		$store,
		static function () use ( $now ): int {
			return $now;
		},
		static function (): string {
			return 'iwsl-test-salt-material-000000000000000000000000';
		},
		static function ( array $config ) use ( $map ): object {
			$GLOBALS['iwsl_mo_seen_secrets'][] = isset( $config['secret_key'] ) ? (string) $config['secret_key'] : '';
			$region = isset( $config['region'] ) ? (string) $config['region'] : '';
			$c      = $map[ $region ] ?? array( 'ok' => false, 'names' => array(), 'owner' => '', 'error' => 'http-403' );
			return new IWSL_MO_Fake_Lister( (bool) $c['ok'], $c['names'], (string) $c['owner'], (string) $c['error'] );
		},
		static function ( int $id ): array {
			return iwsl_mo_derivative( $id );
		},
		static function (): string {
			return $GLOBALS['iwsl_mo_up'];
		},
		static function ( int $limit ): array {
			return $GLOBALS['iwsl_mo_candidates'] ?? array();
		}
	);
}

$GLOBALS['iwsl_mo_seen_secrets'] = array();
$MO_BUCKETS = array(
	'fsn1' => array( 'ok' => true, 'names' => array( 'fsn-alpha', 'fsn-beta' ), 'owner' => 'proj-owner-9', 'error' => '' ),
	'nbg1' => array( 'ok' => true, 'names' => array( 'rlservers' ), 'owner' => 'proj-owner-9', 'error' => '' ),
	'hel1' => array( 'ok' => true, 'names' => array(), 'owner' => 'proj-owner-9', 'error' => '' ),
);

$store11        = new IWSL_Memory_Store();
$eng11          = iwsl_mo_lister_engine( $store11, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $MO_BUCKETS );
$MO_STORED_SEC  = 'stored-hetzner-secret-ABC/xyz+9';
$eng11->save_settings( array( 'location' => 'nbg1', 'bucket' => 'rlservers', 'access_key' => 'AK1234567890', 'secret_key' => $MO_STORED_SEC, 'enabled' => true, 'rule_all' => true ) );

// (a) entered creds ⇒ aggregation grouped by location, with the owner carried through.
$GLOBALS['iwsl_mo_seen_secrets'] = array();
$lb11 = $eng11->list_buckets( 'AK1234567890', 'entered-secret-value-123' );
iwsl_assert_same( true, $lb11['ok'], 'buckets: ok when at least one location lists' );
iwsl_assert_same( 'proj-owner-9', $lb11['owner'], 'buckets: owner id carried from the listing' );
iwsl_assert_same( array( 'fsn-alpha', 'fsn-beta' ), $lb11['locations']['fsn1'], 'buckets: fsn1 group carries its names' );
iwsl_assert_same( array( 'rlservers' ), $lb11['locations']['nbg1'], 'buckets: nbg1 group carries its names' );
iwsl_assert_same( array(), $lb11['locations']['hel1'], 'buckets: hel1 group is empty (no buckets there)' );
iwsl_assert_same(
	true,
	array_key_exists( 'fsn1', $lb11['locations'] ) && array_key_exists( 'nbg1', $lb11['locations'] ) && array_key_exists( 'hel1', $lb11['locations'] ),
	'buckets: all three Hetzner locations are present in the grouping'
);
iwsl_assert( in_array( 'entered-secret-value-123', $GLOBALS['iwsl_mo_seen_secrets'], true ), 'buckets: the ENTERED secret is used when one is provided' );

// (b) an EMPTY POST secret falls back to the stored, decrypted secret.
$GLOBALS['iwsl_mo_seen_secrets'] = array();
$lb11b = $eng11->list_buckets( 'AK1234567890', '' );
iwsl_assert_same( true, $lb11b['ok'], 'buckets(fallback): ok using the stored secret' );
iwsl_assert( in_array( $MO_STORED_SEC, $GLOBALS['iwsl_mo_seen_secrets'], true ), 'buckets(fallback): empty POST secret falls back to the stored decrypted secret' );
iwsl_assert( ! in_array( '', $GLOBALS['iwsl_mo_seen_secrets'], true ), 'buckets(fallback): no location was queried with an empty secret' );

// (c) the secret NEVER appears in the response.
iwsl_assert( false === strpos( (string) json_encode( $lb11b ), $MO_STORED_SEC ), 'buckets: the secret NEVER appears in the AJAX response' );
iwsl_assert_same( false, array_key_exists( 'secret', $lb11b ), 'buckets: the response carries no secret key' );

// (d) ALL locations failing on auth ⇒ ok:false with a friendly reason.
$MO_BUCKETS_FAIL = array(
	'fsn1' => array( 'ok' => false, 'names' => array(), 'owner' => '', 'error' => 'InvalidAccessKeyId' ),
	'nbg1' => array( 'ok' => false, 'names' => array(), 'owner' => '', 'error' => 'SignatureDoesNotMatch' ),
	'hel1' => array( 'ok' => false, 'names' => array(), 'owner' => '', 'error' => 'http-403' ),
);
$eng11c = iwsl_mo_lister_engine( new IWSL_Memory_Store(), $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $MO_BUCKETS_FAIL );
$lb11c  = $eng11c->list_buckets( 'AKBADKEY00001', 'wrong-secret' );
iwsl_assert_same( false, $lb11c['ok'], 'buckets(all-auth-fail): ok:false' );
iwsl_assert_same( 'auth-failed', $lb11c['error'], 'buckets(all-auth-fail): friendly auth-failed reason' );

// (e) a locked gate refuses (STATEMENT 1).
$eng11d = iwsl_mo_lister_engine( new IWSL_Memory_Store(), $MO_NOW, iwsl_mo_gate( $MO_NOW, 'active', array() ), $MO_BUCKETS );
iwsl_assert_same( 'entitlement-locked', $eng11d->list_buckets( 'AK1234567890', 'x' )['error'], 'buckets(locked): refused' );

// (f) save still validates bucket + location (both the dropdown and the manual path save here).
iwsl_assert_same( 'bad-bucket', $eng11->save_settings( array( 'location' => 'fsn1', 'bucket' => 'BAD_BUCKET', 'access_key' => 'AK1234567890' ) )['reason'], 'buckets: save still rejects an invalid bucket' );
iwsl_assert_same( 'bad-location', $eng11->save_settings( array( 'location' => 'zzz9', 'bucket' => 'rlservers', 'access_key' => 'AK1234567890' ) )['reason'], 'buckets: save still rejects an invalid location' );
$ok11 = $eng11->save_settings( array( 'location' => 'fsn1', 'bucket' => 'fsn-alpha', 'access_key' => 'AK1234567890', 'secret_key' => '', 'enabled' => true, 'rule_all' => true ) );
iwsl_assert_same( true, $ok11['ok'], 'buckets: a valid bucket+location chosen from the dropdown saves' );

// (g) the wizard renders the dynamic dropdown, the load button, and the manual fallback.
$GLOBALS['iwsl_mo_candidates'] = array();
ob_start();
$eng11->render_section();
$html11 = ob_get_clean();
iwsl_assert( false !== strpos( $html11, 'Load my buckets' ), 'render: the dynamic "Load my buckets" button is present' );
iwsl_assert( false !== strpos( $html11, 'iwsl-offload-bucket-select' ), 'render: the grouped bucket <select> is present' );
iwsl_assert( false !== strpos( $html11, IWSL_Media_Offload::AJAX_BUCKETS ), 'render: the buckets AJAX action is wired into the inline script' );
iwsl_assert( false !== strpos( $html11, 'Enter bucket manually' ), 'render: the manual-entry fallback toggle is present' );

unset( $GLOBALS['iwsl_mo_seen_secrets'] );

// ── 12. Scope 'all': already-WebP / never-optimized images offload their ORIGINAL ──

$GLOBALS['iwsl_mo_meta']         = array();
$GLOBALS['iwsl_mo_deriv_exists'] = array();
$GLOBALS['iwsl_mo_files']        = array();
$GLOBALS['iwsl_mo_mimes']        = array();
$GLOBALS['iwsl_mo_urls']         = array();

$store12 = new IWSL_Memory_Store();
$fake12  = new IWSL_MO_Fake_S3();
$eng12   = iwsl_mo_engine( $store12, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake12 );

// scope is absent here ⇒ it must default to 'optimized' (back-compat).
$eng12->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true ) );
iwsl_assert_same( 'optimized', $eng12->settings()['scope'], 'scope: absent on save ⇒ defaults to optimized' );

// An already-WebP image with NO optimizer meta does NOT qualify under scope='optimized'.
iwsl_mo_make_original( 1201, 'image/webp', '2024/06/already1201.webp' );
iwsl_assert_same( false, $eng12->qualifies( 1201 ), 'scope(optimized): an already-WebP image with no optimizer meta does NOT qualify (back-compat)' );

// Switch to scope='all': the SAME image now qualifies and offloads its ORIGINAL file.
$eng12->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => '', 'enabled' => true, 'rule_all' => true, 'scope' => 'all' ) );
iwsl_assert_same( 'all', $eng12->settings()['scope'], 'scope: all persisted' );
iwsl_assert_same( true, $eng12->qualifies( 1201 ), 'scope(all): any image attachment qualifies on the rule' );

$r12 = $eng12->offload_one( 1201 );
iwsl_assert_same( true, $r12['ok'], 'scope(all): already-WebP image offloads OK' );
iwsl_assert_same( 'original', $r12['variant'], 'scope(all): variant=original (its OWN original file was shipped)' );
iwsl_assert_same( '2024/06/already1201.webp', $r12['key'], 'scope(all): key is the uploads-relative path of the original' );
iwsl_assert_same( 'image/webp', $fake12->puts[0]['content_type'], 'scope(all): PUT content-type is the ORIGINAL mime (get_post_mime_type)' );
$m12 = $eng12->offload_meta( 1201 );
iwsl_assert_same( 'original', $m12['variant'], 'scope(all): meta records variant=original' );
iwsl_assert_same( 'https://site.test/wp-content/uploads/2024/06/already1201.webp', $m12['src_url'], 'scope(all): meta records the original src_url this offload replaces' );

// Rewrite: the original file URL ⇒ its bucket URL (same name/format).
$bucket12 = 'https://my-bucket.fsn1.your-objectstorage.com/2024/06/already1201.webp';
iwsl_assert_same( $bucket12, $eng12->filter_attachment_url( $m12['src_url'], 1201 ), 'scope(all) rewrite(url): original file URL ⇒ its bucket URL' );

// srcset correctness: only the offloaded original is rewritten; un-offloaded sub-sizes stay on disk.
$sub12       = 'https://site.test/wp-content/uploads/2024/06/already1201-500x500.webp';
$srcset12_in = array(
	1000 => array( 'url' => $m12['src_url'], 'descriptor' => 'w', 'value' => 1000 ),
	500  => array( 'url' => $sub12, 'descriptor' => 'w', 'value' => 500 ),
);
$srcset12 = $eng12->filter_srcset( $srcset12_in, array( 1000, 1000 ), $m12['src_url'], array(), 1201 );
iwsl_assert_same( $bucket12, $srcset12[1000]['url'], 'scope(all) srcset: the offloaded original is served from the bucket' );
iwsl_assert_same( $sub12, $srcset12[500]['url'], 'scope(all) srcset: an un-offloaded sub-size is LEFT on disk (no broken bucket 404)' );

// Manual DENY still overrides in scope='all'.
iwsl_mo_make_original( 1202, 'image/jpeg', '2024/06/photo1202.jpg' );
$eng12->set_manual( 1202, 'deny' );
iwsl_assert_same( false, $eng12->qualifies( 1202 ), 'scope(all): manual DENY still overrides the rule' );

// An OPTIMIZED image still ships its DERIVATIVE under scope='all'.
$GLOBALS['iwsl_mo_mimes'][1203] = 'image/png'; // an image the optimizer turned into WebP.
iwsl_mo_mark_optimized( 1203 );
$r12c = $eng12->offload_one( 1203 );
iwsl_assert_same( true, $r12c['ok'], 'scope(all): optimized image offloads OK' );
iwsl_assert_same( 'derivative', $r12c['variant'], 'scope(all): an optimized image still ships the smaller WebP derivative' );
iwsl_assert_same( '2024/05/photo1203.webp', $r12c['key'], 'scope(all): the derivative key is used for the optimized image' );

// ...and under scope='optimized' too (derivative in BOTH scopes). Uses a fresh id 1204
// so it needs no meta reset — wiping global meta here would erase 1201's mapping that
// the unoffload assertion below depends on.
$store12d = new IWSL_Memory_Store();
$fake12d  = new IWSL_MO_Fake_S3();
$eng12d   = iwsl_mo_engine( $store12d, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake12d );
$eng12d->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'x', 'enabled' => true, 'rule_all' => true, 'scope' => 'optimized' ) );
iwsl_mo_mark_optimized( 1204 );
$r12d = $eng12d->offload_one( 1204 );
iwsl_assert_same( 'derivative', $r12d['variant'], 'scope(optimized): an optimized image ships the derivative' );

// Unoffload clears an ORIGINAL-variant mapping too.
$u12 = $eng12->unoffload_one( 1201 );
iwsl_assert_same( true, $u12['ok'], 'scope(all) unoffload(original): ok' );
iwsl_assert_same( array( '2024/06/already1201.webp' ), $fake12->deletes, 'scope(all) unoffload(original): DELETE called with the original key' );
iwsl_assert_same( false, $eng12->is_offloaded( 1201 ), 'scope(all) unoffload(original): mapping cleared for the original variant' );

// save_settings validates the scope enum (a bogus value is rejected).
iwsl_assert_same( 'bad-scope', $eng12->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'scope' => 'bogus' ) )['reason'], 'scope: an invalid scope enum is rejected' );

// The wizard renders the scope control + the secret still never leaks.
$GLOBALS['iwsl_mo_candidates'] = array();
ob_start();
$eng12->render_section();
$html12 = ob_get_clean();
iwsl_assert( false !== strpos( $html12, 'name="scope"' ), 'render: the scope control is present' );
iwsl_assert( false !== strpos( $html12, 'All images' ), 'render: the "All images" scope option label is present' );
iwsl_assert( false !== strpos( $html12, 'Only optimized images' ), 'render: the "Only optimized images" scope option label is present' );
iwsl_assert( false === strpos( $html12, 'super-secret-value-123' ), 'render: the secret is NEVER echoed even with the scope control present' );

// ── 13. Management list: format + status + search filtering, paging, and counts ───

$GLOBALS['iwsl_mo_meta']    = array();
$GLOBALS['iwsl_mo_files']   = array();
$GLOBALS['iwsl_mo_mimes']   = array();
$GLOBALS['iwsl_mo_list']    = array();
$GLOBALS['iwsl_mo_attmeta'] = array();

$store13 = new IWSL_Memory_Store();
$eng13   = iwsl_mo_engine( $store13, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), new IWSL_MO_Fake_S3() );
$eng13->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true ) );

// Five image attachments: three on disk, two offloaded (seeded meta so the EXISTS filter bites).
iwsl_mo_list_add( 3001, 'image/jpeg', '2024/07/sunset3001.jpg' );
iwsl_mo_list_add( 3002, 'image/png', '2024/07/logo3002.png' );
iwsl_mo_list_add( 3003, 'image/webp', '2024/07/hero3003.webp' );
iwsl_mo_list_add( 3004, 'image/jpeg', '2024/07/beach3004.jpg' );
iwsl_mo_list_add( 3005, 'image/webp', '2024/07/icon3005.webp' );
iwsl_mo_seed_offload( 3004, '2024/07/beach3004.jpg', 'original', 'https://site.test/wp-content/uploads/2024/07/beach3004.jpg' );
iwsl_mo_seed_offload( 3005, '2024/07/icon3005.webp', 'original', 'https://site.test/wp-content/uploads/2024/07/icon3005.webp' );

// (a) unfiltered: all five, correct overall counts + distinct formats.
$L = $eng13->list_attachments( 1, 24, '', 'all', '' );
iwsl_assert_same( true, $L['ok'], 'list: ok' );
iwsl_assert_same( 5, $L['total_matching'], 'list: all images matched' );
iwsl_assert_same( 5, count( $L['rows'] ), 'list: all five rows returned' );
iwsl_assert_same( array( 'all' => 5, 'offloaded' => 2, 'disk' => 3 ), $L['counts'], 'list: overall counts (5 total, 2 on bucket, 3 on disk)' );
iwsl_assert_same( array( 'image/jpeg', 'image/png', 'image/webp' ), $L['formats'], 'list: distinct image formats present (sorted)' );

// A row carries the expected shape (offloaded row shows bucket_url + variant + location).
$rowsById = array();
foreach ( $L['rows'] as $r ) { $rowsById[ $r['id'] ] = $r; }
iwsl_assert_same( true, $rowsById[3004]['offloaded'], 'list: seeded id is reported offloaded' );
iwsl_assert_same( 'original', $rowsById[3004]['variant'], 'list: offloaded row carries its variant' );
iwsl_assert_same( 'fsn1', $rowsById[3004]['location'], 'list: offloaded row carries the bucket location' );
iwsl_assert( false !== strpos( $rowsById[3004]['bucket_url'], '2024/07/beach3004.jpg' ), 'list: offloaded row carries the bucket URL' );
iwsl_assert_same( false, $rowsById[3001]['offloaded'], 'list: on-disk row is reported not offloaded' );
iwsl_assert_same( '', $rowsById[3001]['bucket_url'], 'list: on-disk row has no bucket URL' );
iwsl_assert( false !== strpos( $rowsById[3001]['thumb'], 'wp-content/uploads' ), 'list: thumb is the RAW local URL (not the bucket URL)' );
iwsl_assert( false === strpos( $rowsById[3004]['thumb'], 'your-objectstorage.com' ), 'list: even an offloaded row thumb stays a local URL' );

// (b) format filter.
$Lf = $eng13->list_attachments( 1, 24, 'image/jpeg', 'all', '' );
iwsl_assert_same( 2, $Lf['total_matching'], 'list(format=jpeg): only the two JPEGs match' );

// (c) status filters.
$Lon  = $eng13->list_attachments( 1, 24, '', 'offloaded', '' );
iwsl_assert_same( 2, $Lon['total_matching'], 'list(status=offloaded): two on the bucket' );
$Loff = $eng13->list_attachments( 1, 24, '', 'disk', '' );
iwsl_assert_same( 3, $Loff['total_matching'], 'list(status=disk): three on disk' );

// (d) filename search.
$Ls = $eng13->list_attachments( 1, 24, '', 'all', 'sunset3001' );
iwsl_assert_same( 1, $Ls['total_matching'], 'list(search): matches by filename' );
iwsl_assert_same( 3001, $Ls['rows'][0]['id'], 'list(search): returns the matching attachment' );

// (e) pagination + per_page clamping / defaults.
$P1 = $eng13->list_attachments( 1, 2, '', 'all', '' );
iwsl_assert_same( 5, $P1['total_matching'], 'list(page1): total is the full match count' );
iwsl_assert_same( 2, count( $P1['rows'] ), 'list(page1): first page holds per_page rows' );
$P3 = $eng13->list_attachments( 3, 2, '', 'all', '' );
iwsl_assert_same( 1, count( $P3['rows'] ), 'list(page3): last page holds the remainder' );
iwsl_assert_same( 3, $P3['page'], 'list(page3): echoes the requested page' );
iwsl_assert_same( 100, $eng13->list_attachments( 1, 500, '', 'all', '' )['per_page'], 'list: per_page caps at 100' );
iwsl_assert_same( 24, $eng13->list_attachments( 1, 0, '', 'all', '' )['per_page'], 'list: per_page 0 falls back to the default 24' );

// (f) a locked gate refuses the list (STATEMENT 1).
$eng13_locked = iwsl_mo_engine( new IWSL_Memory_Store(), $MO_NOW, iwsl_mo_gate( $MO_NOW, 'active', array() ), new IWSL_MO_Fake_S3() );
iwsl_assert_same( 'entitlement-locked', $eng13_locked->list_attachments( 1, 24, '', 'all', '' )['reason'], 'list(locked): refused' );

// ── 14. offload-by-id + bulk offload / bring-back ─────────────────────────────────

$GLOBALS['iwsl_mo_meta']  = array();
$GLOBALS['iwsl_mo_files'] = array();
$GLOBALS['iwsl_mo_mimes'] = array();

$store14 = new IWSL_Memory_Store();
$fake14  = new IWSL_MO_Fake_S3();
$eng14   = iwsl_mo_engine( $store14, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake14 );
$eng14->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true, 'scope' => 'optimized' ) );

// offload-by-id: a single optimized image offloads and records its mapping.
iwsl_mo_mark_optimized( 6000 );
$one = $eng14->offload_one( 6000 );
iwsl_assert_same( true, $one['ok'], 'offload-by-id: single id offloads' );
iwsl_assert_same( true, $eng14->is_offloaded( 6000 ), 'offload-by-id: mapping recorded' );

// bulk offload: dedupes, drops non-positive ids, and reports a summary.
iwsl_mo_mark_optimized( 6001 );
iwsl_mo_mark_optimized( 6002 );
$bulkOff = $eng14->bulk( 'offload', array( 6001, 6002, '0', 6001 ) );
iwsl_assert_same( true, $bulkOff['ok'], 'bulk(offload): ok' );
iwsl_assert_same( array( 'total' => 2, 'ok' => 2, 'failed' => 0 ), $bulkOff['summary'], 'bulk(offload): summary counts two (deduped, zero dropped)' );
iwsl_assert_same( true, $eng14->is_offloaded( 6001 ), 'bulk(offload): 6001 offloaded' );
iwsl_assert_same( true, $eng14->is_offloaded( 6002 ), 'bulk(offload): 6002 offloaded' );
iwsl_assert_same( 2, count( $bulkOff['results'] ), 'bulk(offload): one result per unique id' );

// bulk bring-back: local files unknown ⇒ delete-only path; objects removed + meta cleared.
$fake14->deletes = array();
$bulkBack = $eng14->bulk( 'unoffload', array( 6001, 6002 ) );
iwsl_assert_same( array( 'total' => 2, 'ok' => 2, 'failed' => 0 ), $bulkBack['summary'], 'bulk(unoffload): summary counts two ok' );
iwsl_assert_same( false, $eng14->is_offloaded( 6001 ), 'bulk(unoffload): 6001 cleared' );
iwsl_assert_same( false, $eng14->is_offloaded( 6002 ), 'bulk(unoffload): 6002 cleared' );
iwsl_assert_same( 2, count( $fake14->deletes ), 'bulk(unoffload): both bucket objects deleted' );

// bad op is rejected.
iwsl_assert_same( 'bad-op', $eng14->bulk( 'nope', array( 6000 ) )['reason'], 'bulk: an unknown op is rejected' );

// ── 15. Bring back to disk: MISSING local file is downloaded BEFORE the delete ────

$GLOBALS['iwsl_mo_meta']  = array();
$GLOBALS['iwsl_mo_files'] = array();

$store15 = new IWSL_Memory_Store();
$fake15  = new IWSL_MO_Fake_S3();
$RESTORE_BYTES = 'RESTORED-image-bytes-7001-abcdefg';
$http_calls    = array();
$http_ok       = static function ( string $url ) use ( &$http_calls, $RESTORE_BYTES ): array {
	$http_calls[] = $url;
	return array( 'ok' => true, 'body' => $RESTORE_BYTES, 'status' => 200 );
};
$eng15 = iwsl_mo_engine( $store15, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake15, $http_ok );
$eng15->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true, 'scope' => 'all', 'access' => 'public' ) );

$missing15 = $GLOBALS['iwsl_mo_up'] . '/2024/08/gone7001.jpg';
@unlink( $missing15 );
$GLOBALS['iwsl_mo_files'][7001] = $missing15;
iwsl_mo_seed_offload( 7001, '2024/08/gone7001.jpg', 'original', 'https://site.test/wp-content/uploads/2024/08/gone7001.jpg' );
iwsl_assert_same( false, is_file( $missing15 ), 'bring-back: precondition — local file is missing' );

$bb = $eng15->unoffload_one( 7001 );
iwsl_assert_same( true, $bb['ok'], 'bring-back: unoffload succeeds' );
iwsl_assert_same( true, ! empty( $bb['restored'] ), 'bring-back: reports restored=true' );
iwsl_assert_same( 1, count( $http_calls ), 'bring-back: exactly one download performed' );
iwsl_assert( false !== strpos( $http_calls[0], '2024/08/gone7001.jpg' ), 'bring-back(public): downloaded from the public bucket URL' );
iwsl_assert_same( true, is_file( $missing15 ), 'bring-back: the local file was written back to disk' );
iwsl_assert_same( $RESTORE_BYTES, (string) file_get_contents( $missing15 ), 'bring-back: the downloaded bytes were written to get_attached_file() path' );
iwsl_assert_same( array( '2024/08/gone7001.jpg' ), $fake15->deletes, 'bring-back: the bucket object was deleted AFTER the restore' );
iwsl_assert_same( false, $eng15->is_offloaded( 7001 ), 'bring-back: the offload mapping was cleared' );

// Private access: the missing-file restore downloads via a PRESIGNED GET URL.
$GLOBALS['iwsl_mo_meta']  = array();
$store15p = new IWSL_Memory_Store();
$fake15p  = new IWSL_MO_Fake_S3();
$urls15p  = array();
$http_p   = static function ( string $url ) use ( &$urls15p ): array {
	$urls15p[] = $url;
	return array( 'ok' => true, 'body' => 'PRIV-RESTORE-BYTES', 'status' => 200 );
};
$eng15p = iwsl_mo_engine( $store15p, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake15p, $http_p );
$eng15p->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true, 'scope' => 'all', 'access' => 'private', 'private_url_ttl' => 1800 ) );
$missing15p = $GLOBALS['iwsl_mo_up'] . '/2024/08/gone7003.jpg';
@unlink( $missing15p );
$GLOBALS['iwsl_mo_files'][7003] = $missing15p;
iwsl_mo_seed_offload( 7003, '2024/08/gone7003.jpg', 'original', 'https://site.test/wp-content/uploads/2024/08/gone7003.jpg' );
$bbp = $eng15p->unoffload_one( 7003 );
iwsl_assert_same( true, $bbp['ok'], 'bring-back(private): unoffload succeeds' );
iwsl_assert( false !== strpos( $urls15p[0], 'X-Amz-Signature=' ), 'bring-back(private): downloaded via a presigned GET URL' );
@unlink( $missing15p );

// ── 16. Bring back ABORTS when the download fails (bucket copy + meta KEPT) ────────

$GLOBALS['iwsl_mo_meta']  = array();
$store16 = new IWSL_Memory_Store();
$fake16  = new IWSL_MO_Fake_S3();
$http_fail = static function ( string $url ): array {
	return array( 'ok' => false, 'body' => '', 'status' => 500 );
};
$eng16 = iwsl_mo_engine( $store16, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), $fake16, $http_fail );
$eng16->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => 'super-secret-value-123', 'enabled' => true, 'rule_all' => true, 'scope' => 'all', 'access' => 'public' ) );

$missing16 = $GLOBALS['iwsl_mo_up'] . '/2024/08/gone7002.jpg';
@unlink( $missing16 );
$GLOBALS['iwsl_mo_files'][7002] = $missing16;
iwsl_mo_seed_offload( 7002, '2024/08/gone7002.jpg', 'original', 'https://site.test/wp-content/uploads/2024/08/gone7002.jpg' );

$ab = $eng16->unoffload_one( 7002 );
iwsl_assert_same( false, $ab['ok'], 'abort: unoffload fails when the download fails' );
iwsl_assert_same( 'restore-failed', $ab['reason'], 'abort: reason is restore-failed' );
iwsl_assert_same( array(), $fake16->deletes, 'abort: the bucket object was NEVER deleted (last copy kept)' );
iwsl_assert_same( true, $eng16->is_offloaded( 7002 ), 'abort: the offload mapping is intact' );
iwsl_assert_same( false, is_file( $missing16 ), 'abort: no partial/empty local file was left behind' );

// ── 17. The secret NEVER appears in any management AJAX response ───────────────────

$GLOBALS['iwsl_mo_meta']  = array();
$GLOBALS['iwsl_mo_files'] = array();
$GLOBALS['iwsl_mo_mimes'] = array();
$GLOBALS['iwsl_mo_list']  = array();

$SECRET17 = 'AJAX-secret-must-never-leak-98765';
$store17  = new IWSL_Memory_Store();
$eng17    = iwsl_mo_engine( $store17, $MO_NOW, iwsl_mo_unlocked( $MO_NOW ), new IWSL_MO_Fake_S3() );
$eng17->save_settings( array( 'location' => 'fsn1', 'bucket' => 'my-bucket', 'access_key' => 'AK1234567890', 'secret_key' => $SECRET17, 'enabled' => true, 'rule_all' => true ) );
iwsl_mo_list_add( 8001, 'image/jpeg', '2024/09/x8001.jpg' );

$respList = $eng17->list_attachments( 1, 24, '', 'all', '' );
iwsl_assert( false === strpos( (string) json_encode( $respList ), $SECRET17 ), 'secret: the list AJAX response never contains the secret' );
iwsl_assert_same( false, array_key_exists( 'secret', $respList ), 'secret: the list response carries no secret key' );

$respBulk = $eng17->bulk( 'offload', array() );
iwsl_assert( false === strpos( (string) json_encode( $respBulk ), $SECRET17 ), 'secret: the bulk AJAX response never contains the secret' );

// Clean up the temp uploads tree + suite globals so nothing leaks into a later suite.
foreach ( array_reverse( glob( $GLOBALS['iwsl_mo_up'] . '/{,*/,*/*/}*', GLOB_BRACE ) ?: array() ) as $p ) {
	is_dir( $p ) ? @rmdir( $p ) : @unlink( $p );
}
@rmdir( $GLOBALS['iwsl_mo_up'] );
unset( $GLOBALS['iwsl_mo_meta'], $GLOBALS['iwsl_mo_deriv_exists'], $GLOBALS['iwsl_mo_candidates'], $GLOBALS['iwsl_mo_files'], $GLOBALS['iwsl_mo_mimes'], $GLOBALS['iwsl_mo_urls'], $GLOBALS['iwsl_mo_list'], $GLOBALS['iwsl_mo_attmeta'], $GLOBALS['iwsl_mo_up'] );
