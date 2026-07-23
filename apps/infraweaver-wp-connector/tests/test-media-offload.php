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

/** Build an offload engine over $store with the fake S3 client + injected seams. */
function iwsl_mo_engine( IWSL_Store $store, int $now, IWSL_Entitlements $ent, IWSL_MO_Fake_S3 $fake ): IWSL_Media_Offload {
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
		}
	);
}

/** Mark attachment id as optimized (carries the optimizer META_KEY). */
function iwsl_mo_mark_optimized( int $id ): void {
	$GLOBALS['iwsl_mo_meta'][ $id ][ IWSL_Media_Optimizer::META_KEY ] = array( 'ok' => true );
}

// Reset per-run globals.
$GLOBALS['iwsl_mo_meta']         = array();
$GLOBALS['iwsl_mo_deriv_exists'] = array();
$GLOBALS['iwsl_mo_candidates']   = array();

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

// Clean up the temp uploads tree + suite globals so nothing leaks into a later suite.
foreach ( array_reverse( glob( $GLOBALS['iwsl_mo_up'] . '/{,*/,*/*/}*', GLOB_BRACE ) ?: array() ) as $p ) {
	is_dir( $p ) ? @rmdir( $p ) : @unlink( $p );
}
@rmdir( $GLOBALS['iwsl_mo_up'] );
unset( $GLOBALS['iwsl_mo_meta'], $GLOBALS['iwsl_mo_deriv_exists'], $GLOBALS['iwsl_mo_candidates'], $GLOBALS['iwsl_mo_up'] );
