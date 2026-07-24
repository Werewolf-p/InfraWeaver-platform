<?php
/**
 * Engine behind the gated "Media Gallery (by tag)" feature. It shares the
 * `media_folders` entitlement flag with the folders/tags engine — the tag DATA is
 * the gated thing, so a site that already has tags gets galleries at no extra flag.
 *
 * ONE SHARED RENDERER, THREE PUBLIC SURFACES. `render_gallery( array $args ): string`
 * is the single source of truth: given a tag (id / slug / name) it runs ONE bounded
 * WP_Query over the `iwsl_media_tag` taxonomy and returns a grid of published image
 * attachments. Three entry points feed that renderer so their output can never
 * diverge:
 *   1. an Elementor widget  — IWSL_Widget_Media_Gallery, lazily loaded from
 *      includes/elementor/ EXACTLY like IWSL_Elementor_Blocks (never parsed without
 *      Elementor present);
 *   2. a shortcode          — [iwsl_media_gallery tag="paintings"] (+ alias [iwsl_gallery]);
 *   3. a dynamic Gutenberg block — infraweaver/media-gallery, server-rendered via a
 *      render_callback (no build step; a vanilla-JS editor control registers it).
 *
 * PUBLIC-FACING FENCE (information-disclosure boundary). The gallery is front-end
 * output for logged-out visitors. It exposes ONLY published, front-end-safe fields
 * per image — the public attachment URL, its alt text, and its caption — never a
 * folder, optimization/CDN state, uploader, or any admin datum. Its lightbox is the
 * Agent-A viewer's PRESENTATION CORE ONLY (`createPresentationCore` in
 * iwsl-media-viewer.js): markup-driven, mounting zero admin panels, issuing zero
 * requests and never a signed method. See docs on enqueue_assets().
 *
 * BOUNDED + CACHED. `posts_per_page` is hard-capped at GALLERY_MAX (never -1),
 * `no_found_rows`, `fields => ids`. The rendered fragment is cached in a transient
 * keyed on (term, normalized args, taxonomy/posts last-changed) — WordPress bumps
 * `wp_get_last_changed('terms')` on ANY tag assign / retag / rename / merge / delete
 * and `wp_get_last_changed('posts')` on attachment add / delete / edit, so the key
 * self-invalidates without a web of manual hooks. The entitlement gate is re-checked
 * as STATEMENT 1 of render_gallery() — BEFORE any cache read — so a revoked site
 * never serves a cached (previously-unlocked) gallery and never shows a visitor an
 * upsell: it renders nothing.
 *
 * TRUST MODEL. Console-authoritative like every other engine: the `media_folders`
 * flag is written ONLY by the dual-signed `entitlements.set` runner. No self-set,
 * REST, AJAX, cron or nopriv surface is added here; the tag DATA that drives the
 * gallery is mutated only through the signed `media.folder` method's terms-only ops.
 * SAFETY: in-process only, escapes every rendered value, and every WordPress call is
 * function_exists-guarded so the class loads and its pure helpers run under the
 * zero-dependency test harness.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Media_Gallery {

	/** Shared entitlement flag — the tag data is what's gated (Pro/Ultimate). */
	const FEATURE = 'media_folders';

	/** The tag taxonomy the gallery loops over. */
	const TAX_TAG = 'iwsl_media_tag';

	/** Primary shortcode + a friendly alias. */
	const SHORTCODE       = 'iwsl_media_gallery';
	const SHORTCODE_ALIAS = 'iwsl_gallery';

	/** Dynamic Gutenberg block name + the Elementor category the widget joins. */
	const BLOCK_NAME    = 'infraweaver/media-gallery';
	const CATEGORY_SLUG = 'infraweaver';

	/** Front-end lightbox + block-editor script handles. */
	const SCRIPT_HANDLE       = 'iwsl-media-gallery';
	const STYLE_HANDLE        = 'iwsl-media-gallery';
	const BLOCK_SCRIPT_HANDLE = 'iwsl-media-gallery-block';

	/** Query + layout bounds. posts_per_page is NEVER -1; it clamps to GALLERY_MAX. */
	const GALLERY_MAX     = 200;
	const GALLERY_DEFAULT = 24;
	const COLS_MIN        = 1;
	const COLS_MAX        = 6;

	/** Rendered-fragment cache. */
	const CACHE_PREFIX = 'iwsl_gal_';
	const CACHE_TTL    = 300;

	/** Whitelists — anything off-list falls back to the safe default (index 0). */
	const SIZES    = array( 'thumbnail', 'medium', 'medium_large', 'large', 'full' );
	const ORDERBYS = array( 'date', 'title', 'menu_order', 'rand' );
	const ORDERS   = array( 'desc', 'asc' );

	/** @var IWSL_Entitlements The gate. */
	private $entitlements;

	/** @var IWSL_Store settings store (unused; kept for signature parity). */
	private $store;

	/** @var bool One-shot per-request guard so assets enqueue at most once. */
	private $enqueued = false;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Store; production injects IWSL_WP_Store.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
	}

	// ── registration (LAYER 2 wiring; STATEMENT 1 gate) ─────────────────────────

	/**
	 * Wire the three surfaces. STATEMENT 1 is the authoritative gate, so a
	 * locked/revoked site registers NOTHING — no shortcode, no block, no Elementor
	 * hook, no script filter — and behaves exactly like stock WordPress. Guarded so
	 * the harness can call register() harmlessly.
	 */
	public function register(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( function_exists( 'add_shortcode' ) ) {
			add_shortcode( self::SHORTCODE, array( $this, 'shortcode' ) );
			add_shortcode( self::SHORTCODE_ALIAS, array( $this, 'shortcode' ) );
		}
		$this->register_assets();
		if ( function_exists( 'register_block_type' ) ) {
			register_block_type(
				self::BLOCK_NAME,
				array(
					'api_version'     => 2,
					'attributes'      => self::block_attributes(),
					'render_callback' => array( $this, 'render_block' ),
					'editor_script'   => self::BLOCK_SCRIPT_HANDLE,
				)
			);
		}
		if ( function_exists( 'add_action' ) ) {
			// Elementor — categories/widgets hooks fire only when Elementor is booted;
			// the widget file is required lazily inside register_widget().
			add_action( 'elementor/elements/categories_registered', array( $this, 'register_category' ) );
			add_action( 'elementor/widgets/register', array( $this, 'register_widget' ) );
		}
	}

	/**
	 * Register (not enqueue) the front-end lightbox module + the inline grid style +
	 * the no-build block-editor script. Enqueue happens lazily in enqueue_assets()
	 * only when a gallery actually renders, so a page with no gallery pays nothing.
	 */
	private function register_assets(): void {
		if ( ! function_exists( 'wp_register_script' ) || ! function_exists( 'plugins_url' ) ) {
			return;
		}
		$ver = defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : false;
		wp_register_script( self::SCRIPT_HANDLE, plugins_url( 'assets/iwsl-media-gallery.js', __FILE__ ), array(), $ver, true );
		wp_register_script(
			self::BLOCK_SCRIPT_HANDLE,
			plugins_url( 'assets/iwsl-media-gallery-block.js', __FILE__ ),
			array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-i18n' ),
			$ver,
			true
		);
		if ( function_exists( 'wp_register_style' ) ) {
			wp_register_style( self::STYLE_HANDLE, false, array(), $ver );
			if ( function_exists( 'wp_add_inline_style' ) ) {
				wp_add_inline_style( self::STYLE_HANDLE, self::grid_css() );
			}
		}
		// The lightbox is an ES module (it imports the presentation core from the
		// sibling iwsl-media-viewer.js); mark only our handle as type="module".
		if ( function_exists( 'add_filter' ) ) {
			add_filter( 'script_loader_tag', array( $this, 'module_script_tag' ), 10, 3 );
		}
	}

	/**
	 * script_loader_tag filter: turn our lightbox handle into a native ES module so
	 * its `import { createPresentationCore }` resolves. Every other script is left
	 * byte-identical.
	 *
	 * @param string $tag    The full <script> tag.
	 * @param string $handle The script handle.
	 * @param string $src    The script src (unused).
	 */
	public function module_script_tag( $tag, $handle = '', $src = '' ) {
		if ( self::SCRIPT_HANDLE !== $handle || ! is_string( $tag ) ) {
			return $tag;
		}
		if ( false !== strpos( $tag, 'type="module"' ) ) {
			return $tag;
		}
		return str_replace( '<script ', '<script type="module" ', $tag );
	}

	// ── the ONE shared renderer ─────────────────────────────────────────────────

	/**
	 * Render a gallery of every published image carrying $args['tag'] into a bounded,
	 * cached grid. Returns '' (nothing on the public page) when the feature is locked,
	 * the tag can't be resolved, or the tag has no images. This is the single code
	 * path behind the shortcode, the block, and the Elementor widget.
	 *
	 * @param array<string,mixed> $args tag, columns, size, orderby, order, limit,
	 *                                   lightbox, captions (all optional but tag).
	 */
	public function render_gallery( array $args ): string {
		// STATEMENT 1 — the gate, BEFORE any cache read. A revoked site serves
		// nothing: no cached fragment, no upsell, no admin byte.
		if ( ! $this->unlocked() ) {
			return '';
		}
		$norm = self::normalize_args( $args );
		$term = $this->resolve_term( $norm['tag'] );
		if ( null === $term || ! isset( $term->term_id ) ) {
			return '';
		}
		$term_id = (int) $term->term_id;

		$key  = $this->cache_key( $norm, $term_id );
		$html = function_exists( 'get_transient' ) ? get_transient( $key ) : false;
		if ( ! is_string( $html ) ) {
			$html = $this->build_gallery( $norm, $term_id );
			if ( function_exists( 'set_transient' ) ) {
				set_transient( $key, $html, self::CACHE_TTL );
			}
		}
		if ( '' !== $html ) {
			$this->enqueue_assets( (bool) $norm['lightbox'] );
		}
		return $html;
	}

	/** Build the grid HTML from a bounded id query. Returns '' when the tag is empty. */
	private function build_gallery( array $norm, int $term_id ): string {
		$ids = $this->query_tag_attachments( $norm, $term_id );
		if ( array() === $ids ) {
			return '';
		}
		$items = '';
		foreach ( $ids as $id ) {
			$items .= $this->render_item( (int) $id, $norm );
		}
		if ( '' === $items ) {
			return '';
		}
		$cols          = (int) $norm['columns'];
		$lightbox_attr = $norm['lightbox'] ? ' data-iwsl-lightbox="1"' : '';
		return '<div class="iwsl-gallery iwsl-gallery--cols-' . $cols . '"' . $lightbox_attr . ' role="list">'
			. $items . '</div>';
	}

	/**
	 * Bounded WP_Query for image attachments in the tag term. posts_per_page is
	 * clamped to [1, GALLERY_MAX] and is NEVER -1; no_found_rows + fields=ids keep it
	 * cheap even for a 10 000-image tag.
	 *
	 * @return int[] attachment ids (empty under the harness when WP_Query is absent).
	 */
	private function query_tag_attachments( array $norm, int $term_id ): array {
		if ( ! class_exists( 'WP_Query' ) ) {
			return array();
		}
		$per_page = min( self::GALLERY_MAX, max( 1, (int) $norm['limit'] ) );
		$query    = new WP_Query(
			array(
				'post_type'      => 'attachment',
				'post_status'    => 'inherit',
				'post_mime_type' => 'image',
				'fields'         => 'ids',
				'posts_per_page' => $per_page,
				'no_found_rows'  => true,
				'orderby'        => (string) $norm['orderby'],
				'order'          => ( 'asc' === $norm['order'] ) ? 'ASC' : 'DESC',
				'tax_query'      => array(
					array(
						'taxonomy' => self::TAX_TAG,
						'field'    => 'term_id',
						'terms'    => array( $term_id ),
						'operator' => 'IN',
					),
				),
			)
		);
		$posts = isset( $query->posts ) && is_array( $query->posts ) ? $query->posts : array();
		$out   = array();
		foreach ( $posts as $p ) {
			$out[] = (int) ( is_object( $p ) && isset( $p->ID ) ? $p->ID : $p );
		}
		return $out;
	}

	/**
	 * One gallery item. Exposes ONLY public, front-end-safe fields: the attachment's
	 * public URL, its alt text and its caption — the data the lightbox reads straight
	 * from the markup. No folder, optimization/CDN, uploader or any admin datum ever
	 * appears here. Every value is escaped.
	 */
	private function render_item( int $id, array $norm ): string {
		$full = function_exists( 'wp_get_attachment_image_url' ) ? (string) ( wp_get_attachment_image_url( $id, 'full' ) ?: '' ) : '';
		if ( '' === $full && function_exists( 'wp_get_attachment_url' ) ) {
			$full = (string) ( wp_get_attachment_url( $id ) ?: '' );
		}
		if ( '' === $full ) {
			return '';
		}
		$alt     = function_exists( 'get_post_meta' ) ? (string) get_post_meta( $id, '_wp_attachment_image_alt', true ) : '';
		$caption = function_exists( 'wp_get_attachment_caption' ) ? (string) ( wp_get_attachment_caption( $id ) ?: '' ) : '';

		$img = function_exists( 'wp_get_attachment_image' )
			? (string) wp_get_attachment_image( $id, (string) $norm['size'], false, array( 'loading' => 'lazy', 'class' => 'iwsl-gallery__img' ) )
			: '<img class="iwsl-gallery__img" loading="lazy" src="' . self::esc_url( $full ) . '" alt="' . self::esc_attr( $alt ) . '" />';

		$link = '<a class="iwsl-gallery__link" role="listitem" href="' . self::esc_url( $full ) . '"'
			. ' data-iwsl-full="' . self::esc_url( $full ) . '"'
			. ' data-iwsl-alt="' . self::esc_attr( $alt ) . '"'
			. ' data-iwsl-caption="' . self::esc_attr( $caption ) . '">'
			. $img . '</a>';

		$figcaption = ( $norm['captions'] && '' !== $caption )
			? '<figcaption class="iwsl-gallery__caption">' . self::esc_html( $caption ) . '</figcaption>'
			: '';

		return '<figure class="iwsl-gallery__item">' . $link . $figcaption . '</figure>';
	}

	// ── surface adapters (all funnel into render_gallery) ───────────────────────

	/**
	 * Shortcode handler for [iwsl_media_gallery] / [iwsl_gallery]. Attributes arrive
	 * as strings; normalize_args() clamps + whitelists them, so an author can't push
	 * an unbounded limit or a bogus column count.
	 *
	 * @param array<string,mixed>|string $atts
	 * @param string|null                $content
	 */
	public function shortcode( $atts = array(), $content = null ): string {
		$atts = is_array( $atts ) ? $atts : array();
		return $this->render_gallery( self::atts_to_args( $atts ) );
	}

	/**
	 * Dynamic-block render_callback for infraweaver/media-gallery. Server-rendered so
	 * the block, shortcode and widget share one renderer (and one cache).
	 *
	 * @param array<string,mixed> $attributes
	 * @param string              $content
	 */
	public function render_block( $attributes = array(), $content = '' ): string {
		$attributes = is_array( $attributes ) ? $attributes : array();
		return $this->render_gallery( self::atts_to_args( $attributes ) );
	}

	/**
	 * Elementor + any external caller entry that has no engine instance to hand: build
	 * one from the global plugin's entitlements and render. Returns '' when the plugin
	 * global is unavailable (e.g. under the harness).
	 *
	 * @param array<string,mixed> $args
	 */
	public static function render_for_widget( array $args ): string {
		if ( ! function_exists( 'iwsl_plugin' ) ) {
			return '';
		}
		$plugin = iwsl_plugin();
		if ( ! is_object( $plugin ) || ! method_exists( $plugin, 'entitlements' ) ) {
			return '';
		}
		return ( new self( $plugin->entitlements() ) )->render_gallery( $args );
	}

	// ── Elementor (lazy widget, copied discipline from IWSL_Elementor_Blocks) ────

	/**
	 * `elementor/elements/categories_registered`: ensure the shared "InfraWeaver"
	 * category exists (Elementor de-dupes, so registering it here alongside the blocks
	 * pack is harmless). STATEMENT 1 is the gate.
	 *
	 * @param mixed $elements_manager Elementor\Core\Elements_Manager (duck-typed).
	 */
	public function register_category( $elements_manager = null ): void {
		if ( ! $this->unlocked() ) {
			return;
		}
		if ( ! is_object( $elements_manager ) || ! method_exists( $elements_manager, 'add_category' ) ) {
			return;
		}
		$elements_manager->add_category(
			self::CATEGORY_SLUG,
			array(
				'title' => function_exists( 'esc_html__' ) ? esc_html__( 'InfraWeaver', 'infraweaver-connector' ) : 'InfraWeaver',
				'icon'  => 'eicon-gallery-grid',
			)
		);
	}

	/**
	 * `elementor/widgets/register`: lazily require the widget file (now that
	 * \Elementor\Widget_Base is guaranteed present) and register it. The widget file
	 * is NEVER required at load time — a site without Elementor never reaches here, so
	 * the subclass is never declared and there is no fatal. STATEMENT 1 is the gate.
	 *
	 * @param mixed $widgets_manager Elementor\Widgets_Manager (duck-typed).
	 */
	public function register_widget( $widgets_manager = null ): void {
		if ( ! $this->unlocked() ) {
			return;
		}
		if ( ! class_exists( '\\Elementor\\Widget_Base' ) ) {
			return;
		}
		require_once __DIR__ . '/elementor/class-iwsl-elementor-gallery-widget.php';
		foreach ( self::widget_classes() as $class ) {
			if ( ! class_exists( $class ) || ! is_object( $widgets_manager ) ) {
				continue;
			}
			$widget = new $class();
			if ( method_exists( $widgets_manager, 'register' ) ) {
				$widgets_manager->register( $widget );
			} elseif ( method_exists( $widgets_manager, 'register_widget_type' ) ) {
				$widgets_manager->register_widget_type( $widget );
			}
		}
	}

	/**
	 * Pure: the widget class names this engine registers. Public so a test can assert
	 * the set WITHOUT loading Elementor.
	 *
	 * @return string[]
	 */
	public static function widget_classes(): array {
		return array( 'IWSL_Widget_Media_Gallery' );
	}

	// ── enqueue (the public-lightbox fence lives here) ──────────────────────────

	/**
	 * Enqueue the grid CSS always (a gallery rendered), and — only when lightbox is on
	 * — the presentation-core lightbox module. THE FENCE: the enqueued script is
	 * iwsl-media-gallery.js, which imports ONLY `createPresentationCore` from the
	 * viewer module and drives it from DOM markup. It constructs no admin viewer,
	 * registers no panel, and calls no adapter/endpoint/signed method — a logged-out
	 * visitor receives zero admin data.
	 */
	private function enqueue_assets( bool $lightbox ): void {
		if ( $this->enqueued ) {
			return;
		}
		if ( function_exists( 'wp_enqueue_style' ) ) {
			wp_enqueue_style( self::STYLE_HANDLE );
		}
		if ( $lightbox && function_exists( 'wp_enqueue_script' ) ) {
			wp_enqueue_script( self::SCRIPT_HANDLE );
		}
		$this->enqueued = true;
	}

	/** Minimal responsive grid CSS (the columns var is the only per-instance knob). */
	private static function grid_css(): string {
		return '.iwsl-gallery{display:grid;gap:12px;grid-template-columns:repeat(var(--iwsl-gallery-cols,3),1fr);}'
			. '.iwsl-gallery--cols-1{--iwsl-gallery-cols:1;}.iwsl-gallery--cols-2{--iwsl-gallery-cols:2;}'
			. '.iwsl-gallery--cols-3{--iwsl-gallery-cols:3;}.iwsl-gallery--cols-4{--iwsl-gallery-cols:4;}'
			. '.iwsl-gallery--cols-5{--iwsl-gallery-cols:5;}.iwsl-gallery--cols-6{--iwsl-gallery-cols:6;}'
			. '.iwsl-gallery__item{margin:0;}.iwsl-gallery__link{display:block;line-height:0;}'
			. '.iwsl-gallery__img{width:100%;height:auto;display:block;border-radius:4px;}'
			. '.iwsl-gallery__caption{font:13px/1.4 system-ui,sans-serif;padding:6px 2px;line-height:1.4;}'
			. '@media(max-width:600px){.iwsl-gallery{grid-template-columns:repeat(2,1fr);}}';
	}

	// ── teardown parity ─────────────────────────────────────────────────────────

	/**
	 * Teardown-framework parity: the gallery persists NOTHING of its own (no option,
	 * no postmeta, no term — it is computed live from the tag taxonomy). Its only
	 * footprint is short-lived transients that self-expire and self-invalidate via the
	 * last-changed key, so purge() is an honest no-op.
	 *
	 * @return array{ ok:bool, deleted:bool }
	 */
	public function purge(): array {
		return array( 'ok' => true, 'deleted' => false );
	}

	// ── pure helpers (public/static so tests exercise them without WordPress) ────

	/**
	 * Clamp + whitelist raw args into a canonical, bounded shape. Pure and total —
	 * every field has a safe default, so a hostile shortcode/block/widget arg can only
	 * ever narrow to a legal value.
	 *
	 * @param array<string,mixed> $raw
	 * @return array{tag:string,columns:int,size:string,orderby:string,order:string,limit:int,lightbox:bool,captions:bool}
	 */
	public static function normalize_args( array $raw ): array {
		$tag = $raw['tag'] ?? '';
		return array(
			'tag'      => is_scalar( $tag ) ? trim( (string) $tag ) : '',
			'columns'  => self::clamp_int( $raw['columns'] ?? self::COLS_MIN + 2, self::COLS_MIN, self::COLS_MAX, 3 ),
			'size'     => self::enum( $raw['size'] ?? 'medium', self::SIZES, 'medium' ),
			'orderby'  => self::enum( $raw['orderby'] ?? self::ORDERBYS[0], self::ORDERBYS ),
			'order'    => self::enum( is_scalar( $raw['order'] ?? null ) ? strtolower( (string) $raw['order'] ) : self::ORDERS[0], self::ORDERS ),
			'limit'    => self::clamp_int( $raw['limit'] ?? self::GALLERY_DEFAULT, 1, self::GALLERY_MAX, self::GALLERY_DEFAULT ),
			'lightbox' => self::to_bool( $raw['lightbox'] ?? true ),
			'captions' => self::to_bool( $raw['captions'] ?? false ),
		);
	}

	/**
	 * The Gutenberg block attribute schema — the single source shared by
	 * register_block_type() and the no-build editor script.
	 *
	 * @return array<string,array<string,mixed>>
	 */
	public static function block_attributes(): array {
		return array(
			'tag'      => array( 'type' => 'string', 'default' => '' ),
			'columns'  => array( 'type' => 'number', 'default' => 3 ),
			'size'     => array( 'type' => 'string', 'default' => 'medium' ),
			'orderby'  => array( 'type' => 'string', 'default' => 'date' ),
			'order'    => array( 'type' => 'string', 'default' => 'desc' ),
			'limit'    => array( 'type' => 'number', 'default' => self::GALLERY_DEFAULT ),
			'lightbox' => array( 'type' => 'boolean', 'default' => true ),
			'captions' => array( 'type' => 'boolean', 'default' => false ),
		);
	}

	/**
	 * The tag terms as a slug => name map, for the Elementor SELECT control. Guarded
	 * (empty under the harness / on a fresh site).
	 *
	 * @return array<string,string>
	 */
	public static function tag_options(): array {
		if ( ! function_exists( 'get_terms' ) ) {
			return array();
		}
		$terms = get_terms( array( 'taxonomy' => self::TAX_TAG, 'hide_empty' => false ) );
		if ( ! is_array( $terms ) ) {
			return array();
		}
		$out = array();
		foreach ( $terms as $t ) {
			if ( is_object( $t ) && isset( $t->slug, $t->name ) ) {
				$out[ (string) $t->slug ] = (string) $t->name;
			}
		}
		return $out;
	}

	// ── private ─────────────────────────────────────────────────────────────────

	/** True when the surface entitlement is currently unlocked. */
	private function unlocked(): bool {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		return ! empty( $gate['unlocked'] );
	}

	/**
	 * Resolve a tag reference (numeric id, or slug, or name) to a tag WP_Term, or null
	 * when it isn't a real term in our taxonomy. Guarded for the harness.
	 *
	 * @return object|null
	 */
	private function resolve_term( string $tag ) {
		$tag = trim( $tag );
		if ( '' === $tag ) {
			return null;
		}
		if ( ctype_digit( $tag ) && function_exists( 'get_term' ) ) {
			$term = get_term( (int) $tag, self::TAX_TAG );
			if ( is_object( $term ) && isset( $term->term_id ) && ! self::is_error( $term )
				&& ( ! isset( $term->taxonomy ) || self::TAX_TAG === $term->taxonomy ) ) {
				return $term;
			}
			return null;
		}
		if ( function_exists( 'get_term_by' ) ) {
			foreach ( array( 'slug', 'name' ) as $by ) {
				$term = get_term_by( $by, $tag, self::TAX_TAG );
				if ( is_object( $term ) && isset( $term->term_id ) ) {
					return $term;
				}
			}
		}
		return null;
	}

	/**
	 * The transient cache key: term + the render-affecting args + a taxonomy/posts
	 * last-changed signature, so any tag mutation or attachment add/delete yields a
	 * fresh key (self-invalidation). Lightbox/captions affect the markup, so they are
	 * in the key too.
	 */
	private function cache_key( array $norm, int $term_id ): string {
		$payload = array(
			$term_id,
			(int) $norm['columns'],
			(string) $norm['size'],
			(string) $norm['orderby'],
			(string) $norm['order'],
			(int) $norm['limit'],
			$norm['lightbox'] ? 1 : 0,
			$norm['captions'] ? 1 : 0,
			self::cache_signature(),
		);
		return self::CACHE_PREFIX . md5( serialize( $payload ) );
	}

	/** Terms + posts last-changed marker (WP bumps these on any relevant mutation). */
	private static function cache_signature(): string {
		if ( function_exists( 'wp_get_last_changed' ) ) {
			return (string) wp_get_last_changed( 'terms' ) . ':' . (string) wp_get_last_changed( 'posts' );
		}
		return '0';
	}

	/**
	 * Map shortcode/block attributes to render_gallery args (missing keys fall through
	 * to normalize_args defaults).
	 *
	 * @param array<string,mixed> $atts
	 * @return array<string,mixed>
	 */
	private static function atts_to_args( array $atts ): array {
		$args = array();
		foreach ( array( 'tag', 'columns', 'size', 'orderby', 'order', 'limit', 'lightbox', 'captions' ) as $key ) {
			if ( array_key_exists( $key, $atts ) ) {
				$args[ $key ] = $atts[ $key ];
			}
		}
		return $args;
	}

	/** Clamp $raw into [$min,$max], falling back to $default for non-numeric input. */
	private static function clamp_int( $raw, int $min, int $max, int $default ): int {
		if ( ! is_numeric( $raw ) ) {
			return $default;
		}
		return max( $min, min( $max, (int) $raw ) );
	}

	/** Return $value when it's in $allowed, else $default (or $allowed[0] when null). */
	private static function enum( $value, array $allowed, ?string $default = null ): string {
		if ( is_string( $value ) && in_array( $value, $allowed, true ) ) {
			return $value;
		}
		return null !== $default ? $default : $allowed[0];
	}

	/** Coerce a shortcode/block truthy value to bool (handles '0'/'false'/'no'/'off'). */
	private static function to_bool( $value ): bool {
		if ( is_bool( $value ) ) {
			return $value;
		}
		if ( is_string( $value ) ) {
			return ! in_array( strtolower( trim( $value ) ), array( '', '0', 'false', 'no', 'off' ), true );
		}
		return (bool) $value;
	}

	private static function is_error( $thing ): bool {
		return function_exists( 'is_wp_error' ) && is_wp_error( $thing );
	}

	private static function esc_url( string $value ): string {
		return function_exists( 'esc_url' ) ? (string) esc_url( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_attr( string $value ): string {
		return function_exists( 'esc_attr' ) ? (string) esc_attr( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_html( string $value ): string {
		return function_exists( 'esc_html' ) ? (string) esc_html( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}
