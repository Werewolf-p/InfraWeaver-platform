<?php
/**
 * Minimal, dependency-free S3-compatible object-storage client — the transport
 * behind first-party Hetzner Object Storage (fsn1/nbg1/hel1 `*.your-objectstorage.com`)
 * uploads. NO AWS SDK and NO Composer: AWS Signature V4 is hand-rolled here with
 * PHP core primitives (hash / hash_hmac), and every request rides the WordPress
 * HTTP API (wp_remote_request), which is injectable so the whole client runs under
 * the zero-dependency test harness with a captured transport and a fixed clock.
 *
 * WHAT IT DOES. put_object / head_object / delete_object sign an https request to
 * `<bucket>.<endpoint>` (virtual-hosted, default) or `<endpoint>/<bucket>`
 * (path-style) and return a small immutable result array. public_url renders an
 * object's public https URL. test_connection round-trips a fixed-key probe object
 * (PUT → HEAD → DELETE) so an operator can confirm credentials + reachability.
 *
 * SIGV4. sigv4() is a PURE function of its inputs (no network, no state): it builds
 * the canonical request (verb, URI, query, sorted lowercased canonical headers +
 * signed-header list, hashed payload), the AWS4-HMAC-SHA256 string-to-sign, the
 * date→region→service→'aws4_request' signing-key HMAC chain, and the Authorization
 * header. The payload is ALWAYS signed (sha256 hex of the body — never
 * UNSIGNED-PAYLOAD). It is exposed so a known-answer test can pin it to AWS's
 * published Signature V4 example, and is reused by every signed request below.
 *
 * SECURITY. Scheme is ALWAYS https (an http:// endpoint is refused, never
 * downgraded). The endpoint host must not resolve into a loopback / link-local /
 * private range — the same SSRF guard idea as IWSL_Broken_Link_Scan
 * ::resolves_to_private_ip(), duplicated locally (host resolver injectable). The
 * `secret_key` is used only inside the HMAC chain: it NEVER appears in any returned
 * array, error string, or the Authorization header (which carries the access key id
 * and the signature only). Empty endpoint / bucket / key / credentials fail with a
 * structured { ok:false, error } — never a fatal.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_S3_Client {

	/** SigV4 signing service + algorithm label. */
	const SERVICE   = 's3';
	const ALGORITHM = 'AWS4-HMAC-SHA256';

	/** SigV4 defaults. */
	const DEFAULT_REGION = 'us-east-1';
	const DEFAULT_ACL    = 'public-read';

	/** sha256 hex of the empty string — the payload hash for a body-less request. */
	const EMPTY_PAYLOAD_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

	/** The documented payload-hash literal for a query-string presigned request (body not signed). */
	const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

	/** SigV4 query-string presign lifetime bounds (seconds) — S3 caps at 7 days. */
	const PRESIGN_MIN_EXPIRES = 60;
	const PRESIGN_MAX_EXPIRES = 604800;

	/** Per-request network timeout for the default transport (seconds). */
	const TIMEOUT_S = 20;

	/** Deterministic connectivity-probe object (fixed — never random/time-based). */
	const PROBE_KEY  = '.iwsl-probe-connectivity';
	const PROBE_BODY = 'iwsl-s3-connectivity-probe';

	/** @var string Lowercased endpoint HOST only, no scheme/path (e.g. fsn1.your-objectstorage.com). */
	private $endpoint;

	/** @var bool True when the configured endpoint carried a non-https scheme (refused). */
	private $endpoint_insecure;

	/** @var string */
	private $region;

	/** @var string */
	private $bucket;

	/** @var string */
	private $access_key;

	/** @var string SECRET — used only in the HMAC chain, never returned or logged. */
	private $secret_key;

	/** @var string x-amz-acl sent on PUT. */
	private $acl;

	/** @var bool false = virtual-hosted-style host, true = path-style. */
	private $path_style;

	/** @var callable():int Unix seconds; injectable for a deterministic x-amz-date. */
	private $clock;

	/** @var callable(string):string host → resolved IP for the SSRF guard. */
	private $resolver;

	/** @var callable(array):array Transport: fn({method,url,headers,body}):{status,headers,body,error}. */
	private $http;

	/**
	 * @param array         $config { endpoint, region, bucket, access_key, secret_key,
	 *                              acl, path_style, clock?, resolver? }. endpoint is a
	 *                              bare host; a scheme other than https is refused.
	 * @param callable|null $http   Transport override for tests; defaults to a
	 *                              wp_remote_request wrapper.
	 */
	public function __construct( array $config, ?callable $http = null ) {
		$this->endpoint_insecure = false;
		$this->endpoint          = $this->normalize_endpoint( isset( $config['endpoint'] ) ? (string) $config['endpoint'] : '' );

		$this->region     = isset( $config['region'] ) && '' !== (string) $config['region'] ? (string) $config['region'] : self::DEFAULT_REGION;
		$this->bucket     = isset( $config['bucket'] ) ? trim( (string) $config['bucket'] ) : '';
		$this->access_key = isset( $config['access_key'] ) ? (string) $config['access_key'] : '';
		$this->secret_key = isset( $config['secret_key'] ) ? (string) $config['secret_key'] : '';
		// An ABSENT acl key defaults to public-read; an explicit '' means "send no
		// x-amz-acl" (private / bucket-policy delivery). '' is preserved verbatim.
		$this->acl        = array_key_exists( 'acl', $config ) ? (string) $config['acl'] : self::DEFAULT_ACL;
		$this->path_style = ! empty( $config['path_style'] );

		$this->clock = isset( $config['clock'] ) && is_callable( $config['clock'] )
			? $config['clock']
			: static function (): int {
				return time();
			};

		$this->resolver = isset( $config['resolver'] ) && is_callable( $config['resolver'] )
			? $config['resolver']
			: static function ( string $host ): string {
				return function_exists( 'gethostbyname' ) ? (string) gethostbyname( $host ) : $host;
			};

		$this->http = null !== $http ? $http : self::default_http();
	}

	// ── public object operations ──────────────────────────────────────────────

	/**
	 * SigV4-signed PUT. Sends x-amz-acl (from config), the object body, and its
	 * Content-Type. The payload is signed (x-amz-content-sha256 = sha256(body)).
	 *
	 * @return array { ok:bool, status:int, etag?:string, error?:string }
	 */
	public function put_object( string $key, string $body, string $content_type = 'application/octet-stream' ): array {
		$err = $this->precheck( $key );
		if ( '' !== $err ) {
			return array( 'ok' => false, 'status' => 0, 'error' => $err );
		}
		$amz = array( 'content-type' => $content_type );
		if ( '' !== $this->acl ) {
			// Only sign + send x-amz-acl when an ACL is actually configured (a private
			// bucket omits it entirely — the header is neither wired nor signed).
			$amz['x-amz-acl'] = $this->acl;
		}
		$res  = $this->execute( 'PUT', $key, $body, $amz );
		$ok   = '' === $res['error'] && $res['status'] >= 200 && $res['status'] < 300;
		$out  = array( 'ok' => $ok, 'status' => $res['status'] );
		$etag = self::etag_of( $res );
		if ( '' !== $etag ) {
			$out['etag'] = $etag;
		}
		if ( ! $ok ) {
			$out['error'] = self::request_error( $res );
		}
		return $out;
	}

	/**
	 * SigV4-signed HEAD. `exists` is true on a 2xx; `ok` is true whenever the request
	 * completed with a definite HTTP status (a 404 is a successful, negative answer).
	 *
	 * @return array { ok:bool, exists:bool, status:int, etag?:string, error?:string }
	 */
	public function head_object( string $key ): array {
		$err = $this->precheck( $key );
		if ( '' !== $err ) {
			return array( 'ok' => false, 'exists' => false, 'status' => 0, 'error' => $err );
		}
		$res       = $this->execute( 'HEAD', $key, '', array() );
		$completed = '' === $res['error'] && $res['status'] > 0;
		$exists    = $res['status'] >= 200 && $res['status'] < 300;
		$out       = array( 'ok' => $completed, 'exists' => $exists, 'status' => $res['status'] );
		$etag      = self::etag_of( $res );
		if ( '' !== $etag ) {
			$out['etag'] = $etag;
		}
		if ( ! $completed ) {
			$out['error'] = self::request_error( $res );
		}
		return $out;
	}

	/**
	 * SigV4-signed DELETE. S3 answers 204 (or 200) on success; idempotent (a delete
	 * of a missing key still reports 204).
	 *
	 * @return array { ok:bool, status:int, error?:string }
	 */
	public function delete_object( string $key ): array {
		$err = $this->precheck( $key );
		if ( '' !== $err ) {
			return array( 'ok' => false, 'status' => 0, 'error' => $err );
		}
		$res = $this->execute( 'DELETE', $key, '', array() );
		$ok  = '' === $res['error'] && ( 204 === $res['status'] || 200 === $res['status'] );
		$out = array( 'ok' => $ok, 'status' => $res['status'] );
		if ( ! $ok ) {
			$out['error'] = self::request_error( $res );
		}
		return $out;
	}

	/**
	 * The object's public https URL. Virtual-hosted `https://<bucket>.<endpoint>/<key>`
	 * or path-style `https://<endpoint>/<bucket>/<key>`. Key path segments are
	 * url-encoded but '/' is preserved.
	 */
	public function public_url( string $key ): string {
		$path = self::encode_key_path( $key );
		if ( $this->path_style ) {
			return 'https://' . $this->endpoint . '/' . rawurlencode( $this->bucket ) . $path;
		}
		return 'https://' . $this->bucket . '.' . $this->endpoint . $path;
	}

	/**
	 * A SigV4 query-string presigned GET URL — a time-limited link that authorizes a
	 * single read with no credentials (the signature is the authorization). The
	 * canonical request is GET over the key path (same host/style logic as
	 * public_url), the sorted X-Amz-* query, `host` as the only signed header, and the
	 * literal UNSIGNED-PAYLOAD as the payload hash. The final X-Amz-Signature is
	 * appended AFTER signing. The `secret_key` never appears in the URL — only the
	 * derived hex signature does. `$expires` (seconds) is clamped to S3's
	 * [60, 604800] (7-day max). The injected clock drives X-Amz-Date, so the URL is
	 * deterministic under test.
	 */
	public function presigned_get_url( string $key, int $expires = 3600 ): string {
		$expires  = self::clamp_expires( $expires );
		$host     = $this->host();
		$uri      = $this->canonical_uri( $key );
		$amz_date = $this->amz_date();
		$scope    = substr( $amz_date, 0, 8 ) . '/' . $this->region . '/' . self::SERVICE . '/aws4_request';

		$canonical_query = self::canonical_query(
			array(
				'X-Amz-Algorithm'     => self::ALGORITHM,
				'X-Amz-Credential'    => $this->access_key . '/' . $scope,
				'X-Amz-Date'          => $amz_date,
				'X-Amz-Expires'       => (string) $expires,
				'X-Amz-SignedHeaders' => 'host',
			)
		);

		$signed = self::sigv4(
			'GET',
			$uri,
			$canonical_query,
			array( 'host' => $host ),
			self::UNSIGNED_PAYLOAD,
			$amz_date,
			$this->region,
			self::SERVICE,
			$this->access_key,
			$this->secret_key
		);

		return 'https://' . $host . $uri . '?' . $canonical_query . '&X-Amz-Signature=' . $signed['signature'];
	}

	/**
	 * Round-trip a fixed-key probe object to confirm credentials + reachability:
	 * PUT → HEAD → DELETE. The probe key is deterministic (never random/time-based)
	 * so the flow is reproducible under the test harness; an optional override is
	 * accepted. DELETE is best-effort cleanup and always attempted.
	 *
	 * @return array { ok:bool, steps:array, error?:string }
	 */
	public function test_connection( ?string $probe_key = null ): array {
		$key   = ( null !== $probe_key && '' !== $probe_key ) ? $probe_key : self::PROBE_KEY;
		$steps = array();

		$put            = $this->put_object( $key, self::PROBE_BODY, 'text/plain' );
		$steps['put']   = array( 'ok' => $put['ok'], 'status' => $put['status'] );
		if ( ! $put['ok'] ) {
			return array(
				'ok'    => false,
				'steps' => $steps,
				'error' => isset( $put['error'] ) ? $put['error'] : 'put-failed',
			);
		}

		$head          = $this->head_object( $key );
		$steps['head'] = array( 'ok' => $head['ok'], 'exists' => $head['exists'], 'status' => $head['status'] );

		$del             = $this->delete_object( $key ); // Best-effort cleanup regardless of HEAD.
		$steps['delete'] = array( 'ok' => $del['ok'], 'status' => $del['status'] );

		$ok  = $put['ok'] && $head['ok'] && $head['exists'] && $del['ok'];
		$out = array( 'ok' => $ok, 'steps' => $steps );
		if ( ! $ok ) {
			$out['error'] = 'probe-failed';
		}
		return $out;
	}

	/**
	 * List the buckets visible to the configured credentials — a SERVICE-level
	 * SigV4-signed GET on the object-storage root (`https://<endpoint>/`, canonical
	 * URI `/`, empty query, empty-body payload hash). The Host is the bare endpoint —
	 * NEVER `<bucket>.<endpoint>` — so no bucket subdomain is addressed, and a
	 * configured bucket is NOT required (this works with an empty bucket). Hetzner's
	 * ListBuckets is per-location, so this reports only the buckets in the endpoint's
	 * location. The `<Name>` elements become `buckets`, `<Owner><ID>` becomes `owner`.
	 * On a non-2xx reply `ok` is false, `status` is surfaced, and `error` carries the
	 * XML `<Code>` when present (else the transport error, else `http-<status>`). The
	 * `secret_key` never appears in any returned value.
	 *
	 * @return array{ ok:bool, buckets:string[], owner:string, status:int, error:string }
	 */
	public function list_buckets(): array {
		$err = $this->precheck_service();
		if ( '' !== $err ) {
			return array( 'ok' => false, 'buckets' => array(), 'owner' => '', 'status' => 0, 'error' => $err );
		}

		$host          = $this->endpoint; // SERVICE-level: the bare endpoint, no bucket subdomain.
		$canonical_uri = '/';
		$url           = 'https://' . $host . $canonical_uri;
		$payload_hash  = self::EMPTY_PAYLOAD_HASH; // body-less GET.
		$amz_date      = $this->amz_date();

		$sign_headers = array(
			'host'                 => $host,
			'x-amz-content-sha256' => $payload_hash,
			'x-amz-date'           => $amz_date,
		);

		$signed = self::sigv4(
			'GET',
			$canonical_uri,
			'',
			$sign_headers,
			$payload_hash,
			$amz_date,
			$this->region,
			self::SERVICE,
			$this->access_key,
			$this->secret_key
		);

		$wire                  = $sign_headers;
		$wire['authorization'] = $signed['authorization'];

		$raw = ( $this->http )( array(
			'method'  => 'GET',
			'url'     => $url,
			'headers' => $wire,
			'body'    => '',
		) );
		$res = self::normalize_response( $raw );

		if ( '' !== $res['error'] || $res['status'] < 200 || $res['status'] >= 300 ) {
			return array(
				'ok'      => false,
				'buckets' => array(),
				'owner'   => '',
				'status'  => $res['status'],
				'error'   => self::list_error( $res ),
			);
		}

		return array(
			'ok'      => true,
			'buckets' => self::parse_bucket_names( $res['body'] ),
			'owner'   => self::parse_owner_id( $res['body'] ),
			'status'  => $res['status'],
			'error'   => '',
		);
	}

	// ── AWS Signature V4 (pure) ───────────────────────────────────────────────

	/**
	 * Compute the SigV4 Authorization header and its intermediate artifacts for a
	 * request. Pure — no network, no object state. The caller supplies an already
	 * canonicalized query string (sorted, url-encoded) and the hashed payload.
	 *
	 * @param array  $headers      name => value (any case); the SIGNED header set.
	 * @param string $payload_hash sha256 hex of the body (or the documented literal).
	 * @param string $amz_date     ISO-basic timestamp, e.g. 20150830T123600Z.
	 * @return array { canonical_request, string_to_sign, signature, authorization,
	 *                 signed_headers, signing_key_hex }
	 */
	public static function sigv4(
		string $method,
		string $canonical_uri,
		string $canonical_query,
		array $headers,
		string $payload_hash,
		string $amz_date,
		string $region,
		string $service,
		string $access_key,
		string $secret_key
	): array {
		$canon = array();
		foreach ( $headers as $name => $value ) {
			$canon[ strtolower( trim( (string) $name ) ) ] = self::trim_header_value( (string) $value );
		}
		ksort( $canon );

		$canonical_headers = '';
		foreach ( $canon as $name => $value ) {
			$canonical_headers .= $name . ':' . $value . "\n";
		}
		$signed_headers = implode( ';', array_keys( $canon ) );

		$canonical_request = $method . "\n"
			. $canonical_uri . "\n"
			. $canonical_query . "\n"
			. $canonical_headers . "\n"
			. $signed_headers . "\n"
			. $payload_hash;

		$date_stamp = substr( $amz_date, 0, 8 );
		$scope      = $date_stamp . '/' . $region . '/' . $service . '/aws4_request';

		$string_to_sign = self::ALGORITHM . "\n"
			. $amz_date . "\n"
			. $scope . "\n"
			. hash( 'sha256', $canonical_request );

		$signing_key = self::signing_key( $secret_key, $date_stamp, $region, $service );
		$signature   = hash_hmac( 'sha256', $string_to_sign, $signing_key );

		$authorization = self::ALGORITHM . ' '
			. 'Credential=' . $access_key . '/' . $scope . ', '
			. 'SignedHeaders=' . $signed_headers . ', '
			. 'Signature=' . $signature;

		return array(
			'canonical_request' => $canonical_request,
			'string_to_sign'    => $string_to_sign,
			'signature'         => $signature,
			'authorization'     => $authorization,
			'signed_headers'    => $signed_headers,
			'signing_key_hex'   => bin2hex( $signing_key ),
		);
	}

	/**
	 * The SigV4 signing key: HMAC chain over date → region → service → 'aws4_request',
	 * seeded with 'AWS4' + secret. Returns raw bytes.
	 */
	public static function signing_key( string $secret_key, string $date_stamp, string $region, string $service ): string {
		$k_date    = hash_hmac( 'sha256', $date_stamp, 'AWS4' . $secret_key, true );
		$k_region  = hash_hmac( 'sha256', $region, $k_date, true );
		$k_service = hash_hmac( 'sha256', $service, $k_region, true );
		return hash_hmac( 'sha256', 'aws4_request', $k_service, true );
	}

	// ── request assembly ──────────────────────────────────────────────────────

	/**
	 * Sign and dispatch one object request through the transport. Builds the host
	 * (virtual/path style), the canonical URI, the signed amz headers, and the
	 * Authorization header, then hands a normalized request to $this->http.
	 *
	 * @param array $amz_extra Extra SIGNED headers (lowercased), e.g. content-type / x-amz-acl.
	 * @return array { status:int, error:string, headers:array, body:string }
	 */
	private function execute( string $method, string $key, string $body, array $amz_extra ): array {
		$host          = $this->host();
		$canonical_uri = $this->canonical_uri( $key );
		$url           = 'https://' . $host . $canonical_uri;
		$payload_hash  = self::hashed_payload( $body );
		$amz_date      = $this->amz_date();

		$sign_headers = array(
			'host'                 => $host,
			'x-amz-content-sha256' => $payload_hash,
			'x-amz-date'           => $amz_date,
		);
		foreach ( $amz_extra as $name => $value ) {
			$sign_headers[ strtolower( (string) $name ) ] = (string) $value;
		}

		$signed = self::sigv4(
			$method,
			$canonical_uri,
			'',
			$sign_headers,
			$payload_hash,
			$amz_date,
			$this->region,
			self::SERVICE,
			$this->access_key,
			$this->secret_key
		);

		$wire                  = $sign_headers;
		$wire['authorization'] = $signed['authorization'];

		$raw = ( $this->http )( array(
			'method'  => $method,
			'url'     => $url,
			'headers' => $wire,
			'body'    => $body,
		) );
		return self::normalize_response( $raw );
	}

	/** The request Host header: virtual-hosted `<bucket>.<endpoint>` or path-style `<endpoint>`. */
	private function host(): string {
		return $this->path_style ? $this->endpoint : $this->bucket . '.' . $this->endpoint;
	}

	/** The canonical URI (encoded key path), with the bucket prefixed under path-style. */
	private function canonical_uri( string $key ): string {
		$path = self::encode_key_path( $key );
		if ( $this->path_style ) {
			return '/' . rawurlencode( $this->bucket ) . $path;
		}
		return $path;
	}

	/** Current x-amz-date from the injected clock (ISO basic, UTC). */
	private function amz_date(): string {
		return gmdate( 'Ymd\THis\Z', ( $this->clock )() );
	}

	// ── validation / SSRF guard ───────────────────────────────────────────────

	/**
	 * Structured pre-flight validation for a keyed operation. Returns '' when the
	 * request may proceed, or a stable error code otherwise — the client NEVER
	 * fatals on empty config. The secret is never referenced in any code returned.
	 */
	private function precheck( string $key ): string {
		if ( '' === $this->endpoint ) {
			return 'endpoint-missing';
		}
		if ( $this->endpoint_insecure ) {
			return 'endpoint-insecure-scheme';
		}
		if ( '' === $this->bucket ) {
			return 'bucket-missing';
		}
		if ( '' === $this->access_key || '' === $this->secret_key ) {
			return 'credentials-missing';
		}
		if ( '' === trim( $key ) ) {
			return 'key-missing';
		}
		if ( $this->resolves_to_private_ip( $this->endpoint ) ) {
			return 'endpoint-private-ip';
		}
		return '';
	}

	/**
	 * Service-level pre-flight validation (no bucket / no key) for list_buckets().
	 * Same fail-closed idiom as precheck(): endpoint present, https-only, credentials
	 * present, and not an SSRF target. The secret is never referenced in any code.
	 */
	private function precheck_service(): string {
		if ( '' === $this->endpoint ) {
			return 'endpoint-missing';
		}
		if ( $this->endpoint_insecure ) {
			return 'endpoint-insecure-scheme';
		}
		if ( '' === $this->access_key || '' === $this->secret_key ) {
			return 'credentials-missing';
		}
		if ( $this->resolves_to_private_ip( $this->endpoint ) ) {
			return 'endpoint-private-ip';
		}
		return '';
	}

	/**
	 * Whether the endpoint host resolves to a loopback / link-local / private
	 * (RFC1918 or ULA) / reserved address — an SSRF target that must never be
	 * signed and requested. Duplicates the guard idea in IWSL_Broken_Link_Scan
	 * ::resolves_to_private_ip() (which this file may not edit). A host that does
	 * not resolve to a literal IP is NOT provably internal and is left to the
	 * transport (which will simply fail to connect).
	 */
	private function resolves_to_private_ip( string $host ): bool {
		$host = strtolower( trim( $host ) );
		if ( '' === $host ) {
			return false;
		}
		if ( '[' === $host[0] && ']' === substr( $host, -1 ) ) {
			$host = substr( $host, 1, -1 ); // Bracketed IPv6 literal → bare address.
		}
		$ip = filter_var( $host, FILTER_VALIDATE_IP ) ? $host : (string) ( $this->resolver )( $host );
		if ( false === filter_var( $ip, FILTER_VALIDATE_IP ) ) {
			return false; // Did not resolve to a literal IP — not provably internal.
		}
		return false === filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE );
	}

	/**
	 * Normalize the configured endpoint to a bare, lowercased HOST. https:// is
	 * stripped; any OTHER scheme flips the insecure flag so precheck() refuses it
	 * (scheme is always https — never silently downgraded). Port/path are dropped.
	 */
	private function normalize_endpoint( string $raw ): string {
		$endpoint = trim( $raw );
		if ( false !== strpos( $endpoint, '://' ) ) {
			if ( 0 === stripos( $endpoint, 'https://' ) ) {
				$endpoint = substr( $endpoint, 8 );
			} else {
				$this->endpoint_insecure = true;
				$endpoint                = (string) preg_replace( '#^[a-zA-Z][a-zA-Z0-9+.\-]*://#', '', $endpoint );
			}
		}
		$endpoint = rtrim( $endpoint, '/' );
		$slash    = strpos( $endpoint, '/' );
		if ( false !== $slash ) {
			$endpoint = substr( $endpoint, 0, $slash ); // Drop any accidental path.
		}
		return strtolower( $endpoint );
	}

	// ── helpers ───────────────────────────────────────────────────────────────

	/** sha256 hex of the request body — the SIGNED payload hash (never UNSIGNED-PAYLOAD). */
	private static function hashed_payload( string $body ): string {
		return '' === $body ? self::EMPTY_PAYLOAD_HASH : hash( 'sha256', $body );
	}

	/**
	 * A SigV4 canonical query string: each name + value RFC3986-encoded (rawurlencode),
	 * the pairs sorted by name. Used for query-string presigning.
	 */
	private static function canonical_query( array $params ): string {
		ksort( $params, SORT_STRING );
		$pairs = array();
		foreach ( $params as $name => $value ) {
			$pairs[] = rawurlencode( (string) $name ) . '=' . rawurlencode( (string) $value );
		}
		return implode( '&', $pairs );
	}

	/** Clamp a presign lifetime to S3's supported [60, 604800] second window. */
	private static function clamp_expires( int $expires ): int {
		if ( $expires < self::PRESIGN_MIN_EXPIRES ) {
			return self::PRESIGN_MIN_EXPIRES;
		}
		if ( $expires > self::PRESIGN_MAX_EXPIRES ) {
			return self::PRESIGN_MAX_EXPIRES;
		}
		return $expires;
	}

	/** Encode a key into a canonical path: leading '/', each segment url-encoded, '/' kept. */
	private static function encode_key_path( string $key ): string {
		$key = ltrim( $key, '/' );
		if ( '' === $key ) {
			return '/';
		}
		$segments = array_map( 'rawurlencode', explode( '/', $key ) );
		return '/' . implode( '/', $segments );
	}

	/** SigV4 header-value normalization: trim and collapse internal whitespace runs. */
	private static function trim_header_value( string $value ): string {
		return (string) preg_replace( '/\s+/', ' ', trim( $value ) );
	}

	/** The ETag from a response, quotes stripped, or '' when absent. */
	private static function etag_of( array $res ): string {
		$etag = isset( $res['headers']['etag'] ) ? (string) $res['headers']['etag'] : '';
		return trim( $etag, '"' );
	}

	/** A stable error string for a failed request — transport error, else `http-<status>`. */
	private static function request_error( array $res ): string {
		if ( '' !== $res['error'] ) {
			return $res['error'];
		}
		return 'http-' . (int) $res['status'];
	}

	/**
	 * The error code for a failed ListBuckets: prefer the S3 XML `<Code>` (e.g.
	 * SignatureDoesNotMatch / AccessDenied), then the transport error, then
	 * `http-<status>`. Never carries the secret.
	 */
	private static function list_error( array $res ): string {
		$code = self::parse_xml_tag( $res['body'], 'Code' );
		if ( '' !== $code ) {
			return $code;
		}
		return self::request_error( $res );
	}

	/**
	 * The bucket names from a ListAllMyBucketsResult body. Only `<Bucket>` entries
	 * carry a `<Name>` (the owner carries `<ID>`/`<DisplayName>`), so a global
	 * `<Name>` match yields exactly the bucket names, in document order.
	 */
	private static function parse_bucket_names( string $xml ): array {
		if ( '' === $xml ) {
			return array();
		}
		$names = array();
		if ( preg_match_all( '#<Name>(.*?)</Name>#s', $xml, $m ) ) {
			foreach ( $m[1] as $raw ) {
				$name = self::xml_decode( trim( (string) $raw ) );
				if ( '' !== $name ) {
					$names[] = $name;
				}
			}
		}
		return $names;
	}

	/** The owner id (`<Owner><ID>…</ID></Owner>`) from a ListAllMyBucketsResult body, or ''. */
	private static function parse_owner_id( string $xml ): string {
		if ( '' !== $xml && preg_match( '#<Owner>.*?<ID>(.*?)</ID>.*?</Owner>#s', $xml, $m ) ) {
			return self::xml_decode( trim( (string) $m[1] ) );
		}
		return '';
	}

	/** The text of the FIRST `<$tag>…</$tag>` element, xml-decoded, or '' when absent. */
	private static function parse_xml_tag( string $xml, string $tag ): string {
		if ( '' === $xml ) {
			return '';
		}
		$q = preg_quote( $tag, '#' );
		if ( preg_match( '#<' . $q . '>(.*?)</' . $q . '>#s', $xml, $m ) ) {
			return self::xml_decode( trim( (string) $m[1] ) );
		}
		return '';
	}

	/** Decode XML/HTML entities in a parsed value (bucket / owner ids are plain, but be safe). */
	private static function xml_decode( string $value ): string {
		return html_entity_decode( $value, ENT_QUOTES | ENT_XML1, 'UTF-8' );
	}

	/**
	 * Normalize a transport reply into { status:int, error:string, headers:array,
	 * body:string } with lowercased header keys, tolerating a partial array.
	 *
	 * @param mixed $raw
	 */
	private static function normalize_response( $raw ): array {
		$status  = is_array( $raw ) && isset( $raw['status'] ) ? (int) $raw['status'] : 0;
		$error   = is_array( $raw ) && isset( $raw['error'] ) ? (string) $raw['error'] : '';
		$body    = is_array( $raw ) && isset( $raw['body'] ) ? (string) $raw['body'] : '';
		$headers = is_array( $raw ) && isset( $raw['headers'] ) && is_array( $raw['headers'] ) ? $raw['headers'] : array();

		$norm = array();
		foreach ( $headers as $name => $value ) {
			$norm[ strtolower( (string) $name ) ] = is_array( $value ) ? (string) reset( $value ) : (string) $value;
		}
		return array( 'status' => $status, 'error' => $error, 'headers' => $norm, 'body' => $body );
	}

	/**
	 * The default transport: wp_remote_request, normalized to the client's shape.
	 * Returns status 0 with an error outside a WordPress HTTP context so nothing is
	 * mistaken for a successful response.
	 *
	 * @return callable(array):array
	 */
	private static function default_http(): callable {
		return static function ( array $req ): array {
			if ( ! function_exists( 'wp_remote_request' ) ) {
				return array( 'status' => 0, 'headers' => array(), 'body' => '', 'error' => 'no-transport' );
			}
			$response = wp_remote_request(
				$req['url'],
				array(
					'method'    => $req['method'],
					'headers'   => $req['headers'],
					'body'      => $req['body'],
					'timeout'   => self::TIMEOUT_S,
					'sslverify' => true,
				)
			);
			if ( function_exists( 'is_wp_error' ) && is_wp_error( $response ) ) {
				$msg = '';
				if ( is_object( $response ) && method_exists( $response, 'get_error_message' ) ) {
					$msg = (string) $response->get_error_message();
				}
				return array(
					'status'  => 0,
					'headers' => array(),
					'body'    => '',
					'error'   => '' !== $msg ? $msg : 'request-failed',
				);
			}
			$status  = function_exists( 'wp_remote_retrieve_response_code' ) ? (int) wp_remote_retrieve_response_code( $response ) : 0;
			$headers = function_exists( 'wp_remote_retrieve_headers' ) ? wp_remote_retrieve_headers( $response ) : array();
			$body    = function_exists( 'wp_remote_retrieve_body' ) ? (string) wp_remote_retrieve_body( $response ) : '';

			$norm = array();
			if ( is_array( $headers ) || $headers instanceof Traversable ) {
				foreach ( $headers as $name => $value ) {
					$norm[ strtolower( (string) $name ) ] = is_array( $value ) ? (string) reset( $value ) : (string) $value;
				}
			}
			return array( 'status' => $status, 'headers' => $norm, 'body' => $body, 'error' => '' );
		};
	}
}
