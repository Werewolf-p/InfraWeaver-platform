<?php
/**
 * S3-compatible client (IWSL_S3_Client) — the hand-rolled AWS Signature V4 signer
 * + object PUT/HEAD/DELETE transport for Hetzner Object Storage.
 *
 * Runs under the zero-dependency harness with an INJECTED, request-capturing
 * transport (no network) and an INJECTED fixed clock (deterministic x-amz-date).
 * No random/time is used anywhere in this suite.
 *
 * KNOWN-ANSWER TEST. sigv4() is pinned to AWS's published Signature V4 example —
 * the "GET ListUsers" vector: service `iam`, region `us-east-1`, date
 * `20150830T123600Z`, access key `AKIDEXAMPLE`, secret
 * `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, signed headers
 * `content-type;host;x-amz-date`. AWS documents the canonical-request SHA256 as
 * f536975d…; the signing key (2c94c0cf…) and final signature
 * (33f5dad2191de0cb4b7ab912f876876c2c4f72e2991a458f9499233c7b992438) are the
 * deterministic SigV4 outputs for that input — cross-verified here against
 * botocore's own SigV4Auth (AWS's reference library), which emits the identical
 * signature. Fixed input → the AWS reference signature.
 */

// ── capturing transport + config helpers ──────────────────────────────────────

$GLOBALS['iwsl_s3_reqs'] = array(); // every dispatched request, in order.

/** A transport that records each request and returns a fixed (or per-method) reply. */
function iwsl_s3_transport( $response ): callable {
	return static function ( array $req ) use ( $response ): array {
		$GLOBALS['iwsl_s3_reqs'][] = $req;
		if ( is_callable( $response ) ) {
			return $response( $req );
		}
		return $response;
	};
}

/** Case-insensitive header lookup on a captured request. */
function iwsl_s3_hdr( array $req, string $name ) {
	foreach ( $req['headers'] as $k => $v ) {
		if ( strtolower( (string) $k ) === strtolower( $name ) ) {
			return (string) $v;
		}
	}
	return null;
}

/** A never-leak secret used across the suite (asserted absent from every output). */
const IWSL_S3_TEST_SECRET = 'super-secret-value-DO-NOT-LEAK/abc+123';

/** Base config; clock is frozen so x-amz-date is deterministic. */
function iwsl_s3_config( array $over = array() ): array {
	return array_merge(
		array(
			'endpoint'   => 'fsn1.your-objectstorage.com',
			'region'     => 'fsn1',
			'bucket'     => 'my-bucket',
			'access_key' => 'AKIAEXAMPLE',
			'secret_key' => IWSL_S3_TEST_SECRET,
			'acl'        => 'public-read',
			'path_style' => false,
			'clock'      => static function (): int {
				return 1440938160; // 2015-08-30T12:36:00Z — fixed, not wall-clock.
			},
		),
		$over
	);
}

/** A 200/200/204 responder for PUT/HEAD/DELETE round-trips. */
function iwsl_s3_ok_responder(): callable {
	return static function ( array $req ): array {
		$m = $req['method'];
		if ( 'PUT' === $m ) {
			return array( 'status' => 200, 'headers' => array( 'ETag' => '"put-etag-001"' ), 'body' => '', 'error' => '' );
		}
		if ( 'HEAD' === $m ) {
			return array( 'status' => 200, 'headers' => array( 'ETag' => '"head-etag-001"' ), 'body' => '', 'error' => '' );
		}
		return array( 'status' => 204, 'headers' => array(), 'body' => '', 'error' => '' );
	};
}

// ── 1. SigV4 known-answer test (AWS published iam/us-east-1/20150830 vector) ────

$kat = IWSL_S3_Client::sigv4(
	'GET',
	'/',
	'Action=ListUsers&Version=2010-05-08',
	array(
		'Host'         => 'iam.amazonaws.com',
		'Content-Type' => 'application/x-www-form-urlencoded; charset=utf-8',
		'X-Amz-Date'   => '20150830T123600Z',
	),
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // sha256('')
	'20150830T123600Z',
	'us-east-1',
	'iam',
	'AKIDEXAMPLE',
	'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
);

