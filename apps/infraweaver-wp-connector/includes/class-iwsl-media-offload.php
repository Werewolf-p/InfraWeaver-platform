<?php
/**
 * Media Offload to S3 (Hetzner Object Storage) — the self-contained engine that
 * ships a site's already-optimized lossless WebP derivatives to a first-party
 * Hetzner Object Storage bucket (fsn1/nbg1/hel1 `*.your-objectstorage.com`) and
 * rewrites front-end image references to the public bucket URL.
 *
 * WHY NO NEW ENTITLEMENT. Offload only ever uploads the WebP derivatives produced
 * by IWSL_Media_Optimizer, so it gates on the SAME flag — IWSL_Media_Optimizer
 * ::FEATURE ('image_optimization'). Three-layer gate, identical idiom to the
 * optimizer: (1) render_section(), (2) every AJAX / admin-post handler, (3) each
 * mutator (save_settings / offload_one / unoffload_one) re-checks as STATEMENT 1.
 * A locked / revoked / heartbeat-stale site attaches no rewrite filters (register()
 * returns early) and every handler refuses, so the site behaves like stock WP.
 *
 * WHAT IT DOES. A bounded batch pass (ONE image per AJAX request, like the optimizer
 * popup) finds qualifying attachments whose WebP derivative EXISTS and are not yet
 * offloaded, PUTs the file bytes to `<uploads-relative-path>.webp`, HEAD-verifies the
 * object (etag), and ONLY THEN records `_iwsl_offload = { key, url, etag, ts }` in
 * attachment meta. If the PUT or the HEAD verification fails the mapping is NOT
 * written — the image is simply retried next pass. An image qualifies when
 * (rule "offload all optimized" is ON and it carries IWSL_Media_Optimizer::META_KEY)
 * OR it is manually forced on; never when it is manually forced off.
 *
 * PRESERVATION. Nothing is ever deleted: the local original AND the local derivative
 * always stay on disk. "Remove from bucket" (per-image / bulk) deletes the S3 object
 * and clears the mapping meta — the local files are untouched.
 *
 * SECURITY. The S3 `secret_key` is encrypted AT REST with AES-256-GCM under a key
 * HKDF-derived from the WordPress secret salts (same approach as IWSL_Email_Delivery)
 * — fail-closed, never echoed, never returned by settings_for_render(), never logged.
 * IWSL_S3_Client already SSRF-guards the endpoint and never leaks the secret. Every
 * AJAX / admin-post handler requires manage_options + a nonce and has NO nopriv twin.
 * All admin output is escaped. WordPress calls are function_exists-guarded and the
 * S3 client, the derivative resolver, the uploads base dir, and the clock are all
 * injectable seams so the whole engine runs under the zero-dependency test harness
 * with a fake S3 client and no network.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Media_Offload {

	/** Gate on the optimizer's flag — offload only ships its optimized WebPs. */
	const FEATURE = IWSL_Media_Optimizer::FEATURE; // 'image_optimization'

	/** Meta that marks an attachment as optimized (the offload-rule input). */
	const OPTIMIZED_META = IWSL_Media_Optimizer::META_KEY; // '_iwsl_media_optimizer'

	/** Attachment meta holding the offload mapping { key, url, etag, ts }. */
	const OFFLOAD_META = '_iwsl_offload';

	/** Store key for the settings map (IWSL_WP_Store prefixes → iwsl_media_offload). */
	const SETTINGS_KEY = 'media_offload';
	/** Store key for the per-attachment manual allow/deny override map. */
	const MANUAL_KEY = 'media_offload_manual';

	/** Hetzner Object Storage locations → human label. Location IS the region. */
	const LOCATIONS = array(
		'fsn1' => 'Falkenstein',
		'nbg1' => 'Nuremberg',
		'hel1' => 'Helsinki',
	);
	/** Object-storage host suffix; endpoint host = "<loc>.<suffix>". */
	const ENDPOINT_SUFFIX = 'your-objectstorage.com';

	/** Object ACL per delivery mode + addressing (virtual-hosted). */
	const ACL         = 'public-read'; // public delivery — the object is world-readable.
	const ACL_PRIVATE = 'private';     // private delivery — reads go through presigned URLs.
	const PATH_STYLE  = false;

	/** Delivery modes + presigned-link lifetime bounds (seconds; S3 caps at 7 days). */
	const ACCESS_PUBLIC  = 'public';
	const ACCESS_PRIVATE = 'private';
	const DEFAULT_TTL    = 86400;  // 1 day.
	const MIN_TTL        = 300;    // 5 minutes.
	const MAX_TTL        = 604800; // 7 days.
	/** Content type of every offloaded object (always the lossless WebP derivative). */
	const CONTENT_TYPE = 'image/webp';

	/** Defensive cap on the manual-override map (unbounded option guard). */
	const MAX_MANUAL = 5000;
	/** Largest derivative we will read into memory and PUT (bytes). */
	const MAX_OFFLOAD_BYTES = 26214400; // 25 MiB — mirrors the optimizer's source ceiling.

	/** AES-256-GCM at-rest secret encryption (mirrors IWSL_Email_Delivery). */
	const ENC_MARKER   = 'IWSLENCv1:';
	const ENC_CIPHER   = 'aes-256-gcm';
	const ENC_IV_LEN   = 12;
	const ENC_TAG_LEN  = 16;
	const ENC_HKDF_INFO = 'IWSL-media-offload-s3-secret-v1';

	/** Logged-in AJAX actions (no nopriv twins) + their shared nonce. */
	const AJAX_TEST      = 'iwsl_media_offload_test';
	const AJAX_STATUS    = 'iwsl_media_offload_status';
	const AJAX_BATCH     = 'iwsl_media_offload_batch';
	const AJAX_UNOFFLOAD = 'iwsl_media_offload_unoffload';
	const AJAX_MANUAL    = 'iwsl_media_offload_manual';
	const NONCE          = 'iwsl_media_offload';

	/** admin-post settings save action + nonce (PRG). */
	const ACTION_SAVE = 'iwsl_media_offload_save';
	const NONCE_SAVE  = 'iwsl_media_offload_save';

	/** The Plus admin page + tab this section lives under (for the PRG redirect). */
	const PAGE_SLUG = 'infraweaver-plus';
	const TAB_ID    = 'media-offload';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings + manual map live here. */
	private $store;

	/** @var callable():int current unix seconds. */
	private $now;

	/** @var callable():string WP secret-salt IKM — the encryption-key material; NEVER stored. */
	private $salt;

	/** @var callable(array):object fn(config): an S3 client (put/head/delete/public_url/test). */
	private $s3_factory;

	/** @var callable(int):array fn(id): { path, url, exists } — the WebP derivative descriptor. */
	private $derivative_resolver;

	/** @var callable():string fn(): the uploads base directory (absolute), for key derivation. */
	private $upload_basedir;

	/** @var callable(int):int[] fn(limit): candidate attachment ids to consider for offload. */
	private $candidate_provider;

	/** @var bool|null memoized gate result for this request. */
	private $unlocked_cache = null;

	/**
	 * @param IWSL_Entitlements $entitlements        The gate (image_optimization).
	 * @param IWSL_Store        $store               Settings + manual-map persistence.
	 * @param callable|null     $now                 Clock — fn(): unix seconds.
	 * @param callable|null     $salt                WP secret-salt reader (encryption IKM).
	 * @param callable|null     $s3_factory          fn(config): S3 client; tests inject a fake.
	 * @param callable|null     $derivative_resolver fn(id): {path,url,exists}; default wraps the optimizer.
	 * @param callable|null     $upload_basedir      fn(): uploads base dir; default wp_upload_dir().
	 * @param callable|null     $candidate_provider  fn(limit): int[]; default queries optimized attachments.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		IWSL_Store $store,
		?callable $now = null,
		?callable $salt = null,
		?callable $s3_factory = null,
		?callable $derivative_resolver = null,
		?callable $upload_basedir = null,
		?callable $candidate_provider = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = $store;

		$this->now = $now ?? static function (): int {
			return time();
		};

		$this->salt = $salt ?? static function (): string {
			if ( function_exists( 'wp_salt' ) ) {
				return (string) wp_salt( 'auth' ) . (string) wp_salt( 'secure_auth' );
			}
			return ( defined( 'AUTH_KEY' ) ? (string) AUTH_KEY : '' )
				. ( defined( 'SECURE_AUTH_KEY' ) ? (string) SECURE_AUTH_KEY : '' );
		};

		$this->s3_factory = $s3_factory ?? static function ( array $config ): IWSL_S3_Client {
			return new IWSL_S3_Client( $config );
		};

		$this->derivative_resolver = $derivative_resolver ?? function ( int $id ): array {
			$optimizer = new IWSL_Media_Optimizer( $this->entitlements );
			return $optimizer->derivative_for( $id );
		};

		$this->upload_basedir = $upload_basedir ?? static function (): string {
			if ( function_exists( 'wp_upload_dir' ) ) {
				$dir = wp_upload_dir();
				if ( is_array( $dir ) && isset( $dir['basedir'] ) && is_string( $dir['basedir'] ) ) {
					return $dir['basedir'];
				}
			}
			return '';
		};

		$this->candidate_provider = $candidate_provider ?? function ( int $limit ): array {
			return $this->default_candidates( $limit );
		};
	}

	// ── registration (STATEMENT 1 is the gate; locked ⇒ attach nothing) ───────────

	/**
	 * Wire the three URL-rewrite filters (front-end delivery) and the admin AJAX /
	 * admin-post handlers. STATEMENT 1 is the gate: a locked / revoked / stale site
	 * attaches nothing and behaves like stock WordPress. The rewrite filters run on
	 * every request (front end included); the AJAX + save handlers only ever fire in
	 * an admin context (admin-ajax / admin-post), each re-checking the gate itself.
	 */
	public function register(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( ! function_exists( 'add_filter' ) ) {
			return;
		}

		add_filter( 'wp_get_attachment_url', array( $this, 'filter_attachment_url' ), 10, 2 );
		add_filter( 'wp_get_attachment_image_src', array( $this, 'filter_image_src' ), 10, 4 );
		add_filter( 'wp_calculate_image_srcset', array( $this, 'filter_srcset' ), 10, 5 );

		if ( function_exists( 'add_action' ) ) {
			add_action( 'wp_ajax_' . self::AJAX_TEST, array( $this, 'handle_test_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_STATUS, array( $this, 'handle_status_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_BATCH, array( $this, 'handle_batch_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_UNOFFLOAD, array( $this, 'handle_unoffload_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_MANUAL, array( $this, 'handle_manual_ajax' ) );
			add_action( 'admin_post_' . self::ACTION_SAVE, array( $this, 'handle_save' ) );
		}
	}

	// ── URL rewrite filters (front-end; offloaded ⇒ bucket URL, else untouched) ───

	/**
	 * `wp_get_attachment_url`. Serve the public bucket URL for an offloaded
	 * attachment; leave every other attachment's URL untouched.
	 *
	 * @param mixed $url
	 * @param mixed $attachment_id
	 */
	public function filter_attachment_url( $url, $attachment_id = 0 ): string {
		$offloaded = $this->offloaded_url( (int) $attachment_id );
		return '' !== $offloaded ? $offloaded : (string) $url;
	}

	/**
	 * `wp_get_attachment_image_src`. Replace the src URL (index 0) with the offloaded
	 * bucket URL for an offloaded attachment; pass everything else through unchanged.
	 *
	 * @param mixed $image [url, width, height, is_intermediate] | false
	 * @param mixed $attachment_id
	 * @param mixed $size
	 * @param mixed $icon
	 * @return mixed
	 */
	public function filter_image_src( $image, $attachment_id = 0, $size = 'thumbnail', $icon = false ) {
		if ( ! is_array( $image ) || ! isset( $image[0] ) ) {
			return $image;
		}
		$offloaded = $this->offloaded_url( (int) $attachment_id );
		if ( '' !== $offloaded ) {
			$image[0] = $offloaded;
		}
		return $image;
	}

	/**
	 * `wp_calculate_image_srcset`. Point every srcset source at the offloaded bucket
	 * URL for an offloaded attachment; other attachments' srcsets are unchanged.
	 *
	 * @param mixed $sources
	 * @param mixed $size_array
	 * @param mixed $image_src
	 * @param mixed $image_meta
	 * @param mixed $attachment_id
	 * @return mixed
	 */
	public function filter_srcset( $sources, $size_array = array(), $image_src = '', $image_meta = array(), $attachment_id = 0 ) {
		if ( ! is_array( $sources ) ) {
			return $sources;
		}
		$offloaded = $this->offloaded_url( (int) $attachment_id );
		if ( '' === $offloaded ) {
			return $sources;
		}
		$out = array();
		foreach ( $sources as $key => $source ) {
			if ( is_array( $source ) && isset( $source['url'] ) ) {
				$source['url'] = $offloaded;
			}
			$out[ $key ] = $source;
		}
		return $out;
	}

	// ── reads (safe on every render) ──────────────────────────────────────────────

	/**
	 * The normalized settings map. Unknown/tampered values collapse to safe defaults
	 * (disabled, rule off, first location). The stored (encrypted) secret is included
	 * here for INTERNAL use only — never expose this map to render (use
	 * settings_for_render(), which strips the secret).
	 *
	 * @return array{ enabled:bool, rule_all:bool, location:string, bucket:string, access_key:string, secret:string, access:string, private_url_ttl:int }
	 */
	public function settings(): array {
		return self::normalize_settings( $this->store->get( self::SETTINGS_KEY, array() ) );
	}

	/**
	 * The render-safe settings view: the encrypted secret is stripped WHOLESALE and
	 * replaced with a boolean `has_secret`. The plaintext secret is never present, so
	 * no template / AJAX response can ever echo it.
	 *
	 * @return array{ enabled:bool, rule_all:bool, location:string, bucket:string, access_key:string, has_secret:bool, access:string, private_url_ttl:int }
	 */
	public function settings_for_render(): array {
		$s = $this->settings();
		return array(
			'enabled'         => $s['enabled'],
			'rule_all'        => $s['rule_all'],
			'location'        => $s['location'],
			'bucket'          => $s['bucket'],
			'access_key'      => $s['access_key'],
			'has_secret'      => '' !== $s['secret'],
			'access'          => $s['access'],
			'private_url_ttl' => $s['private_url_ttl'],
		);
	}

	/** The per-attachment manual override map: [ id => 'allow' | 'deny' ]. */
	public function manual_map(): array {
		$raw = $this->store->get( self::MANUAL_KEY, array() );
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$out = array();
		foreach ( $raw as $id => $mode ) {
			$iid = (int) $id;
			if ( $iid > 0 && ( 'allow' === $mode || 'deny' === $mode ) ) {
				$out[ $iid ] = (string) $mode;
			}
		}
		return $out;
	}

	/** The offload mapping recorded for an attachment, or an empty shape. */
	public function offload_meta( int $attachment_id ): array {
		$empty = array( 'key' => '', 'url' => '', 'etag' => '', 'ts' => 0 );
		if ( $attachment_id <= 0 || ! function_exists( 'get_post_meta' ) ) {
			return $empty;
		}
		$raw = get_post_meta( $attachment_id, self::OFFLOAD_META, true );
		if ( ! is_array( $raw ) ) {
			return $empty;
		}
		return array(
			'key'  => isset( $raw['key'] ) ? (string) $raw['key'] : '',
			'url'  => isset( $raw['url'] ) ? (string) $raw['url'] : '',
			'etag' => isset( $raw['etag'] ) ? (string) $raw['etag'] : '',
			'ts'   => isset( $raw['ts'] ) ? (int) $raw['ts'] : 0,
		);
	}

	/** True when the attachment has a recorded, non-empty offload mapping. */
	public function is_offloaded( int $attachment_id ): bool {
		return '' !== $this->offload_meta( $attachment_id )['key'];
	}

	/** True when the attachment carries the optimizer's "optimized" marker. */
	public function is_optimized( int $attachment_id ): bool {
		if ( $attachment_id <= 0 || ! function_exists( 'get_post_meta' ) ) {
			return false;
		}
		$v = get_post_meta( $attachment_id, self::OPTIMIZED_META, true );
		return ! empty( $v );
	}

	/**
	 * Whether an attachment should be offloaded, per the rule + manual overrides:
	 *   manual 'deny'  → NEVER (overrides the rule).
	 *   manual 'allow' → ALWAYS (even without the optimized marker).
	 *   otherwise      → rule "offload all optimized" ON  AND  the optimized marker.
	 */
	public function qualifies( int $attachment_id ): bool {
		if ( $attachment_id <= 0 ) {
			return false;
		}
		$manual = $this->manual_map()[ $attachment_id ] ?? '';
		if ( 'deny' === $manual ) {
			return false;
		}
		if ( 'allow' === $manual ) {
			return true;
		}
		return ! empty( $this->settings()['rule_all'] ) && $this->is_optimized( $attachment_id );
	}

	// ── mutators (STATEMENT 1 is the authoritative gate) ──────────────────────────

	/**
	 * Persist a new settings map. STATEMENT 1 is the gate — a locked site cannot
	 * write settings. The secret is validated + encrypted at rest; a BLANK secret
	 * keeps the existing one (so re-saving the form does not wipe it). Encryption
	 * failure FAILS CLOSED (never persists plaintext).
	 *
	 * @param array<string,mixed> $input Raw form input (caller has unslashed).
	 * @return array{ ok:bool, reason?:string, settings?:array, gate?:array }
	 */
	public function save_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$location = isset( $input['location'] ) ? self::request_string( $input['location'] ) : '';
		if ( ! isset( self::LOCATIONS[ $location ] ) ) {
			return array( 'ok' => false, 'reason' => 'bad-location' );
		}

		$bucket = isset( $input['bucket'] ) ? self::request_string( $input['bucket'] ) : '';
		if ( ! self::is_valid_bucket( $bucket ) ) {
			return array( 'ok' => false, 'reason' => 'bad-bucket' );
		}

		$access_key = isset( $input['access_key'] ) ? self::request_string( $input['access_key'] ) : '';
		if ( ! self::is_valid_access_key( $access_key ) ) {
			return array( 'ok' => false, 'reason' => 'bad-access-key' );
		}

		$existing   = $this->settings();
		$new_secret = isset( $input['secret_key'] ) ? self::request_string( $input['secret_key'] ) : '';
		if ( '' === $new_secret ) {
			$secret_enc = $existing['secret']; // keep the stored (already-encrypted) secret.
		} else {
			$secret_enc = $this->encrypt_secret( $new_secret );
			if ( null === $secret_enc || '' === $secret_enc ) {
				return array( 'ok' => false, 'reason' => 'crypto-unavailable' );
			}
		}

		$access = isset( $input['access'] ) && self::ACCESS_PRIVATE === self::request_string( $input['access'] )
			? self::ACCESS_PRIVATE
			: self::ACCESS_PUBLIC;
		$ttl    = self::clamp_ttl( isset( $input['private_url_ttl'] ) ? (int) $input['private_url_ttl'] : self::DEFAULT_TTL );

		$clean = array(
			'enabled'         => ! empty( $input['enabled'] ),
			'rule_all'        => ! empty( $input['rule_all'] ),
			'location'        => $location,
			'bucket'          => $bucket,
			'access_key'      => $access_key,
			'secret'          => $secret_enc,
			'access'          => $access,
			'private_url_ttl' => $ttl,
		);
		$this->store->set( self::SETTINGS_KEY, $clean );

		return array( 'ok' => true, 'settings' => $this->settings_for_render() );
	}

	/** Set (or clear) an attachment's manual override. $mode ∈ { allow, deny, clear }. */
	public function set_manual( int $attachment_id, string $mode ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		if ( $attachment_id <= 0 ) {
			return array( 'ok' => false, 'reason' => 'bad-id' );
		}
		$map = $this->manual_map();
		if ( 'allow' === $mode || 'deny' === $mode ) {
			if ( ! isset( $map[ $attachment_id ] ) && count( $map ) >= self::MAX_MANUAL ) {
				return array( 'ok' => false, 'reason' => 'manual-map-full' );
			}
			$map[ $attachment_id ] = $mode;
		} elseif ( 'clear' === $mode ) {
			unset( $map[ $attachment_id ] );
		} else {
			return array( 'ok' => false, 'reason' => 'bad-mode' );
		}
		$this->store->set( self::MANUAL_KEY, $map );
		return array( 'ok' => true, 'mode' => 'clear' === $mode ? '' : $mode );
	}

	/**
	 * Offload ONE attachment: PUT its WebP derivative, HEAD-verify the object, and
	 * ONLY on verification success record the `_iwsl_offload` mapping. STATEMENT 1 is
	 * the gate. On any put/verify failure the mapping is NOT written (left for retry)
	 * and the error is surfaced. Never deletes or modifies any local file.
	 *
	 * @return array{ ok:bool, id:int, reason?:string, key?:string, url?:string, etag?:string, error?:string, skipped?:bool }
	 */
	public function offload_one( int $attachment_id ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'id' => $attachment_id, 'reason' => 'entitlement-locked' );
		}
		if ( $attachment_id <= 0 ) {
			return array( 'ok' => false, 'id' => $attachment_id, 'reason' => 'bad-id' );
		}
		if ( ! $this->qualifies( $attachment_id ) ) {
			return array( 'ok' => false, 'id' => $attachment_id, 'reason' => 'not-qualifying' );
		}
		if ( $this->is_offloaded( $attachment_id ) ) {
			return array( 'ok' => true, 'id' => $attachment_id, 'reason' => 'already-offloaded', 'skipped' => true );
		}

		$deriv = ( $this->derivative_resolver )( $attachment_id );
		if ( ! is_array( $deriv ) || empty( $deriv['exists'] ) || empty( $deriv['path'] ) ) {
			return array( 'ok' => false, 'id' => $attachment_id, 'reason' => 'no-derivative' );
		}
		$path = (string) $deriv['path'];

		$key = $this->offload_key_for( (string) $path );
		if ( '' === $key ) {
			return array( 'ok' => false, 'id' => $attachment_id, 'reason' => 'bad-key' );
		}

		$body = $this->read_file( $path );
		if ( null === $body ) {
			return array( 'ok' => false, 'id' => $attachment_id, 'reason' => 'read-failed' );
		}

		$client = $this->s3();
		$put    = $client->put_object( $key, $body, self::CONTENT_TYPE );
		if ( empty( $put['ok'] ) ) {
			return array(
				'ok'     => false,
				'id'     => $attachment_id,
				'reason' => 'put-failed',
				'error'  => isset( $put['error'] ) ? (string) $put['error'] : 'put-failed',
			);
		}

		// HEAD-verify the object actually landed before recording anything.
		$head = $client->head_object( $key );
		if ( empty( $head['ok'] ) || empty( $head['exists'] ) ) {
			return array(
				'ok'     => false,
				'id'     => $attachment_id,
				'reason' => 'verify-failed',
				'error'  => isset( $head['error'] ) ? (string) $head['error'] : 'verify-failed',
			);
		}

		$etag = '';
		if ( isset( $head['etag'] ) && '' !== (string) $head['etag'] ) {
			$etag = (string) $head['etag'];
		} elseif ( isset( $put['etag'] ) ) {
			$etag = (string) $put['etag'];
		}
		$url = (string) $client->public_url( $key );

		$this->write_offload_meta(
			$attachment_id,
			array( 'key' => $key, 'url' => $url, 'etag' => $etag, 'ts' => ( $this->now )() )
		);

		return array( 'ok' => true, 'id' => $attachment_id, 'key' => $key, 'url' => $url, 'etag' => $etag );
	}

	/**
	 * Remove ONE attachment from the bucket: DELETE the object and clear the mapping
	 * meta. STATEMENT 1 is the gate. Idempotent (a not-offloaded id is a success
	 * no-op). The local original + derivative are NEVER touched. On a delete failure
	 * the mapping is kept (so a retry is possible) and the error is surfaced.
	 *
	 * @return array{ ok:bool, id:int, reason?:string, error?:string }
	 */
	public function unoffload_one( int $attachment_id ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'id' => $attachment_id, 'reason' => 'entitlement-locked' );
		}
		if ( $attachment_id <= 0 ) {
			return array( 'ok' => false, 'id' => $attachment_id, 'reason' => 'bad-id' );
		}
		$meta = $this->offload_meta( $attachment_id );
		if ( '' === $meta['key'] ) {
			return array( 'ok' => true, 'id' => $attachment_id, 'reason' => 'not-offloaded' );
		}

		$del = $this->s3()->delete_object( $meta['key'] );
		if ( empty( $del['ok'] ) ) {
			return array(
				'ok'     => false,
				'id'     => $attachment_id,
				'reason' => 'delete-failed',
				'error'  => isset( $del['error'] ) ? (string) $del['error'] : 'delete-failed',
			);
		}

		$this->clear_offload_meta( $attachment_id );
		return array( 'ok' => true, 'id' => $attachment_id );
	}

	// ── batch orchestration (ONE image per call; JS loops it) ─────────────────────

	/** The next attachment the offload pass will process, or 0 when the queue is empty. */
	public function next_candidate_id(): int {
		foreach ( ( $this->candidate_provider )( 1 ) as $id ) {
			$iid = (int) $id;
			if ( $iid > 0 && $this->qualifies( $iid ) && ! $this->is_offloaded( $iid ) && $this->derivative_exists( $iid ) ) {
				return $iid;
			}
		}
		return 0;
	}

	/** Read-only counts for the progress popup. */
	public function stats(): array {
		$candidates = ( $this->candidate_provider )( self::MAX_MANUAL );
		$qualifying = 0;
		$remaining  = 0;
		foreach ( $candidates as $id ) {
			$iid = (int) $id;
			if ( $iid <= 0 || ! $this->qualifies( $iid ) ) {
				continue;
			}
			++$qualifying;
			if ( ! $this->is_offloaded( $iid ) && $this->derivative_exists( $iid ) ) {
				++$remaining;
			}
		}
		return array(
			'qualifying' => $qualifying,
			'offloaded'  => $qualifying - $remaining,
			'remaining'  => $remaining,
		);
	}

	// ── AJAX handlers (manage_options + nonce + gate; NO nopriv) ───────────────────

	/** AJAX: test S3 credentials + reachability (PUT→HEAD→DELETE probe). */
	public function handle_test_ajax(): void {
		$this->ajax_guard();
		$this->send_json( $this->test_connection() );
	}

	/** AJAX: read-only offload counters + the next image to process. */
	public function handle_status_ajax(): void {
		$this->ajax_guard();
		$next = $this->next_candidate_id();
		$this->send_json(
			array( 'ok' => true, 'stats' => $this->stats(), 'next' => $this->card( $next ) )
		);
	}

	/** AJAX: offload exactly ONE image, then report fresh stats so JS can loop. */
	public function handle_batch_ajax(): void {
		$this->ajax_guard();
		$id      = $this->next_candidate_id();
		$current = $this->card( $id );
		$result  = $id > 0 ? $this->offload_one( $id ) : array( 'ok' => true, 'reason' => 'done' );
		$this->send_json(
			array(
				'ok'      => true,
				'result'  => $result,
				'current' => $current,
				'stats'   => $this->stats(),
				'next'    => $this->card( $this->next_candidate_id() ),
			)
		);
	}

	/** AJAX: remove ONE (by id) or the NEXT offloaded image from the bucket. */
	public function handle_unoffload_ajax(): void {
		$this->ajax_guard();
		$id = isset( $_POST['id'] ) ? (int) $_POST['id'] : 0;
		if ( $id <= 0 ) {
			$id = $this->next_offloaded_id();
		}
		$result = $id > 0 ? $this->unoffload_one( $id ) : array( 'ok' => true, 'reason' => 'done' );
		$this->send_json( array( 'ok' => true, 'result' => $result, 'remaining' => $this->offloaded_count() ) );
	}

	/** AJAX: set/clear an attachment's manual allow/deny override. */
	public function handle_manual_ajax(): void {
		$this->ajax_guard();
		$id   = isset( $_POST['id'] ) ? (int) $_POST['id'] : 0;
		$mode = isset( $_POST['mode'] ) ? self::request_string( $_POST['mode'] ) : '';
		$this->send_json( $this->set_manual( $id, $mode ) );
	}

	/** admin-post: PRG settings save (manage_options + nonce + gate). */
	public function handle_save(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			$this->deny();
			return;
		}
		if ( function_exists( 'check_admin_referer' ) ) {
			check_admin_referer( self::NONCE_SAVE );
		}
		$input  = function_exists( 'wp_unslash' ) ? wp_unslash( $_POST ) : $_POST;
		$result = $this->save_settings( is_array( $input ) ? $input : array() );
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_media_offload_result_' . get_current_user_id(), $result, 60 );
		}
		$this->redirect_back();
	}

	// ── S3 connection test + config ───────────────────────────────────────────────

	/**
	 * Round-trip a probe object to confirm the stored credentials + reachability.
	 * Never returns or logs the secret. Fails cleanly (structured error) when the
	 * config is incomplete or the secret cannot be decrypted.
	 *
	 * @return array{ ok:bool, reason?:string, steps?:array, error?:string }
	 */
	public function test_connection(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		$config = $this->s3_config();
		if ( '' === $config['bucket'] || '' === $config['access_key'] || '' === $config['secret_key'] ) {
			return array( 'ok' => false, 'reason' => 'incomplete-config' );
		}
		$result = $this->s3( $config )->test_connection();
		return is_array( $result ) ? $result : array( 'ok' => false, 'reason' => 'test-failed' );
	}

	/**
	 * Build the S3 client config from the stored settings (secret decrypted in
	 * memory only). Endpoint host is "<location>.your-objectstorage.com"; region is
	 * the location; ACL public-read; virtual-hosted addressing.
	 *
	 * @return array{ endpoint:string, region:string, bucket:string, access_key:string, secret_key:string, acl:string, path_style:bool }
	 */
	private function s3_config(): array {
		$s      = $this->settings();
		$loc    = isset( self::LOCATIONS[ $s['location'] ] ) ? $s['location'] : self::default_location();
		$secret = '' !== $s['secret'] ? (string) $this->decrypt_secret( $s['secret'] ) : '';
		$acl    = self::ACCESS_PRIVATE === $s['access'] ? self::ACL_PRIVATE : self::ACL;
		return array(
			'endpoint'   => $loc . '.' . self::ENDPOINT_SUFFIX,
			'region'     => $loc,
			'bucket'     => $s['bucket'],
			'access_key' => $s['access_key'],
			'secret_key' => $secret,
			'acl'        => $acl,
			'path_style' => self::PATH_STYLE,
		);
	}

	/** Instantiate the S3 client from the given (or stored) config via the factory. */
	private function s3( ?array $config = null ): object {
		return ( $this->s3_factory )( null !== $config ? $config : $this->s3_config() );
	}

	// ── render ────────────────────────────────────────────────────────────────────

	/**
	 * The admin section. Locked → a notice listing the gate reasons. Unlocked → the
	 * connection wizard (location → bucket → access key → secret → Test connection),
	 * the enable + rule toggles, and the "Offload now" / "Remove from bucket" progress
	 * controls. The secret is NEVER rendered — only a "secret is set" indicator.
	 */
	public function render_section(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$view       = $this->settings_for_render();
		$action_url = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : 'admin-post.php';

		echo '<div class="iwsl-media-offload">';
		echo '<h2>' . self::esc_html_safe( 'Media Offload (S3)' ) . '</h2>';
		echo '<p class="description">' . self::esc_html_safe( 'Copy your optimized WebP images to Hetzner Object Storage and serve them from the bucket. Your local originals are always kept — nothing is ever deleted.' ) . '</p>';

		$this->render_config_wizard( (string) $action_url, $view );
		$this->render_offload_controls( $view );
		$this->render_inline_script();

		echo '</div>';
	}

	/** The step-by-step connection wizard (config form + Test connection button). */
	private function render_config_wizard( string $action_url, array $view ): void {
		echo '<form method="post" action="' . self::esc_url_safe( $action_url ) . '" class="iwsl-offload-wizard">';
		echo '<input type="hidden" name="action" value="' . self::esc_attr_safe( self::ACTION_SAVE ) . '" />';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::NONCE_SAVE );
		}

		// Step 1 — location.
		echo '<fieldset class="iwsl-step"><legend>' . self::esc_html_safe( 'Step 1 — Storage location' ) . '</legend>';
		echo '<p><label>' . self::esc_html_safe( 'Hetzner location' ) . ' <select name="location">';
		foreach ( self::LOCATIONS as $code => $label ) {
			echo '<option value="' . self::esc_attr_safe( $code ) . '" ' . self::selected( $code === $view['location'] ) . '>'
				. self::esc_html_safe( $label . ' (' . $code . ')' ) . '</option>';
		}
		echo '</select></label></p></fieldset>';

		// Step 2 — bucket + credentials.
		echo '<fieldset class="iwsl-step"><legend>' . self::esc_html_safe( 'Step 2 — Bucket & credentials' ) . '</legend>';
		echo '<p><label>' . self::esc_html_safe( 'Bucket name' ) . ' <input type="text" name="bucket" value="' . self::esc_attr_safe( $view['bucket'] ) . '" autocomplete="off" /></label></p>';
		echo '<p><label>' . self::esc_html_safe( 'Access key' ) . ' <input type="text" name="access_key" value="' . self::esc_attr_safe( $view['access_key'] ) . '" autocomplete="off" /></label></p>';
		$secret_ph = $view['has_secret'] ? 'Secret is set — leave blank to keep it' : 'Secret key';
		echo '<p><label>' . self::esc_html_safe( 'Secret key' ) . ' <input type="password" name="secret_key" value="" placeholder="' . self::esc_attr_safe( $secret_ph ) . '" autocomplete="new-password" /></label></p>';
		echo '<p><button type="button" class="button" id="iwsl-offload-test">' . self::esc_html_safe( 'Test connection' ) . '</button> <span id="iwsl-offload-test-result" aria-live="polite"></span></p>';
		echo '<p class="description">' . self::esc_html_safe( 'Tip: save your bucket and credentials first, then test.' ) . '</p></fieldset>';

		// Step 3 — enable + rule.
		echo '<fieldset class="iwsl-step"><legend>' . self::esc_html_safe( 'Step 3 — Turn it on' ) . '</legend>';
		echo '<p><label><input type="checkbox" name="enabled" value="1" ' . self::checked( $view['enabled'] ) . '/> ' . self::esc_html_safe( 'Serve offloaded images from the bucket' ) . '</label></p>';
		echo '<p><label><input type="checkbox" name="rule_all" value="1" ' . self::checked( $view['rule_all'] ) . '/> ' . self::esc_html_safe( 'Offload all lossless-optimized images' ) . '</label></p></fieldset>';

		// Step 4 — bucket access: public objects vs private presigned-URL delivery.
		$is_private = self::ACCESS_PRIVATE === $view['access'];
		echo '<fieldset class="iwsl-step"><legend>' . self::esc_html_safe( 'Step 4 — Bucket access' ) . '</legend>';
		echo '<p><label>' . self::esc_html_safe( 'Bucket access' ) . ' <select name="access">';
		echo '<option value="' . self::esc_attr_safe( self::ACCESS_PUBLIC ) . '" ' . self::selected( ! $is_private ) . '>'
			. self::esc_html_safe( 'Public — anyone with the link can view (fastest, fully cacheable)' ) . '</option>';
		echo '<option value="' . self::esc_attr_safe( self::ACCESS_PRIVATE ) . '" ' . self::selected( $is_private ) . '>'
			. self::esc_html_safe( 'Private — images served through temporary signed links' ) . '</option>';
		echo '</select></label></p>';
		echo '<p><label>' . self::esc_html_safe( 'Signed-link lifetime (seconds)' )
			. ' <input type="number" name="private_url_ttl" min="' . self::esc_attr_safe( (string) self::MIN_TTL ) . '" max="' . self::esc_attr_safe( (string) self::MAX_TTL ) . '" step="1" value="' . self::esc_attr_safe( (string) $view['private_url_ttl'] ) . '" /></label>'
			. ' <span class="description">' . self::esc_html_safe( 'Only used for Private access. Between 5 minutes (300) and 7 days (604800).' ) . '</span></p>';
		echo '<p class="description iwsl-offload-private-warning"><strong>' . self::esc_html_safe( 'Private access and caching:' ) . '</strong> '
			. self::esc_html_safe( 'Private images are delivered through temporary signed links that stop working once the lifetime above passes. If a full-page cache or a CDN stores your pages for LONGER than this lifetime, those cached pages will keep serving the old, now-expired links and the images can fail to load (HTTP 403 Forbidden). Set your page-cache and CDN lifetimes SHORTER than the signed-link lifetime, or use Public access if you cache pages aggressively.' )
			. '</p>';
		echo '</fieldset>';

		echo '<p><button type="submit" class="button button-primary">' . self::esc_html_safe( 'Save settings' ) . '</button></p>';
		echo '</form>';
	}

	/** The "Offload now" + "Remove from bucket" progress controls (JS-driven). */
	private function render_offload_controls( array $view ): void {
		$stats = $this->stats();
		echo '<div class="iwsl-offload-run">';
		echo '<h3>' . self::esc_html_safe( 'Offload' ) . '</h3>';
		echo '<p id="iwsl-offload-stats">' . self::esc_html_safe(
			sprintf( 'Qualifying: %d — Offloaded: %d — Remaining: %d', $stats['qualifying'], $stats['offloaded'], $stats['remaining'] )
		) . '</p>';
		echo '<p>';
		echo '<button type="button" class="button button-secondary" id="iwsl-offload-start">' . self::esc_html_safe( 'Offload qualifying images now' ) . '</button> ';
		echo '<button type="button" class="button" id="iwsl-offload-remove">' . self::esc_html_safe( 'Remove all from bucket' ) . '</button>';
		echo '</p>';
		echo '<p id="iwsl-offload-progress" aria-live="polite"></p>';
		echo '</div>';
	}

	/** The locked-state notice with the human gate reasons. */
	private function render_locked_notice( array $gate ): void {
		$reasons = isset( $gate['reasons'] ) && is_array( $gate['reasons'] ) ? $gate['reasons'] : array();
		echo '<div class="notice notice-warning"><p>';
		echo self::esc_html_safe( 'Media Offload (S3) is locked.' );
		if ( array() !== $reasons ) {
			echo ' ' . self::esc_html_safe( 'Reasons: ' . implode( ', ', array_map( 'strval', $reasons ) ) );
		}
		echo '</p></div>';
	}

	/** The small AJAX-loop script driving Test connection + offload/remove progress. */
	private function render_inline_script(): void {
		$cfg = array(
			'ajaxUrl'  => function_exists( 'admin_url' ) ? admin_url( 'admin-ajax.php' ) : 'admin-ajax.php',
			'nonce'    => function_exists( 'wp_create_nonce' ) ? wp_create_nonce( self::NONCE ) : '',
			'actTest'  => self::AJAX_TEST,
			'actBatch' => self::AJAX_BATCH,
			'actUnoff' => self::AJAX_UNOFFLOAD,
		);
		$json = function_exists( 'wp_json_encode' ) ? wp_json_encode( $cfg ) : json_encode( $cfg );
		echo "<script>(function(){var cfg=" . $json . ";\n";
		echo <<<'JS'
function post(action,extra){var b=new URLSearchParams();b.set('action',action);b.set('nonce',cfg.nonce);if(extra){for(var k in extra){b.set(k,extra[k]);}}return fetch(cfg.ajaxUrl,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString()}).then(function(r){return r.json();});}
var t=document.getElementById('iwsl-offload-test');if(t){t.addEventListener('click',function(){var o=document.getElementById('iwsl-offload-test-result');o.textContent='Testing…';post(cfg.actTest,{}).then(function(j){o.textContent=(j&&j.success&&j.data&&j.data.ok)?'Connection OK':'Connection failed';}).catch(function(){o.textContent='Connection failed';});});}
var prog=document.getElementById('iwsl-offload-progress');
function loop(action,extra,label){post(action,extra).then(function(j){var d=j&&j.data?j.data:{};var st=d.stats;if(st){var s=document.getElementById('iwsl-offload-stats');if(s){s.textContent='Qualifying: '+st.qualifying+' — Offloaded: '+st.offloaded+' — Remaining: '+st.remaining;}}var more=(action===cfg.actBatch)?(d.next&&d.next.id):(d.remaining>0);if(more){prog.textContent=label+' ('+((st&&st.remaining)||d.remaining||'…')+' left)';loop(action,extra,label);}else{prog.textContent=label+' complete.';}}).catch(function(){prog.textContent=label+' stopped (error).';});}
var start=document.getElementById('iwsl-offload-start');if(start){start.addEventListener('click',function(){prog.textContent='Offloading…';loop(cfg.actBatch,{},'Offloading');});}
var rm=document.getElementById('iwsl-offload-remove');if(rm){rm.addEventListener('click',function(){if(!window.confirm('Remove all offloaded images from the bucket? Local files are kept.')){return;}prog.textContent='Removing…';loop(cfg.actUnoff,{},'Removing');});}
})();</script>
JS;
		echo "\n";
	}

	// ── at-rest secret encryption (AES-256-GCM; key derived from WP salts) ─────────

	/** True when an authenticated cipher + CSPRNG are actually available here. */
	private static function crypto_available(): bool {
		return function_exists( 'openssl_encrypt' )
			&& function_exists( 'openssl_decrypt' )
			&& function_exists( 'random_bytes' )
			&& function_exists( 'openssl_get_cipher_methods' )
			&& in_array( self::ENC_CIPHER, openssl_get_cipher_methods(), true );
	}

	/** Derive the 32-byte per-site AES key from the WP secret-salt IKM (never stored). */
	private function encryption_key(): ?string {
		$ikm = ( $this->salt )();
		if ( ! is_string( $ikm ) || '' === $ikm ) {
			return null;
		}
		if ( function_exists( 'hash_hkdf' ) ) {
			return hash_hkdf( 'sha256', $ikm, 32, self::ENC_HKDF_INFO, '' );
		}
		return substr( hash( 'sha256', self::ENC_HKDF_INFO . "\x00" . $ikm, true ), 0, 32 );
	}

	/**
	 * Encrypt a plaintext secret → `MARKER || base64(iv || tag || ciphertext)`.
	 * Returns '' for '' input, and null when encryption is impossible (no cipher / no
	 * key material) so the caller FAILS CLOSED rather than persist plaintext.
	 */
	private function encrypt_secret( string $plaintext ): ?string {
		if ( '' === $plaintext ) {
			return '';
		}
		if ( ! self::crypto_available() ) {
			return null;
		}
		$key = $this->encryption_key();
		if ( null === $key ) {
			return null;
		}
		try {
			$iv  = random_bytes( self::ENC_IV_LEN );
			$tag = '';
			$ct  = openssl_encrypt( $plaintext, self::ENC_CIPHER, $key, OPENSSL_RAW_DATA, $iv, $tag, '', self::ENC_TAG_LEN );
		} catch ( \Throwable $e ) {
			return null;
		}
		if ( ! is_string( $ct ) || '' === $ct || ! is_string( $tag ) || self::ENC_TAG_LEN !== strlen( $tag ) ) {
			return null;
		}
		return self::ENC_MARKER . base64_encode( $iv . $tag . $ct );
	}

	/** Authenticated-decrypt a stored secret; null on any failure. Unmarked = legacy plaintext. */
	private function decrypt_secret( string $stored ): ?string {
		if ( '' === $stored ) {
			return '';
		}
		if ( 0 !== strpos( $stored, self::ENC_MARKER ) ) {
			return $stored; // legacy plaintext (re-encrypted on next save).
		}
		if ( ! self::crypto_available() ) {
			return null;
		}
		$key = $this->encryption_key();
		if ( null === $key ) {
			return null;
		}
		$blob = base64_decode( substr( $stored, strlen( self::ENC_MARKER ) ), true );
		if ( false === $blob || strlen( $blob ) <= self::ENC_IV_LEN + self::ENC_TAG_LEN ) {
			return null;
		}
		$iv  = substr( $blob, 0, self::ENC_IV_LEN );
		$tag = substr( $blob, self::ENC_IV_LEN, self::ENC_TAG_LEN );
		$ct  = substr( $blob, self::ENC_IV_LEN + self::ENC_TAG_LEN );
		try {
			$pt = openssl_decrypt( $ct, self::ENC_CIPHER, $key, OPENSSL_RAW_DATA, $iv, $tag );
		} catch ( \Throwable $e ) {
			return null;
		}
		return is_string( $pt ) ? $pt : null;
	}

	// ── keys / candidates / meta helpers ──────────────────────────────────────────

	/**
	 * The object key for a derivative: its path made relative to the uploads base
	 * dir. Returns '' when the path escapes the uploads root or the key is unsafe
	 * (empty, absolute, or traversal) so a malformed path is never signed/PUT.
	 */
	private function offload_key_for( string $derivative_path ): string {
		$basedir = rtrim( str_replace( '\\', '/', (string) ( $this->upload_basedir )() ), '/' );
		$path    = str_replace( '\\', '/', $derivative_path );
		if ( '' === $basedir || 0 !== strpos( $path, $basedir . '/' ) ) {
			return '';
		}
		$key = ltrim( substr( $path, strlen( $basedir ) ), '/' );
		if ( '' === $key || '/' === $key[0] || false !== strpos( $key, '..' ) ) {
			return '';
		}
		if ( 1 !== preg_match( '#^[A-Za-z0-9._\-/]+\.webp$#', $key ) ) {
			return '';
		}
		return $key;
	}

	/** Default candidate provider: optimized attachments + manual-allow ids (bounded). */
	private function default_candidates( int $limit ): array {
		$ids = array();
		if ( function_exists( 'get_posts' ) ) {
			$posts = get_posts(
				array(
					'post_type'      => 'attachment',
					'post_status'    => 'inherit',
					'posts_per_page' => max( 1, min( $limit, self::MAX_MANUAL ) ),
					'fields'         => 'ids',
					'meta_key'       => self::OPTIMIZED_META, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
					'no_found_rows'  => true,
				)
			);
			if ( is_array( $posts ) ) {
				foreach ( $posts as $p ) {
					$ids[ (int) $p ] = true;
				}
			}
		}
		foreach ( array_keys( $this->manual_map() ) as $mid ) {
			$ids[ (int) $mid ] = true; // include manual overrides (allow forces on; deny filtered by qualifies()).
		}
		return array_slice( array_keys( $ids ), 0, max( 1, $limit ) );
	}

	/** True when the attachment's WebP derivative currently exists on disk. */
	private function derivative_exists( int $attachment_id ): bool {
		$d = ( $this->derivative_resolver )( $attachment_id );
		return is_array( $d ) && ! empty( $d['exists'] );
	}

	/**
	 * The delivery URL for an offloaded attachment (gate-checked), or '' when not
	 * offloaded. PUBLIC access serves the stored public bucket URL. PRIVATE access
	 * mints a fresh, time-limited presigned GET URL from the stored key at RENDER TIME
	 * (never persisted, so each page load gets a link valid for the full TTL).
	 */
	private function offloaded_url( int $attachment_id ): string {
		if ( $attachment_id <= 0 || ! $this->is_unlocked() ) {
			return '';
		}
		$meta = $this->offload_meta( $attachment_id );
		if ( '' === $meta['key'] ) {
			return '';
		}
		$s = $this->settings();
		if ( self::ACCESS_PRIVATE === $s['access'] ) {
			$client = $this->s3();
			if ( ! method_exists( $client, 'presigned_get_url' ) ) {
				return '';
			}
			return (string) $client->presigned_get_url( $meta['key'], (int) $s['private_url_ttl'] );
		}
		return $meta['url'];
	}

	/** Memoized per-request gate evaluation for the hot-path rewrite filters. */
	private function is_unlocked(): bool {
		if ( null === $this->unlocked_cache ) {
			$gate                 = $this->entitlements->evaluate( self::FEATURE );
			$this->unlocked_cache = ! empty( $gate['unlocked'] );
		}
		return $this->unlocked_cache;
	}

	/** The first still-offloaded attachment among the candidates, or 0. */
	private function next_offloaded_id(): int {
		foreach ( $this->offloaded_ids() as $id ) {
			return (int) $id;
		}
		return 0;
	}

	/** Count of currently-offloaded attachments among the candidates. */
	private function offloaded_count(): int {
		return count( $this->offloaded_ids() );
	}

	/** The candidate ids that currently carry an offload mapping. */
	private function offloaded_ids(): array {
		$out = array();
		foreach ( ( $this->candidate_provider )( self::MAX_MANUAL ) as $id ) {
			$iid = (int) $id;
			if ( $iid > 0 && $this->is_offloaded( $iid ) ) {
				$out[] = $iid;
			}
		}
		return $out;
	}

	/** Persist the offload mapping meta for an attachment. */
	private function write_offload_meta( int $attachment_id, array $mapping ): void {
		if ( function_exists( 'update_post_meta' ) ) {
			update_post_meta( $attachment_id, self::OFFLOAD_META, $mapping );
		}
	}

	/** Clear the offload mapping meta for an attachment. */
	private function clear_offload_meta( int $attachment_id ): void {
		if ( function_exists( 'delete_post_meta' ) ) {
			delete_post_meta( $attachment_id, self::OFFLOAD_META );
		}
	}

	/** Read a file's bytes, bounded by MAX_OFFLOAD_BYTES; null on any failure. */
	private function read_file( string $path ): ?string {
		if ( ! is_file( $path ) || ! is_readable( $path ) ) {
			return null;
		}
		$size = filesize( $path );
		if ( false === $size || $size <= 0 || $size > self::MAX_OFFLOAD_BYTES ) {
			return null;
		}
		$body = file_get_contents( $path );
		return is_string( $body ) ? $body : null;
	}

	/** A tiny display descriptor for the progress popup, or null for a non-positive id. */
	private function card( int $id ): ?array {
		if ( $id <= 0 ) {
			return null;
		}
		return array(
			'id'    => $id,
			'name'  => function_exists( 'get_the_title' ) ? (string) get_the_title( $id ) : '',
			'thumb' => function_exists( 'wp_get_attachment_image_url' )
				? (string) ( wp_get_attachment_image_url( $id, 'thumbnail' ) ?: '' )
				: '',
		);
	}

	// ── input / normalization / validation ────────────────────────────────────────

	/**
	 * Normalize a raw settings map (form input or stored value) into the canonical
	 * shape. Immutable; unknown location collapses to the default; everything safe.
	 *
	 * @param mixed $raw
	 * @return array{ enabled:bool, rule_all:bool, location:string, bucket:string, access_key:string, secret:string, access:string, private_url_ttl:int }
	 */
	private static function normalize_settings( $raw ): array {
		$raw      = is_array( $raw ) ? $raw : array();
		$location = isset( $raw['location'] ) && isset( self::LOCATIONS[ (string) $raw['location'] ] )
			? (string) $raw['location']
			: self::default_location();
		$access   = isset( $raw['access'] ) && self::ACCESS_PRIVATE === (string) $raw['access']
			? self::ACCESS_PRIVATE
			: self::ACCESS_PUBLIC;
		$ttl      = self::clamp_ttl( isset( $raw['private_url_ttl'] ) ? (int) $raw['private_url_ttl'] : self::DEFAULT_TTL );
		return array(
			'enabled'         => ! empty( $raw['enabled'] ),
			'rule_all'        => ! empty( $raw['rule_all'] ),
			'location'        => $location,
			'bucket'          => isset( $raw['bucket'] ) ? (string) $raw['bucket'] : '',
			'access_key'      => isset( $raw['access_key'] ) ? (string) $raw['access_key'] : '',
			'secret'          => isset( $raw['secret'] ) ? (string) $raw['secret'] : '',
			'access'          => $access,
			'private_url_ttl' => $ttl,
		);
	}

	/** Clamp a presigned-link lifetime to the supported [300, 604800] second window. */
	private static function clamp_ttl( int $ttl ): int {
		if ( $ttl < self::MIN_TTL ) {
			return self::MIN_TTL;
		}
		if ( $ttl > self::MAX_TTL ) {
			return self::MAX_TTL;
		}
		return $ttl;
	}

	/** The first configured location (fsn1) — the deterministic default. */
	private static function default_location(): string {
		foreach ( self::LOCATIONS as $code => $label ) {
			return (string) $code;
		}
		return 'fsn1';
	}

	/** S3 bucket-name validation: 3–63 chars, lowercase alnum / dot / hyphen, alnum ends. */
	private static function is_valid_bucket( string $bucket ): bool {
		return 1 === preg_match( '/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/', $bucket )
			&& false === strpos( $bucket, '..' );
	}

	/** Access-key-id validation: 8–128 printable key characters. */
	private static function is_valid_access_key( string $key ): bool {
		return 1 === preg_match( '/^[A-Za-z0-9]{8,128}$/', $key );
	}

	/** Read a scalar request value as a trimmed, unslashed string. */
	private static function request_string( $value ): string {
		if ( ! is_scalar( $value ) ) {
			return '';
		}
		$str = (string) $value;
		if ( function_exists( 'wp_unslash' ) ) {
			$str = (string) wp_unslash( $str );
		}
		return trim( $str );
	}

	// ── AJAX / output plumbing ────────────────────────────────────────────────────

	/**
	 * The shared AJAX gate: manage_options + nonce + the entitlement check. Emits a
	 * JSON error and stops on any failure. NO nopriv twin is ever registered.
	 */
	private function ajax_guard(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			$this->send_json_error( 'forbidden', 403 );
		}
		if ( function_exists( 'check_ajax_referer' ) ) {
			check_ajax_referer( self::NONCE, 'nonce' );
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->send_json_error( 'entitlement-locked', 403 );
		}
	}

	/** Emit a JSON success envelope (wp_send_json_success in WP; echo under the harness). */
	private function send_json( array $data ): void {
		if ( function_exists( 'wp_send_json_success' ) ) {
			wp_send_json_success( $data );
		}
		echo function_exists( 'wp_json_encode' ) ? wp_json_encode( array( 'success' => true, 'data' => $data ) ) : json_encode( array( 'success' => true, 'data' => $data ) );
	}

	/** Emit a JSON error envelope + stop. */
	private function send_json_error( string $reason, int $status = 400 ): void {
		if ( function_exists( 'wp_send_json_error' ) ) {
			wp_send_json_error( array( 'reason' => $reason ), $status );
		}
		echo function_exists( 'wp_json_encode' ) ? wp_json_encode( array( 'success' => false, 'data' => array( 'reason' => $reason ) ) ) : json_encode( array( 'success' => false, 'data' => array( 'reason' => $reason ) ) );
	}

	private function deny(): void {
		if ( function_exists( 'wp_die' ) ) {
			wp_die( self::esc_html_safe( 'Insufficient permissions.' ) );
		}
	}

	/** PRG redirect back to the Plus admin page, then stop. */
	private function redirect_back(): void {
		$url = 'admin.php?page=' . self::PAGE_SLUG;
		if ( function_exists( 'admin_url' ) ) {
			$url = admin_url( $url );
		}
		if ( function_exists( 'wp_safe_redirect' ) ) {
			wp_safe_redirect( $url );
		}
		exit;
	}

	private static function checked( bool $on ): string {
		return $on ? 'checked="checked" ' : '';
	}

	private static function selected( bool $on ): string {
		return $on ? 'selected="selected"' : '';
	}

	private static function esc_html_safe( string $value ): string {
		return function_exists( 'esc_html' ) ? esc_html( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_attr_safe( string $value ): string {
		return function_exists( 'esc_attr' ) ? esc_attr( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_url_safe( string $value ): string {
		return function_exists( 'esc_url' ) ? esc_url( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}
