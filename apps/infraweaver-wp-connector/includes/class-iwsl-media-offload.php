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
 * popup) finds qualifying attachments not yet offloaded, PUTs a SOURCE FILE to its
 * `<uploads-relative-path>` key, HEAD-verifies the object (etag), and ONLY THEN records
 * `_iwsl_offload = { key, url, etag, ts, variant, src_url }` in attachment meta. If the
 * PUT or the HEAD verification fails the mapping is NOT written — the image is simply
 * retried next pass. The SCOPE setting chooses WHICH images qualify under the rule:
 * `optimized` (default) offloads only images the optimizer turned into a smaller WebP
 * derivative (variant='derivative'); `all` also offloads images that are already WebP or
 * were never optimized, uploading each attachment's OWN original file (variant='original',
 * same format/name). An image qualifies when (rule ON and — per scope — it is optimized
 * OR is any image attachment) OR it is manually forced on; never when manually forced off.
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

	/** Attachment meta holding the offload mapping { key, url, etag, ts, variant, src_url }. */
	const OFFLOAD_META = '_iwsl_offload';

	/** Store key for the settings map (IWSL_WP_Store prefixes → iwsl_media_offload). */
	const SETTINGS_KEY = 'media_offload';
	/** Store key for the per-attachment manual allow/deny override map. */
	const MANUAL_KEY = 'media_offload_manual';

	/**
	 * Auto-rule SCOPE — which images the rule (rule_all) offloads. `optimized` (default,
	 * the historical behaviour) offloads only images the optimizer turned into a smaller
	 * WebP derivative; `all` also offloads images that are already WebP / were never
	 * optimized, by uploading each attachment's OWN original file. Manual allow/deny
	 * always overrides in either scope.
	 */
	const SCOPE_OPTIMIZED = 'optimized';
	const SCOPE_ALL       = 'all';

	/** Offload variant recorded per attachment — which source file was shipped. */
	const VARIANT_DERIVATIVE = 'derivative'; // the optimizer's smaller WebP derivative.
	const VARIANT_ORIGINAL   = 'original';   // the attachment's own original file (same format/name).

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
	/** Content type of an offloaded WebP DERIVATIVE (an original uploads under its own mime). */
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
	const AJAX_BUCKETS   = 'iwsl_media_offload_buckets';
	/** Management panel: paginated media list + per-id offload + bulk (logged-in only, no nopriv). */
	const AJAX_LIST        = 'iwsl_media_offload_list';
	const AJAX_OFFLOAD_ONE = 'iwsl_media_offload_one_by_id';
	const AJAX_BULK        = 'iwsl_media_offload_bulk';
	const NONCE          = 'iwsl_media_offload';

	/** Management list: default + max page size, and the per-call bulk id cap. */
	const LIST_PER_PAGE     = 24;
	const LIST_PER_PAGE_MAX = 100;
	const BULK_MAX          = 50;

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

	/** @var callable(string):array fn(url): { ok, body, status } — HTTP GET seam for bring-back. */
	private $http_get;

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
		?callable $candidate_provider = null,
		?callable $http_get = null
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

		$this->http_get = $http_get ?? static function ( string $url ): array {
			if ( '' === $url || ! function_exists( 'wp_safe_remote_get' ) ) {
				return array( 'ok' => false, 'body' => '', 'status' => 0 );
			}
			$resp = wp_safe_remote_get( $url, array( 'timeout' => 30 ) );
			if ( function_exists( 'is_wp_error' ) && is_wp_error( $resp ) ) {
				return array( 'ok' => false, 'body' => '', 'status' => 0 );
			}
			$code = function_exists( 'wp_remote_retrieve_response_code' ) ? (int) wp_remote_retrieve_response_code( $resp ) : 0;
			$body = function_exists( 'wp_remote_retrieve_body' ) ? (string) wp_remote_retrieve_body( $resp ) : '';
			return array( 'ok' => ( $code >= 200 && $code < 300 && '' !== $body ), 'body' => $body, 'status' => $code );
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
			add_action( 'wp_ajax_' . self::AJAX_BUCKETS, array( $this, 'handle_buckets_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_LIST, array( $this, 'handle_list_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_OFFLOAD_ONE, array( $this, 'handle_offload_one_ajax' ) );
			add_action( 'wp_ajax_' . self::AJAX_BULK, array( $this, 'handle_bulk_ajax' ) );
			add_action( 'admin_post_' . self::ACTION_SAVE, array( $this, 'handle_save' ) );
		}
	}

	// ── URL rewrite filters (front-end; offloaded ⇒ bucket URL, else untouched) ───

	/**
	 * `wp_get_attachment_url`. Serve the offloaded bucket URL for an offloaded
	 * attachment; leave every other attachment's URL untouched.
	 *
	 * @param mixed $url
	 * @param mixed $attachment_id
	 */
	public function filter_attachment_url( $url, $attachment_id = 0 ): string {
		$offloaded = $this->rewritten_url( (int) $attachment_id, (string) $url );
		return '' !== $offloaded ? $offloaded : (string) $url;
	}

	/**
	 * `wp_get_attachment_image_src`. Replace the src URL (index 0) with the offloaded
	 * bucket URL for an offloaded attachment; pass everything else through unchanged.
	 * For an `original`-variant offload only the exact original file we uploaded is
	 * swapped — a sub-size request is left on disk (no broken bucket 404).
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
		$offloaded = $this->rewritten_url( (int) $attachment_id, (string) $image[0] );
		if ( '' !== $offloaded ) {
			$image[0] = $offloaded;
		}
		return $image;
	}

	/**
	 * `wp_calculate_image_srcset`. Point srcset sources at the offloaded bucket URL for
	 * an offloaded attachment; other attachments' srcsets are unchanged. A `derivative`
	 * offload maps EVERY source at the single WebP object (historical behaviour). An
	 * `original` offload only rewrites the exact original file it shipped — un-offloaded
	 * sub-sizes stay on disk so no source ever points at a bucket object that is absent.
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
		$id = (int) $attachment_id;
		if ( $id <= 0 || ! $this->is_unlocked() ) {
			return $sources;
		}
		$meta = $this->offload_meta( $id );
		if ( '' === $meta['key'] ) {
			return $sources;
		}
		$delivery = $this->delivery_url_for( $meta );
		if ( '' === $delivery ) {
			return $sources;
		}
		$only_src = self::VARIANT_ORIGINAL === $meta['variant'] && '' !== $meta['src_url'];
		$out      = array();
		foreach ( $sources as $key => $source ) {
			if ( is_array( $source ) && isset( $source['url'] ) ) {
				if ( ! $only_src || (string) $source['url'] === $meta['src_url'] ) {
					$source['url'] = $delivery;
				}
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
	 * @return array{ enabled:bool, rule_all:bool, scope:string, location:string, bucket:string, access_key:string, secret:string, access:string, private_url_ttl:int }
	 */
	public function settings(): array {
		return self::normalize_settings( $this->store->get( self::SETTINGS_KEY, array() ) );
	}

	/**
	 * The render-safe settings view: the encrypted secret is stripped WHOLESALE and
	 * replaced with a boolean `has_secret`. The plaintext secret is never present, so
	 * no template / AJAX response can ever echo it.
	 *
	 * @return array{ enabled:bool, rule_all:bool, scope:string, location:string, bucket:string, access_key:string, has_secret:bool, access:string, private_url_ttl:int }
	 */
	public function settings_for_render(): array {
		$s = $this->settings();
		return array(
			'enabled'         => $s['enabled'],
			'rule_all'        => $s['rule_all'],
			'scope'           => $s['scope'],
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

	/**
	 * The offload mapping recorded for an attachment, or an empty shape. Legacy mappings
	 * written before the scope feature carry no `variant`; they are treated as
	 * `derivative` (every pre-existing offload was a WebP derivative), preserving the
	 * historical rewrite behaviour for already-offloaded images.
	 */
	public function offload_meta( int $attachment_id ): array {
		$empty = array( 'key' => '', 'url' => '', 'etag' => '', 'ts' => 0, 'variant' => self::VARIANT_DERIVATIVE, 'src_url' => '' );
		if ( $attachment_id <= 0 || ! function_exists( 'get_post_meta' ) ) {
			return $empty;
		}
		$raw = get_post_meta( $attachment_id, self::OFFLOAD_META, true );
		if ( ! is_array( $raw ) ) {
			return $empty;
		}
		$variant = isset( $raw['variant'] ) && self::VARIANT_ORIGINAL === (string) $raw['variant']
			? self::VARIANT_ORIGINAL
			: self::VARIANT_DERIVATIVE;
		return array(
			'key'     => isset( $raw['key'] ) ? (string) $raw['key'] : '',
			'url'     => isset( $raw['url'] ) ? (string) $raw['url'] : '',
			'etag'    => isset( $raw['etag'] ) ? (string) $raw['etag'] : '',
			'ts'      => isset( $raw['ts'] ) ? (int) $raw['ts'] : 0,
			'variant' => $variant,
			'src_url' => isset( $raw['src_url'] ) ? (string) $raw['src_url'] : '',
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

	/** True when the attachment is an image (its mime type starts with "image/"). */
	public function is_image_attachment( int $attachment_id ): bool {
		if ( $attachment_id <= 0 || ! function_exists( 'get_post_mime_type' ) ) {
			return false;
		}
		$mime = get_post_mime_type( $attachment_id );
		return is_string( $mime ) && 0 === strpos( $mime, 'image/' );
	}

	/**
	 * Whether an attachment should be offloaded, per the rule + scope + manual overrides:
	 *   manual 'deny'  → NEVER (overrides the rule, in BOTH scopes).
	 *   manual 'allow' → ALWAYS (even without the optimized marker, in BOTH scopes).
	 *   otherwise      → rule ON AND — per scope — the image is optimized (scope
	 *                    'optimized') OR is any image attachment (scope 'all').
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
		$s = $this->settings();
		if ( empty( $s['rule_all'] ) ) {
			return false;
		}
		if ( self::SCOPE_ALL === $s['scope'] ) {
			return $this->is_image_attachment( $attachment_id );
		}
		return $this->is_optimized( $attachment_id );
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

		$scope = self::SCOPE_OPTIMIZED;
		if ( isset( $input['scope'] ) ) {
			$raw_scope = self::request_string( $input['scope'] );
			if ( self::SCOPE_ALL === $raw_scope ) {
				$scope = self::SCOPE_ALL;
			} elseif ( self::SCOPE_OPTIMIZED !== $raw_scope ) {
				return array( 'ok' => false, 'reason' => 'bad-scope' );
			}
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
			'scope'           => $scope,
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
	 * Offload ONE attachment: PUT its source file, HEAD-verify the object, and ONLY on
	 * verification success record the `_iwsl_offload` mapping. STATEMENT 1 is the gate.
	 * The source is the optimizer WebP derivative when it exists (smaller — variant
	 * 'derivative'), otherwise (scope 'all') the attachment's OWN original file (variant
	 * 'original', same format/name). On any put/verify failure the mapping is NOT written
	 * (left for retry) and the error is surfaced. Never deletes or modifies any local file.
	 *
	 * @return array{ ok:bool, id:int, reason?:string, key?:string, url?:string, etag?:string, variant?:string, error?:string, skipped?:bool }
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

		$source = $this->offload_source( $attachment_id );
		if ( empty( $source['ok'] ) ) {
			return array( 'ok' => false, 'id' => $attachment_id, 'reason' => (string) $source['reason'] );
		}
		$variant      = (string) $source['variant'];
		$path         = (string) $source['path'];
		$key          = (string) $source['key'];
		$content_type = (string) $source['content_type'];
		$src_url      = (string) $source['src_url'];

		$body = $this->read_file( $path );
		if ( null === $body ) {
			return array( 'ok' => false, 'id' => $attachment_id, 'reason' => 'read-failed' );
		}

		$client = $this->s3();
		$put    = $client->put_object( $key, $body, $content_type );
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
			array( 'key' => $key, 'url' => $url, 'etag' => $etag, 'ts' => ( $this->now )(), 'variant' => $variant, 'src_url' => $src_url )
		);

		return array( 'ok' => true, 'id' => $attachment_id, 'key' => $key, 'url' => $url, 'etag' => $etag, 'variant' => $variant );
	}

	/**
	 * Resolve the SOURCE file to upload for an attachment. Prefers the optimizer's WebP
	 * derivative when it exists on disk (variant 'derivative', content type image/webp).
	 * Otherwise — ONLY under scope 'all' — falls back to the attachment's own original
	 * file (variant 'original', uploaded under its own mime, same key/name). Under scope
	 * 'optimized' a missing derivative is refused with 'no-derivative' (historical
	 * behaviour: that scope ships only the smaller WebP). Every key is validated so a
	 * malformed / escaping path is never signed or PUT.
	 *
	 * @return array{ ok:bool, reason?:string, variant?:string, path?:string, key?:string, content_type?:string, src_url?:string }
	 */
	private function offload_source( int $attachment_id ): array {
		$deriv = ( $this->derivative_resolver )( $attachment_id );
		if ( is_array( $deriv ) && ! empty( $deriv['exists'] ) && ! empty( $deriv['path'] ) ) {
			$key = $this->offload_key_for( (string) $deriv['path'] );
			if ( '' === $key ) {
				return array( 'ok' => false, 'reason' => 'bad-key' );
			}
			return array(
				'ok'           => true,
				'variant'      => self::VARIANT_DERIVATIVE,
				'path'         => (string) $deriv['path'],
				'key'          => $key,
				'content_type' => self::CONTENT_TYPE,
				'src_url'      => $this->attachment_url( $attachment_id ),
			);
		}

		if ( self::SCOPE_ALL !== $this->settings()['scope'] ) {
			return array( 'ok' => false, 'reason' => 'no-derivative' );
		}

		$path = $this->attached_file( $attachment_id );
		if ( '' === $path ) {
			return array( 'ok' => false, 'reason' => 'no-source' );
		}
		$key = $this->original_key_for( $path );
		if ( '' === $key ) {
			return array( 'ok' => false, 'reason' => 'bad-key' );
		}
		$mime = $this->attachment_mime( $attachment_id );
		if ( '' === $mime || 0 !== strpos( $mime, 'image/' ) ) {
			return array( 'ok' => false, 'reason' => 'not-image' );
		}
		return array(
			'ok'           => true,
			'variant'      => self::VARIANT_ORIGINAL,
			'path'         => $path,
			'key'          => $key,
			'content_type' => $mime,
			'src_url'      => $this->attachment_url( $attachment_id ),
		);
	}

	/**
	 * Remove ONE attachment from the bucket ("bring back to disk"): DELETE the object and
	 * clear the mapping meta. STATEMENT 1 is the gate. Idempotent (a not-offloaded id is a
	 * success no-op). NEVER deletes the last copy: if the LOCAL file is MISSING, the bucket
	 * object is DOWNLOADED back to disk (public → public bucket URL, private → a presigned
	 * GET) and verified non-empty FIRST; only then is the bucket object deleted. If the
	 * download/verify fails the bucket copy is KEPT and an error is surfaced. When the local
	 * file already exists nothing is downloaded (the historical delete-only path). On a
	 * delete failure the mapping is kept (so a retry is possible) and the error is surfaced.
	 *
	 * @return array{ ok:bool, id:int, reason?:string, error?:string, restored?:bool }
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

		// Never delete the last copy: restore a missing local file from the bucket first.
		$restore = $this->ensure_local_copy( $attachment_id, $meta );
		if ( empty( $restore['ok'] ) ) {
			return array(
				'ok'     => false,
				'id'     => $attachment_id,
				'reason' => 'restore-failed',
				'error'  => isset( $restore['error'] ) ? (string) $restore['error'] : 'restore-failed',
			);
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
		$out = array( 'ok' => true, 'id' => $attachment_id );
		if ( ! empty( $restore['restored'] ) ) {
			$out['restored'] = true;
		}
		return $out;
	}

	/**
	 * Guarantee a local copy of an offloaded attachment's file exists BEFORE its bucket
	 * object is deleted. If the local path is unknown or the file is already present, this
	 * is a no-op success. Otherwise the bucket object is fetched over HTTP (public bucket
	 * URL or a fresh presigned GET, via delivery_url_for) and written to the local path,
	 * then verified non-empty. Returns ok:false (bucket copy MUST be kept) on any
	 * download / write / verify failure.
	 *
	 * @return array{ ok:bool, error?:string, restored?:bool }
	 */
	private function ensure_local_copy( int $attachment_id, array $meta ): array {
		$path = $this->attached_file( $attachment_id );
		if ( '' === $path ) {
			return array( 'ok' => true ); // no known local path — nothing to restore.
		}
		if ( is_file( $path ) ) {
			return array( 'ok' => true ); // local file already present.
		}

		$url = $this->delivery_url_for( $meta );
		if ( '' === $url ) {
			return array( 'ok' => false, 'error' => 'no-download-url' );
		}
		$resp = ( $this->http_get )( $url );
		$body = is_array( $resp ) && isset( $resp['body'] ) && is_string( $resp['body'] ) ? (string) $resp['body'] : '';
		if ( ! is_array( $resp ) || empty( $resp['ok'] ) || '' === $body ) {
			return array( 'ok' => false, 'error' => 'download-failed' );
		}
		if ( ! $this->restore_file( $path, $body ) ) {
			return array( 'ok' => false, 'error' => 'write-failed' );
		}
		if ( ! is_file( $path ) ) {
			return array( 'ok' => false, 'error' => 'verify-failed' );
		}
		$size = filesize( $path );
		if ( false === $size || $size <= 0 ) {
			return array( 'ok' => false, 'error' => 'verify-failed' );
		}
		return array( 'ok' => true, 'restored' => true );
	}

	/** Write restored bytes to a local path (creating its directory), true on a non-empty write. */
	private function restore_file( string $path, string $body ): bool {
		$dir = dirname( $path );
		if ( '' !== $dir && ! is_dir( $dir ) ) {
			if ( function_exists( 'wp_mkdir_p' ) ) {
				wp_mkdir_p( $dir );
			} else {
				@mkdir( $dir, 0755, true );
			}
		}
		$bytes = @file_put_contents( $path, $body );
		return is_int( $bytes ) && $bytes > 0;
	}

	// ── batch orchestration (ONE image per call; JS loops it) ─────────────────────

	/** The next attachment the offload pass will process, or 0 when the queue is empty. */
	public function next_candidate_id(): int {
		foreach ( ( $this->candidate_provider )( 1 ) as $id ) {
			$iid = (int) $id;
			if ( $iid > 0 && $this->qualifies( $iid ) && ! $this->is_offloaded( $iid ) && $this->has_offloadable_source( $iid ) ) {
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
			if ( ! $this->is_offloaded( $iid ) && $this->has_offloadable_source( $iid ) ) {
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

	/**
	 * AJAX: enumerate the buckets the entered (or stored) credentials can see, grouped
	 * by Hetzner location, for the wizard's live dropdown. Reads the access key +
	 * secret from POST (the creds the operator just typed); the aggregation itself
	 * enforces the gate + the stored-secret fallback + secret hygiene.
	 */
	public function handle_buckets_ajax(): void {
		$this->ajax_guard();
		$access_key = isset( $_POST['access_key'] ) && is_scalar( $_POST['access_key'] ) ? (string) $_POST['access_key'] : '';
		$secret_key = isset( $_POST['secret_key'] ) && is_scalar( $_POST['secret_key'] ) ? (string) $_POST['secret_key'] : '';
		$this->send_json( $this->list_buckets( $access_key, $secret_key ) );
	}

	/**
	 * Enumerate the buckets visible to a pair of S3 credentials, grouped by Hetzner
	 * location. STATEMENT 1 is the gate. The ENTERED secret is used only in memory;
	 * a BLANK secret (the wizard re-opened, where the field shows only a placeholder)
	 * falls back to the STORED decrypted secret so listing still works. Each location
	 * is queried at its OWN endpoint because Hetzner's ListBuckets is per-location.
	 * Returns { ok, owner, locations:{ fsn1:[], nbg1:[], hel1:[] }, error }. When every
	 * location fails on auth, `ok` is false with a friendly reason. The `secret_key`
	 * is NEVER returned, echoed, or logged.
	 *
	 * @return array{ ok:bool, owner:string, locations:array<string,string[]>, error:string }
	 */
	public function list_buckets( string $access_key, string $secret_key ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'owner' => '', 'locations' => array(), 'error' => 'entitlement-locked' );
		}

		$access_key = self::request_string( $access_key );
		$secret_key = self::request_string( $secret_key );
		if ( '' === $secret_key ) {
			$stored     = $this->settings()['secret'];
			$secret_key = '' !== $stored ? (string) $this->decrypt_secret( $stored ) : '';
		}
		if ( '' === $access_key || '' === $secret_key ) {
			return array( 'ok' => false, 'owner' => '', 'locations' => array(), 'error' => 'incomplete-credentials' );
		}

		$locations   = array();
		$owner       = '';
		$any_ok      = false;
		$queried     = 0;
		$auth_errors = 0;

		foreach ( array_keys( self::LOCATIONS ) as $loc ) {
			$locations[ $loc ] = array();
			$client            = $this->s3(
				array(
					'endpoint'   => $loc . '.' . self::ENDPOINT_SUFFIX,
					'region'     => $loc,
					'bucket'     => '', // service-level listing needs no bucket.
					'access_key' => $access_key,
					'secret_key' => $secret_key,
					'acl'        => self::ACL,
					'path_style' => self::PATH_STYLE,
				)
			);
			if ( ! method_exists( $client, 'list_buckets' ) ) {
				continue;
			}
			++$queried;
			$res = $client->list_buckets();
			if ( ! is_array( $res ) ) {
				continue;
			}
			if ( ! empty( $res['ok'] ) ) {
				$any_ok            = true;
				$locations[ $loc ] = isset( $res['buckets'] ) && is_array( $res['buckets'] )
					? array_values( array_map( 'strval', $res['buckets'] ) )
					: array();
				if ( '' === $owner && isset( $res['owner'] ) && '' !== (string) $res['owner'] ) {
					$owner = (string) $res['owner'];
				}
			} elseif ( self::is_auth_error( isset( $res['error'] ) ? (string) $res['error'] : '' ) ) {
				++$auth_errors;
			}
		}

		if ( ! $any_ok ) {
			$reason = ( $queried > 0 && $auth_errors >= $queried ) ? 'auth-failed' : 'no-buckets-listed';
			return array( 'ok' => false, 'owner' => '', 'locations' => $locations, 'error' => $reason );
		}

		return array( 'ok' => true, 'owner' => $owner, 'locations' => $locations, 'error' => '' );
	}

	// ── management panel AJAX: paginated list + per-id offload + bulk ──────────────

	/** AJAX: a filtered, paginated page of the media library with per-image offload state. */
	public function handle_list_ajax(): void {
		$this->ajax_guard();
		$page     = isset( $_POST['page'] ) ? (int) $_POST['page'] : 1;
		$per_page = isset( $_POST['per_page'] ) ? (int) $_POST['per_page'] : self::LIST_PER_PAGE;
		$format   = isset( $_POST['format'] ) ? self::request_string( $_POST['format'] ) : '';
		$status   = isset( $_POST['status'] ) ? self::request_string( $_POST['status'] ) : 'all';
		$search   = isset( $_POST['search'] ) ? self::request_string( $_POST['search'] ) : '';
		$this->send_json( $this->list_attachments( $page, $per_page, $format, $status, $search ) );
	}

	/** AJAX: offload exactly ONE attachment chosen by id (management row action). */
	public function handle_offload_one_ajax(): void {
		$this->ajax_guard();
		$id = isset( $_POST['id'] ) ? (int) $_POST['id'] : 0;
		$this->send_json( $this->offload_one( $id ) );
	}

	/** AJAX: bulk offload / bring-back for a checked set of ids (capped per call). */
	public function handle_bulk_ajax(): void {
		$this->ajax_guard();
		$op  = isset( $_POST['op'] ) ? self::request_string( $_POST['op'] ) : '';
		$ids = isset( $_POST['ids'] ) && is_array( $_POST['ids'] ) ? $_POST['ids'] : array();
		$this->send_json( $this->bulk( $op, $ids ) );
	}

	/**
	 * A filtered, paginated page of image attachments with each row's offload state.
	 * STATEMENT 1 is the gate. Inputs are clamped/validated: page ≥ 1, per_page in
	 * [1, LIST_PER_PAGE_MAX] (default LIST_PER_PAGE), status ∈ {all, offloaded, disk},
	 * format is a validated image mime or '' (all images), search is a free filename term.
	 * `counts` is the OVERALL unfiltered tally; `formats` lists the distinct image mimes
	 * present. Never returns the secret.
	 *
	 * @return array{ ok:bool, reason?:string, rows?:array, page?:int, per_page?:int, total_matching?:int, formats?:string[], counts?:array }
	 */
	public function list_attachments( int $page, int $per_page, string $format, string $status, string $search ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		$page     = max( 1, $page );
		$per_page = $per_page > 0 ? min( $per_page, self::LIST_PER_PAGE_MAX ) : self::LIST_PER_PAGE;
		$status   = in_array( $status, array( 'all', 'offloaded', 'disk' ), true ) ? $status : 'all';
		$format   = ( '' !== $format && 1 === preg_match( '#^image/[A-Za-z0-9.+-]+$#', $format ) ) ? $format : '';

		$q    = $this->run_attachment_query( $this->list_query_args( $page, $per_page, $format, $status, $search ) );
		$rows = array();
		foreach ( $q['ids'] as $id ) {
			$rows[] = $this->list_row( (int) $id );
		}

		return array(
			'ok'             => true,
			'rows'           => $rows,
			'page'           => $page,
			'per_page'       => $per_page,
			'total_matching' => (int) $q['total'],
			'formats'        => $this->present_formats(),
			'counts'         => $this->list_counts(),
		);
	}

	/**
	 * Bulk offload / bring-back a set of ids. STATEMENT 1 is the gate. `$op` must be
	 * 'offload' or 'unoffload'; ids are cast, de-duplicated, positive-filtered, and capped
	 * at BULK_MAX per call. Each id runs the same single mutator (offload_one /
	 * unoffload_one) so every per-id guarantee (verify-before-record, restore-before-delete)
	 * holds. Returns per-id results plus an ok/failed summary.
	 *
	 * @param array<int,mixed> $ids
	 * @return array{ ok:bool, reason?:string, op?:string, results?:array, summary?:array }
	 */
	public function bulk( string $op, array $ids ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked' );
		}
		if ( 'offload' !== $op && 'unoffload' !== $op ) {
			return array( 'ok' => false, 'reason' => 'bad-op' );
		}

		$clean = array();
		foreach ( $ids as $id ) {
			$iid = (int) $id;
			if ( $iid > 0 && ! in_array( $iid, $clean, true ) ) {
				$clean[] = $iid;
			}
			if ( count( $clean ) >= self::BULK_MAX ) {
				break;
			}
		}

		$results = array();
		$ok      = 0;
		$failed  = 0;
		foreach ( $clean as $iid ) {
			$res       = 'offload' === $op ? $this->offload_one( $iid ) : $this->unoffload_one( $iid );
			$results[] = $res;
			if ( ! empty( $res['ok'] ) ) {
				++$ok;
			} else {
				++$failed;
			}
		}

		return array(
			'ok'      => true,
			'op'      => $op,
			'results' => $results,
			'summary' => array( 'total' => count( $clean ), 'ok' => $ok, 'failed' => $failed ),
		);
	}

	// ── list query + row helpers (WP_Query-backed; guarded for the harness) ────────

	/** Build the WP_Query args for a filtered/paginated image-attachment page. */
	private function list_query_args( int $page, int $per_page, string $format, string $status, string $search ): array {
		$args = array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'post_mime_type' => '' !== $format ? $format : 'image',
			'fields'         => 'ids',
			'paged'          => $page,
			'posts_per_page' => $per_page,
			'orderby'        => 'date',
			'order'          => 'DESC',
		);
		if ( 'offloaded' === $status ) {
			$args['meta_query'] = array( array( 'key' => self::OFFLOAD_META, 'compare' => 'EXISTS' ) ); // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
		} elseif ( 'disk' === $status ) {
			$args['meta_query'] = array( array( 'key' => self::OFFLOAD_META, 'compare' => 'NOT EXISTS' ) ); // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
		}
		if ( '' !== $search ) {
			$args['s'] = $search;
		}
		return $args;
	}

	/** Run a WP_Query, returning { ids:int[], total:int }. Empty when WP_Query is absent. */
	private function run_attachment_query( array $args ): array {
		if ( ! class_exists( 'WP_Query' ) ) {
			return array( 'ids' => array(), 'total' => 0 );
		}
		$q     = new WP_Query( $args );
		$posts = isset( $q->posts ) && is_array( $q->posts ) ? $q->posts : array();
		$ids   = array();
		foreach ( $posts as $p ) {
			$ids[] = (int) ( is_object( $p ) && isset( $p->ID ) ? $p->ID : $p );
		}
		$total = isset( $q->found_posts ) ? (int) $q->found_posts : count( $ids );
		return array( 'ids' => $ids, 'total' => $total );
	}

	/** The OVERALL (unfiltered) tally of image attachments split by offload state. */
	private function list_counts(): array {
		$all       = $this->count_attachments( array() );
		$offloaded = $this->count_attachments( array( array( 'key' => self::OFFLOAD_META, 'compare' => 'EXISTS' ) ) );
		return array( 'all' => $all, 'offloaded' => $offloaded, 'disk' => max( 0, $all - $offloaded ) );
	}

	/** Count image attachments, optionally constrained by a meta_query. */
	private function count_attachments( array $meta_query ): int {
		$args = array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'post_mime_type' => 'image',
			'fields'         => 'ids',
			'paged'          => 1,
			'posts_per_page' => 1,
		);
		if ( array() !== $meta_query ) {
			$args['meta_query'] = $meta_query; // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
		}
		return $this->run_attachment_query( $args )['total'];
	}

	/** The distinct image mime types present in the library (for the format filter). */
	private function present_formats(): array {
		$q = $this->run_attachment_query(
			array(
				'post_type'      => 'attachment',
				'post_status'    => 'inherit',
				'post_mime_type' => 'image',
				'fields'         => 'ids',
				'paged'          => 1,
				'posts_per_page' => self::MAX_MANUAL,
			)
		);
		$seen = array();
		foreach ( $q['ids'] as $id ) {
			$mime = $this->attachment_mime( (int) $id );
			if ( '' !== $mime && 0 === strpos( $mime, 'image/' ) ) {
				$seen[ $mime ] = true;
			}
		}
		$formats = array_keys( $seen );
		sort( $formats );
		return $formats;
	}

	/**
	 * Build one management row for an attachment. `thumb` is the RAW local thumbnail URL
	 * (built from disk, bypassing our own bucket-rewrite filters so the table renders fast
	 * and consistently). `bucket_url`/`variant`/`location` are only populated when offloaded.
	 *
	 * @return array{ id:int, name:string, mime:string, size:int, thumb:string, offloaded:bool, variant:string, location:string, bucket_url:string, dims:string }
	 */
	private function list_row( int $id ): array {
		$meta      = $this->offload_meta( $id );
		$offloaded = '' !== $meta['key'];
		return array(
			'id'         => $id,
			'name'       => $this->attachment_name( $id ),
			'mime'       => $this->attachment_mime( $id ),
			'size'       => $this->attachment_filesize( $id ),
			'thumb'      => $this->raw_thumb_url( $id ),
			'offloaded'  => $offloaded,
			'variant'    => $offloaded ? $meta['variant'] : '',
			'location'   => $offloaded ? $this->settings()['location'] : '',
			'bucket_url' => $offloaded ? $meta['url'] : '',
			'dims'       => $this->attachment_dims( $id ),
		);
	}

	/** The attachment's display name — its title, else the on-disk filename, else "#id". */
	private function attachment_name( int $id ): string {
		$title = function_exists( 'get_the_title' ) ? (string) get_the_title( $id ) : '';
		if ( '' !== $title ) {
			return $title;
		}
		$file = $this->attached_file( $id );
		return '' !== $file ? basename( $file ) : ( '#' . $id );
	}

	/** The attachment's local file size in bytes (0 when unavailable). */
	private function attachment_filesize( int $id ): int {
		$file = $this->attached_file( $id );
		if ( '' === $file || ! is_file( $file ) ) {
			return 0;
		}
		$size = filesize( $file );
		return is_int( $size ) && $size > 0 ? $size : 0;
	}

	/** The attachment's "WxH" dimension label from its metadata, or '' when unknown. */
	private function attachment_dims( int $id ): string {
		if ( ! function_exists( 'wp_get_attachment_metadata' ) ) {
			return '';
		}
		$m = wp_get_attachment_metadata( $id );
		if ( is_array( $m ) && isset( $m['width'], $m['height'] ) ) {
			return (int) $m['width'] . 'x' . (int) $m['height'];
		}
		return '';
	}

	/**
	 * The RAW local thumbnail URL for an attachment (uploads baseurl + its relative path,
	 * preferring the generated `thumbnail` size). Built directly from disk metadata so it
	 * bypasses our bucket-rewrite filters — the table always shows a fast local preview.
	 * '' when the uploads base URL or the file path is unavailable.
	 */
	private function raw_thumb_url( int $id ): string {
		$baseurl = $this->upload_baseurl();
		if ( '' === $baseurl ) {
			return '';
		}
		$rel = $this->uploads_relative_key( $this->attached_file( $id ) );
		if ( '' === $rel ) {
			return '';
		}
		$meta = function_exists( 'wp_get_attachment_metadata' ) ? wp_get_attachment_metadata( $id ) : array();
		if ( is_array( $meta ) && isset( $meta['sizes']['thumbnail']['file'] ) && is_string( $meta['sizes']['thumbnail']['file'] ) ) {
			$slash = strrpos( $rel, '/' );
			$dir   = false !== $slash ? substr( $rel, 0, $slash + 1 ) : '';
			$rel   = $dir . $meta['sizes']['thumbnail']['file'];
		}
		return rtrim( $baseurl, '/' ) . '/' . ltrim( $rel, '/' );
	}

	/** The uploads base URL (for building raw local media URLs), or '' when unavailable. */
	private function upload_baseurl(): string {
		if ( function_exists( 'wp_upload_dir' ) ) {
			$d = wp_upload_dir();
			if ( is_array( $d ) && isset( $d['baseurl'] ) && is_string( $d['baseurl'] ) ) {
				return $d['baseurl'];
			}
		}
		return '';
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
	 * connection wizard (access key + secret → Load my buckets → pick one from the live
	 * location-grouped dropdown, which auto-sets the location; a manual-entry fallback
	 * covers keys without list permission → Test connection), the enable + rule toggles,
	 * and the "Offload now" / "Remove from bucket" progress controls. The secret is
	 * NEVER rendered — only a "secret is set" indicator.
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
		echo '<p class="description">' . self::esc_html_safe( 'Copy your images to Hetzner Object Storage and serve them from the bucket. Choose optimized-only (smaller WebP) or all images below. Your local originals are always kept — nothing is ever deleted.' ) . '</p>';

		$this->render_config_wizard( (string) $action_url, $view );
		$this->render_offload_controls( $view );
		$this->render_manage_panel( $view );
		$this->render_inline_script();

		echo '</div>';
	}

	/**
	 * The media-management panel below the wizard: a filter bar (format / status / search),
	 * a counts summary, a table of images with per-row offload state + actions, bulk
	 * offload / bring-back buttons, and pagination. Rendered only once the bucket + creds
	 * are configured; otherwise a hint points back to the wizard. The table body is filled
	 * client-side from AJAX_LIST using DOM APIs (no untrusted innerHTML). All server output
	 * here is escaped.
	 */
	private function render_manage_panel( array $view ): void {
		$configured = '' !== $view['bucket'] && '' !== $view['access_key'] && ! empty( $view['has_secret'] );

		echo '<div class="iwsl-offload-manage">';
		echo '<h3>' . self::esc_html_safe( 'Manage media' ) . '</h3>';
		if ( ! $configured ) {
			echo '<p class="description iwsl-offload-manage-hint">' . self::esc_html_safe( 'Finish the connection wizard above — set your bucket, access key and secret and Save — then manage your images here.' ) . '</p></div>';
			return;
		}

		// Filter bar. The format <select> is populated client-side from the list response.
		echo '<div class="iwsl-offload-filters">';
		echo '<label>' . self::esc_html_safe( 'Format' ) . ' <select id="iwsl-offload-f-format"><option value="">' . self::esc_html_safe( 'All formats' ) . '</option></select></label> ';
		echo '<label>' . self::esc_html_safe( 'Status' ) . ' <select id="iwsl-offload-f-status">';
		echo '<option value="all">' . self::esc_html_safe( 'All' ) . '</option>';
		echo '<option value="offloaded">' . self::esc_html_safe( 'On bucket' ) . '</option>';
		echo '<option value="disk">' . self::esc_html_safe( 'On disk' ) . '</option>';
		echo '</select></label> ';
		echo '<label>' . self::esc_html_safe( 'Search' ) . ' <input type="search" id="iwsl-offload-f-search" placeholder="' . self::esc_attr_safe( 'Filename…' ) . '" autocomplete="off" /></label> ';
		echo '<button type="button" class="button" id="iwsl-offload-f-apply">' . self::esc_html_safe( 'Apply' ) . '</button>';
		echo '</div>';

		echo '<p id="iwsl-offload-manage-counts" class="description" aria-live="polite"></p>';

		// Bulk actions.
		echo '<p class="iwsl-offload-bulk">';
		echo '<button type="button" class="button" id="iwsl-offload-bulk-offload">' . self::esc_html_safe( 'Offload selected' ) . '</button> ';
		echo '<button type="button" class="button" id="iwsl-offload-bulk-restore">' . self::esc_html_safe( 'Bring back selected' ) . '</button> ';
		echo '<span id="iwsl-offload-bulk-status" aria-live="polite"></span>';
		echo '</p>';

		// Table shell. tbody rows are built by the script from AJAX_LIST.
		echo '<table class="widefat striped iwsl-offload-table"><thead><tr>';
		echo '<th class="check-column"><input type="checkbox" id="iwsl-offload-check-all" /></th>';
		echo '<th>' . self::esc_html_safe( 'Preview' ) . '</th>';
		echo '<th>' . self::esc_html_safe( 'Filename' ) . '</th>';
		echo '<th>' . self::esc_html_safe( 'Format' ) . '</th>';
		echo '<th>' . self::esc_html_safe( 'Size' ) . '</th>';
		echo '<th>' . self::esc_html_safe( 'Status' ) . '</th>';
		echo '<th>' . self::esc_html_safe( 'Variant' ) . '</th>';
		echo '<th>' . self::esc_html_safe( 'Actions' ) . '</th>';
		echo '</tr></thead><tbody id="iwsl-offload-rows"></tbody></table>';

		// Pagination.
		echo '<p class="iwsl-offload-pager">';
		echo '<button type="button" class="button" id="iwsl-offload-prev">' . self::esc_html_safe( '‹ Prev' ) . '</button> ';
		echo '<span id="iwsl-offload-page-info" aria-live="polite"></span> ';
		echo '<button type="button" class="button" id="iwsl-offload-next">' . self::esc_html_safe( 'Next ›' ) . '</button>';
		echo '</p>';

		echo '</div>';

		$this->render_manage_script();
	}

	/**
	 * The vanilla-JS driver for the management panel: fetches AJAX_LIST, renders each row
	 * with DOM APIs (textContent / setAttribute / createElement — never innerHTML with
	 * server values), wires filters + pagination + per-row + bulk actions, and re-fetches
	 * after every mutation so status pills stay current.
	 */
	private function render_manage_script(): void {
		$cfg  = array(
			'ajaxUrl'   => function_exists( 'admin_url' ) ? admin_url( 'admin-ajax.php' ) : 'admin-ajax.php',
			'nonce'     => function_exists( 'wp_create_nonce' ) ? wp_create_nonce( self::NONCE ) : '',
			'actList'   => self::AJAX_LIST,
			'actOne'    => self::AJAX_OFFLOAD_ONE,
			'actUnoff'  => self::AJAX_UNOFFLOAD,
			'actBulk'   => self::AJAX_BULK,
			'perPage'   => self::LIST_PER_PAGE,
			'onBucket'  => self::esc_html_safe( 'On bucket' ),
			'onDisk'    => self::esc_html_safe( 'On disk' ),
			'offload'   => self::esc_html_safe( 'Offload' ),
			'bringBack' => self::esc_html_safe( 'Bring back to disk' ),
			'openLabel' => self::esc_html_safe( 'Open on bucket' ),
		);
		$json = function_exists( 'wp_json_encode' ) ? wp_json_encode( $cfg ) : json_encode( $cfg );
		echo "<script>(function(){var mcfg=" . $json . ";\n";
		echo <<<'JS'
var state={page:1,per_page:mcfg.perPage,format:'',status:'all',search:'',pages:1,fmtLoaded:false};
function q(id){return document.getElementById(id);}
function mpost(action,extra,ids){var b=new URLSearchParams();b.set('action',action);b.set('nonce',mcfg.nonce);if(extra){for(var k in extra){if(Object.prototype.hasOwnProperty.call(extra,k)){b.set(k,extra[k]);}}}if(ids){for(var i=0;i<ids.length;i++){b.append('ids[]',ids[i]);}}return fetch(mcfg.ajaxUrl,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString()}).then(function(r){return r.json();});}
function humanSize(n){n=Number(n)||0;if(n<1024){return n+' B';}var u=['KB','MB','GB'],i=-1;do{n=n/1024;i++;}while(n>=1024&&i<u.length-1);return n.toFixed(1)+' '+u[i];}
function pill(row){var span=document.createElement('span');if(row.offloaded){span.textContent='\u{1F7E2} '+mcfg.onBucket+(row.location?(' · '+row.location):'');}else{span.textContent='⚪ '+mcfg.onDisk;}return span;}
function actionCell(row){var td=document.createElement('td');if(row.offloaded){var back=document.createElement('button');back.type='button';back.className='button button-small';back.textContent=mcfg.bringBack;back.addEventListener('click',function(){rowAction(mcfg.actUnoff,row.id,back);});td.appendChild(back);if(row.bucket_url){td.appendChild(document.createTextNode(' '));var a=document.createElement('a');a.textContent=mcfg.openLabel;a.setAttribute('href',row.bucket_url);a.setAttribute('target','_blank');a.setAttribute('rel','noopener noreferrer');td.appendChild(a);}}else{var off=document.createElement('button');off.type='button';off.className='button button-small';off.textContent=mcfg.offload;off.addEventListener('click',function(){rowAction(mcfg.actOne,row.id,off);});td.appendChild(off);}return td;}
function rowAction(action,id,btn){if(btn){btn.disabled=true;btn.textContent='…';}mpost(action,{id:id}).then(function(){fetchList();}).catch(function(){if(btn){btn.disabled=false;}});}
function renderRows(rows){var tb=q('iwsl-offload-rows');while(tb.firstChild){tb.removeChild(tb.firstChild);}if(!rows||!rows.length){var tr=document.createElement('tr');var td=document.createElement('td');td.setAttribute('colspan','8');td.textContent='No images match these filters.';tr.appendChild(td);tb.appendChild(tr);return;}for(var i=0;i<rows.length;i++){var row=rows[i];var tr=document.createElement('tr');var cChk=document.createElement('td');var chk=document.createElement('input');chk.type='checkbox';chk.className='iwsl-offload-rowcheck';chk.value=row.id;cChk.appendChild(chk);tr.appendChild(cChk);var cImg=document.createElement('td');if(row.thumb){var img=document.createElement('img');img.setAttribute('src',row.thumb);img.setAttribute('alt','');img.setAttribute('width','48');img.setAttribute('height','48');img.setAttribute('loading','lazy');img.style.objectFit='cover';cImg.appendChild(img);}tr.appendChild(cImg);var cName=document.createElement('td');cName.textContent=row.name+(row.dims?(' ('+row.dims+')'):'');tr.appendChild(cName);var cFmt=document.createElement('td');var badge=document.createElement('code');badge.textContent=row.mime||'';cFmt.appendChild(badge);tr.appendChild(cFmt);var cSize=document.createElement('td');cSize.textContent=humanSize(row.size);tr.appendChild(cSize);var cStat=document.createElement('td');cStat.appendChild(pill(row));tr.appendChild(cStat);var cVar=document.createElement('td');cVar.textContent=row.variant||'—';tr.appendChild(cVar);tr.appendChild(actionCell(row));tb.appendChild(tr);}}
function fillFormats(formats){if(state.fmtLoaded){return;}var sel=q('iwsl-offload-f-format');if(!sel){return;}for(var i=0;i<formats.length;i++){var o=document.createElement('option');o.value=formats[i];o.textContent=formats[i];sel.appendChild(o);}state.fmtLoaded=true;}
function fetchList(){mpost(mcfg.actList,{page:state.page,per_page:state.per_page,format:state.format,status:state.status,search:state.search}).then(function(j){var d=j&&j.data?j.data:{};if(!d.ok){q('iwsl-offload-manage-counts').textContent='Could not load media.';return;}fillFormats(d.formats||[]);renderRows(d.rows||[]);var c=d.counts||{all:0,offloaded:0,disk:0};q('iwsl-offload-manage-counts').textContent=c.all+' images · '+c.offloaded+' on bucket · '+c.disk+' on disk';var total=Number(d.total_matching)||0;state.pages=Math.max(1,Math.ceil(total/state.per_page));q('iwsl-offload-page-info').textContent='Page '+state.page+' of '+state.pages+' ('+total+' matching)';q('iwsl-offload-prev').disabled=(state.page<=1);q('iwsl-offload-next').disabled=(state.page>=state.pages);var ca=q('iwsl-offload-check-all');if(ca){ca.checked=false;}}).catch(function(){q('iwsl-offload-manage-counts').textContent='Could not load media (network error).';});}
function checkedIds(){var out=[];var list=document.querySelectorAll('.iwsl-offload-rowcheck');for(var i=0;i<list.length;i++){if(list[i].checked){out.push(list[i].value);}}return out;}
function bulk(op){var ids=checkedIds();var st=q('iwsl-offload-bulk-status');if(!ids.length){st.textContent='Select one or more images first.';return;}st.textContent='Working on '+ids.length+' image(s)…';mpost(mcfg.actBulk,{op:op},ids).then(function(j){var d=j&&j.data?j.data:{};if(d&&d.summary){st.textContent='Done: '+d.summary.ok+' ok, '+d.summary.failed+' failed.';}else{st.textContent='Done.';}fetchList();}).catch(function(){st.textContent='Bulk action failed.';});}
var ap=q('iwsl-offload-f-apply');if(ap){ap.addEventListener('click',function(){state.format=q('iwsl-offload-f-format').value;state.status=q('iwsl-offload-f-status').value;state.search=q('iwsl-offload-f-search').value;state.page=1;fetchList();});}
var pv=q('iwsl-offload-prev');if(pv){pv.addEventListener('click',function(){if(state.page>1){state.page--;fetchList();}});}
var nx=q('iwsl-offload-next');if(nx){nx.addEventListener('click',function(){if(state.page<state.pages){state.page++;fetchList();}});}
var ca=q('iwsl-offload-check-all');if(ca){ca.addEventListener('change',function(){var list=document.querySelectorAll('.iwsl-offload-rowcheck');for(var i=0;i<list.length;i++){list[i].checked=ca.checked;}});}
var bo=q('iwsl-offload-bulk-offload');if(bo){bo.addEventListener('click',function(){bulk('offload');});}
var br=q('iwsl-offload-bulk-restore');if(br){br.addEventListener('click',function(){bulk('unoffload');});}
fetchList();
})();</script>
JS;
		echo "\n";
	}

	/** The step-by-step connection wizard (config form + Test connection button). */
	private function render_config_wizard( string $action_url, array $view ): void {
		echo '<form method="post" action="' . self::esc_url_safe( $action_url ) . '" class="iwsl-offload-wizard">';
		echo '<input type="hidden" name="action" value="' . self::esc_attr_safe( self::ACTION_SAVE ) . '" />';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::NONCE_SAVE );
		}

		// Step 1 — credentials, then a live bucket dropdown loaded from them (manual fallback included).
		$this->render_bucket_step( $view );

		// Step 2 — enable + rule + which-images scope.
		$scope_all = self::SCOPE_ALL === $view['scope'];
		echo '<fieldset class="iwsl-step"><legend>' . self::esc_html_safe( 'Step 2 — Turn it on' ) . '</legend>';
		echo '<p><label><input type="checkbox" name="enabled" value="1" ' . self::checked( $view['enabled'] ) . '/> ' . self::esc_html_safe( 'Serve offloaded images from the bucket' ) . '</label></p>';
		echo '<p><label><input type="checkbox" name="rule_all" value="1" ' . self::checked( $view['rule_all'] ) . '/> ' . self::esc_html_safe( 'Offload images automatically (per the rule below)' ) . '</label></p>';
		echo '<p class="iwsl-offload-scope"><strong>' . self::esc_html_safe( 'Which images to offload' ) . '</strong></p>';
		echo '<p><label><input type="radio" name="scope" value="' . self::esc_attr_safe( self::SCOPE_OPTIMIZED ) . '" ' . self::checked( ! $scope_all ) . '/> '
			. self::esc_html_safe( 'Only optimized images (smaller WebP)' ) . '</label></p>';
		echo '<p><label><input type="radio" name="scope" value="' . self::esc_attr_safe( self::SCOPE_ALL ) . '" ' . self::checked( $scope_all ) . '/> '
			. self::esc_html_safe( 'All images (also uploads images that are already WebP or were never optimized, using the original file)' ) . '</label></p>';
		echo '<p class="description">' . self::esc_html_safe( '"Only optimized" ships the smaller WebP the optimizer created. "All images" also offloads pictures that are already WebP or were never optimized, uploading each image\'s own original file. Your local files are always kept.' ) . '</p></fieldset>';

		// Step 3 — bucket access: public objects vs private presigned-URL delivery.
		$is_private = self::ACCESS_PRIVATE === $view['access'];
		echo '<fieldset class="iwsl-step"><legend>' . self::esc_html_safe( 'Step 3 — Bucket access' ) . '</legend>';
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

	/**
	 * Credentials + a LIVE bucket dropdown loaded from those credentials. "Load my
	 * buckets" calls handle_buckets_ajax and the JS builds a `<select name="bucket">`
	 * grouped by location (`<optgroup>`), each `<option data-location="…">`; picking one
	 * auto-sets the hidden `location`. A manual-entry fallback (a plain bucket field +
	 * a location `<select>`) covers keys that lack the ListBuckets permission. The
	 * manual controls are DISABLED until toggled, so exactly one bucket/location pair is
	 * ever submitted, and both paths save through the same validated fields. The secret
	 * field is write-only — never pre-filled; a placeholder hints that one is stored.
	 */
	private function render_bucket_step( array $view ): void {
		$secret_ph = $view['has_secret'] ? 'Secret is set — leave blank to keep it' : 'Secret key';

		echo '<fieldset class="iwsl-step"><legend>' . self::esc_html_safe( 'Step 1 — Credentials & bucket' ) . '</legend>';
		echo '<p><label>' . self::esc_html_safe( 'Access key' ) . ' <input type="text" name="access_key" id="iwsl-offload-ak" value="' . self::esc_attr_safe( $view['access_key'] ) . '" autocomplete="off" /></label></p>';
		echo '<p><label>' . self::esc_html_safe( 'Secret key' ) . ' <input type="password" name="secret_key" id="iwsl-offload-sk" value="" placeholder="' . self::esc_attr_safe( $secret_ph ) . '" autocomplete="new-password" /></label></p>';
		echo '<p><button type="button" class="button" id="iwsl-offload-load-buckets">' . self::esc_html_safe( 'Load my buckets' ) . '</button> <span id="iwsl-offload-buckets-status" aria-live="polite"></span></p>';

		// Dynamic dropdown (default). Selecting an option auto-sets the hidden location.
		echo '<div id="iwsl-offload-bucket-dynamic">';
		echo '<p><label>' . self::esc_html_safe( 'Bucket' ) . ' <select name="bucket" id="iwsl-offload-bucket-select">';
		if ( '' !== $view['bucket'] ) {
			echo '<option value="' . self::esc_attr_safe( $view['bucket'] ) . '" data-location="' . self::esc_attr_safe( $view['location'] ) . '" selected="selected">'
				. self::esc_html_safe( $view['bucket'] . ' (' . $view['location'] . ')' ) . '</option>';
		} else {
			echo '<option value="">' . self::esc_html_safe( '— Load your buckets to choose —' ) . '</option>';
		}
		echo '</select></label></p>';
		echo '<input type="hidden" name="location" id="iwsl-offload-location" value="' . self::esc_attr_safe( $view['location'] ) . '" />';
		echo '<p id="iwsl-offload-owner" class="description" aria-live="polite"></p>';
		echo '</div>';

		// Manual fallback for keys without ListBuckets permission (disabled until toggled).
		echo '<p><label><input type="checkbox" id="iwsl-offload-manual-toggle" /> ' . self::esc_html_safe( 'Enter bucket manually (for keys without list permission)' ) . '</label></p>';
		echo '<div id="iwsl-offload-bucket-manual" style="display:none;">';
		echo '<p><label>' . self::esc_html_safe( 'Bucket name' ) . ' <input type="text" name="bucket" id="iwsl-offload-bucket-manual-input" value="' . self::esc_attr_safe( $view['bucket'] ) . '" autocomplete="off" disabled="disabled" /></label></p>';
		echo '<p><label>' . self::esc_html_safe( 'Location' ) . ' <select name="location" id="iwsl-offload-location-manual" disabled="disabled">';
		foreach ( self::LOCATIONS as $code => $label ) {
			echo '<option value="' . self::esc_attr_safe( $code ) . '" ' . self::selected( $code === $view['location'] ) . '>'
				. self::esc_html_safe( $label . ' (' . $code . ')' ) . '</option>';
		}
		echo '</select></label></p></div>';

		echo '<p><button type="button" class="button" id="iwsl-offload-test">' . self::esc_html_safe( 'Test connection' ) . '</button> <span id="iwsl-offload-test-result" aria-live="polite"></span></p>';
		echo '<p class="description">' . self::esc_html_safe( 'Load your buckets, pick one (the location fills in automatically), then Save. Save your bucket and credentials before testing.' ) . '</p>';
		echo '</fieldset>';
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
			'ajaxUrl'    => function_exists( 'admin_url' ) ? admin_url( 'admin-ajax.php' ) : 'admin-ajax.php',
			'nonce'      => function_exists( 'wp_create_nonce' ) ? wp_create_nonce( self::NONCE ) : '',
			'actTest'    => self::AJAX_TEST,
			'actBatch'   => self::AJAX_BATCH,
			'actUnoff'   => self::AJAX_UNOFFLOAD,
			'actBuckets' => self::AJAX_BUCKETS,
			'locLabels'  => self::LOCATIONS,
		);
		$json = function_exists( 'wp_json_encode' ) ? wp_json_encode( $cfg ) : json_encode( $cfg );
		echo "<script>(function(){var cfg=" . $json . ";\n";
		echo <<<'JS'