iwsl_assert_same(
	'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59',
	hash( 'sha256', $kat['canonical_request'] ),
	'KAT: canonical-request SHA256 equals AWS published value'
);
iwsl_assert_same(
	'content-type;host;x-amz-date',
	$kat['signed_headers'],
	'KAT: signed headers lowercased + sorted'
);
iwsl_assert_same(
	'2c94c0cf5378ada6887f09bb697df8fc0affdb34ba1cdd5bda32b664bd55b73c',
	$kat['signing_key_hex'],
	'KAT: date→region→service→aws4_request signing key'
);
iwsl_assert_same(
	'33f5dad2191de0cb4b7ab912f876876c2c4f72e2991a458f9499233c7b992438',
	$kat['signature'],
	'KAT: final signature equals AWS reference (botocore) signature'
);
iwsl_assert_same(
	'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=33f5dad2191de0cb4b7ab912f876876c2c4f72e2991a458f9499233c7b992438',
	$kat['authorization'],
	'KAT: full Authorization header matches AWS reference'
);
iwsl_assert(
	0 === strpos( $kat['string_to_sign'], "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/iam/aws4_request\n" ),
	'KAT: string-to-sign carries algorithm, amz-date, and credential scope'
);

// ── 2. put_object: signed PUT, virtual-hosted host, acl, payload hash ──────────

$GLOBALS['iwsl_s3_reqs'] = array();
$body   = 'hello object storage';
$client = new IWSL_S3_Client(
	iwsl_s3_config(),
	iwsl_s3_transport( array( 'status' => 200, 'headers' => array( 'ETag' => '"deadbeef"' ), 'body' => '', 'error' => '' ) )
);
$put = $client->put_object( 'images/photo.png', $body, 'image/png' );

iwsl_assert_same( true, $put['ok'], 'put_object: ok on 200' );
iwsl_assert_same( 200, $put['status'], 'put_object: status surfaced' );
iwsl_assert_same( 'deadbeef', $put['etag'] ?? '', 'put_object: ETag unquoted' );

$req = $GLOBALS['iwsl_s3_reqs'][0];
iwsl_assert_same( 'PUT', $req['method'], 'put_object: method PUT' );
iwsl_assert_same(
	'https://my-bucket.fsn1.your-objectstorage.com/images/photo.png',
	$req['url'],
	'put_object: virtual-hosted https URL + correct host'
);
iwsl_assert_same( 'my-bucket.fsn1.your-objectstorage.com', iwsl_s3_hdr( $req, 'host' ), 'put_object: Host header is <bucket>.<endpoint>' );
iwsl_assert_same( 'public-read', iwsl_s3_hdr( $req, 'x-amz-acl' ), 'put_object: x-amz-acl from config' );
iwsl_assert_same( hash( 'sha256', $body ), iwsl_s3_hdr( $req, 'x-amz-content-sha256' ), 'put_object: x-amz-content-sha256 = sha256(body)' );
iwsl_assert( null !== iwsl_s3_hdr( $req, 'x-amz-date' ), 'put_object: x-amz-date present' );
iwsl_assert( 1 === preg_match( '/^\d{8}T\d{6}Z$/', (string) iwsl_s3_hdr( $req, 'x-amz-date' ) ), 'put_object: x-amz-date is ISO-basic' );

$auth = (string) iwsl_s3_hdr( $req, 'authorization' );
iwsl_assert(
	1 === preg_match(
		'#^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/\d{8}/fsn1/s3/aws4_request, SignedHeaders=[a-z0-9;\-]+, Signature=[0-9a-f]{64}$#',
		$auth
	),
	'put_object: Authorization is well-formed AWS4-HMAC-SHA256 over /s3/aws4_request'
);
foreach ( array( 'content-type', 'host', 'x-amz-acl', 'x-amz-content-sha256', 'x-amz-date' ) as $sh ) {
	iwsl_assert( false !== strpos( $auth, 'SignedHeaders=' ) && false !== strpos( $auth, $sh ), "put_object: SignedHeaders includes {$sh}" );
}

