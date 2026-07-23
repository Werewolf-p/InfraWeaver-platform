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

// Clean up the temp uploads tree + suite globals so nothing leaks into a later suite.
foreach ( array_reverse( glob( $GLOBALS['iwsl_mo_up'] . '/{,*/,*/*/}*', GLOB_BRACE ) ?: array() ) as $p ) {
	is_dir( $p ) ? @rmdir( $p ) : @unlink( $p );
}
@rmdir( $GLOBALS['iwsl_mo_up'] );
unset( $GLOBALS['iwsl_mo_meta'], $GLOBALS['iwsl_mo_deriv_exists'], $GLOBALS['iwsl_mo_candidates'], $GLOBALS['iwsl_mo_up'] );
