<?php
/**
 * Native-media takeover — the gated, reversible replacement of WordPress's OWN
 * media surfaces (the `upload.php` Library screen and the `wp.media` Backbone
 * modal that the post editor, featured-image box, gallery inserter AND Elementor's
 * picker all compose) with the InfraWeaver Explorer + shared viewer.
 *
 * TRUST MODEL. wp-admin only. This engine owns NO console channel of its own; the
 * console flips the takeover through the signed `media.config.get/set` shims
 * (IWSL_Plugin::allowed_methods), which delegate to set_replace_native() /
 * config_snapshot() here. Every MUTATION stays exactly where it already lives
 * (folder/tag assign on IWSL_Media_Folders, guarded by `manage_options`); this
 * class adds ONLY a READ tier — `upload_files`-guarded browse (tree/list/get) so
 * the editors and authors who actually live inside the modal can see the grid.
 *
 * THE OFF PATH IS HOOK-ABSENCE, NOT HOOK-EARLY-RETURN. When the feature is locked
 * OR the operator toggle is off (the default), register() attaches NOTHING — no
 * enqueue, no redirect, no AJAX action, no filter — so a site with the takeover
 * off behaves BYTE-FOR-BYTE like stock WordPress. That structural absence (not a
 * guard inside a live callback) is what makes "zero behaviour change" provable:
 * see test-media-native's hook-count assertions.
 *
 * FALLBACK. The modal injection (assets/iwsl-media-modal.js) is ADDITIVE — it
 * registers an extra default Backbone state and NEVER destructively replaces
 * `wp.media.view.*`. The one injection seam is wrapped in a single try/catch that
 * restores the native frame on ANY throw, so a future wp.media / Elementor change
 * can degrade the picker to stock but can never brick it.
 *
 * SELF-CONTAINED. The Explorer page + viewer are no-build ES modules; this class
 * only enqueues them and prints a localized config object. It reads its takeover
 * toggle from ONE option (`iwsl_media_explorer` → { replace_native: bool }).
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Media_Native {

	/** The entitlement flag the whole takeover gates on (Pro/Ultimate). */
	const FEATURE = 'media_folders';

	/**
	 * IWSL_Store key holding the takeover config. IWSL_WP_Store prepends its
	 * `iwsl_` prefix, so this resolves to the WordPress option `iwsl_media_explorer`
	 * (the name the console + docs pin). Value shape: { replace_native: bool }.
	 */
	const STORE_KEY = 'media_explorer';

	/** The single boolean inside the config option. */
	const KEY_REPLACE = 'replace_native';

	/**
	 * The full-page Explorer admin slug (registered by IWSL_Admin::add_menu()).
	 * Mirrors IWSL_Media_Folders_UI::EXPLORER_PAGE — kept as a literal so this
	 * engine parses even if the UI class is not loaded.
	 */
	const EXPLORER_PAGE = 'infraweaver-plus-explorer';

	/** `?iwsl_native=1` on upload.php renders stock WordPress for one request. */
	const ESCAPE_ARG = 'iwsl_native';

	/** Read-tier AJAX nonce; the posted field is always 'nonce'. */
	const NONCE = 'iwsl_media_native';

	/**
	 * Read-tier (upload_files) logged-in AJAX actions — browse ONLY. No nopriv
	 * twins are EVER registered, and no mutation action lives here (mutations keep
	 * their `manage_options` guard on their own engines).
	 */
	const AJAX_TREE = 'iwsl_native_tree';
	const AJAX_LIST = 'iwsl_native_list';
	const AJAX_GET  = 'iwsl_native_get';

	/** The capability the read tier requires (NOT manage_options — that is mutations). */
	const READ_CAP = 'upload_files';

	/** Script handles (the shared viewer module + the modal injector). */
	const HANDLE_VIEWER = 'iwsl-media-viewer';
	const HANDLE_MODAL  = 'iwsl-media-modal';

	/** Browse list bounds (mirror IWSL_Media_Library conventions). */
	const LIST_PER_PAGE_MAX     = 100;
	const LIST_PER_PAGE_DEFAULT = 60;
	const TAG_IDS_MAX           = 100;

	/** @var IWSL_Entitlements The gate (media_folders). */
	private $entitlements;

	/** @var IWSL_Store Config persistence; production injects IWSL_WP_Store. */
	private $store;

	/**
	 * @param IWSL_Entitlements $entitlements The media_folders gate.
	 * @param IWSL_Store|null   $store        Persistence; production injects IWSL_WP_Store.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
	}

	// ── config: the console-flippable toggle ────────────────────────────────────────

	/**
	 * The stored takeover flag. DEFAULT FALSE — a fresh install (and any missing /
	 * malformed option) behaves like stock WordPress. Never throws.
	 */
	public function replace_native(): bool {
		$raw = $this->store->get( self::STORE_KEY, array() );
		if ( ! is_array( $raw ) || ! array_key_exists( self::KEY_REPLACE, $raw ) ) {
			return false;
		}
		return (bool) $raw[ self::KEY_REPLACE ];
	}

	/**
	 * Flip the takeover. STATEMENT 1 is the gate: a locked site cannot enable (nor
	 * meaningfully store) the takeover — it returns the gate as a renderable state
	 * and writes nothing. Turning OFF is always honoured (so a downgraded site can
	 * still be reverted). Idempotent.
	 *
	 * @return array{ok: bool, replace_native: bool, locked?: bool, gate?: array}
	 */
	public function set_replace_native( bool $on ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) && $on ) {
			// Refuse to turn ON when locked; report the gate, store nothing.
			return array(
				'ok'             => false,
				'replace_native' => $this->replace_native(),
				'locked'         => true,
				'gate'           => $gate,
			);
		}
		$this->store->set( self::STORE_KEY, array( self::KEY_REPLACE => $on ) );
		return array( 'ok' => true, 'replace_native' => $on );
	}

	/**
	 * The renderable config the console reads through `media.config.get`. A locked
	 * site reports the gate rather than its state (mirrors email.config.get). The
	 * secret-free, always-safe read.
	 *
	 * @return array{replace_native: bool, locked: bool, gate?: array}
	 */
	public function config_snapshot(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'replace_native' => false, 'locked' => true, 'gate' => $gate );
		}
		return array( 'replace_native' => $this->replace_native(), 'locked' => false );
	}

	/**
	 * The composite decision every hook keys off: the takeover is live ONLY when the
	 * feature is unlocked AND the operator toggle is on. This is the predicate
	 * register() uses to decide whether to attach ANY hook at all.
	 */
	public function is_replacing(): bool {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		return ! empty( $gate['unlocked'] ) && $this->replace_native();
	}

	// ── registration (HOOK-ABSENCE when off) ────────────────────────────────────────

	/**
	 * Wire the takeover — but ONLY when it is actually live. When the feature is
	 * locked or the toggle is off, this attaches NOTHING and returns: the fallback
	 * to stock WordPress is the STRUCTURAL absence of hooks, which is why "off = zero
	 * behaviour change" is provable rather than merely asserted.
	 *
	 * When live: the upload.php redirect, the wp.media modal enqueue, and the THREE
	 * read-tier browse AJAX actions. No nopriv twins; no mutation action.
	 */
	public function register(): void {
		if ( ! $this->is_replacing() ) {
			return; // ── the entire OFF path: hook-absence ──
		}

		if ( function_exists( 'add_action' ) ) {
			// upload.php (grid/list) → the Explorer, with the ?iwsl_native=1 escape.
			add_action( 'load-upload.php', array( $this, 'maybe_redirect_upload' ) );

			// The wp.media modal (post editor / featured image / gallery / Elementor).
			add_action( 'wp_enqueue_media', array( $this, 'enqueue_modal' ) );

			// Read-tier browse — logged-in only, upload_files-guarded (see ajax_guard()).
			add_action( 'wp_ajax_' . self::AJAX_TREE, array( $this, 'handle_browse_tree' ) );
			add_action( 'wp_ajax_' . self::AJAX_LIST, array( $this, 'handle_browse_list' ) );
			add_action( 'wp_ajax_' . self::AJAX_GET, array( $this, 'handle_browse_get' ) );
		}
	}

	// ── upload.php takeover ──────────────────────────────────────────────────────────

	/**
	 * `load-upload.php`: redirect the native Library to the Explorer unless the
	 * escape hatch is present. Delegates the decision to redirect_target() (a pure
	 * function of the query) so the takeover rule is unit-testable without a redirect.
	 */
	public function maybe_redirect_upload(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$query  = isset( $_GET ) && is_array( $_GET ) && function_exists( 'wp_unslash' ) ? wp_unslash( $_GET ) : ( isset( $_GET ) && is_array( $_GET ) ? $_GET : array() );
		$target = $this->redirect_target( $query );
		if ( null === $target ) {
			return; // escape hatch, or takeover no longer live → render stock.
		}
		if ( function_exists( 'wp_safe_redirect' ) ) {
			wp_safe_redirect( $target );
			// Never exit under the test harness (it would kill the runner); WordPress
			// always defines wp_safe_redirect AND the harness never does, so gating the
			// exit on a WP-only sentinel keeps production correct and tests alive.
			if ( ! defined( 'IWSL_TEST' ) ) {
				exit;
			}
		}
	}

	/**
	 * The pure takeover rule. Returns the Explorer URL to redirect to, or null when
	 * the request must render stock WordPress (escape hatch present, or the takeover
	 * is no longer live). Carries the list search + folder filter as best-effort
	 * deep-links.
	 *
	 * @param array<string,mixed> $query The (unslashed) request query.
	 */
	public function redirect_target( array $query ): ?string {
		if ( isset( $query[ self::ESCAPE_ARG ] ) && '1' === (string) $query[ self::ESCAPE_ARG ] ) {
			return null; // one-request stock render.
		}
		if ( ! $this->is_replacing() ) {
			return null; // defensive: the toggle could have flipped mid-session.
		}
		$args = array();
		if ( isset( $query['s'] ) && is_string( $query['s'] ) && '' !== $query['s'] ) {
			$args['s'] = substr( self::request_string( $query['s'] ), 0, 200 );
		}
		if ( isset( $query[ IWSL_Media_Folders::LIBRARY_FILTER_ARG ] ) && '' !== (string) $query[ IWSL_Media_Folders::LIBRARY_FILTER_ARG ] ) {
			$args['folder'] = (int) $query[ IWSL_Media_Folders::LIBRARY_FILTER_ARG ];
		}
		return $this->explorer_url( $args );
	}

	/** The full Explorer admin URL, with optional deep-link query args. */
	public function explorer_url( array $args = array() ): string {
		$base = function_exists( 'admin_url' )
			? admin_url( 'admin.php?page=' . self::EXPLORER_PAGE )
			: 'admin.php?page=' . self::EXPLORER_PAGE;
		if ( array() === $args ) {
			return $base;
		}
		if ( function_exists( 'add_query_arg' ) ) {
			return add_query_arg( $args, $base );
		}
		$pairs = array();
		foreach ( $args as $k => $v ) {
			$pairs[] = rawurlencode( (string) $k ) . '=' . rawurlencode( (string) $v );
		}
		return $base . '&' . implode( '&', $pairs );
	}

	// ── modal enqueue ─────────────────────────────────────────────────────────────────

	/**
	 * `wp_enqueue_media`: enqueue the shared viewer module + the modal injector as ES
	 * modules and print the localized config the injector reads. Fully guarded so the
	 * harness never fatals. The heavy lifting (the additive Backbone state + the
	 * try/catch fallback) lives in the enqueued JS; this only wires + configures it.
	 */
	public function enqueue_modal(): void {
		if ( ! $this->is_replacing() ) {
			return; // paranoia: never enqueue when not live.
		}
		if ( ! function_exists( 'wp_enqueue_script' ) ) {
			return;
		}
		$base    = defined( 'IWSL_PLUGIN_URL' ) ? IWSL_PLUGIN_URL : self::plugin_base_url();
		$viewer  = $base . 'includes/assets/iwsl-media-viewer.js';
		$modal   = $base . 'includes/assets/iwsl-media-modal.js';
		$version = defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : '0';

		// Prefer the module API (WP 6.5+); it keeps the ES `import` between the two
		// files intact. Fall back to a classic enqueue tagged type="module".
		if ( function_exists( 'wp_enqueue_script_module' ) ) {
			wp_enqueue_script_module( self::HANDLE_VIEWER, $viewer, array(), $version );
			wp_enqueue_script_module(
				self::HANDLE_MODAL,
				$modal,
				array( array( 'id' => self::HANDLE_VIEWER ) ),
				$version
			);
		} else {
			wp_enqueue_script( self::HANDLE_VIEWER, $viewer, array(), $version, true );
			wp_enqueue_script( self::HANDLE_MODAL, $modal, array( self::HANDLE_VIEWER ), $version, true );
		}

		// The config rides a tiny inline classic script so the ES module can read it
		// off window without depending on wp_localize_script's classic-handle model.
		$config = $this->localized_config();
		if ( function_exists( 'wp_add_inline_script' ) ) {
			$json = function_exists( 'wp_json_encode' ) ? wp_json_encode( $config ) : json_encode( $config );
			wp_add_inline_script( self::HANDLE_VIEWER, 'window.IWSL_MEDIA_NATIVE = ' . $json . ';', 'before' );
		} elseif ( function_exists( 'wp_localize_script' ) ) {
			wp_localize_script( self::HANDLE_VIEWER, 'IWSL_MEDIA_NATIVE', $config );
		}
	}

	/**
	 * The config object the modal injector consumes. Pure (no echo, no enqueue) so it
	 * is unit-testable. Carries the read-tier AJAX surface, the feature flags the
	 * viewer gates panels on, and the current user's capability map so the UI hides
	 * verbs the user cannot perform.
	 *
	 * @return array<string,mixed>
	 */
	public function localized_config(): array {
		return array(
			'ajaxUrl'     => function_exists( 'admin_url' ) ? admin_url( 'admin-ajax.php' ) : 'admin-ajax.php',
			'nonce'       => function_exists( 'wp_create_nonce' ) ? wp_create_nonce( self::NONCE ) : '',
			'actions'     => array(
				'tree' => self::AJAX_TREE,
				'list' => self::AJAX_LIST,
				'get'  => self::AJAX_GET,
			),
			'features'    => array(
				'media_folders'      => $this->unlocked( self::FEATURE ),
				'image_optimization' => $this->unlocked( 'image_optimization' ),
				'media_protection'   => $this->unlocked( 'media_protection' ),
			),
			'can'         => array(
				'manage_options' => $this->current_user_can( 'manage_options' ),
				'upload_files'   => $this->current_user_can( self::READ_CAP ),
			),
			'explorerUrl' => $this->explorer_url(),
			'escapeArg'   => self::ESCAPE_ARG,
		);
	}

	// ── read-tier browse (upload_files) ───────────────────────────────────────────────

	/**
	 * The READ gate — upload_files → nonce → entitlement, in that exact order. This
	 * is the ONE relaxation from the mutation guard: modal browse must be visible to
	 * the editors/authors who work inside the picker, so it keys on `upload_files`
	 * (view/upload) rather than `manage_options`. Every MUTATION keeps manage_options
	 * on its own engine; nothing mutating is reachable through this guard.
	 */
	public function ajax_guard(): void {
		$reason = $this->capability_reason();
		if ( '' !== $reason ) {
			$this->err( $reason, 403 );
			return;
		}
		if ( function_exists( 'check_ajax_referer' ) ) {
			check_ajax_referer( self::NONCE, 'nonce' );
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->err( 'entitlement-locked', 403 );
		}
	}

	/**
	 * The capability half of the read guard, split out so a test can assert WHICH
	 * capability the browse tier demands (it must be READ_CAP, never manage_options).
	 * Returns '' when allowed, 'forbidden' otherwise.
	 */
	public function capability_reason(): string {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( self::READ_CAP ) ) {
			return 'forbidden';
		}
		return '';
	}

	/** AJAX (read): the folder + tag tree. Delegates to the folders engine unchanged. */
	public function handle_browse_tree(): void {
		$this->ajax_guard();
		$folders = new IWSL_Media_Folders( $this->entitlements, $this->store );
		$this->ok( $folders->folder_tree() );
	}

	/** AJAX (read): one fused, filtered, paginated page of assets (the read-model). */
	public function handle_browse_list(): void {
		$this->ajax_guard();
		$library = new IWSL_Media_Library( $this->entitlements );
		$this->ok( $library->list_assets( $this->list_args_from_post() ) );
	}

	/** AJAX (read): the full detail read-model for one asset (drives the viewer). */
	public function handle_browse_get(): void {
		$this->ajax_guard();
		// phpcs:ignore WordPress.Security.NonceVerification.Missing
		$id     = isset( $_POST['id'] ) ? (int) $_POST['id'] : 0;
		$detail = new IWSL_Media_Detail( $this->entitlements );
		$this->ok( $detail->get_asset( $id ) );
	}

	/**
	 * Parse the browse-list POST into the IWSL_Media_Library arg shape. Bounds are
	 * enforced by the library itself; this only casts + defaults.
	 *
	 * @return array<string,mixed>
	 */
	private function list_args_from_post(): array {
		// phpcs:disable WordPress.Security.NonceVerification.Missing
		return array(
			'folder_id'    => isset( $_POST['folder_id'] ) ? (int) $_POST['folder_id'] : -1,
			'search'       => isset( $_POST['search'] ) ? self::request_string( $_POST['search'] ) : '',
			'mime_group'   => isset( $_POST['mime_group'] ) ? self::request_string( $_POST['mime_group'] ) : 'all',
			'tag_ids'      => self::post_int_array( 'tag_ids' ),
			'orderby'      => isset( $_POST['orderby'] ) ? self::request_string( $_POST['orderby'] ) : 'date',
			'order'        => isset( $_POST['order'] ) ? self::request_string( $_POST['order'] ) : 'desc',
			'optimization' => isset( $_POST['optimization'] ) ? self::request_string( $_POST['optimization'] ) : 'all',
			'offload'      => isset( $_POST['offload'] ) ? self::request_string( $_POST['offload'] ) : 'all',
			'page'         => isset( $_POST['page'] ) ? (int) $_POST['page'] : 1,
			'per_page'     => isset( $_POST['per_page'] ) ? (int) $_POST['per_page'] : self::LIST_PER_PAGE_DEFAULT,
		);
		// phpcs:enable WordPress.Security.NonceVerification.Missing
	}

	// ── private: harness-safe helpers ─────────────────────────────────────────────────

	/** True when a feature's gate is unlocked (cheap, guarded). */
	private function unlocked( string $feature ): bool {
		$gate = $this->entitlements->evaluate( $feature );
		return ! empty( $gate['unlocked'] );
	}

	/** current_user_can wrapper — true under the harness (no cap system present). */
	private function current_user_can( string $cap ): bool {
		return function_exists( 'current_user_can' ) ? (bool) current_user_can( $cap ) : true;
	}

	/** The plugin's base URL, harness-safe. Only used when IWSL_PLUGIN_URL is unset. */
	private static function plugin_base_url(): string {
		if ( function_exists( 'plugins_url' ) ) {
			return rtrim( plugins_url( '', dirname( __DIR__ ) . '/infraweaver-connector.php' ), '/\\' ) . '/';
		}
		return '/wp-content/plugins/infraweaver-wp-connector/';
	}

	/** Emit a JSON success envelope (wp_send_json_success in WP; echo under harness). */
	private function ok( array $data ): void {
		if ( function_exists( 'wp_send_json_success' ) ) {
			wp_send_json_success( $data );
		}
		echo function_exists( 'wp_json_encode' )
			? wp_json_encode( array( 'success' => true, 'data' => $data ) )
			: json_encode( array( 'success' => true, 'data' => $data ) );
	}

	/** Emit a JSON error envelope + stop. */
	private function err( string $reason, int $status = 400 ): void {
		if ( function_exists( 'wp_send_json_error' ) ) {
			wp_send_json_error( array( 'reason' => $reason ), $status );
		}
		echo function_exists( 'wp_json_encode' )
			? wp_json_encode( array( 'success' => false, 'data' => array( 'reason' => $reason ) ) )
			: json_encode( array( 'success' => false, 'data' => array( 'reason' => $reason ) ) );
	}

	/** A single-line, trimmed request string (harness-safe sanitizer). */
	private static function request_string( $value ): string {
		$value = is_string( $value ) ? $value : '';
		if ( function_exists( 'sanitize_text_field' ) ) {
			return sanitize_text_field( $value );
		}
		return trim( preg_replace( '/[\r\n\t]+/', ' ', $value ) );
	}

	/**
	 * Read a POST field as a bounded int array.
	 *
	 * @return int[]
	 */
	private static function post_int_array( string $field ): array {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing
		$raw = isset( $_POST[ $field ] ) ? $_POST[ $field ] : array();
		if ( is_string( $raw ) ) {
			$raw = '' === $raw ? array() : explode( ',', $raw );
		}
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$out = array();
		foreach ( array_slice( $raw, 0, self::TAG_IDS_MAX ) as $v ) {
			$n = (int) $v;
			if ( $n > 0 ) {
				$out[] = $n;
			}
		}
		return $out;
	}
}