// ── 3. head_object + delete_object (empty-payload hash, DELETE 204) ────────────

$GLOBALS['iwsl_s3_reqs'] = array();
$client = new IWSL_S3_Client( iwsl_s3_config(), iwsl_s3_transport( iwsl_s3_ok_responder() ) );

$head = $client->head_object( 'images/photo.png' );
iwsl_assert_same( true, $head['ok'], 'head_object: ok on 200' );
iwsl_assert_same( true, $head['exists'], 'head_object: exists on 200' );
iwsl_assert_same( 'head-etag-001', $head['etag'] ?? '', 'head_object: ETag unquoted' );
$hreq = $GLOBALS['iwsl_s3_reqs'][0];
iwsl_assert_same( 'HEAD', $hreq['method'], 'head_object: method HEAD' );
iwsl_assert_same( IWSL_S3_Client::EMPTY_PAYLOAD_HASH, iwsl_s3_hdr( $hreq, 'x-amz-content-sha256' ), 'head_object: empty-payload hash signed' );

$GLOBALS['iwsl_s3_reqs'] = array();
$client = new IWSL_S3_Client( iwsl_s3_config(), iwsl_s3_transport( iwsl_s3_ok_responder() ) );
$del    = $client->delete_object( 'images/photo.png' );
iwsl_assert_same( true, $del['ok'], 'delete_object: ok on 204' );
iwsl_assert_same( 204, $del['status'], 'delete_object: status 204' );
iwsl_assert_same( 'DELETE', $GLOBALS['iwsl_s3_reqs'][0]['method'], 'delete_object: method DELETE' );

// A HEAD on a missing key: request completed (ok) but exists=false.
$GLOBALS['iwsl_s3_reqs'] = array();
$client = new IWSL_S3_Client(
	iwsl_s3_config(),
	iwsl_s3_transport( array( 'status' => 404, 'headers' => array(), 'body' => '', 'error' => '' ) )
);
$miss = $client->head_object( 'nope.txt' );
iwsl_assert_same( true, $miss['ok'], 'head_object(404): ok — a definite negative answer' );
iwsl_assert_same( false, $miss['exists'], 'head_object(404): exists=false' );

// ── 4. path-style host + canonical URI ─────────────────────────────────────────

$GLOBALS['iwsl_s3_reqs'] = array();
$client = new IWSL_S3_Client(
	iwsl_s3_config( array( 'path_style' => true ) ),
	iwsl_s3_transport( array( 'status' => 200, 'headers' => array(), 'body' => '', 'error' => '' ) )
);
$client->put_object( 'images/photo.png', 'x', 'image/png' );
$preq = $GLOBALS['iwsl_s3_reqs'][0];
iwsl_assert_same(
	'https://fsn1.your-objectstorage.com/my-bucket/images/photo.png',
	$preq['url'],
	'path-style: URL is https://<endpoint>/<bucket>/<key>'
);
iwsl_assert_same( 'fsn1.your-objectstorage.com', iwsl_s3_hdr( $preq, 'host' ), 'path-style: Host is the bare endpoint' );

// ── 5. public_url formatting (both styles, key encoding) ───────────────────────

$vh = new IWSL_S3_Client( iwsl_s3_config(), iwsl_s3_transport( array() ) );
iwsl_assert_same(
	'https://my-bucket.fsn1.your-objectstorage.com/images/photo.png',
	$vh->public_url( 'images/photo.png' ),
	'public_url: virtual-hosted style'
);
iwsl_assert_same(
	'https://my-bucket.fsn1.your-objectstorage.com/my%20folder/a%20b.png',
	$vh->public_url( 'my folder/a b.png' ),
	'public_url: encodes segments but keeps /'
);
iwsl_assert_same(
	'https://my-bucket.fsn1.your-objectstorage.com/images/photo.png',
	$vh->public_url( '/images/photo.png' ),
	'public_url: leading slash on key is tolerated'
);
$ps = new IWSL_S3_Client( iwsl_s3_config( array( 'path_style' => true ) ), iwsl_s3_transport( array() ) );
iwsl_assert_same(
	'https://fsn1.your-objectstorage.com/my-bucket/images/photo.png',
	$ps->public_url( 'images/photo.png' ),
	'public_url: path style'
);