function post(action,extra){var b=new URLSearchParams();b.set('action',action);b.set('nonce',cfg.nonce);if(extra){for(var k in extra){b.set(k,extra[k]);}}return fetch(cfg.ajaxUrl,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString()}).then(function(r){return r.json();});}
var t=document.getElementById('iwsl-offload-test');if(t){t.addEventListener('click',function(){var o=document.getElementById('iwsl-offload-test-result');o.textContent='Testing…';post(cfg.actTest,{}).then(function(j){o.textContent=(j&&j.success&&j.data&&j.data.ok)?'Connection OK':'Connection failed';}).catch(function(){o.textContent='Connection failed';});});}
var lb=document.getElementById('iwsl-offload-load-buckets');
if(lb){lb.addEventListener('click',function(){var st=document.getElementById('iwsl-offload-buckets-status');var ak=document.getElementById('iwsl-offload-ak');var sk=document.getElementById('iwsl-offload-sk');if(st){st.textContent='Loading buckets…';}post(cfg.actBuckets,{access_key:ak?ak.value:'',secret_key:sk?sk.value:''}).then(function(j){var d=(j&&j.data)?j.data:{};var none='No buckets found for these keys — create one in the Hetzner Cloud console, or check the key permissions.';if(!d.ok){if(st){st.textContent=(d.error==='auth-failed')?'Could not authenticate with those keys — check the access key and secret.':none;}return;}var sel=document.getElementById('iwsl-offload-bucket-select');var count=0;if(sel){while(sel.firstChild){sel.removeChild(sel.firstChild);}var ph=document.createElement('option');ph.value='';ph.textContent='— Select a bucket —';sel.appendChild(ph);var locs=d.locations||{};for(var code in locs){if(!Object.prototype.hasOwnProperty.call(locs,code)){continue;}var names=locs[code]||[];if(!names.length){continue;}var og=document.createElement('optgroup');og.label=((cfg.locLabels&&cfg.locLabels[code])||code)+' ('+code+')';for(var i=0;i<names.length;i++){var opt=document.createElement('option');opt.value=names[i];opt.setAttribute('data-location',code);opt.textContent=names[i];og.appendChild(opt);count++;}sel.appendChild(og);}}if(st){st.textContent=count?('Loaded '+count+' bucket(s) — pick one below.'):none;}var own=document.getElementById('iwsl-offload-owner');if(own){own.textContent=d.owner?('Account: '+d.owner):'';}}).catch(function(){if(st){st.textContent='Could not load buckets (network error).';}});});}
var bsel=document.getElementById('iwsl-offload-bucket-select');
if(bsel){bsel.addEventListener('change',function(){var o=bsel.options[bsel.selectedIndex];var loc=o?o.getAttribute('data-location'):'';var h=document.getElementById('iwsl-offload-location');if(h&&loc){h.value=loc;}});}
var mt=document.getElementById('iwsl-offload-manual-toggle');
if(mt){mt.addEventListener('change',function(){var manual=mt.checked;var dyn=document.getElementById('iwsl-offload-bucket-dynamic');var man=document.getElementById('iwsl-offload-bucket-manual');if(dyn){dyn.style.display=manual?'none':'';}if(man){man.style.display=manual?'':'none';}var ds=document.getElementById('iwsl-offload-bucket-select');var dl=document.getElementById('iwsl-offload-location');var ms=document.getElementById('iwsl-offload-bucket-manual-input');var ml=document.getElementById('iwsl-offload-location-manual');if(ds){ds.disabled=manual;}if(dl){dl.disabled=manual;}if(ms){ms.disabled=!manual;}if(ml){ml.disabled=!manual;}});}
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
	 * The uploads-relative object key for a file path (path made relative to the uploads
	 * base dir). Returns '' when the path escapes the uploads root or the key is unsafe
	 * (empty, absolute, or traversal) so a malformed path is never signed/PUT. Extension
	 * validation is applied by the per-variant callers below.
	 */
	private function uploads_relative_key( string $file_path ): string {
		$basedir = rtrim( str_replace( '\\', '/', (string) ( $this->upload_basedir )() ), '/' );
		$path    = str_replace( '\\', '/', $file_path );
		if ( '' === $basedir || 0 !== strpos( $path, $basedir . '/' ) ) {
			return '';
		}
		$key = ltrim( substr( $path, strlen( $basedir ) ), '/' );
		if ( '' === $key || '/' === $key[0] || false !== strpos( $key, '..' ) ) {
			return '';
		}
		return $key;
	}

	/** The object key for a WebP derivative (must be a `.webp` under the uploads root). */
	private function offload_key_for( string $derivative_path ): string {
		$key = $this->uploads_relative_key( $derivative_path );
		if ( '' === $key || 1 !== preg_match( '#^[A-Za-z0-9._\-/]+\.webp$#', $key ) ) {
			return '';
		}
		return $key;
	}

	/** The object key for an ORIGINAL image file (any common web image extension). */
	private function original_key_for( string $original_path ): string {
		$key = $this->uploads_relative_key( $original_path );
		if ( '' === $key || 1 !== preg_match( '#^[A-Za-z0-9._\-/]+\.(?:webp|jpe?g|png|gif|avif)$#i', $key ) ) {
			return '';
		}
		return $key;
	}

	/** The attachment's own original file path (absolute), or '' when unavailable. */
	private function attached_file( int $attachment_id ): string {
		if ( $attachment_id <= 0 || ! function_exists( 'get_attached_file' ) ) {
			return '';
		}
		$path = get_attached_file( $attachment_id );
		return is_string( $path ) ? $path : '';
	}

	/** The attachment's mime type (e.g. `image/webp`), or '' when unavailable. */
	private function attachment_mime( int $attachment_id ): string {
		if ( $attachment_id <= 0 || ! function_exists( 'get_post_mime_type' ) ) {
			return '';
		}
		$mime = get_post_mime_type( $attachment_id );
		return is_string( $mime ) ? $mime : '';
	}

	/**
	 * The attachment's ORIGINAL public URL — the reference an `original`-variant offload
	 * replaces (captured before the mapping is written, so it is the real on-disk URL,
	 * not the bucket URL our own filter would otherwise return). '' when unavailable.
	 */
	private function attachment_url( int $attachment_id ): string {
		if ( $attachment_id <= 0 || ! function_exists( 'wp_get_attachment_url' ) ) {
			return '';
		}
		$url = wp_get_attachment_url( $attachment_id );
		return is_string( $url ) ? $url : '';
	}

	/**
	 * Default candidate provider (bounded): under scope 'optimized' the optimized
	 * attachments; under scope 'all' every image attachment. Manual-allow ids are always
	 * included (deny ids are filtered later by qualifies()).
	 */
	private function default_candidates( int $limit ): array {
		$ids  = array();
		$args = array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'posts_per_page' => max( 1, min( $limit, self::MAX_MANUAL ) ),
			'fields'         => 'ids',
			'no_found_rows'  => true,
		);
		if ( self::SCOPE_ALL === $this->settings()['scope'] ) {
			$args['post_mime_type'] = 'image'; // all image attachments.
		} else {
			$args['meta_key'] = self::OPTIMIZED_META; // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
		}
		if ( function_exists( 'get_posts' ) ) {
			$posts = get_posts( $args );
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
	 * True when the attachment has a source file we can offload right now: its WebP
	 * derivative (any scope) or — under scope 'all' — its own original image file with a
	 * valid uploads-relative key and an image mime. Keeps already-WebP images that carry
	 * no derivative in the batch queue under scope 'all'.
	 */
	private function has_offloadable_source( int $attachment_id ): bool {
		if ( $this->derivative_exists( $attachment_id ) ) {
			return true;
		}
		if ( self::SCOPE_ALL !== $this->settings()['scope'] ) {
			return false;
		}
		$path = $this->attached_file( $attachment_id );
		if ( '' === $path || '' === $this->original_key_for( $path ) ) {
			return false;
		}
		$mime = $this->attachment_mime( $attachment_id );
		return '' !== $mime && 0 === strpos( $mime, 'image/' );
	}

	/**
	 * The delivery URL to serve in place of $url for an offloaded attachment (gate-
	 * checked), or '' to leave $url untouched. A `derivative` offload always serves the
	 * bucket object (the single WebP maps every reference — historical behaviour). An
	 * `original` offload only rewrites the exact original file it shipped: a different
	 * size ($url ≠ src_url) is left on disk, so no reference points at a bucket object
	 * that was never uploaded.
	 */
	private function rewritten_url( int $attachment_id, string $url ): string {
		if ( $attachment_id <= 0 || ! $this->is_unlocked() ) {
			return '';
		}
		$meta = $this->offload_meta( $attachment_id );
		if ( '' === $meta['key'] ) {
			return '';
		}
		if ( self::VARIANT_ORIGINAL === $meta['variant'] && '' !== $meta['src_url'] && '' !== $url && $url !== $meta['src_url'] ) {
			return '';
		}
		return $this->delivery_url_for( $meta );
	}

	/**
	 * The public/presigned delivery URL for a stored offload mapping. PUBLIC access
	 * serves the stored public bucket URL. PRIVATE access mints a fresh, time-limited
	 * presigned GET URL from the stored key at RENDER TIME (never persisted, so each page
	 * load gets a link valid for the full TTL). Returns '' when the key is empty or a
	 * presigner is unavailable.
	 */
	private function delivery_url_for( array $meta ): string {
		$key = isset( $meta['key'] ) ? (string) $meta['key'] : '';
		if ( '' === $key ) {
			return '';
		}
		$s = $this->settings();
		if ( self::ACCESS_PRIVATE === $s['access'] ) {
			$client = $this->s3();
			if ( ! method_exists( $client, 'presigned_get_url' ) ) {
				return '';
			}
			return (string) $client->presigned_get_url( $key, (int) $s['private_url_ttl'] );
		}
		return isset( $meta['url'] ) ? (string) $meta['url'] : '';
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
	 * @return array{ enabled:bool, rule_all:bool, scope:string, location:string, bucket:string, access_key:string, secret:string, access:string, private_url_ttl:int }
	 */
	private static function normalize_settings( $raw ): array {
		$raw      = is_array( $raw ) ? $raw : array();
		$scope    = isset( $raw['scope'] ) && self::SCOPE_ALL === (string) $raw['scope']
			? self::SCOPE_ALL
			: self::SCOPE_OPTIMIZED; // absent / unknown ⇒ back-compat default.
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
			'scope'           => $scope,
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

	/** Whether a list_buckets error code signals bad/rejected credentials (vs. a transient/other fault). */
	private static function is_auth_error( string $error ): bool {
		return in_array(
			$error,
			array( 'SignatureDoesNotMatch', 'InvalidAccessKeyId', 'AccessDenied', 'http-401', 'http-403' ),
			true
		);
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
