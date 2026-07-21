<?php
/**
 * Generic engine behind the gated "SEO Suite" feature (flag `seo_suite`, tier
 * Ultimate) — a self-contained, Yoast-Premium-class on-page SEO toolkit.
 *
 * This is the WordPress-facing orchestrator. The heavy lifting lives in three
 * pure, WP-free, unit-tested helpers that MUST load before this class:
 *   IWSL_SEO_Analyzer  — the traffic-light analysis engine (the heart).
 *   IWSL_SEO_Head      — template vars, robots, OG/Twitter, JSON-LD @graph.
 *   IWSL_SEO_Sitemap   — the XML sitemap index + url-sets.
 * This engine only gathers a plain context/paper from post meta + settings + WP
 * and hands it to those builders, then wires the head/robots/sitemap/meta-box/
 * save_post/breadcrumb/admin surfaces.
 *
 * TRUST MODEL. Console-authoritative like every Plus feature: the `seo_suite`
 * flag is written ONLY by the dual-signed `entitlements.set` runner (§7). No
 * self-set path, no REST/AJAX/cron/nopriv surface. The gate is re-checked as
 * STATEMENT 1 of every hook callback and every state-changing method, so a locked
 * site emits NO head output, registers NO meta box, serves NO sitemap and writes
 * NO meta — and revoking the flag from the console restores stock WordPress head
 * behaviour instantly, no cache to bust.
 *
 * SAFETY. In-process only — no exec/eval/network. Per-post data lives in ordinary
 * `_iwseo_*` post meta (no shadow DB tables). Every stored value is sanitized on
 * write and every output is escaped. WordPress calls are function_exists-guarded
 * so the engine constructs/registers harmlessly under the zero-dependency harness
 * with an injected store + clock.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_SEO_Suite {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'seo_suite';

	/** Store key for the sanitized site-wide settings map (option `iwsl_seo_settings`). */
	const SETTINGS_KEY = 'seo_settings';

	/** admin-post action + nonce for the Search Appearance settings save. */
	const SAVE_ACTION = 'iwsl_seo_settings_save';
	const SAVE_NONCE  = 'iwsl_seo_settings_save';

	/** Per-post editor meta box nonce. */
	const METABOX_NONCE = 'iwsl_seo_metabox_save';

	/** Per-user PRG result transient prefix (append the user id). */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_seo_result_';

	/** Post-meta keys — all `_iwseo_*`, all private, all portable. */
	const META_TITLE        = '_iwseo_title';
	const META_DESC         = '_iwseo_desc';
	const META_FOCUSKW      = '_iwseo_focuskw';
	const META_SYNONYMS     = '_iwseo_synonyms';
	const META_RELATED      = '_iwseo_related';
	const META_CANONICAL    = '_iwseo_canonical';
	const META_NOINDEX      = '_iwseo_noindex';
	const META_NOFOLLOW     = '_iwseo_nofollow';
	const META_ROBOTS_ADV   = '_iwseo_robots_adv';
	const META_OG_TITLE     = '_iwseo_og_title';
	const META_OG_DESC      = '_iwseo_og_desc';
	const META_OG_IMAGE     = '_iwseo_og_image';
	const META_TW_TITLE     = '_iwseo_tw_title';
	const META_TW_DESC      = '_iwseo_tw_desc';
	const META_TW_IMAGE     = '_iwseo_tw_image';
	const META_CORNERSTONE  = '_iwseo_cornerstone';
	const META_PAGE_TYPE    = '_iwseo_page_type';
	const META_ARTICLE_TYPE = '_iwseo_article_type';
	const META_BCTITLE      = '_iwseo_bctitle';
	const META_SCORE        = '_iwseo_score';
	const META_READ_SCORE   = '_iwseo_read_score';

	/** Byte ceilings. */
	const MAX_TITLE_LEN = 300;
	const MAX_DESC_LEN  = 400;
	const MAX_KW_LEN    = 200;
	const MAX_URL_LEN   = 2048;

	/** Default templates when a type has none configured. */
	const DEFAULT_TITLE_TEMPLATE = '%%title%% %%sep%% %%sitename%%';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings live here. */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Settings persistence; defaults to the WP option store.
	 * @param callable|null     $now_ms       Clock, mirrors the other engines.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_Store $store = null, ?callable $now_ms = null ) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/**
	 * Wire the hooks. Registered on every request (the front-end + meta-box + admin
	 * callbacks each re-check the gate as their first act, so a locked site is
	 * inert). Guarded so the harness can call it harmlessly.
	 */
	public function register(): void {
		if ( ! function_exists( 'add_action' ) || ! function_exists( 'add_filter' ) ) {
			return;
		}
		// Front-end output.
		add_action( 'wp_head', array( $this, 'render_head' ), 1 );
		add_filter( 'wp_robots', array( $this, 'filter_robots' ) );
		add_filter( 'pre_get_document_title', array( $this, 'filter_document_title' ), 20 );
		add_filter( 'document_title_parts', array( $this, 'filter_title_parts' ), 20 );

		// Our head block emits the authoritative <link rel="canonical"> at wp_head
		// priority 1, so on the active path we strip WordPress core's competing
		// canonical / shortlink / index links. Without this a duplicate, conflicting
		// canonical would be emitted alongside ours and could defeat a per-post
		// `_iwseo_canonical` override. Only done when unlocked (our canonical output
		// is live); a locked site keeps stock WordPress head behaviour untouched.
		if ( $this->unlocked() && function_exists( 'remove_action' ) ) {
			remove_action( 'wp_head', 'rel_canonical' );
			remove_action( 'wp_head', 'wp_shortlink_wp_head' );
			remove_action( 'wp_head', 'index_rel_link' );
		}

		// Sitemap: take over sitemap_index.xml, disable core sitemaps, add robots line.
		add_action( 'template_redirect', array( $this, 'maybe_serve_sitemap' ), 1 );
		add_filter( 'wp_sitemaps_enabled', '__return_false' );
		add_filter( 'robots_txt', array( $this, 'filter_robots_txt' ), 10, 1 );

		// Editor.
		add_action( 'init', array( $this, 'register_post_meta' ) );
		add_action( 'add_meta_boxes', array( $this, 'register_meta_boxes' ) );
		add_action( 'save_post', array( $this, 'handle_save_post' ), 10, 2 );

		// Breadcrumb shortcode.
		if ( function_exists( 'add_shortcode' ) ) {
			add_shortcode( 'iwseo_breadcrumb', array( $this, 'shortcode_breadcrumb' ) );
		}

		// Settings save (admin-post).
		add_action( 'admin_post_' . self::SAVE_ACTION, array( $this, 'handle_save' ) );
	}

	/** Whether the feature is currently unlocked (single source of truth). */
	private function unlocked(): bool {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		return ! empty( $gate['unlocked'] );
	}

	// ── settings (reads/writes) ─────────────────────────────────────────────────

	/**
	 * The sanitized site-wide settings, re-validated on every read (defence in
	 * depth): a DB-tampered value is normalized here, never mutated in place.
	 *
	 * @return array<string, mixed>
	 */
	public function settings(): array {
		$stored = $this->store->get( self::SETTINGS_KEY, array() );
		$stored = is_array( $stored ) ? $stored : array();
		$clean = $this->sanitize_settings( $stored );
		$clean['saved_at'] = isset( $stored['saved_at'] ) ? (int) $stored['saved_at'] : 0;
		return $clean;
	}

	/**
	 * Normalize a raw settings input into the stored shape. Immutable: builds a
	 * fresh array; never mutates $input.
	 *
	 * @param array<string, mixed> $input
	 * @return array<string, mixed>
	 */
	public function sanitize_settings( array $input ): array {
		$templates_in = isset( $input['title_templates'] ) && is_array( $input['title_templates'] ) ? $input['title_templates'] : array();
		$meta_in = isset( $input['meta_templates'] ) && is_array( $input['meta_templates'] ) ? $input['meta_templates'] : array();
		$title_templates = array();
		$meta_templates = array();
		foreach ( array( 'post', 'page', 'home' ) as $type ) {
			$title_templates[ $type ] = self::clean_line( self::pluck( $templates_in, $type ), self::MAX_TITLE_LEN );
			$meta_templates[ $type ] = self::clean_line( self::pluck( $meta_in, $type ), self::MAX_DESC_LEN );
		}

		$org_in = isset( $input['org'] ) && is_array( $input['org'] ) ? $input['org'] : array();
		$same_as_in = isset( $org_in['same_as'] ) ? $org_in['same_as'] : array();
		if ( is_string( $same_as_in ) ) {
			$same_as_in = preg_split( '/[\r\n,]+/', $same_as_in ) ?: array();
		}
		$same_as = array();
		foreach ( (array) $same_as_in as $url ) {
			$u = self::clean_url( is_string( $url ) ? trim( $url ) : '' );
			if ( '' !== $u ) {
				$same_as[] = $u;
			}
		}

		$bc_in = isset( $input['breadcrumbs'] ) && is_array( $input['breadcrumbs'] ) ? $input['breadcrumbs'] : array();

		return array(
			'separator'            => self::clean_separator( self::pluck( $input, 'separator' ) ),
			'title_templates'      => $title_templates,
			'meta_templates'       => $meta_templates,
			'org'                  => array(
				'type'    => ( isset( $org_in['type'] ) && 'person' === $org_in['type'] ) ? 'person' : 'organization',
				'name'    => self::clean_line( self::pluck( $org_in, 'name' ), self::MAX_TITLE_LEN ),
				'logo'    => self::clean_url( self::pluck( $org_in, 'logo' ) ),
				'same_as' => array_slice( $same_as, 0, 12 ),
			),
			'default_social_image' => self::clean_url( self::pluck( $input, 'default_social_image' ) ),
			'twitter_site'         => self::clean_line( self::pluck( $input, 'twitter_site' ), 60 ),
			'sitemap_enabled'      => ! empty( $input['sitemap_enabled'] ),
			'breadcrumbs'          => array(
				'enabled'    => ! empty( $bc_in['enabled'] ),
				'home_label' => '' !== self::clean_line( self::pluck( $bc_in, 'home_label' ), 60 ) ? self::clean_line( self::pluck( $bc_in, 'home_label' ), 60 ) : 'Home',
				'separator'  => '' !== self::clean_line( self::pluck( $bc_in, 'separator' ), 12 ) ? self::clean_line( self::pluck( $bc_in, 'separator' ), 12 ) : '›',
			),
			'saved_at'             => 0,
		);
	}

	/**
	 * Persist a new settings map. STATEMENT 1 is the authoritative gate.
	 *
	 * @param array<string, mixed> $input
	 * @return array{ ok:bool, reason?:string, settings?:array, gate?:array }
	 */
	public function save_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$clean = $this->sanitize_settings( $input );
		$clean['saved_at'] = $this->now_seconds();
		$this->store->set( self::SETTINGS_KEY, $clean );
		return array( 'ok' => true, 'settings' => $clean );
	}

	// ── per-post save (STATEMENT 1 is the gate) ─────────────────────────────────

	/**
	 * Sanitize + persist per-post SEO meta and (re)compute the stored scores. The
	 * pure return value makes this unit-testable without WordPress; the WP glue is
	 * handle_save_post().
	 *
	 * @param int                  $post_id
	 * @param array<string, mixed> $input Raw editor field map (already unslashed by caller).
	 * @param callable|null        $writer fn(string $key, $value): void — defaults to update_post_meta.
	 * @return array{ ok:bool, reason?:string, meta?:array, scores?:array, gate?:array }
	 */
	public function save_post_meta( int $post_id, array $input, ?callable $writer = null ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$meta = $this->sanitize_post_meta( $input );

		// Score server-side from a paper assembled from the sanitized fields.
		$paper = array(
			'title'          => '' !== $meta[ self::META_TITLE ] ? $meta[ self::META_TITLE ] : self::str( $input, 'post_title' ),
			'content'        => self::str( $input, 'content' ),
			'meta'           => $meta[ self::META_DESC ],
			'slug'           => self::str( $input, 'slug' ),
			'keyphrase'      => $meta[ self::META_FOCUSKW ],
			'synonyms'       => self::csv_list( $meta[ self::META_SYNONYMS ] ),
			'related'        => self::csv_list( $meta[ self::META_RELATED ] ),
			'is_cornerstone' => '1' === $meta[ self::META_CORNERSTONE ],
			'type'           => self::str( $input, 'post_type' ),
			'locale'         => self::str( $input, 'locale' ),
		);
		$result = IWSL_SEO_Analyzer::analyze( $paper );
		$scores = array(
			self::META_SCORE      => (int) $result['seo']['score'],
			self::META_READ_SCORE => (int) $result['readability']['score'],
		);

		$writer = $writer ?? static function ( string $key, $value ) use ( $post_id ): void {
			if ( function_exists( 'update_post_meta' ) ) {
				update_post_meta( $post_id, $key, $value );
			}
		};
		foreach ( $meta as $key => $value ) {
			$writer( $key, $value );
		}
		foreach ( $scores as $key => $value ) {
			$writer( $key, $value );
		}

		return array( 'ok' => true, 'meta' => $meta, 'scores' => $scores );
	}

	/**
	 * Normalize the editor field map into the stored `_iwseo_*` shape. Immutable;
	 * every field is length-bounded and control-stripped, URLs pass the URL gate,
	 * booleans are cast to '1'/''.
	 *
	 * @param array<string, mixed> $in
	 * @return array<string, string>
	 */
	public function sanitize_post_meta( array $in ): array {
		$adv = array();
		$adv_in = isset( $in['robots_adv'] ) ? $in['robots_adv'] : array();
		if ( is_string( $adv_in ) ) {
			$adv_in = self::csv_list( $adv_in );
		}
		foreach ( (array) $adv_in as $d ) {
			if ( in_array( $d, IWSL_SEO_Head::ADV_DIRECTIVES, true ) ) {
				$adv[] = $d;
			}
		}

		return array(
			self::META_TITLE       => self::clean_line( self::str( $in, 'title' ), self::MAX_TITLE_LEN ),
			self::META_DESC        => self::clean_line( self::str( $in, 'desc' ), self::MAX_DESC_LEN ),
			self::META_FOCUSKW     => self::clean_line( self::str( $in, 'focuskw' ), self::MAX_KW_LEN ),
			self::META_SYNONYMS    => self::clean_line( self::str( $in, 'synonyms' ), self::MAX_DESC_LEN ),
			self::META_RELATED     => self::clean_line( self::str( $in, 'related' ), self::MAX_DESC_LEN ),
			self::META_CANONICAL   => self::clean_url( self::str( $in, 'canonical' ) ),
			self::META_NOINDEX     => ! empty( $in['noindex'] ) ? '1' : '',
			self::META_NOFOLLOW    => ! empty( $in['nofollow'] ) ? '1' : '',
			self::META_ROBOTS_ADV  => implode( ',', array_values( array_unique( $adv ) ) ),
			self::META_OG_TITLE    => self::clean_line( self::str( $in, 'og_title' ), self::MAX_TITLE_LEN ),
			self::META_OG_DESC     => self::clean_line( self::str( $in, 'og_desc' ), self::MAX_DESC_LEN ),
			self::META_OG_IMAGE    => self::clean_url( self::str( $in, 'og_image' ) ),
			self::META_TW_TITLE    => self::clean_line( self::str( $in, 'tw_title' ), self::MAX_TITLE_LEN ),
			self::META_TW_DESC     => self::clean_line( self::str( $in, 'tw_desc' ), self::MAX_DESC_LEN ),
			self::META_TW_IMAGE    => self::clean_url( self::str( $in, 'tw_image' ) ),
			self::META_CORNERSTONE => ! empty( $in['cornerstone'] ) ? '1' : '',
			self::META_PAGE_TYPE   => self::clean_schema_type( self::str( $in, 'page_type' ) ),
			self::META_ARTICLE_TYPE => self::clean_schema_type( self::str( $in, 'article_type' ) ),
			self::META_BCTITLE     => self::clean_line( self::str( $in, 'bctitle' ), self::MAX_TITLE_LEN ),
		);
	}

	/**
	 * save_post glue. LAYER 2/3 of the gate: bail on autosave/revision, verify the
	 * nonce + capability, then defer to save_post_meta() (whose STATEMENT 1 is the
	 * authoritative gate).
	 *
	 * @param int   $post_id
	 * @param mixed $post
	 */
	public function handle_save_post( int $post_id, $post = null ): void {
		if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
			return;
		}
		if ( function_exists( 'wp_is_post_revision' ) && wp_is_post_revision( $post_id ) ) {
			return;
		}
		if ( ! isset( $_POST['iwseo_metabox_nonce'] ) ) {
			return; // Our meta box was not on this save — leave it alone.
		}
		if ( ! function_exists( 'wp_verify_nonce' )
			|| ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['iwseo_metabox_nonce'] ) ), self::METABOX_NONCE ) ) {
			return;
		}
		if ( ! function_exists( 'current_user_can' ) || ! current_user_can( 'edit_post', $post_id ) ) {
			return;
		}
		if ( ! $this->unlocked() ) {
			return; // Locked site never writes SEO meta.
		}

		$input = array(
			'title'        => self::post_field( 'iwseo_title' ),
			'desc'         => self::post_field( 'iwseo_desc' ),
			'focuskw'      => self::post_field( 'iwseo_focuskw' ),
			'synonyms'     => self::post_field( 'iwseo_synonyms' ),
			'related'      => self::post_field( 'iwseo_related' ),
			'canonical'    => self::post_field( 'iwseo_canonical' ),
			'noindex'      => isset( $_POST['iwseo_noindex'] ),
			'nofollow'     => isset( $_POST['iwseo_nofollow'] ),
			'robots_adv'   => isset( $_POST['iwseo_robots_adv'] ) && is_array( $_POST['iwseo_robots_adv'] )
				? array_map( array( __CLASS__, 'scalar' ), wp_unslash( $_POST['iwseo_robots_adv'] ) )
				: array(),
			'og_title'     => self::post_field( 'iwseo_og_title' ),
			'og_desc'      => self::post_field( 'iwseo_og_desc' ),
			'og_image'     => self::post_field( 'iwseo_og_image' ),
			'tw_title'     => self::post_field( 'iwseo_tw_title' ),
			'tw_desc'      => self::post_field( 'iwseo_tw_desc' ),
			'tw_image'     => self::post_field( 'iwseo_tw_image' ),
			'cornerstone'  => isset( $_POST['iwseo_cornerstone'] ),
			'page_type'    => self::post_field( 'iwseo_page_type' ),
			'article_type' => self::post_field( 'iwseo_article_type' ),
			'bctitle'      => self::post_field( 'iwseo_bctitle' ),
			'post_title'   => is_object( $post ) && isset( $post->post_title ) ? (string) $post->post_title : '',
			'content'      => is_object( $post ) && isset( $post->post_content ) ? (string) $post->post_content : '',
			'slug'         => is_object( $post ) && isset( $post->post_name ) ? (string) $post->post_name : '',
			'post_type'    => is_object( $post ) && isset( $post->post_type ) ? (string) $post->post_type : 'post',
			'locale'       => function_exists( 'get_locale' ) ? (string) get_locale() : 'en_US',
		);
		$this->save_post_meta( $post_id, $input );
	}

	// ── front-end: title / robots / head ────────────────────────────────────────

	/**
	 * `pre_get_document_title`. STATEMENT 1 is the gate. Returns the resolved SEO
	 * title for the queried object, or the incoming value untouched when we have
	 * nothing to say (so themes/other plugins still work).
	 *
	 * @param mixed $title
	 * @return mixed
	 */
	public function filter_document_title( $title ) {
		if ( ! $this->unlocked() ) {
			return $title;
		}
		$resolved = $this->resolve_title();
		return '' !== $resolved ? $resolved : $title;
	}

	/**
	 * `document_title_parts`. Gate-checked; overrides the title part for themes
	 * that build the title from parts rather than honouring pre_get_document_title.
	 *
	 * @param mixed $parts
	 * @return mixed
	 */
	public function filter_title_parts( $parts ) {
		if ( ! $this->unlocked() || ! is_array( $parts ) ) {
			return $parts;
		}
		$resolved = $this->resolve_title();
		if ( '' !== $resolved ) {
			$parts['title'] = $resolved;
			unset( $parts['site'], $parts['tagline'] );
		}
		return $parts;
	}

	/**
	 * `wp_robots` filter. STATEMENT 1 is the gate. Composes per-post noindex/
	 * nofollow + advanced flags + the always-on snippet permissions onto the array
	 * WordPress hands us.
	 *
	 * @param mixed $robots
	 * @return mixed
	 */
	public function filter_robots( $robots ) {
		if ( ! $this->unlocked() || ! is_array( $robots ) ) {
			return $robots;
		}
		$ctx = $this->current_robots_ctx();
		$noindex = ! empty( $ctx['noindex'] );
		$nofollow = ! empty( $ctx['nofollow'] );

		unset( $robots['index'], $robots['noindex'], $robots['follow'], $robots['nofollow'] );
		$robots[ $noindex ? 'noindex' : 'index' ] = true;
		$robots[ $nofollow ? 'nofollow' : 'follow' ] = true;

		foreach ( IWSL_SEO_Head::ADV_DIRECTIVES as $d ) {
			if ( in_array( $d, $ctx['robots_adv'], true ) ) {
				$robots[ $d ] = true;
			}
		}
		if ( ! $noindex && empty( $robots['nosnippet'] ) ) {
			$robots['max-snippet'] = -1;
			$robots['max-image-preview'] = 'large';
			$robots['max-video-preview'] = -1;
		}
		return $robots;
	}

	/**
	 * `wp_head` (priority 1). STATEMENT 1 is the gate. Echoes the escaped head
	 * block (canonical, description, OG/Twitter, JSON-LD) for singular/front views.
	 */
	public function render_head(): void {
		if ( ! $this->unlocked() ) {
			return;
		}
		$ctx = $this->build_context();
		if ( null === $ctx ) {
			return;
		}
		echo IWSL_SEO_Head::render_head( $ctx ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- builder escapes every field.
	}

	// ── front-end: sitemap ──────────────────────────────────────────────────────

	/**
	 * `template_redirect` (priority 1). STATEMENT 1 is the gate. Detects our
	 * sitemap URLs from the request path (no rewrite-flush dependency) and serves
	 * bounded XML, or returns to let WordPress render the page normally.
	 */
	public function maybe_serve_sitemap(): void {
		if ( ! $this->unlocked() ) {
			return;
		}
		if ( empty( $this->settings()['sitemap_enabled'] ) ) {
			return;
		}
		$path = $this->request_path();
		if ( null === $path ) {
			return;
		}
		if ( preg_match( '#/sitemap_index\.xml$#', $path ) ) {
			$this->serve_xml( IWSL_SEO_Sitemap::index_xml( $this->sitemap_subs() ) );
			return;
		}
		$sub = self::parse_type_sitemap( $path );
		if ( null !== $sub ) {
			$entries = $this->sitemap_entries( $sub['type'], $sub['page'] );
			if ( array() === $entries ) {
				return; // Unknown type / empty page — let WP 404.
			}
			$this->serve_xml( IWSL_SEO_Sitemap::urlset_xml( $entries ) );
		}
	}

	/**
	 * Parse a `{type}-sitemapN.xml` request path into its post-type slug + page.
	 * The slug class accepts letters, digits, `_` and `-` so custom-post-type
	 * slugs (e.g. `my-cpt2`) resolve; membership is still bounded by
	 * public_types() at fetch time. Returns null when the path is not one of ours.
	 *
	 * @return array{ type:string, page:int }|null
	 */
	private static function parse_type_sitemap( string $path ): ?array {
		if ( preg_match( '#/([a-z0-9_-]+)-sitemap([0-9]*)\.xml$#', $path, $m ) ) {
			return array(
				'type' => $m[1],
				'page' => '' === $m[2] ? 1 : max( 1, (int) $m[2] ),
			);
		}
		return null;
	}

	/** Emit an XML document with the right header and stop. */
	private function serve_xml( string $xml ): void {
		if ( function_exists( 'header' ) && ! headers_sent() ) {
			header( 'Content-Type: application/xml; charset=UTF-8' );
			header( 'X-Robots-Tag: noindex, follow', true );
		}
		echo $xml; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- builder XML-escapes every node.
		exit;
	}

	/**
	 * Child sitemaps for the index: one `<sitemap>` per PER_PAGE page per public
	 * post type. The page count is derived from the type's total entry count
	 * (ceil(total / PER_PAGE)) so every advertised child resolves; types with zero
	 * entries are skipped so we never advertise a 404ing child. @return array
	 */
	private function sitemap_subs(): array {
		$home = $this->home_url();
		$subs = array();
		foreach ( $this->public_types() as $type ) {
			$total = $this->count_type_posts( $type );
			if ( $total < 1 ) {
				continue; // No entries — don't advertise a child that would 404.
			}
			$pages = (int) ceil( $total / IWSL_SEO_Sitemap::PER_PAGE );
			for ( $page = 1; $page <= $pages; $page++ ) {
				$suffix = $page > 1 ? (string) $page : '';
				$subs[] = array( 'loc' => $home . '/' . $type . '-sitemap' . $suffix . '.xml' );
			}
		}
		return $subs;
	}

	/** Count of published posts for a public type (the sitemap universe). Bounded, no scan. */
	private function count_type_posts( string $type ): int {
		if ( ! in_array( $type, $this->public_types(), true ) || ! function_exists( 'wp_count_posts' ) ) {
			return 0;
		}
		$counts = wp_count_posts( $type );
		if ( is_object( $counts ) && isset( $counts->publish ) ) {
			return max( 0, (int) $counts->publish );
		}
		return 0;
	}

	/**
	 * Sitemap entries for ONE page of a post type, noindex-excluded. The query is
	 * bounded to PER_PAGE rows at the requested page's offset (LIMIT PER_PAGE OFFSET
	 * (page-1)*PER_PAGE) so nothing beyond an arbitrary ceiling is silently dropped.
	 * @return array
	 */
	private function sitemap_entries( string $type, int $page = 1 ): array {
		if ( ! function_exists( 'get_posts' ) || ! in_array( $type, $this->public_types(), true ) ) {
			return array();
		}
		$page = max( 1, $page );
		$ids = get_posts(
			array(
				'post_type'        => $type,
				'post_status'      => 'publish',
				'fields'           => 'ids',
				'posts_per_page'   => IWSL_SEO_Sitemap::PER_PAGE,
				'offset'           => ( $page - 1 ) * IWSL_SEO_Sitemap::PER_PAGE,
				'orderby'          => 'modified',
				'order'            => 'DESC',
				'suppress_filters' => true,
			)
		);
		$entries = array();
		foreach ( (array) $ids as $id ) {
			$id = (int) $id;
			$noindex = '1' === (string) $this->post_meta( $id, self::META_NOINDEX );
			$entries[] = array(
				'loc'     => function_exists( 'get_permalink' ) ? (string) get_permalink( $id ) : '',
				'lastmod' => function_exists( 'get_post_modified_time' ) ? (string) get_post_modified_time( 'c', true, $id ) : '',
				'noindex' => $noindex,
			);
		}
		return $entries;
	}

	/** `robots_txt` filter: append the sitemap index line (spec §9.2). */
	public function filter_robots_txt( $output ) {
		if ( ! $this->unlocked() || empty( $this->settings()['sitemap_enabled'] ) ) {
			return $output;
		}
		$line = 'Sitemap: ' . $this->home_url() . '/sitemap_index.xml';
		return rtrim( (string) $output ) . "\n" . $line . "\n";
	}

	// ── breadcrumbs ─────────────────────────────────────────────────────────────

	/** `[iwseo_breadcrumb]` shortcode. Gate-checked; returns '' when locked. */
	public function shortcode_breadcrumb( $atts = array() ): string {
		if ( ! $this->unlocked() ) {
			return '';
		}
		return $this->render_breadcrumb();
	}

	/**
	 * Render an accessible breadcrumb trail for the current view. The matching
	 * BreadcrumbList schema is emitted by the head builder, not as microdata here
	 * (clean separation, §11.2).
	 */
	public function render_breadcrumb(): string {
		$crumbs = $this->breadcrumb_trail();
		if ( count( $crumbs ) < 2 ) {
			return '';
		}
		$s = $this->settings();
		$sep = isset( $s['breadcrumbs']['separator'] ) ? (string) $s['breadcrumbs']['separator'] : '›';
		$html = '<nav class="iwseo-breadcrumb" aria-label="' . self::eattr( 'Breadcrumb' ) . '"><ol>';
		$last = count( $crumbs );
		$i = 0;
		foreach ( $crumbs as $crumb ) {
			++$i;
			$name = isset( $crumb['name'] ) ? (string) $crumb['name'] : '';
			$html .= '<li>';
			if ( $i < $last && ! empty( $crumb['url'] ) ) {
				$html .= '<a href="' . self::eurl( (string) $crumb['url'] ) . '">' . self::ehtml( $name ) . '</a>'
					. ' <span aria-hidden="true">' . self::ehtml( $sep ) . '</span> ';
			} else {
				$html .= '<span aria-current="page">' . self::ehtml( $name ) . '</span>';
			}
			$html .= '</li>';
		}
		$html .= '</ol></nav>';
		return $html;
	}

	/** The crumb list [ ['name'=>,'url'=>], ... ] for the current query. @return array */
	private function breadcrumb_trail(): array {
		$s = $this->settings();
		$home_label = isset( $s['breadcrumbs']['home_label'] ) ? (string) $s['breadcrumbs']['home_label'] : 'Home';
		$trail = array( array( 'name' => $home_label, 'url' => $this->home_url() . '/' ) );

		if ( function_exists( 'is_singular' ) && is_singular() && function_exists( 'get_queried_object' ) ) {
			$post = get_queried_object();
			if ( is_object( $post ) && isset( $post->ID ) ) {
				$title = $this->breadcrumb_title_for( (int) $post->ID, isset( $post->post_title ) ? (string) $post->post_title : '' );
				$trail[] = array( 'name' => $title, 'url' => function_exists( 'get_permalink' ) ? (string) get_permalink( (int) $post->ID ) : '' );
			}
		}
		return $trail;
	}

	private function breadcrumb_title_for( int $post_id, string $fallback ): string {
		$bc = (string) $this->post_meta( $post_id, self::META_BCTITLE );
		return '' !== $bc ? $bc : $fallback;
	}

	// ── context assembly for the head builder ───────────────────────────────────

	/**
	 * Assemble the head-builder context from the current WP query. Returns null on
	 * views we don't decorate (so nothing is emitted). Every WP call is guarded.
	 *
	 * @return array<string, mixed>|null
	 */
	private function build_context(): ?array {
		$is_singular = function_exists( 'is_singular' ) && is_singular();
		$is_front = function_exists( 'is_front_page' ) && is_front_page();
		if ( ! $is_singular && ! $is_front ) {
			return null;
		}

		$post = function_exists( 'get_queried_object' ) ? get_queried_object() : null;
		$post_id = is_object( $post ) && isset( $post->ID ) ? (int) $post->ID : 0;

		$title = $this->resolve_title();
		$desc = $this->resolve_description( $post_id, $post );
		$canonical = $this->resolve_canonical( $post_id );
		$robots_ctx = $this->current_robots_ctx();

		$og_type = ( $post_id > 0 && is_object( $post ) && isset( $post->post_type ) && 'post' === $post->post_type ) ? 'article' : 'website';

		$ctx = array(
			'site_name'   => $this->bloginfo( 'name' ),
			'site_desc'   => $this->bloginfo( 'description' ),
			'home_url'    => $this->home_url(),
			'canonical'   => $canonical,
			'title'       => $title,
			'description' => $desc,
			'locale'      => $this->locale_tag(),
			'noindex'     => ! empty( $robots_ctx['noindex'] ),
			'nofollow'    => ! empty( $robots_ctx['nofollow'] ),
			'robots_adv'  => $robots_ctx['robots_adv'],
			'published'   => $post_id > 0 && function_exists( 'get_post_time' ) ? (string) get_post_time( 'c', true, $post_id ) : '',
			'modified'    => $post_id > 0 && function_exists( 'get_post_modified_time' ) ? (string) get_post_modified_time( 'c', true, $post_id ) : '',
			'author'      => $this->author_name( $post ),
			'og'          => $this->og_ctx( $post_id, $title, $desc ),
			'twitter'     => array(
				'card' => 'summary_large_image',
				'site' => (string) $this->settings()['twitter_site'],
			),
			'schema'      => $this->schema_ctx( $post_id, $post, $og_type ),
		);
		return $ctx;
	}

	private function og_ctx( int $post_id, string $title, string $desc ): array {
		$settings = $this->settings();
		$og = array(
			'title'         => '' !== (string) $this->post_meta( $post_id, self::META_OG_TITLE ) ? (string) $this->post_meta( $post_id, self::META_OG_TITLE ) : $title,
			'description'   => '' !== (string) $this->post_meta( $post_id, self::META_OG_DESC ) ? (string) $this->post_meta( $post_id, self::META_OG_DESC ) : $desc,
			'image'         => (string) $this->post_meta( $post_id, self::META_OG_IMAGE ),
			'default_image' => (string) $settings['default_social_image'],
		);
		if ( $post_id > 0 && function_exists( 'get_the_post_thumbnail_url' ) ) {
			$thumb = get_the_post_thumbnail_url( $post_id, 'full' );
			if ( is_string( $thumb ) && '' !== $thumb ) {
				$og['featured'] = $thumb;
			}
		}
		return $og;
	}

	private function schema_ctx( int $post_id, $post, string $og_type ): array {
		$settings = $this->settings();
		$org = isset( $settings['org'] ) && is_array( $settings['org'] ) ? $settings['org'] : array();
		$page_type = (string) $this->post_meta( $post_id, self::META_PAGE_TYPE );
		$article_type = (string) $this->post_meta( $post_id, self::META_ARTICLE_TYPE );
		if ( '' === $article_type && 'article' === $og_type ) {
			$article_type = 'Article';
		}
		return array(
			'representation' => array(
				'type'    => isset( $org['type'] ) ? $org['type'] : 'organization',
				'name'    => isset( $org['name'] ) && '' !== $org['name'] ? $org['name'] : $this->bloginfo( 'name' ),
				'logo'    => isset( $org['logo'] ) ? $org['logo'] : '',
				'same_as' => isset( $org['same_as'] ) ? $org['same_as'] : array(),
			),
			'page_type'    => '' !== $page_type ? $page_type : 'WebPage',
			'article_type' => $article_type,
			'breadcrumbs'  => $this->breadcrumb_trail(),
		);
	}

	// ── resolution helpers (title / description / canonical / robots) ───────────

	/** Resolve the SEO title for the current view (meta override → template). */
	private function resolve_title(): string {
		$is_front = function_exists( 'is_front_page' ) && is_front_page();
		$settings = $this->settings();

		if ( $is_front ) {
			$tpl = $this->template_for( 'home', $settings );
			return IWSL_SEO_Head::replace_vars( $tpl, $this->front_vars( $settings ) );
		}
		if ( ! function_exists( 'is_singular' ) || ! is_singular() ) {
			return '';
		}
		$post = function_exists( 'get_queried_object' ) ? get_queried_object() : null;
		if ( ! is_object( $post ) || ! isset( $post->ID ) ) {
			return '';
		}
		$post_id = (int) $post->ID;
		$custom = (string) $this->post_meta( $post_id, self::META_TITLE );
		$vars = $this->post_vars( $post, $settings );
		if ( '' !== $custom ) {
			return IWSL_SEO_Head::replace_vars( $custom, $vars );
		}
		$type = isset( $post->post_type ) ? (string) $post->post_type : 'post';
		$tpl = $this->template_for( $type, $settings );
		return IWSL_SEO_Head::replace_vars( $tpl, $vars );
	}

	private function resolve_description( int $post_id, $post ): string {
		$custom = (string) $this->post_meta( $post_id, self::META_DESC );
		if ( '' !== $custom ) {
			return $custom;
		}
		$settings = $this->settings();
		$type = is_object( $post ) && isset( $post->post_type ) ? (string) $post->post_type : 'post';
		$tpl = isset( $settings['meta_templates'][ $type ] ) ? (string) $settings['meta_templates'][ $type ] : '';
		if ( '' === $tpl && is_object( $post ) && isset( $post->post_excerpt ) && '' !== $post->post_excerpt ) {
			return self::clean_line( (string) $post->post_excerpt, self::MAX_DESC_LEN );
		}
		return IWSL_SEO_Head::replace_vars( $tpl, is_object( $post ) ? $this->post_vars( $post, $settings ) : array() );
	}

	private function resolve_canonical( int $post_id ): string {
		$custom = (string) $this->post_meta( $post_id, self::META_CANONICAL );
		if ( '' !== $custom ) {
			return $custom;
		}
		if ( $post_id > 0 && function_exists( 'get_permalink' ) ) {
			return (string) get_permalink( $post_id );
		}
		if ( function_exists( 'is_front_page' ) && is_front_page() ) {
			return $this->home_url() . '/';
		}
		return '';
	}

	/** The per-post robots context (noindex/nofollow/adv) for the current view. @return array */
	private function current_robots_ctx(): array {
		$post_id = 0;
		if ( function_exists( 'is_singular' ) && is_singular() && function_exists( 'get_queried_object_id' ) ) {
			$post_id = (int) get_queried_object_id();
		}
		$adv = self::csv_list( (string) $this->post_meta( $post_id, self::META_ROBOTS_ADV ) );
		return array(
			'noindex'    => '1' === (string) $this->post_meta( $post_id, self::META_NOINDEX ),
			'nofollow'   => '1' === (string) $this->post_meta( $post_id, self::META_NOFOLLOW ),
			'robots_adv' => $adv,
		);
	}

	private function template_for( string $type, array $settings ): string {
		$templates = isset( $settings['title_templates'] ) && is_array( $settings['title_templates'] ) ? $settings['title_templates'] : array();
		$tpl = isset( $templates[ $type ] ) ? (string) $templates[ $type ] : '';
		return '' !== $tpl ? $tpl : self::DEFAULT_TITLE_TEMPLATE;
	}

	/** Replacement-variable map for a post. @return array<string, string> */
	private function post_vars( $post, array $settings ): array {
		$sep = isset( $settings['separator'] ) ? (string) $settings['separator'] : '-';
		$excerpt = is_object( $post ) && isset( $post->post_excerpt ) ? (string) $post->post_excerpt : '';
		$category = '';
		if ( is_object( $post ) && isset( $post->ID ) && function_exists( 'get_the_category' ) ) {
			$cats = get_the_category( (int) $post->ID );
			if ( is_array( $cats ) && isset( $cats[0]->name ) ) {
				$category = (string) $cats[0]->name;
			}
		}
		return array(
			'title'            => is_object( $post ) && isset( $post->post_title ) ? (string) $post->post_title : '',
			'sitename'         => $this->bloginfo( 'name' ),
			'sitedesc'         => $this->bloginfo( 'description' ),
			'sep'              => $sep,
			'excerpt'          => self::clean_line( $excerpt, self::MAX_DESC_LEN ),
			'excerpt_only'     => self::clean_line( $excerpt, self::MAX_DESC_LEN ),
			'category'         => $category,
			'primary_category' => $category,
			'name'             => $this->author_name( $post ),
			'date'             => is_object( $post ) && isset( $post->post_date ) ? substr( (string) $post->post_date, 0, 10 ) : '',
			'modified'         => is_object( $post ) && isset( $post->post_modified ) ? substr( (string) $post->post_modified, 0, 10 ) : '',
			'currentdate'      => gmdate( 'Y-m-d' ),
			'currentyear'      => gmdate( 'Y' ),
			'pt_single'        => is_object( $post ) && isset( $post->post_type ) ? (string) $post->post_type : '',
			'pt_plural'        => is_object( $post ) && isset( $post->post_type ) ? (string) $post->post_type : '',
			'page'             => '',
		);
	}

	/** Replacement-variable map for the homepage. @return array<string, string> */
	private function front_vars( array $settings ): array {
		$sep = isset( $settings['separator'] ) ? (string) $settings['separator'] : '-';
		return array(
			'title'       => $this->bloginfo( 'name' ),
			'sitename'    => $this->bloginfo( 'name' ),
			'sitedesc'    => $this->bloginfo( 'description' ),
			'sep'         => $sep,
			'currentyear' => gmdate( 'Y' ),
			'currentdate' => gmdate( 'Y-m-d' ),
		);
	}

	// ── admin surface (LAYER 1 UX + LAYER 2 handlers) ───────────────────────────

	/** Register the editor meta box on public post types. Gate-checked. */
	public function register_meta_boxes(): void {
		if ( ! $this->unlocked() || ! function_exists( 'add_meta_box' ) ) {
			return;
		}
		$types = $this->public_types();
		foreach ( $types as $type ) {
			add_meta_box( 'iwseo-metabox', 'InfraWeaver SEO', array( $this, 'render_meta_box' ), $type, 'normal', 'high' );
		}
	}

	/** Register `_iwseo_*` post meta so the block editor + REST see them natively. */
	public function register_post_meta(): void {
		if ( ! function_exists( 'register_post_meta' ) ) {
			return;
		}
		$auth = static function (): bool {
			return function_exists( 'current_user_can' ) ? (bool) current_user_can( 'edit_posts' ) : false;
		};
		$keys = array(
			self::META_TITLE, self::META_DESC, self::META_FOCUSKW, self::META_SYNONYMS, self::META_RELATED,
			self::META_CANONICAL, self::META_NOINDEX, self::META_NOFOLLOW, self::META_ROBOTS_ADV,
			self::META_OG_TITLE, self::META_OG_DESC, self::META_OG_IMAGE, self::META_TW_TITLE, self::META_TW_DESC,
			self::META_TW_IMAGE, self::META_CORNERSTONE, self::META_PAGE_TYPE, self::META_ARTICLE_TYPE, self::META_BCTITLE,
		);
		foreach ( $keys as $key ) {
			register_post_meta(
				'',
				$key,
				array(
					'type'          => 'string',
					'single'        => true,
					'show_in_rest'  => false,
					'auth_callback' => $auth,
				)
			);
		}
	}

	/**
	 * Render the editor meta box: live snippet preview, editable title/desc/slug,
	 * focus keyphrase + related/synonyms, the traffic-light analysis result list,
	 * social overrides, robots/advanced, cornerstone. Self-contained inline CSS + a
	 * small vanilla-JS analyzer for live feedback (PHP is authoritative on save).
	 *
	 * @param mixed $post
	 */
	public function render_meta_box( $post ): void {
		if ( ! function_exists( 'esc_html' ) ) {
			return;
		}
		if ( ! $this->unlocked() ) {
			echo '<p>🔒 ' . self::ehtml( 'The SEO Suite entitlement is not granted for this site.' ) . '</p>';
			return;
		}
		$post_id = is_object( $post ) && isset( $post->ID ) ? (int) $post->ID : 0;
		$m = static function ( $k ) use ( $post_id ) {
			return function_exists( 'get_post_meta' ) ? (string) get_post_meta( $post_id, $k, true ) : '';
		};
		$focuskw = $m( self::META_FOCUSKW );
		$paper = array(
			'title'          => '' !== $m( self::META_TITLE ) ? $m( self::META_TITLE ) : ( is_object( $post ) && isset( $post->post_title ) ? (string) $post->post_title : '' ),
			'content'        => is_object( $post ) && isset( $post->post_content ) ? (string) $post->post_content : '',
			'meta'           => $m( self::META_DESC ),
			'slug'           => is_object( $post ) && isset( $post->post_name ) ? (string) $post->post_name : '',
			'keyphrase'      => $focuskw,
			'synonyms'       => self::csv_list( $m( self::META_SYNONYMS ) ),
			'related'        => self::csv_list( $m( self::META_RELATED ) ),
			'is_cornerstone' => '1' === $m( self::META_CORNERSTONE ),
			'type'           => is_object( $post ) && isset( $post->post_type ) ? (string) $post->post_type : 'post',
			'locale'         => function_exists( 'get_locale' ) ? (string) get_locale() : 'en_US',
		);
		$result = IWSL_SEO_Analyzer::analyze( $paper );

		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::METABOX_NONCE, 'iwseo_metabox_nonce' );
		}
		$this->print_metabox_styles();
		echo '<div class="iwseo-box">';
		$this->render_snippet_preview( $paper, $m );
		$this->render_analysis_columns( $result );
		$this->render_advanced_fields( $m );
		echo '</div>';
		$this->print_metabox_script();
	}

	/** The light "paper" SERP preview card + the editable title/slug/description fields. */
	private function render_snippet_preview( array $paper, callable $m ): void {
		$sitename = $this->bloginfo( 'name' );
		echo '<div class="iwseo-preview" data-sitename="' . self::eattr( $sitename ) . '">';
		echo '<div class="iwseo-preview-head"><strong>' . self::ehtml( 'Search preview' ) . '</strong>';
		echo '<span class="iwseo-seg" role="group" aria-label="' . self::eattr( 'Preview device' ) . '">';
		echo '<button type="button" class="iwseo-seg-btn is-on" data-device="mobile">' . self::ehtml( 'Mobile' ) . '</button>';
		echo '<button type="button" class="iwseo-seg-btn" data-device="desktop">' . self::ehtml( 'Desktop' ) . '</button></span></div>';
		echo '<div class="iwseo-serp" data-device="mobile">';
		echo '<div class="iwseo-serp-url"><span class="iwseo-favicon" aria-hidden="true"></span><span class="iwseo-url-text"></span></div>';
		echo '<div class="iwseo-serp-title"></div>';
		echo '<div class="iwseo-serp-desc"></div>';
		echo '</div>';

		echo '<div class="iwseo-fields">';
		$this->text_field( 'iwseo_focuskw', 'Focus keyphrase', (string) $m( self::META_FOCUSKW ), 'The query you want this page to rank for.' );
		$this->text_field( 'iwseo_synonyms', 'Synonyms (comma-separated)', (string) $m( self::META_SYNONYMS ), 'Counted as keyphrase matches so you can write naturally.' );
		$this->text_field( 'iwseo_related', 'Related keyphrases (comma-separated)', (string) $m( self::META_RELATED ), 'Each gets its own mini-analysis.' );
		$this->text_field( 'iwseo_title', 'SEO title', (string) $m( self::META_TITLE ), 'Leave blank to inherit the template. Variables like %%title%% %%sep%% %%sitename%% work.', 'iwseo-meter-title' );
		$this->textarea_field( 'iwseo_desc', 'Meta description', (string) $m( self::META_DESC ), 'Aim for 120–156 characters.', 'iwseo-meter-desc' );
		echo '</div>';
		echo '</div>';
	}

	/** Problems / Improvements / Good columns of the traffic-light analysis. */
	private function render_analysis_columns( array $result ): void {
		echo '<div class="iwseo-analysis">';
		foreach ( array( 'seo' => 'SEO analysis', 'readability' => 'Readability' ) as $side => $label ) {
			$data = $result[ $side ];
			$chip = $this->status_chip( $data['rating'] );
			echo '<section class="iwseo-side"><h4>' . self::ehtml( $label ) . ' ' . $chip . '</h4>';
			$groups = array(
				IWSL_SEO_Analyzer::RED    => array( 'Problems', array() ),
				IWSL_SEO_Analyzer::ORANGE => array( 'Improvements', array() ),
				IWSL_SEO_Analyzer::GREEN  => array( 'Good results', array() ),
			);
			foreach ( $data['checks'] as $c ) {
				if ( isset( $groups[ $c['status'] ] ) ) {
					$groups[ $c['status'] ][1][] = $c;
				}
			}
			foreach ( $groups as $status => $bucket ) {
				list( $heading, $items ) = $bucket;
				if ( array() === $items ) {
					continue;
				}
				echo '<div class="iwseo-group"><div class="iwseo-group-h">' . self::ehtml( $heading ) . ' · ' . count( $items ) . '</div><ul>';
				foreach ( $items as $c ) {
					echo '<li>' . $this->status_chip( $status, true ) . ' <span>' . self::ehtml( (string) $c['message'] ) . '</span></li>';
				}
				echo '</ul></div>';
			}
			echo '</section>';
		}
		echo '</div>';
	}

	/** Social overrides + robots/advanced + schema + cornerstone. */
	private function render_advanced_fields( callable $m ): void {
		echo '<details class="iwseo-adv"><summary>' . self::ehtml( 'Social, robots & advanced' ) . '</summary><div class="iwseo-adv-body">';
		$this->text_field( 'iwseo_og_title', 'Social title', (string) $m( self::META_OG_TITLE ), 'Shown when the page is shared. Inherits the SEO title if blank.' );
		$this->textarea_field( 'iwseo_og_desc', 'Social description', (string) $m( self::META_OG_DESC ), '' );
		$this->text_field( 'iwseo_og_image', 'Social image URL', (string) $m( self::META_OG_IMAGE ), 'Falls back to the featured image, then the site default.' );
		$this->text_field( 'iwseo_canonical', 'Canonical URL', (string) $m( self::META_CANONICAL ), 'Leave blank to default to the permalink.' );
		$this->text_field( 'iwseo_bctitle', 'Breadcrumb title', (string) $m( self::META_BCTITLE ), 'Overrides this page\'s name in the trail.' );

		$noindex = '1' === (string) $m( self::META_NOINDEX );
		$nofollow = '1' === (string) $m( self::META_NOFOLLOW );
		$cornerstone = '1' === (string) $m( self::META_CORNERSTONE );
		echo '<p><label><input type="checkbox" name="iwseo_noindex" value="1"' . self::checked( $noindex ) . '> ' . self::ehtml( 'Ask search engines NOT to index this page (noindex)' ) . '</label></p>';
		echo '<p><label><input type="checkbox" name="iwseo_nofollow" value="1"' . self::checked( $nofollow ) . '> ' . self::ehtml( 'Ask search engines NOT to follow links on this page (nofollow)' ) . '</label></p>';
		$adv = self::csv_list( (string) $m( self::META_ROBOTS_ADV ) );
		echo '<fieldset><legend>' . self::ehtml( 'Advanced robots' ) . '</legend>';
		foreach ( IWSL_SEO_Head::ADV_DIRECTIVES as $d ) {
			echo '<label style="margin-right:12px;"><input type="checkbox" name="iwseo_robots_adv[]" value="' . self::eattr( $d ) . '"' . self::checked( in_array( $d, $adv, true ) ) . '> ' . self::ehtml( $d ) . '</label>';
		}
		echo '</fieldset>';
		echo '<p class="iwseo-cornerstone"><label><input type="checkbox" name="iwseo_cornerstone" value="1"' . self::checked( $cornerstone ) . '> <strong>' . self::ehtml( 'Cornerstone content' ) . '</strong></label><br>';
		echo '<span class="description">' . self::ehtml( 'Stricter checks (900+ words) and prioritized in link suggestions. This is what marking cornerstone actually does.' ) . '</span></p>';
		echo '</div></details>';
	}

	private function text_field( string $name, string $label, string $value, string $help, string $meter = '' ): void {
		$id = 'f_' . $name;
		echo '<p class="iwseo-field"><label for="' . self::eattr( $id ) . '">' . self::ehtml( $label ) . '</label>';
		echo '<input type="text" id="' . self::eattr( $id ) . '" name="' . self::eattr( $name ) . '" value="' . self::eattr( $value ) . '" class="widefat">';
		if ( '' !== $meter ) {
			echo '<span class="iwseo-meter ' . self::eattr( $meter ) . '"><span class="iwseo-meter-bar"></span><span class="iwseo-meter-label"></span></span>';
		}
		if ( '' !== $help ) {
			echo '<span class="description">' . self::ehtml( $help ) . '</span>';
		}
		echo '</p>';
	}

	private function textarea_field( string $name, string $label, string $value, string $help, string $meter = '' ): void {
		$id = 'f_' . $name;
		echo '<p class="iwseo-field"><label for="' . self::eattr( $id ) . '">' . self::ehtml( $label ) . '</label>';
		echo '<textarea id="' . self::eattr( $id ) . '" name="' . self::eattr( $name ) . '" rows="2" class="widefat">' . self::ehtml( $value ) . '</textarea>';
		if ( '' !== $meter ) {
			echo '<span class="iwseo-meter ' . self::eattr( $meter ) . '"><span class="iwseo-meter-bar"></span><span class="iwseo-meter-label"></span></span>';
		}
		if ( '' !== $help ) {
			echo '<span class="description">' . self::ehtml( $help ) . '</span>';
		}
		echo '</p>';
	}

	/** A status chip: icon + word together, never colour alone (WCAG). */
	private function status_chip( string $status, bool $dot_only = false ): string {
		$map = array(
			IWSL_SEO_Analyzer::GREEN  => array( '✔', 'Good', '#1a7f37' ),
			IWSL_SEO_Analyzer::ORANGE => array( '△', 'OK', '#8a6d00' ),
			IWSL_SEO_Analyzer::RED    => array( '✖', 'Needs work', '#b3261e' ),
			IWSL_SEO_Analyzer::NA     => array( '–', 'n/a', '#6b7280' ),
		);
		$c = isset( $map[ $status ] ) ? $map[ $status ] : $map[ IWSL_SEO_Analyzer::NA ];
		$text = $dot_only ? $c[0] : $c[0] . ' ' . $c[1];
		return '<span class="iwseo-chip" style="color:' . self::eattr( $c[2] ) . ';" role="img" aria-label="' . self::eattr( $c[1] ) . '">' . self::ehtml( $text ) . '</span>';
	}

	/**
	 * admin-post handler for the Search Appearance settings. LAYER 2: capability +
	 * nonce, re-check the gate, then save_settings() (LAYER 3 inside). PRG back to
	 * the Plus page with a per-user result transient.
	 */
	public function handle_save(): void {
		if ( ! function_exists( 'current_user_can' ) || ! current_user_can( 'manage_options' ) ) {
			if ( function_exists( 'wp_die' ) ) {
				wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
			}
			return;
		}
		if ( function_exists( 'check_admin_referer' ) ) {
			check_admin_referer( self::SAVE_NONCE );
		}
		$redirect = function_exists( 'admin_url' ) ? admin_url( 'admin.php?page=infraweaver-plus' ) : '';

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			if ( function_exists( 'wp_safe_redirect' ) ) {
				wp_safe_redirect( add_query_arg( 'iwsl_seo_locked', '1', $redirect ) );
				exit;
			}
			return;
		}

		$input = $this->collect_settings_input();
		$result = $this->save_settings( $input );
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id(), $result, 60 );
		}
		if ( function_exists( 'wp_safe_redirect' ) ) {
			wp_safe_redirect( $redirect );
			exit;
		}
	}

	/** Pull the settings form fields from $_POST (unslashed + shallow-sanitized). @return array */
	private function collect_settings_input(): array {
		$post = wp_unslash( $_POST ); // phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified by handle_save.
		$titles = isset( $post['iwseo_title_tpl'] ) && is_array( $post['iwseo_title_tpl'] ) ? array_map( array( __CLASS__, 'scalar' ), $post['iwseo_title_tpl'] ) : array();
		$metas = isset( $post['iwseo_meta_tpl'] ) && is_array( $post['iwseo_meta_tpl'] ) ? array_map( array( __CLASS__, 'scalar' ), $post['iwseo_meta_tpl'] ) : array();
		return array(
			'separator'            => self::scalar( $post['iwseo_separator'] ?? '-' ),
			'title_templates'      => $titles,
			'meta_templates'       => $metas,
			'org'                  => array(
				'type'    => self::scalar( $post['iwseo_org_type'] ?? 'organization' ),
				'name'    => self::scalar( $post['iwseo_org_name'] ?? '' ),
				'logo'    => self::scalar( $post['iwseo_org_logo'] ?? '' ),
				'same_as' => self::scalar( $post['iwseo_org_same_as'] ?? '' ),
			),
			'default_social_image' => self::scalar( $post['iwseo_default_social_image'] ?? '' ),
			'twitter_site'         => self::scalar( $post['iwseo_twitter_site'] ?? '' ),
			'sitemap_enabled'      => isset( $post['iwseo_sitemap_enabled'] ),
			'breadcrumbs'          => array(
				'enabled'    => isset( $post['iwseo_bc_enabled'] ),
				'home_label' => self::scalar( $post['iwseo_bc_home_label'] ?? '' ),
				'separator'  => self::scalar( $post['iwseo_bc_separator'] ?? '' ),
			),
		);
	}

	/**
	 * Render the SEO section for the `.iwsl-shell` Plus tab (LAYER 1). Locked → the
	 * gate reasons, no form. Unlocked → the Search Appearance settings form.
	 */
	public function render_section(): void {
		if ( ! function_exists( 'esc_html__' ) || ! function_exists( 'admin_url' ) ) {
			return;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'SEO Suite', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Yoast-Premium-class on-page SEO: focus-keyphrase analysis, a live Google snippet preview, titles/meta templates, robots, Open Graph, JSON-LD schema, an XML sitemap and breadcrumbs — self-contained, no external services, no ads.', 'infraweaver-connector' ) . '</p>';

		if ( isset( $_GET['iwsl_seo_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . esc_html__( 'The SEO Suite entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p></div>';
		}
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}
		$this->render_result_notice();

		// Progressive disclosure (additive): a PRIMARY status row summarises the
		// active state; the full settings form stays entirely VISIBLE below so the
		// required title/meta/sitemap toggles are never hidden.
		$s = $this->settings();
		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html( sprintf(
			'SEO Suite active · XML sitemap %s · breadcrumbs %s.',
			empty( $s['sitemap_enabled'] ) ? 'off' : 'on',
			empty( $s['breadcrumbs']['enabled'] ) ? 'off' : 'on'
		) ) . '</span>';
		echo '</div>';

		$this->render_settings_form();
	}

	private function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The SEO Suite entitlement is not granted — assign the Ultimate tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 The SEO Suite is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . self::ehtml( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	private function render_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key = self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>' . esc_html__( 'SEO settings saved.', 'infraweaver-connector' ) . '</p></div>';
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>' . self::ehtml( sprintf( 'Could not save: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p></div>';
		}
	}

	private function render_settings_form(): void {
		$s = $this->settings();
		echo '<form method="post" action="' . self::eurl( admin_url( 'admin-post.php' ) ) . '" class="iwsl-seo-settings" style="margin-top:16px;max-width:760px;">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::SAVE_NONCE );
		}
		echo '<input type="hidden" name="action" value="' . self::eattr( self::SAVE_ACTION ) . '">';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row"><label for="iwseo_separator">' . esc_html__( 'Title separator', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><input type="text" id="iwseo_separator" name="iwseo_separator" value="' . self::eattr( (string) $s['separator'] ) . '" class="small-text"> <span class="description">' . esc_html__( 'Used for %%sep%% in templates.', 'infraweaver-connector' ) . '</span></td></tr>';

		foreach ( array( 'post' => 'Posts', 'page' => 'Pages', 'home' => 'Homepage' ) as $type => $label ) {
			$t = isset( $s['title_templates'][ $type ] ) ? (string) $s['title_templates'][ $type ] : '';
			$d = isset( $s['meta_templates'][ $type ] ) ? (string) $s['meta_templates'][ $type ] : '';
			echo '<tr><th scope="row">' . self::ehtml( $label ) . '</th><td>';
			echo '<label>' . esc_html__( 'SEO title template', 'infraweaver-connector' ) . '<input type="text" name="iwseo_title_tpl[' . self::eattr( $type ) . ']" value="' . self::eattr( $t ) . '" class="widefat" placeholder="' . self::eattr( self::DEFAULT_TITLE_TEMPLATE ) . '"></label>';
			echo '<label style="display:block;margin-top:6px;">' . esc_html__( 'Meta description template', 'infraweaver-connector' ) . '<input type="text" name="iwseo_meta_tpl[' . self::eattr( $type ) . ']" value="' . self::eattr( $d ) . '" class="widefat"></label>';
			echo '</td></tr>';
		}

		// Core toggle stays visible with the templates.
		echo '<tr><th scope="row">' . esc_html__( 'XML sitemap', 'infraweaver-connector' ) . '</th><td>';
		echo '<label><input type="checkbox" name="iwseo_sitemap_enabled" value="1"' . self::checked( ! empty( $s['sitemap_enabled'] ) ) . '> ' . esc_html__( 'Serve /sitemap_index.xml (noindex URLs excluded)', 'infraweaver-connector' ) . '</label></td></tr>';

		echo '</tbody></table>';

		// Advanced: schema identity, social defaults, breadcrumbs — power knobs most
		// sites set once and forget. All field names + the save submit are unchanged.
		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<table class="form-table" role="presentation"><tbody>';

		$org = $s['org'];
		echo '<tr><th scope="row">' . esc_html__( 'Site represented by', 'infraweaver-connector' ) . '</th><td>';
		echo '<label><input type="radio" name="iwseo_org_type" value="organization"' . self::checked( 'organization' === $org['type'] ) . '> ' . esc_html__( 'Organization', 'infraweaver-connector' ) . '</label> ';
		echo '<label><input type="radio" name="iwseo_org_type" value="person"' . self::checked( 'person' === $org['type'] ) . '> ' . esc_html__( 'Person', 'infraweaver-connector' ) . '</label>';
		echo '<label style="display:block;margin-top:6px;">' . esc_html__( 'Name', 'infraweaver-connector' ) . '<input type="text" name="iwseo_org_name" value="' . self::eattr( (string) $org['name'] ) . '" class="widefat"></label>';
		echo '<label style="display:block;margin-top:6px;">' . esc_html__( 'Logo URL', 'infraweaver-connector' ) . '<input type="text" name="iwseo_org_logo" value="' . self::eattr( (string) $org['logo'] ) . '" class="widefat"></label>';
		echo '<label style="display:block;margin-top:6px;">' . esc_html__( 'Social profile URLs (one per line)', 'infraweaver-connector' ) . '<textarea name="iwseo_org_same_as" rows="3" class="widefat">' . self::ehtml( implode( "\n", (array) $org['same_as'] ) ) . '</textarea></label>';
		echo '</td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Social defaults', 'infraweaver-connector' ) . '</th><td>';
		echo '<label>' . esc_html__( 'Default share image URL', 'infraweaver-connector' ) . '<input type="text" name="iwseo_default_social_image" value="' . self::eattr( (string) $s['default_social_image'] ) . '" class="widefat"></label>';
		echo '<label style="display:block;margin-top:6px;">' . esc_html__( 'X / Twitter site handle', 'infraweaver-connector' ) . '<input type="text" name="iwseo_twitter_site" value="' . self::eattr( (string) $s['twitter_site'] ) . '" class="regular-text" placeholder="@site"></label>';
		echo '</td></tr>';

		$bc = $s['breadcrumbs'];
		echo '<tr><th scope="row">' . esc_html__( 'Breadcrumbs', 'infraweaver-connector' ) . '</th><td>';
		echo '<label><input type="checkbox" name="iwseo_bc_enabled" value="1"' . self::checked( ! empty( $bc['enabled'] ) ) . '> ' . esc_html__( 'Enable the [iwseo_breadcrumb] shortcode + schema', 'infraweaver-connector' ) . '</label>';
		echo '<label style="display:block;margin-top:6px;">' . esc_html__( 'Home label', 'infraweaver-connector' ) . '<input type="text" name="iwseo_bc_home_label" value="' . self::eattr( (string) $bc['home_label'] ) . '" class="regular-text"></label>';
		echo '<label style="display:block;margin-top:6px;">' . esc_html__( 'Separator', 'infraweaver-connector' ) . '<input type="text" name="iwseo_bc_separator" value="' . self::eattr( (string) $bc['separator'] ) . '" class="small-text"></label>';
		echo '</td></tr>';

		echo '</tbody></table>';
		echo '</div></details>';
		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Save SEO settings', 'infraweaver-connector' ) . '</button></p>';
		echo '</form>';
	}

	// ── inline CSS + JS for the meta box (self-contained, strict-CSP-safe) ───────

	private function print_metabox_styles(): void {
		echo '<style>'
			. '.iwseo-box{font-size:13px;line-height:1.5}'
			. '.iwseo-preview{margin:0 0 16px}'
			. '.iwseo-preview-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}'
			. '.iwseo-seg{display:inline-flex;border:1px solid #c3c4c7;border-radius:999px;overflow:hidden}'
			. '.iwseo-seg-btn{border:0;background:transparent;padding:4px 12px;cursor:pointer;font:inherit}'
			. '.iwseo-seg-btn.is-on{background:#2271b1;color:#fff}'
			. '.iwseo-serp{background:#fff;color:#202124;border:1px solid #dadce0;border-radius:10px;padding:14px 16px;max-width:600px}'
			. '.iwseo-serp-url{display:flex;align-items:center;gap:8px;color:#4d5156;font-size:12px}'
			. '.iwseo-favicon{width:18px;height:18px;border-radius:50%;background:#e8eaed;display:inline-block;flex:0 0 auto}'
			. '.iwseo-serp-title{color:#1a0dab;font-size:18px;line-height:1.3;margin:4px 0 2px;overflow:hidden;text-overflow:ellipsis}'
			. '.iwseo-serp-title b,.iwseo-serp-desc b{font-weight:700}'
			. '.iwseo-serp-desc{color:#4d5156;font-size:13px}'
			. '.iwseo-serp[data-device="mobile"] .iwseo-serp-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}'
			. '.iwseo-field{margin:10px 0}'
			. '.iwseo-field label{display:block;font-weight:600;margin-bottom:2px}'
			. '.iwseo-meter{display:block;margin-top:4px}'
			. '.iwseo-meter-bar{display:block;height:6px;border-radius:3px;background:#8a6d00;width:0;transition:width .2s ease-out}'
			. '.iwseo-meter-label{display:block;font-size:11px;color:#50575e;margin-top:2px}'
			. '.iwseo-meter.is-good .iwseo-meter-bar{background:#1a7f37}'
			. '.iwseo-meter.is-long .iwseo-meter-bar{background:#b3261e}'
			. '.iwseo-analysis{display:grid;grid-template-columns:1fr;gap:16px;margin:16px 0}'
			. '@media(min-width:900px){.iwseo-analysis{grid-template-columns:1fr 1fr}}'
			. '.iwseo-side h4{margin:0 0 8px;display:flex;align-items:center;gap:8px}'
			. '.iwseo-group{margin:8px 0}'
			. '.iwseo-group-h{font-weight:700;margin-bottom:4px}'
			. '.iwseo-analysis ul{margin:0;list-style:none;padding:0}'
			. '.iwseo-analysis li{display:flex;gap:8px;align-items:flex-start;margin:4px 0}'
			. '.iwseo-chip{font-weight:700;white-space:nowrap}'
			. '.iwseo-adv{margin-top:12px;border:1px solid #dcdcde;border-radius:8px;padding:0 12px}'
			. '.iwseo-adv>summary{cursor:pointer;padding:10px 0;font-weight:600}'
			. '.iwseo-adv-body{padding-bottom:12px}'
			. '@media(prefers-reduced-motion:reduce){.iwseo-meter-bar{transition:none}}'
			. '</style>';
	}

	private function print_metabox_script(): void {
		// Live snippet preview + length meters. Mirrors the PHP checks for feedback;
		// the authoritative analysis runs server-side on save. No external assets.
		echo "<script>(function(){var box=document.currentScript.previousElementSibling;if(!box||!box.classList||!box.classList.contains('iwseo-box')){box=document.querySelector('.iwseo-box');}if(!box)return;"
			. "var q=function(s){return box.querySelector(s);};"
			. "var titleIn=q('#f_iwseo_title'),descIn=q('#f_iwseo_desc'),kwIn=q('#f_iwseo_focuskw');"
			. "var serp=q('.iwseo-serp'),serpT=q('.iwseo-serp-title'),serpD=q('.iwseo-serp-desc'),serpU=q('.iwseo-url-text');"
			. "var cvs=document.createElement('canvas'),ctx=cvs.getContext('2d');ctx.font='18px arial';"
			. "function esc(s){return s.replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}"
			. "function bold(text,kw){text=esc(text);if(!kw)return text;var words=kw.split(/[\\s,]+/).filter(Boolean);words.forEach(function(w){if(w.length<2)return;var re=new RegExp('('+w.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')+')','ig');text=text.replace(re,'<b>$1</b>');});return text;}"
			. "function meter(sel,val,lo,hi,unit){var m=box.querySelector('.'+sel);if(!m)return;var bar=m.querySelector('.iwseo-meter-bar'),lab=m.querySelector('.iwseo-meter-label');var pct=Math.min(100,Math.round(val/hi*100));bar.style.width=pct+'%';m.classList.remove('is-good','is-long');if(val>hi){m.classList.add('is-long');}else if(val>=lo){m.classList.add('is-good');}lab.textContent=Math.round(val)+' / '+hi+' '+unit;}"
			. "function sitedomain(){var s=(box.querySelector('.iwseo-preview')||{}).getAttribute?box.querySelector('.iwseo-preview').getAttribute('data-sitename'):'';return s||location.host;}"
			. "function update(){var t=(titleIn&&titleIn.value)||'';var d=(descIn&&descIn.value)||'';var kw=(kwIn&&kwIn.value)||'';"
			. "if(serpT)serpT.innerHTML=bold(t||document.title||'',kw);if(serpD)serpD.innerHTML=bold(d,kw);if(serpU)serpU.textContent=sitedomain();"
			. "var w=Math.round(ctx.measureText(t).width);meter('iwseo-meter-title',w,401,600,'px');meter('iwseo-meter-desc',d.length,120,156,'chars');}"
			. "[titleIn,descIn,kwIn].forEach(function(el){if(el){el.addEventListener('input',update);}});"
			. "box.querySelectorAll('.iwseo-seg-btn').forEach(function(b){b.addEventListener('click',function(){box.querySelectorAll('.iwseo-seg-btn').forEach(function(x){x.classList.remove('is-on');});b.classList.add('is-on');if(serp)serp.setAttribute('data-device',b.getAttribute('data-device'));});});"
			. "update();})();</script>";
	}

	// ── small guarded WP getters + shared sanitizers ────────────────────────────

	private function post_meta( int $post_id, string $key ) {
		if ( $post_id > 0 && function_exists( 'get_post_meta' ) ) {
			return get_post_meta( $post_id, $key, true );
		}
		return '';
	}

	private function bloginfo( string $key ): string {
		return function_exists( 'get_bloginfo' ) ? (string) get_bloginfo( $key ) : '';
	}

	private function home_url(): string {
		if ( function_exists( 'home_url' ) ) {
			return rtrim( (string) home_url(), '/' );
		}
		return '';
	}

	private function locale_tag(): string {
		if ( function_exists( 'get_locale' ) ) {
			return str_replace( '_', '-', (string) get_locale() );
		}
		return 'en-US';
	}

	private function author_name( $post ): string {
		if ( is_object( $post ) && isset( $post->post_author ) && function_exists( 'get_the_author_meta' ) ) {
			return (string) get_the_author_meta( 'display_name', (int) $post->post_author );
		}
		return '';
	}

	/** Public post types we decorate, defaulting to post+page outside WP. @return string[] */
	private function public_types(): array {
		if ( function_exists( 'get_post_types' ) ) {
			$types = get_post_types( array( 'public' => true ), 'names' );
			if ( is_array( $types ) ) {
				unset( $types['attachment'] );
				return array_values( $types );
			}
		}
		return array( 'post', 'page' );
	}

	private function request_path(): ?string {
		if ( ! isset( $_SERVER['REQUEST_URI'] ) ) {
			return null;
		}
		$raw = function_exists( 'wp_unslash' ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : (string) $_SERVER['REQUEST_URI']; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		$path = function_exists( 'wp_parse_url' ) ? wp_parse_url( $raw, PHP_URL_PATH ) : parse_url( $raw, PHP_URL_PATH );
		return is_string( $path ) && '' !== $path ? $path : null;
	}

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}

	// ── static input helpers ─────────────────────────────────────────────────────

	private static function str( array $a, string $k ): string {
		return isset( $a[ $k ] ) && is_string( $a[ $k ] ) ? $a[ $k ] : '';
	}

	private static function pluck( array $a, string $k ): string {
		return isset( $a[ $k ] ) && is_string( $a[ $k ] ) ? $a[ $k ] : '';
	}

	/** @param mixed $v */
	private static function scalar( $v ): string {
		return is_scalar( $v ) ? (string) $v : '';
	}

	/** Split a comma/newline list into trimmed non-empty strings. @return string[] */
	private static function csv_list( string $value ): array {
		$parts = preg_split( '/[\r\n,]+/', $value );
		$out = array();
		foreach ( (array) $parts as $p ) {
			$p = trim( (string) $p );
			if ( '' !== $p ) {
				$out[] = $p;
			}
		}
		return $out;
	}

	/** Strip control chars, collapse whitespace, cap length. */
	private static function clean_line( string $value, int $max ): string {
		$v = preg_replace( '/[\x00-\x1F\x7F]+/u', ' ', $value ) ?? '';
		$v = trim( preg_replace( '/[ \t]+/', ' ', $v ) ?? '' );
		if ( function_exists( 'mb_substr' ) ) {
			return mb_strlen( $v, 'UTF-8' ) > $max ? mb_substr( $v, 0, $max, 'UTF-8' ) : $v;
		}
		return strlen( $v ) > $max ? substr( $v, 0, $max ) : $v;
	}

	private static function clean_separator( string $value ): string {
		$v = self::clean_line( $value, 8 );
		return '' !== $v ? $v : '-';
	}

	/** Whitelist a schema @type token (letters only, bounded). */
	private static function clean_schema_type( string $value ): string {
		$v = trim( $value );
		return preg_match( '/^[A-Za-z]{1,40}$/', $v ) ? $v : '';
	}

	/**
	 * Validate a URL: empty is allowed (no override); otherwise a rooted internal
	 * path or a strict http(s) URL. Mirrors the white-label URL gauntlet.
	 */
	private static function clean_url( string $url ): string {
		$url = trim( $url );
		if ( '' === $url || strlen( $url ) > self::MAX_URL_LEN ) {
			return '';
		}
		if ( false !== strpos( $url, '\\' ) || preg_match( '/[\x00-\x1F\x7F\s]/', $url ) ) {
			return '';
		}
		if ( 0 === strpos( $url, '//' ) ) {
			return '';
		}
		if ( '/' === $url[0] ) {
			return false === strpos( $url, '://' ) ? $url : '';
		}
		$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) ) {
			return '';
		}
		$scheme = isset( $parts['scheme'] ) ? strtolower( (string) $parts['scheme'] ) : '';
		if ( 'http' !== $scheme && 'https' !== $scheme ) {
			return '';
		}
		if ( isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			return '';
		}
		if ( function_exists( 'esc_url_raw' ) ) {
			$clean = esc_url_raw( $url, array( 'http', 'https' ) );
			return $clean === $url ? $url : '';
		}
		return $url;
	}

	private static function post_field( string $key ): string {
		if ( ! isset( $_POST[ $key ] ) ) {
			return '';
		}
		$raw = function_exists( 'wp_unslash' ) ? wp_unslash( $_POST[ $key ] ) : $_POST[ $key ]; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		return self::scalar( $raw );
	}

	private static function checked( bool $on ): string {
		return $on ? ' checked' : '';
	}

	private static function ehtml( string $s ): string {
		return function_exists( 'esc_html' ) ? esc_html( $s ) : htmlspecialchars( $s, ENT_QUOTES, 'UTF-8' );
	}

	private static function eattr( string $s ): string {
		return function_exists( 'esc_attr' ) ? esc_attr( $s ) : htmlspecialchars( $s, ENT_QUOTES, 'UTF-8' );
	}

	private static function eurl( string $s ): string {
		return function_exists( 'esc_url' ) ? esc_url( $s ) : self::eattr( $s );
	}
}