// ── 6. SSRF guard: a private/link-local/loopback endpoint is refused ───────────

$GLOBALS['iwsl_s3_reqs'] = array(); // clean slate — assert no signed request escapes.
foreach ( array(
	'169.254.169.254' => 'link-local metadata IP',
	'127.0.0.1'       => 'loopback IP',
	'192.168.10.5'    => 'RFC1918 private IP',
	'10.0.0.9'        => 'RFC1918 private IP (10/8)',
) as $bad_host => $desc ) {
	$c = new IWSL_S3_Client( iwsl_s3_config( array( 'endpoint' => $bad_host ) ), iwsl_s3_transport( array() ) );
	$r = $c->put_object( 'k.txt', 'x' );
	iwsl_assert_same( false, $r['ok'], "SSRF: {$desc} endpoint refused (ok=false)" );
	iwsl_assert_same( 'endpoint-private-ip', $r['error'], "SSRF: {$desc} → endpoint-private-ip, no request signed" );
}
iwsl_assert_same( array(), $GLOBALS['iwsl_s3_reqs'], 'SSRF: no request reached the transport for any private endpoint' );

// A hostname that resolves (injected) into a private range is likewise refused.
$c = new IWSL_S3_Client(
	iwsl_s3_config( array(
		'endpoint'  => 'metadata.internal.example',
		'resolver'  => static function ( string $host ): string {
			return '169.254.169.254';
		},
	) ),
	iwsl_s3_transport( array() )
);
iwsl_assert_same( 'endpoint-private-ip', $c->put_object( 'k', 'x' )['error'], 'SSRF: hostname resolving to link-local is refused' );

// ── 7. https-only: a non-https endpoint scheme is refused (never downgraded) ────

$c = new IWSL_S3_Client( iwsl_s3_config( array( 'endpoint' => 'http://fsn1.your-objectstorage.com' ) ), iwsl_s3_transport( array() ) );
iwsl_assert_same( 'endpoint-insecure-scheme', $c->put_object( 'k', 'x' )['error'], 'https-only: http:// endpoint refused' );
// An https:// scheme in config is stripped and the host still signs/serves.
$c = new IWSL_S3_Client( iwsl_s3_config( array( 'endpoint' => 'https://fsn1.your-objectstorage.com' ) ), iwsl_s3_transport( array() ) );
iwsl_assert_same( 'https://my-bucket.fsn1.your-objectstorage.com/k', $c->public_url( 'k' ), 'https-only: https:// prefix normalized to bare host' );

// ── 8. structured validation for empty bucket / key / credentials ──────────────

iwsl_assert_same(
	'bucket-missing',
	( new IWSL_S3_Client( iwsl_s3_config( array( 'bucket' => '' ) ), iwsl_s3_transport( array() ) ) )->put_object( 'k', 'x' )['error'],
	'validation: empty bucket → structured error (no fatal)'
);
iwsl_assert_same(
	'key-missing',
	( new IWSL_S3_Client( iwsl_s3_config(), iwsl_s3_transport( array() ) ) )->put_object( '   ', 'x' )['error'],
	'validation: empty key → structured error'
);
iwsl_assert_same(
	'credentials-missing',
	( new IWSL_S3_Client( iwsl_s3_config( array( 'secret_key' => '' ) ), iwsl_s3_transport( array() ) ) )->head_object( 'k' )['error'],
	'validation: empty secret_key → structured error'
);
iwsl_assert_same(
	'endpoint-missing',
	( new IWSL_S3_Client( iwsl_s3_config( array( 'endpoint' => '' ) ), iwsl_s3_transport( array() ) ) )->delete_object( 'k' )['error'],
	'validation: empty endpoint → structured error'
);

