<?php
/**
 * Engine behind the gated "Elementor Blocks" feature (flag `elementor_blocks`,
 * Pro tier). Ships a small set of InfraWeaver-branded Elementor widgets that a
 * site owner can drag into any Elementor page — a Call-to-Action banner, a
 * feature grid, a pricing table, and a notice/badge — grouped under their own
 * "InfraWeaver" widget category. When the flag is locked or Elementor is not
 * installed, the engine registers NOTHING and the site behaves exactly like
 * stock WordPress.
 *
 * ELEMENTOR-OPTIONAL BY CONSTRUCTION. The widget classes subclass
 * `\Elementor\Widget_Base`, so their source file can only be safely PARSED once
 * that parent class exists. This engine therefore never `require`s the widget
 * file at load time — it loads it lazily inside the `elementor/widgets/register`
 * callback, which Elementor only ever fires after it is fully booted. A site
 * without Elementor never reaches that path, so the subclass is never declared
 * and there is no fatal. The engine's own class carries no Elementor reference
 * and loads cleanly under the zero-dependency test harness.
 *
 * TRUST MODEL. Console-authoritative, mirroring IWSL_Lazy_Load /
 * IWSL_Media_Protection: the `elementor_blocks` flag is written ONLY by the
 * dual-signed `entitlements.set` runner (§7). No self-set path, REST route, AJAX
 * endpoint, cron or nopriv surface. The gate is re-checked at every layer — the
 * admin page (LAYER 1), the bootstrap feature switch (LAYER 2), and here as
 * STATEMENT 1 of register() AND of every hook callback (the engine layer). A
 * locked/revoked site never registers a widget or a category, even if the outer
 * layers are ever bypassed. RESIDUAL RISK is the accepted `plus` model, bounded
 * by heartbeat staleness.
 *
 * SAFETY. In-process only — no exec, no network, no persistent footprint (the
 * feature stores no options and touches no postmeta, so its purge() is a cheap
 * no-op, present only for parity with the IWSL_Teardown framework). The
 * widgets escape every rendered value (esc_html / esc_attr / esc_url /
 * wp_kses_post) and read author input via get_settings_for_display(). Every
 * WordPress call here is function_exists-guarded so the class loads and its pure
 * helpers run under the harness with an injected store.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Elementor_Blocks {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'elementor_blocks';

	/** The Elementor widget-category slug the widgets are grouped under. */
	const CATEGORY_SLUG = 'infraweaver';

	/** @var IWSL_Entitlements The gate. */
	private $entitlements;

	/** @var IWSL_Store settings store (unused today; kept for signature parity). */
	private $store;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Store; production injects IWSL_WP_Store.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
	}

	/**
	 * Wire the Elementor category + widget registration hooks. STATEMENT 1 is the
	 * authoritative gate, so a locked/revoked site attaches nothing. Elementor
	 * must actually be present too, or there is nothing to register into — a site
	 * without the page builder pays exactly zero. Guarded so the harness can call
	 * register() harmlessly (add_action is undefined there → early return).
	 */
	public function register(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( ! self::elementor_active() ) {
			return;
		}
		if ( ! function_exists( 'add_action' ) ) {
			return;
		}
		add_action( 'elementor/elements/categories_registered', array( $this, 'register_category' ) );
		add_action( 'elementor/widgets/register', array( $this, 'register_widgets' ) );
	}

	/**
	 * Whether Elementor is loaded in this request. Prefers the definitive
	 * `elementor/loaded` action flag; falls back to the presence of the base
	 * widget class (which is what the widget files actually subclass). Guarded so
	 * it answers `false` cleanly under the harness.
	 */
	public static function elementor_active(): bool {
		if ( function_exists( 'did_action' ) && did_action( 'elementor/loaded' ) ) {
			return true;
		}
		return class_exists( '\\Elementor\\Widget_Base' );
	}

	/**
	 * `elementor/elements/categories_registered` callback: add the "InfraWeaver"
	 * category so the widgets cluster together in the Elementor panel. STATEMENT 1
	 * is the gate; a locked site adds no category.
	 *
	 * @param mixed $elements_manager Elementor\Core\Elements_Manager (duck-typed).
	 */
	public function register_category( $elements_manager = null ): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( ! is_object( $elements_manager ) || ! method_exists( $elements_manager, 'add_category' ) ) {
			return;
		}
		$elements_manager->add_category( self::CATEGORY_SLUG, self::category_args() );
	}

	/**
	 * `elementor/widgets/register` callback: lazily load the widget classes (now
	 * that `\Elementor\Widget_Base` is guaranteed to exist) and register each with
	 * the widgets manager. Supports the modern `register()` API and the legacy
	 * `register_widget_type()` alias. STATEMENT 1 is the gate; a locked site
	 * registers nothing.
	 *
	 * @param mixed $widgets_manager Elementor\Widgets_Manager (duck-typed).
	 */
	public function register_widgets( $widgets_manager = null ): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		// The parent class our widgets subclass MUST be present before the widget
		// file is parsed, or declaring the subclass would fatal. If it isn't, do
		// nothing — this is the belt-and-braces guard for the no-Elementor case.
		if ( ! class_exists( '\\Elementor\\Widget_Base' ) ) {
			return;
		}
		self::load_widget_classes();

		foreach ( self::widget_classes() as $class ) {
			if ( ! class_exists( $class ) ) {
				continue;
			}
			$widget = new $class();
			if ( ! is_object( $widgets_manager ) ) {
				continue;
			}
			if ( method_exists( $widgets_manager, 'register' ) ) {
				$widgets_manager->register( $widget );
			} elseif ( method_exists( $widgets_manager, 'register_widget_type' ) ) {
				$widgets_manager->register_widget_type( $widget );
			}
		}
	}

	/**
	 * Pure: the fully-qualified widget class names this engine registers, in panel
	 * order. Public so a test can assert the set without loading Elementor.
	 *
	 * @return string[]
	 */
	public static function widget_classes(): array {
		return array(
			'IWSL_Widget_Callout',
			'IWSL_Widget_Feature_Grid',
			'IWSL_Widget_Pricing_Table',
			'IWSL_Widget_Notice',
		);
	}

	/**
	 * Pure: the Elementor category definition (title + icon). Escaped title so it
	 * is safe wherever Elementor prints it.
	 *
	 * @return array{ title:string, icon:string }
	 */
	public static function category_args(): array {
		return array(
			'title' => function_exists( 'esc_html__' )
				? esc_html__( 'InfraWeaver', 'infraweaver-connector' )
				: 'InfraWeaver',
			'icon'  => 'eicon-flash',
		);
	}

	/** Lazily require the widget class file — only ever called with Elementor present. */
	private static function load_widget_classes(): void {
		require_once __DIR__ . '/elementor/class-iwsl-elementor-widgets.php';
	}

	/**
	 * Teardown-framework parity: this feature persists nothing (no option, no
	 * postmeta, no cron, no disk artifact) — its widgets simply stop registering
	 * when the flag is revoked or the switch is flipped off. So purge() is an
	 * honest, idempotent no-op. Present only so IWSL_Teardown::engine_for() resolves
	 * this flag like every other switchable engine.
	 *
	 * @return array{ ok:bool, deleted:bool }
	 */
	public function purge(): array {
		return array( 'ok' => true, 'deleted' => false );
	}

	// ── admin UI (LAYER 1 gate) ────────────────────────────────────────────────

	/**
	 * Render the admin section: a locked notice listing the gate reasons when the
	 * feature is locked, otherwise a plain-English description, whether Elementor
	 * is installed, and the list of blocks this feature adds. There is no settings
	 * form — the widgets are configured per-instance inside Elementor itself. All
	 * WordPress output helpers are function_exists-guarded so the class stays
	 * loadable under the no-WP harness.
	 */
	public function render_section(): void {
		if ( ! function_exists( 'esc_html' ) ) {
			return;
		}

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		echo '<p class="description" style="max-width:640px;">'
			. esc_html__( 'Adds a set of ready-made InfraWeaver blocks to the Elementor page builder. Open any page in Elementor, look under the “InfraWeaver” category in the widgets panel, and drag a block onto your page — nothing else on your site changes.', 'infraweaver-connector' )
			. '</p>';

		if ( ! self::elementor_active() ) {
			echo '<div class="notice notice-warning inline" style="margin-top:12px;padding:12px;max-width:640px;"><p>'
				. esc_html__( 'Elementor is not active on this site yet. Install and activate the free Elementor page builder, then edit a page with Elementor to find these blocks under the “InfraWeaver” category.', 'infraweaver-connector' )
				. '</p></div>';
		} else {
			echo '<div class="notice notice-success inline" style="margin-top:12px;padding:12px;max-width:640px;"><p>'
				. esc_html__( 'Elementor is active — the InfraWeaver blocks are ready. Edit any page with Elementor and look for the “InfraWeaver” category in the widgets panel.', 'infraweaver-connector' )
				. '</p></div>';
		}

		$blocks = array(
			__( 'Call-to-Action Banner — a headline, supporting text and a button, with colour and alignment controls.', 'infraweaver-connector' ),
			__( 'Feature Grid — a responsive grid of icon + title + text cards for listing what you offer.', 'infraweaver-connector' ),
			__( 'Pricing Table — a plan name, price, feature list and call-to-action button, with an optional “featured” highlight.', 'infraweaver-connector' ),
			__( 'Notice / Badge — a small info, success, warning or error callout to draw the eye.', 'infraweaver-connector' ),
		);
		echo '<p class="description" style="margin-top:12px;"><strong>' . esc_html__( 'Blocks in this pack:', 'infraweaver-connector' ) . '</strong></p>';
		echo '<ul style="list-style:disc;margin-left:20px;max-width:640px;">';
		foreach ( $blocks as $block ) {
			echo '<li>' . esc_html( $block ) . '</li>';
		}
		echo '</ul>';
	}

	/** The locked-state notice, listing each gate reason in friendly language. */
	private function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => __( 'This site is not linked to the console.', 'infraweaver-connector' ),
			'heartbeat-stale' => __( 'The console has not verified this site recently.', 'infraweaver-connector' ),
			'requires-plus'   => __( 'Elementor Blocks requires a Pro plan.', 'infraweaver-connector' ),
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>'
			. esc_html__( '🔒 Elementor Blocks is locked.', 'infraweaver-connector' )
			. '</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) ( $gate['reasons'] ?? array() ) as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}
}