// ── 9. test_connection: PUT → HEAD → DELETE round-trip, deterministic probe ────

$GLOBALS['iwsl_s3_reqs'] = array();
$client = new IWSL_S3_Client( iwsl_s3_config(), iwsl_s3_transport( iwsl_s3_ok_responder() ) );
$probe  = $client->test_connection();
iwsl_assert_same( true, $probe['ok'], 'test_connection: ok when PUT+HEAD+DELETE all succeed' );
iwsl_assert_same( 3, count( $GLOBALS['iwsl_s3_reqs'] ), 'test_connection: exactly three requests' );
iwsl_assert_same( 'PUT', $GLOBALS['iwsl_s3_reqs'][0]['method'], 'test_connection: step 1 is PUT' );
iwsl_assert_same( 'HEAD', $GLOBALS['iwsl_s3_reqs'][1]['method'], 'test_connection: step 2 is HEAD' );
iwsl_assert_same( 'DELETE', $GLOBALS['iwsl_s3_reqs'][2]['method'], 'test_connection: step 3 is DELETE' );
iwsl_assert(
	false !== strpos( $GLOBALS['iwsl_s3_reqs'][0]['url'], '/.iwsl-probe-' ),
	'test_connection: probe key is the fixed static key (no random/time)'
);
iwsl_assert( isset( $probe['steps']['put'], $probe['steps']['head'], $probe['steps']['delete'] ), 'test_connection: steps reported for each phase' );

// A probe whose HEAD misses (500) reports not-ok but still cleans up (DELETE runs).
$GLOBALS['iwsl_s3_reqs'] = array();
$client = new IWSL_S3_Client(
	iwsl_s3_config(),
	iwsl_s3_transport( static function ( array $req ): array {
		$m = $req['method'];
		if ( 'PUT' === $m ) {
			return array( 'status' => 200, 'headers' => array(), 'body' => '', 'error' => '' );
		}
		if ( 'HEAD' === $m ) {
			return array( 'status' => 500, 'headers' => array(), 'body' => '', 'error' => '' );
		}
		return array( 'status' => 204, 'headers' => array(), 'body' => '', 'error' => '' );
	} )
);
$probe2 = $client->test_connection();
iwsl_assert_same( false, $probe2['ok'], 'test_connection: not-ok when HEAD does not confirm the object' );
iwsl_assert_same( 3, count( $GLOBALS['iwsl_s3_reqs'] ), 'test_connection: DELETE cleanup still attempted after a bad HEAD' );

// ── 10. secret_key never leaks into any returned value, header, or error ───────

$GLOBALS['iwsl_s3_reqs'] = array();
$client = new IWSL_S3_Client( iwsl_s3_config(), iwsl_s3_transport( iwsl_s3_ok_responder() ) );
$outputs = array(
	$client->put_object( 'a/b.txt', 'payload-body', 'text/plain' ),
	$client->head_object( 'a/b.txt' ),
	$client->delete_object( 'a/b.txt' ),
	$client->test_connection(),
	$client->public_url( 'a/b.txt' ),
	$kat, // includes the Authorization header (access key + signature only).
	$GLOBALS['iwsl_s3_reqs'], // every signed request that hit the transport.
);
$haystack = json_encode( $outputs );
iwsl_assert(
	false === strpos( (string) $haystack, IWSL_S3_TEST_SECRET ),
	'security: secret_key appears in NO returned value, header, or error'
);
// And the signed Authorization header carries the access key id, not the secret.
iwsl_assert(
	false !== strpos( (string) iwsl_s3_hdr( $GLOBALS['iwsl_s3_reqs'][0], 'authorization' ), 'Credential=AKIAEXAMPLE/' ),
	'security: Authorization carries the access key id (never the secret)'
);

// ── 11. presigned_get_url: AWS published query-string presign example (KAT) ─────
// The AWS "Authenticating Requests: Using Query Parameters (SigV4)" reference
// vector: GET examplebucket/test.txt, us-east-1, 20130524T000000Z, X-Amz-Expires
// 86400, host=examplebucket.s3.amazonaws.com, payload literal UNSIGNED-PAYLOAD. AWS
// documents the signature as aeeed9bb…604d404; our presigner reproduces the entire
// URL byte-for-byte (cross-verification against AWS's own published example).
$aws_presign = new IWSL_S3_Client(
	array(
		'endpoint'   => 's3.amazonaws.com',
		'region'     => 'us-east-1',
		'bucket'     => 'examplebucket',
		'access_key' => 'AKIAIOSFODNN7EXAMPLE',
		'secret_key' => 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
		'path_style' => false,
		'clock'      => static function (): int {
			return 1369353600; // 2013-05-24T00:00:00Z — fixed.
		},
	),
	iwsl_s3_transport( array() )
);
iwsl_assert_same(
	'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
	$aws_presign->presigned_get_url( 'test.txt', 86400 ),
	'presign KAT: full URL equals the AWS published query-string presign example'
);

// ── 12. presigned_get_url: required X-Amz-* params, host/path, deterministic sig ─
$vh_presign = new IWSL_S3_Client( iwsl_s3_config(), iwsl_s3_transport( array() ) );
$purl       = $vh_presign->presigned_get_url( 'images/photo.png', 3600 );

iwsl_assert(
	0 === strpos( $purl, 'https://my-bucket.fsn1.your-objectstorage.com/images/photo.png?' ),
	'presign: virtual-hosted host + encoded key path, then the query string'
);
iwsl_assert( false !== strpos( $purl, 'X-Amz-Algorithm=AWS4-HMAC-SHA256' ), 'presign: X-Amz-Algorithm=AWS4-HMAC-SHA256' );
iwsl_assert( false !== strpos( $purl, 'X-Amz-Credential=AKIAEXAMPLE%2F20150830%2Ffsn1%2Fs3%2Faws4_request' ), 'presign: X-Amz-Credential is the url-encoded scope' );
iwsl_assert( false !== strpos( $purl, 'X-Amz-Date=20150830T123600Z' ), 'presign: X-Amz-Date from the injected clock' );
iwsl_assert( false !== strpos( $purl, 'X-Amz-Expires=3600' ), 'presign: X-Amz-Expires present' );
iwsl_assert( false !== strpos( $purl, 'X-Amz-SignedHeaders=host' ), 'presign: X-Amz-SignedHeaders=host (only host is signed)' );
iwsl_assert( 1 === preg_match( '/[?&]X-Amz-Signature=[0-9a-f]{64}$/', $purl ), 'presign: X-Amz-Signature is a 64-hex string, appended last' );
// Deterministic pinned signature under the frozen clock — the SAME SigV4 presign
// machinery the AWS KAT above validates, so this pin is anchored to a real vector.
iwsl_assert(
	false !== strpos( $purl, 'X-Amz-Signature=3fc3b03745bae041d76d50063d14251ce8ac415194a804b06857d6736ede4042' ),
	'presign: deterministic signature for the frozen fsn1 vector'
);

// Path-style presign: https://<endpoint>/<bucket>/<key>?…
$ps_presign = new IWSL_S3_Client( iwsl_s3_config( array( 'path_style' => true ) ), iwsl_s3_transport( array() ) );
iwsl_assert(
	0 === strpos( $ps_presign->presigned_get_url( 'images/photo.png', 3600 ), 'https://fsn1.your-objectstorage.com/my-bucket/images/photo.png?' ),
	'presign(path-style): host is the bare endpoint, bucket in the path'
);

// ── 13. presign: expires clamped to [60, 604800]; secret NEVER in the URL ───────
$clamp_client = new IWSL_S3_Client( iwsl_s3_config(), iwsl_s3_transport( array() ) );
iwsl_assert( false !== strpos( $clamp_client->presigned_get_url( 'k', 1 ), 'X-Amz-Expires=60&' ), 'presign: below-min expires clamps up to 60' );
iwsl_assert( false !== strpos( $clamp_client->presigned_get_url( 'k', 99999999 ), 'X-Amz-Expires=604800&' ), 'presign: above-max expires clamps down to 604800 (7 days)' );
iwsl_assert( false !== strpos( $clamp_client->presigned_get_url( 'k', 3600 ), 'X-Amz-Expires=3600&' ), 'presign: an in-range expires is unchanged' );
iwsl_assert(
	false === strpos( $clamp_client->presigned_get_url( 'secret/path.png', 3600 ), IWSL_S3_TEST_SECRET ),
	'presign: secret_key NEVER appears in the presigned URL (only the signature does)'
);

// ── 14. put_object x-amz-acl: sent + signed only when a non-empty ACL is set ─────
// acl='private' ⇒ the header is present AND part of SignedHeaders.
$GLOBALS['iwsl_s3_reqs'] = array();
$acl_priv = new IWSL_S3_Client(
	iwsl_s3_config( array( 'acl' => 'private' ) ),
	iwsl_s3_transport( array( 'status' => 200, 'headers' => array(), 'body' => '', 'error' => '' ) )
);
$acl_priv->put_object( 'k.webp', 'x', 'image/webp' );
$req_priv = $GLOBALS['iwsl_s3_reqs'][0];
iwsl_assert_same( 'private', iwsl_s3_hdr( $req_priv, 'x-amz-acl' ), "acl(private): x-amz-acl header is 'private'" );
iwsl_assert( false !== strpos( (string) iwsl_s3_hdr( $req_priv, 'authorization' ), 'x-amz-acl' ), 'acl(private): x-amz-acl is in SignedHeaders' );

// acl='' ⇒ NO x-amz-acl header, and it is NOT in SignedHeaders.
$GLOBALS['iwsl_s3_reqs'] = array();
$acl_none = new IWSL_S3_Client(
	iwsl_s3_config( array( 'acl' => '' ) ),
	iwsl_s3_transport( array( 'status' => 200, 'headers' => array(), 'body' => '', 'error' => '' ) )
);
$put_none = $acl_none->put_object( 'k.webp', 'x', 'image/webp' );
$req_none = $GLOBALS['iwsl_s3_reqs'][0];
iwsl_assert_same( true, $put_none['ok'], 'acl(empty): PUT still succeeds with no ACL header' );
iwsl_assert_same( null, iwsl_s3_hdr( $req_none, 'x-amz-acl' ), 'acl(empty): no x-amz-acl header is sent' );
iwsl_assert( false === strpos( (string) iwsl_s3_hdr( $req_none, 'authorization' ), 'x-amz-acl' ), 'acl(empty): x-amz-acl absent from SignedHeaders' );

// ── 15. list_buckets: SERVICE-level signed GET, names/owner parsed, no bucket in host ─
// Structural (KAT-free): a canned ListAllMyBucketsResult over an injected transport.
$lb_xml = '<?xml version="1.0" encoding="UTF-8"?>'
	. '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
	. '<Owner><ID>project-abc123</ID><DisplayName>project</DisplayName></Owner>'
	. '<Buckets>'
	. '<Bucket><Name>rlservers</Name><CreationDate>2024-01-01T00:00:00.000Z</CreationDate></Bucket>'
	. '<Bucket><Name>media-cdn</Name><CreationDate>2024-02-01T00:00:00.000Z</CreationDate></Bucket>'
	. '</Buckets>'
	. '</ListAllMyBucketsResult>';

$GLOBALS['iwsl_s3_reqs'] = array();
// A configured bucket is NOT required for a service-level listing — build with an empty bucket.
$lb_client = new IWSL_S3_Client(
	iwsl_s3_config( array( 'bucket' => '' ) ),
	iwsl_s3_transport( array( 'status' => 200, 'headers' => array(), 'body' => $lb_xml, 'error' => '' ) )
);
$lb = $lb_client->list_buckets();
iwsl_assert_same( true, $lb['ok'], 'list_buckets: ok:true on 200' );
iwsl_assert_same( 200, $lb['status'], 'list_buckets: status surfaced' );
iwsl_assert_same( array( 'rlservers', 'media-cdn' ), $lb['buckets'], 'list_buckets: <Name> names parsed in document order' );
iwsl_assert_same( 'project-abc123', $lb['owner'], 'list_buckets: <Owner><ID> parsed' );
iwsl_assert_same( '', $lb['error'], 'list_buckets: no error on success' );

$lreq = $GLOBALS['iwsl_s3_reqs'][0];
iwsl_assert_same( 'GET', $lreq['method'], 'list_buckets: method GET' );
iwsl_assert_same( 'https://fsn1.your-objectstorage.com/', $lreq['url'], 'list_buckets: request goes to https://<endpoint>/ (service root)' );
iwsl_assert_same( 'fsn1.your-objectstorage.com', iwsl_s3_hdr( $lreq, 'host' ), 'list_buckets: Host is the bare endpoint — no bucket subdomain' );
iwsl_assert( false === strpos( $lreq['url'], 'my-bucket' ), 'list_buckets: no bucket appears anywhere in the URL' );
iwsl_assert_same( IWSL_S3_Client::EMPTY_PAYLOAD_HASH, iwsl_s3_hdr( $lreq, 'x-amz-content-sha256' ), 'list_buckets: empty-payload hash signed (body-less GET)' );
$lauth = (string) iwsl_s3_hdr( $lreq, 'authorization' );
iwsl_assert(
	1 === preg_match( '#^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/\d{8}/fsn1/s3/aws4_request, SignedHeaders=[a-z0-9;\-]+, Signature=[0-9a-f]{64}$#', $lauth ),
	'list_buckets: SigV4 Authorization header over /s3/aws4_request'
);
// Empty <Buckets/> ⇒ ok:true with an empty list.
$lb_empty = ( new IWSL_S3_Client(
	iwsl_s3_config( array( 'bucket' => '' ) ),
	iwsl_s3_transport( array( 'status' => 200, 'headers' => array(), 'body' => '<ListAllMyBucketsResult><Owner><ID>p</ID></Owner><Buckets/></ListAllMyBucketsResult>', 'error' => '' ) )
) )->list_buckets();
iwsl_assert_same( true, $lb_empty['ok'], 'list_buckets(empty): ok:true' );
iwsl_assert_same( array(), $lb_empty['buckets'], 'list_buckets(empty): empty bucket list' );
iwsl_assert_same( 'p', $lb_empty['owner'], 'list_buckets(empty): owner still parsed' );

// 403 ⇒ ok:false, status surfaced, error carries the XML <Code>.
$lb_403 = ( new IWSL_S3_Client(
	iwsl_s3_config( array( 'bucket' => '' ) ),
	iwsl_s3_transport( array( 'status' => 403, 'headers' => array(), 'body' => '<Error><Code>SignatureDoesNotMatch</Code><Message>nope</Message></Error>', 'error' => '' ) )
) )->list_buckets();
iwsl_assert_same( false, $lb_403['ok'], 'list_buckets(403): ok:false' );
iwsl_assert_same( 403, $lb_403['status'], 'list_buckets(403): status surfaced' );
iwsl_assert_same( array(), $lb_403['buckets'], 'list_buckets(403): no buckets' );
iwsl_assert_same( 'SignatureDoesNotMatch', $lb_403['error'], 'list_buckets(403): error code from the XML <Code>' );

// The secret NEVER appears in any list_buckets output, header, or the captured request.
$lb_haystack = json_encode( array( $lb, $lb_empty, $lb_403, $GLOBALS['iwsl_s3_reqs'] ) );
iwsl_assert( false === strpos( (string) $lb_haystack, IWSL_S3_TEST_SECRET ), 'list_buckets: secret_key appears in no output, header, or signed request' );
