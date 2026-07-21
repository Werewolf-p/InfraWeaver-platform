<?php
/**
 * The plugin's wp-admin surface: a single Tools → "InfraWeaver Plus" page that
 * is the MANUAL TEST SURFACE for the client-side feature gates. It reads only
 * local plugin state (IWSL_Entitlements::evaluate) — never a network call — and
 * hosts two gated sections:
 *
 *   1. Plus — Site Content & Health Snapshot (gate flag `plus`), read-only.
 *   2. Lossless Image Optimization (gate flag `image_optimization`), which runs
 *      a bounded, purely-local batch of PNG→WebP-lossless conversions via
 *      IWSL_Media_Optimizer. Originals are never modified.
 *
 * The image-optimization action is gated at THREE layers, innermost
 * authoritative: this page (UX), the admin-post handler (before doing work), and
 * IWSL_Media_Optimizer::run() itself (survives any future caller). The action is
 * POST → admin-post.php → redirect back (PRG); NO attachment ids ever cross the
 * request boundary — the only inputs are the nonce and an allow-listed converter
 * id validated against the registry.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Admin {

	/** admin-post action name for the image-optimization run. */
	const OPTIMIZE_ACTION = 'iwsl_media_optimize';
	/** Nonce action guarding the run form. */
	const OPTIMIZE_NONCE = 'iwsl_media_optimize';

	/** admin-post action + nonce for the SMTP settings save. */
	const EMAIL_SETTINGS_ACTION = 'iwsl_email_settings';
	const EMAIL_SETTINGS_NONCE  = 'iwsl_email_settings';
	/** admin-post action + nonce for the email-log clear. */
	const EMAIL_LOG_CLEAR_ACTION = 'iwsl_email_log_clear';
	const EMAIL_LOG_CLEAR_NONCE  = 'iwsl_email_log_clear';

	const EMAIL_TEST_ACTION = 'iwsl_email_test';
	const EMAIL_TEST_NONCE  = 'iwsl_email_test';

	/** admin-post actions + nonces for the 301 Redirect Manager. */
	const REDIRECT_ADD_ACTION    = 'iwsl_redirects_add';
	const REDIRECT_ADD_NONCE     = 'iwsl_redirects_add';
	const REDIRECT_DELETE_ACTION = 'iwsl_redirects_delete';
	const REDIRECT_DELETE_NONCE  = 'iwsl_redirects_delete';
	const REDIRECT_LOG_ACTION    = 'iwsl_redirects_log';
	const REDIRECT_LOG_NONCE     = 'iwsl_redirects_log';

	/** admin-post action + nonce for the white-label settings save. */
	const WHITE_LABEL_ACTION = 'iwsl_white_label_save';
	const WHITE_LABEL_NONCE  = 'iwsl_white_label_save';

	/** admin-post action + nonce for the database cleanup/optimize run (preview + clean). */
	const DB_OPTIMIZE_ACTION = 'iwsl_db_optimize';
	const DB_OPTIMIZE_NONCE  = 'iwsl_db_optimize';

	/** admin-post actions + nonces for the Page Cache enable/disable toggle + purge. */
	const PAGE_CACHE_TOGGLE_ACTION = 'iwsl_page_cache_toggle';
	const PAGE_CACHE_TOGGLE_NONCE  = 'iwsl_page_cache_toggle';
	const PAGE_CACHE_PURGE_ACTION  = 'iwsl_page_cache_purge';
	const PAGE_CACHE_PURGE_NONCE   = 'iwsl_page_cache_purge';

	/** @var IWSL_Plugin */
	private $plugin;

	/** @var IWSL_Media_Optimizer|null lazily built from the plugin's entitlements. */
	private $optimizer;

	/** @var IWSL_Email_Delivery|null lazily built from the plugin's entitlements + store. */
	private $email_delivery;

	/** @var IWSL_Redirects|null lazily built from the plugin's entitlements + store. */
	private $redirects;

	/** @var IWSL_White_Label|null lazily built from the plugin's entitlements + store. */
	private $white_label;

	/** @var IWSL_DB_Optimizer|null lazily built from the plugin's entitlements + global $wpdb. */
	private $db_optimizer;

	/** @var IWSL_Page_Cache|null lazily built from the plugin's entitlements. */
	private $page_cache;

	public function __construct( IWSL_Plugin $plugin, ?IWSL_Media_Optimizer $optimizer = null, ?IWSL_Email_Delivery $email_delivery = null, ?IWSL_Redirects $redirects = null, ?IWSL_White_Label $white_label = null, ?IWSL_DB_Optimizer $db_optimizer = null, ?IWSL_Page_Cache $page_cache = null ) {
		$this->plugin         = $plugin;
		$this->optimizer      = $optimizer;
		$this->email_delivery = $email_delivery;
		$this->redirects      = $redirects;
		$this->white_label    = $white_label;
		$this->db_optimizer   = $db_optimizer;
		$this->page_cache     = $page_cache;
	}

	/** Hook the admin menu + the image-optimization + email-delivery + redirect + db-optimize admin-post handlers. */
	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
		add_action( 'admin_post_' . self::OPTIMIZE_ACTION, array( $this, 'handle_media_optimize' ) );
		add_action( 'admin_post_' . self::EMAIL_SETTINGS_ACTION, array( $this, 'handle_email_settings_save' ) );
		add_action( 'admin_post_' . self::EMAIL_LOG_CLEAR_ACTION, array( $this, 'handle_email_log_clear' ) );
		add_action( 'admin_post_' . self::EMAIL_TEST_ACTION, array( $this, 'handle_email_test' ) );
		add_action( 'admin_post_' . self::REDIRECT_ADD_ACTION, array( $this, 'handle_redirects_add' ) );
		add_action( 'admin_post_' . self::REDIRECT_DELETE_ACTION, array( $this, 'handle_redirects_delete' ) );
		add_action( 'admin_post_' . self::REDIRECT_LOG_ACTION, array( $this, 'handle_redirects_log' ) );
		add_action( 'admin_post_' . self::WHITE_LABEL_ACTION, array( $this, 'handle_white_label_save' ) );
		add_action( 'admin_post_' . self::DB_OPTIMIZE_ACTION, array( $this, 'handle_db_optimize' ) );
		add_action( 'admin_post_' . self::PAGE_CACHE_TOGGLE_ACTION, array( $this, 'handle_page_cache_toggle' ) );
		add_action( 'admin_post_' . self::PAGE_CACHE_PURGE_ACTION, array( $this, 'handle_page_cache_purge' ) );
	}

	public function add_menu(): void {
		// Top-level sidebar entry so operators can find the Plus features
		// (image optimization, DB cleanup, email, redirects, white-label,
		// page cache) directly, rather than buried under Tools.
		add_menu_page(
			'InfraWeaver Plus',
			'InfraWeaver Plus',
			'manage_options',
			'infraweaver-plus',
			array( $this, 'render_page' ),
			'dashicons-shield',
			81
		);
	}

	/** The optimizer, built once from the plugin's entitlement gate. */
	private function optimizer(): IWSL_Media_Optimizer {
		if ( null === $this->optimizer ) {
			$this->optimizer = new IWSL_Media_Optimizer( $this->plugin->entitlements() );
		}
		return $this->optimizer;
	}

	/** The email-delivery engine, built once from the plugin's entitlement gate + store. */
	private function email_delivery(): IWSL_Email_Delivery {
		if ( null === $this->email_delivery ) {
			$this->email_delivery = new IWSL_Email_Delivery( $this->plugin->entitlements(), $this->plugin->store() );
		}
		return $this->email_delivery;
	}

	/** The redirect manager, built once from the plugin's entitlement gate + store. */
	private function redirects(): IWSL_Redirects {
		if ( null === $this->redirects ) {
			$this->redirects = new IWSL_Redirects( $this->plugin->entitlements(), new IWSL_WP_Store() );
		}
		return $this->redirects;
	}

	/** The white-label engine, built once from the plugin's entitlement gate + store. */
	private function white_label(): IWSL_White_Label {
		if ( null === $this->white_label ) {
			$this->white_label = new IWSL_White_Label( $this->plugin->entitlements(), new IWSL_WP_Store() );
		}
		return $this->white_label;
	}

	/** The database optimizer, built once from the plugin's entitlement gate + global $wpdb. */
	private function db_optimizer(): IWSL_DB_Optimizer {
		if ( null === $this->db_optimizer ) {
			$this->db_optimizer = new IWSL_DB_Optimizer( $this->plugin->entitlements() );
		}
		return $this->db_optimizer;
	}

	/** The page-cache controller, built once from the plugin's entitlement gate. */
	private function page_cache(): IWSL_Page_Cache {
		if ( null === $this->page_cache ) {
			$this->page_cache = new IWSL_Page_Cache( $this->plugin->entitlements() );
		}
		return $this->page_cache;
	}

	public function render_page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'infraweaver-connector' ) );
		}
		$gate = $this->plugin->entitlements()->evaluate( 'plus' );

		// Per-feature unlock state drives the live status dot on each tab.
		$feature_map = array(
			'images'     => IWSL_Media_Optimizer::FEATURE,
			'database'   => IWSL_DB_Optimizer::FEATURE,
			'email'      => IWSL_Email_Delivery::FEATURE,
			'redirects'  => IWSL_Redirects::FEATURE,
			'whitelabel' => IWSL_White_Label::FEATURE,
			'cache'      => IWSL_Page_Cache::FEATURE,
		);
		$unlocked = array();
		foreach ( $feature_map as $key => $feature ) {
			$fg              = $this->plugin->entitlements()->evaluate( $feature );
			$unlocked[ $key ] = ! empty( $fg['unlocked'] );
		}

		echo '<div class="wrap iwsl-shell">';
		self::render_shell_styles();
		$this->render_hero( $gate );
		self::render_tab_nav( $gate, $unlocked );

		echo '<div class="iwsl-panels">';

		// ── Overview ──────────────────────────────────────────────────────────
		echo '<section class="iwsl-tabpanel is-active" id="iwsl-tab-overview" role="tabpanel" aria-labelledby="iwsl-tabbtn-overview" tabindex="0">';
		echo '<h2>' . esc_html__( 'Connection & entitlements', 'infraweaver-connector' ) . '</h2>';
		echo '<p class="iwsl-lede">' . wp_kses(
			__( 'Every Plus feature is gated locally. It runs only when this site is <strong>linked</strong>, shows a <strong>fresh signed heartbeat</strong>, and has the matching entitlement granted from the console — no standing WordPress&rarr;InfraWeaver path.', 'infraweaver-connector' ),
			array( 'strong' => array() )
		) . '</p>';
		self::render_gate_table( $gate );
		if ( ! empty( $gate['unlocked'] ) ) {
			IWSL_Plus_Feature::render();
		} else {
			self::render_locked_notice( $gate );
		}
		echo '</section>';

		// ── Feature panels (each existing renderer, wrapped as a tab panel) ───
		echo '<section class="iwsl-tabpanel" id="iwsl-tab-images" role="tabpanel" aria-labelledby="iwsl-tabbtn-images" tabindex="0" hidden>';
		$this->render_image_optimization_section();
		echo '</section>';

		echo '<section class="iwsl-tabpanel" id="iwsl-tab-database" role="tabpanel" aria-labelledby="iwsl-tabbtn-database" tabindex="0" hidden>';
		$this->render_db_optimizer_section();
		echo '</section>';

		echo '<section class="iwsl-tabpanel" id="iwsl-tab-email" role="tabpanel" aria-labelledby="iwsl-tabbtn-email" tabindex="0" hidden>';
		$this->render_email_delivery_section();
		echo '</section>';

		echo '<section class="iwsl-tabpanel" id="iwsl-tab-redirects" role="tabpanel" aria-labelledby="iwsl-tabbtn-redirects" tabindex="0" hidden>';
		$this->render_redirects_section();
		echo '</section>';

		echo '<section class="iwsl-tabpanel" id="iwsl-tab-whitelabel" role="tabpanel" aria-labelledby="iwsl-tabbtn-whitelabel" tabindex="0" hidden>';
		$this->render_white_label_section();
		echo '</section>';

		echo '<section class="iwsl-tabpanel" id="iwsl-tab-cache" role="tabpanel" aria-labelledby="iwsl-tabbtn-cache" tabindex="0" hidden>';
		$this->render_page_cache_section();
		echo '</section>';

		echo '<section class="iwsl-tabpanel" id="iwsl-tab-roadmap" role="tabpanel" aria-labelledby="iwsl-tabbtn-roadmap" tabindex="0" hidden>';
		echo '<h2>' . esc_html__( 'Roadmap', 'infraweaver-connector' ) . '</h2>';
		echo '<p class="iwsl-lede">' . esc_html__( 'Features on the way. Nothing here is active yet — these are inert previews of what Pro and Ultimate will add.', 'infraweaver-connector' ) . '</p>';
		self::render_coming_soon();
		echo '</section>';

		echo '</div>'; // .iwsl-panels

		self::render_shell_script();
		echo '</div>'; // .wrap.iwsl-shell
	}

	/** The seven tabs, in display order. Shared by the nav and the status dots. */
	private static function tab_defs(): array {
		return array(
			array( 'id' => 'overview', 'label' => 'Overview', 'icon' => 'shield' ),
			array( 'id' => 'images', 'label' => 'Images', 'icon' => 'format-image' ),
			array( 'id' => 'database', 'label' => 'Database', 'icon' => 'database' ),
			array( 'id' => 'email', 'label' => 'Email', 'icon' => 'email-alt' ),
			array( 'id' => 'redirects', 'label' => 'Redirects', 'icon' => 'randomize' ),
			array( 'id' => 'whitelabel', 'label' => 'White-Label', 'icon' => 'art' ),
			array( 'id' => 'cache', 'label' => 'Cache', 'icon' => 'performance' ),
			array( 'id' => 'roadmap', 'label' => 'Roadmap', 'icon' => 'flag' ),
		);
	}

	/** The branded header: identity, connector version, and three live posture chips. */
	private function render_hero( array $gate ): void {
		$chips = array(
			array( 'label' => 'Linked', 'ok' => ! empty( $gate['linked'] ) ),
			array( 'label' => 'Heartbeat', 'ok' => ! empty( $gate['heartbeat_fresh'] ) ),
			array( 'label' => 'Plus', 'ok' => ! empty( $gate['plus'] ) ),
		);
		$version = defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : '';

		echo '<header class="iwsl-hero">';
		echo '<div class="iwsl-hero__glow" aria-hidden="true"></div>';
		echo '<div class="iwsl-hero__lead">';
		echo '<span class="iwsl-hero__mark" aria-hidden="true"><span class="dashicons dashicons-shield"></span></span>';
		echo '<div>';
		echo '<h1 class="iwsl-hero__title">InfraWeaver <span>Plus</span></h1>';
		echo '<p class="iwsl-hero__sub">' . esc_html__( 'Signed, console-granted power features for this site.', 'infraweaver-connector' );
		if ( '' !== $version ) {
			echo ' <span class="iwsl-hero__ver">Connector v' . esc_html( $version ) . '</span>';
		}
		echo '</p>';
		echo '</div>';
		echo '</div>';

		echo '<div class="iwsl-hero__posture" role="group" aria-label="' . esc_attr__( 'Link posture', 'infraweaver-connector' ) . '">';
		foreach ( $chips as $chip ) {
			$cls = $chip['ok'] ? 'is-ok' : 'is-off';
			echo '<span class="iwsl-chip ' . esc_attr( $cls ) . '">';
			echo '<span class="iwsl-chip__dot" aria-hidden="true"></span>';
			echo esc_html( $chip['label'] );
			echo '<span class="screen-reader-text">: ' . ( $chip['ok'] ? esc_html__( 'active', 'infraweaver-connector' ) : esc_html__( 'inactive', 'infraweaver-connector' ) ) . '</span>';
			echo '</span>';
		}
		echo '</div>';
		echo '</header>';
	}

	/** The horizontal tab rail. Each feature tab carries a live locked/active dot. */
	private static function render_tab_nav( array $gate, array $unlocked ): void {
		echo '<nav class="iwsl-tabnav" role="tablist" aria-label="' . esc_attr__( 'InfraWeaver Plus sections', 'infraweaver-connector' ) . '">';
		foreach ( self::tab_defs() as $i => $tab ) {
			$id       = $tab['id'];
			$is_first = 0 === $i;
			$state    = ( 'overview' === $id || ! array_key_exists( $id, $unlocked ) ) ? 'core' : ( ! empty( $unlocked[ $id ] ) ? 'on' : 'off' );
			echo '<button type="button" class="iwsl-tab' . ( $is_first ? ' is-active' : '' ) . '"'
				. ' id="iwsl-tabbtn-' . esc_attr( $id ) . '"'
				. ' role="tab" aria-controls="iwsl-tab-' . esc_attr( $id ) . '"'
				. ' aria-selected="' . ( $is_first ? 'true' : 'false' ) . '"'
				. ' tabindex="' . ( $is_first ? '0' : '-1' ) . '"'
				. ' data-tab="' . esc_attr( $id ) . '">';
			echo '<span class="dashicons dashicons-' . esc_attr( $tab['icon'] ) . '" aria-hidden="true"></span>';
			echo '<span class="iwsl-tab__label">' . esc_html( $tab['label'] ) . '</span>';
			if ( 'core' !== $state ) {
				echo '<span class="iwsl-tab__status iwsl-tab__status--' . esc_attr( $state ) . '" aria-hidden="true"></span>';
			}
			echo '</button>';
		}
		echo '</nav>';
	}

	/**
	 * The scoped design system for the whole page. Everything is namespaced
	 * under `.iwsl-shell` so it restyles the sections' native markup
	 * (.widefat, .form-table, .button*, .notice*, inputs) without leaking into
	 * the rest of wp-admin. Ships inline — no external asset, no CDN, no build.
	 */
	private static function render_shell_styles(): void {
		echo "<style id='iwsl-plus-css'>\n";
		echo <<<'CSS'
#wpcontent .iwsl-shell{
	--iw-bg: oklch(0.205 0.021 264);
	--iw-panel: oklch(0.248 0.023 264);
	--iw-panel-2: oklch(0.288 0.025 264);
	--iw-field: oklch(0.262 0.021 264);
	--iw-line: color-mix(in oklch, white 11%, transparent);
	--iw-line-2: color-mix(in oklch, white 20%, transparent);
	--iw-ink: oklch(0.965 0.004 264);
	--iw-muted: oklch(0.79 0.014 264);
	--iw-faint: oklch(0.66 0.015 264);
	--iw-signal: oklch(0.83 0.128 196);
	--iw-signal-2: oklch(0.9 0.09 196);
	--iw-signal-ink: oklch(0.24 0.03 220);
	--iw-violet: oklch(0.72 0.15 300);
	--iw-warn: oklch(0.84 0.13 85);
	--iw-bad: oklch(0.74 0.16 25);
	--iw-good: oklch(0.82 0.15 156);
	--iw-r: 16px;
	--iw-r-sm: 10px;
	--iw-ease: cubic-bezier(0.22, 1, 0.36, 1);
	--iw-z-rail: 20;
	margin: 0;
	max-width: none;
	width: 100%;
	min-height: calc(100vh - 32px);
	display: flex;
	flex-direction: column;
	color: var(--iw-ink);
	background: var(--iw-bg);
	border: 0;
	border-radius: 0;
	overflow: clip;
	box-shadow: none;
	color-scheme: dark;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", sans-serif;
	-webkit-font-smoothing: antialiased;
}
/* Full-bleed: eat the wp-admin content padding + drop the footer + the sample
   "Hello Dolly" lyric so the dark surface reaches every edge. Every rule here is
   safe globally because this whole sheet is printed ONLY on the Plus admin page. */
#wpcontent{ padding-left: 0 !important; }
#wpbody-content{ padding-bottom: 0 !important; }
#wpfooter{ display: none !important; }
#dolly{ display: none !important; }

#wpcontent .iwsl-shell *,
#wpcontent .iwsl-shell *::before,
#wpcontent .iwsl-shell *::after{ box-sizing: border-box; }
.iwsl-shell a{ color: var(--iw-signal-2); }
.iwsl-shell strong{ color: var(--iw-ink); font-weight: 650; }

/* ── Hero ─────────────────────────────────────────────────────────────── */
.iwsl-hero{
	position: relative;
	display: flex; flex-wrap: wrap; gap: 20px;
	align-items: center; justify-content: space-between;
	padding: 30px 32px;
	background:
		radial-gradient(120% 140% at 12% -10%, color-mix(in oklch, var(--iw-violet) 26%, transparent), transparent 55%),
		radial-gradient(120% 160% at 108% 130%, color-mix(in oklch, var(--iw-signal) 20%, transparent), transparent 52%),
		var(--iw-panel);
	border-bottom: 1px solid var(--iw-line);
	overflow: clip;
}
.iwsl-hero__glow{
	position: absolute; inset: auto -10% -60% 40%; height: 200px;
	background: radial-gradient(closest-side, color-mix(in oklch, var(--iw-signal) 34%, transparent), transparent);
	filter: blur(30px); opacity: 0.7; pointer-events: none;
}
.iwsl-hero__lead{ display: flex; align-items: center; gap: 18px; position: relative; z-index: 1; }
.iwsl-hero__mark{
	display: grid; place-items: center; width: 52px; height: 52px; flex: none;
	border-radius: 14px; color: var(--iw-signal-ink);
	background: linear-gradient(155deg, var(--iw-signal-2), var(--iw-signal));
	box-shadow: 0 8px 22px -8px color-mix(in oklch, var(--iw-signal) 70%, transparent), 0 0 0 1px color-mix(in oklch, white 22%, transparent) inset;
}
.iwsl-hero__mark .dashicons{ font-size: 30px; width: 30px; height: 30px; }
.iwsl-hero__title{
	margin: 0; padding: 0; font-size: clamp(1.6rem, 1.1rem + 1.4vw, 2.1rem);
	font-weight: 750; letter-spacing: -0.02em; line-height: 1.05; color: var(--iw-ink);
}
.iwsl-hero__title span{ color: var(--iw-signal-2); font-weight: 750; }
.iwsl-hero__sub{ margin: 6px 0 0; color: var(--iw-muted); font-size: 13.5px; }
.iwsl-hero__ver{
	display: inline-block; margin-left: 4px; padding: 2px 8px; border-radius: 999px;
	font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em; color: var(--iw-signal-2);
	background: color-mix(in oklch, var(--iw-signal) 15%, transparent);
	border: 1px solid color-mix(in oklch, var(--iw-signal) 30%, transparent);
}
.iwsl-hero__posture{ position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; }
.iwsl-chip{
	display: inline-flex; align-items: center; gap: 8px;
	padding: 7px 13px 7px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
	border: 1px solid var(--iw-line-2); background: color-mix(in oklch, black 14%, transparent);
	color: var(--iw-muted);
}
.iwsl-chip__dot{ width: 8px; height: 8px; border-radius: 50%; background: var(--iw-faint); flex: none; }
.iwsl-chip.is-ok{ color: var(--iw-ink); border-color: color-mix(in oklch, var(--iw-good) 40%, transparent); }
.iwsl-chip.is-ok .iwsl-chip__dot{
	background: var(--iw-good);
	box-shadow: 0 0 0 4px color-mix(in oklch, var(--iw-good) 22%, transparent);
	animation: iwsl-pulse 2.4s var(--iw-ease) infinite;
}
.iwsl-chip.is-off{ opacity: 0.72; }
.iwsl-chip.is-off .iwsl-chip__dot{ background: var(--iw-bad); }

/* ── Tab rail ─────────────────────────────────────────────────────────── */
.iwsl-tabnav{
	position: sticky; top: 32px; z-index: var(--iw-z-rail);
	display: flex; gap: 4px; padding: 8px; overflow-x: auto; scrollbar-width: none;
	background: color-mix(in oklch, var(--iw-bg) 82%, transparent);
	backdrop-filter: blur(10px);
	border-bottom: 1px solid var(--iw-line);
}
.iwsl-tabnav::-webkit-scrollbar{ display: none; }
.iwsl-tab{
	position: relative; display: inline-flex; align-items: center; gap: 8px; flex: none;
	padding: 10px 15px; border: 0; border-radius: var(--iw-r-sm); cursor: pointer;
	background: transparent; color: var(--iw-muted); font-size: 13.5px; font-weight: 600;
	font-family: inherit; white-space: nowrap;
	transition: color .18s var(--iw-ease), background .18s var(--iw-ease);
}
.iwsl-tab .dashicons{ font-size: 18px; width: 18px; height: 18px; opacity: 0.85; }
.iwsl-tab:hover{ color: var(--iw-ink); background: color-mix(in oklch, white 5%, transparent); }
.iwsl-tab.is-active{ color: var(--iw-ink); background: var(--iw-panel-2); box-shadow: 0 1px 0 var(--iw-line-2) inset; }
.iwsl-tab.is-active::after{
	content: ""; position: absolute; left: 14px; right: 14px; bottom: -8px; height: 2px;
	border-radius: 2px; background: var(--iw-signal);
	box-shadow: 0 0 10px color-mix(in oklch, var(--iw-signal) 70%, transparent);
}
.iwsl-tab:focus-visible{ outline: 2px solid var(--iw-signal); outline-offset: 2px; }
.iwsl-tab__status{ width: 7px; height: 7px; border-radius: 50%; margin-left: 1px; }
.iwsl-tab__status--on{ background: var(--iw-good); box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-good) 20%, transparent); }
.iwsl-tab__status--off{ background: color-mix(in oklch, var(--iw-bad) 75%, var(--iw-faint)); }

/* ── Panels ───────────────────────────────────────────────────────────── */
.iwsl-panels{ padding: 26px 32px 34px; flex: 1 1 auto; }
.iwsl-tabpanel[hidden]{ display: none; }
.iwsl-tabpanel:focus{ outline: none; }
.iwsl-tabpanel > h2:first-child,
.iwsl-tabpanel > .iwsl-lede + h2{ margin-top: 0; }
.iwsl-lede{ max-width: 68ch; color: var(--iw-muted); font-size: 14px; line-height: 1.6; margin: 0 0 20px; }

/* Section chrome emitted by the renderers */
.iwsl-shell h2{ font-size: 19px; font-weight: 700; letter-spacing: -0.01em; color: var(--iw-ink); margin: 4px 0 14px; }
.iwsl-shell h3{ font-size: 14px; font-weight: 650; color: var(--iw-ink); margin: 26px 0 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.iwsl-shell h3::before{ content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 9px; border-radius: 2px; background: var(--iw-signal); transform: translateY(-1px); }
.iwsl-shell p{ color: var(--iw-muted); font-size: 13.5px; line-height: 1.6; }
.iwsl-shell hr{ display: none; }
.iwsl-shell .screen-reader-text{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

/* Tables — data (.widefat) */
.iwsl-shell table.widefat{
	background: var(--iw-panel); border: 1px solid var(--iw-line); border-radius: var(--iw-r);
	border-collapse: separate; border-spacing: 0; overflow: clip; box-shadow: none; margin-top: 14px;
}
.iwsl-shell table.widefat thead th{
	background: color-mix(in oklch, var(--iw-panel-2) 70%, transparent); color: var(--iw-faint);
	font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
	padding: 11px 16px; border: 0; border-bottom: 1px solid var(--iw-line-2);
}
.iwsl-shell table.widefat td,
.iwsl-shell table.widefat tbody th{
	padding: 12px 16px; border: 0; border-top: 1px solid var(--iw-line);
	color: var(--iw-ink); font-size: 13.5px; background: transparent;
}
.iwsl-shell table.widefat tbody th{ color: var(--iw-muted); font-weight: 600; }
.iwsl-shell table.widefat.striped > tbody > :nth-child(odd){ background: color-mix(in oklch, white 2.5%, transparent); }
.iwsl-shell table.widefat tbody tr:hover td,
.iwsl-shell table.widefat tbody tr:hover th{ background: color-mix(in oklch, var(--iw-signal) 7%, transparent); }
.iwsl-shell td span[style*="1a7f37"]{ color: var(--iw-good) !important; font-weight: 650 !important; }
.iwsl-shell td span[style*="b3261e"]{ color: var(--iw-bad) !important; font-weight: 650 !important; }

/* Tables — forms (.form-table) */
.iwsl-shell table.form-table{ margin-top: 8px; max-width: 640px; }
.iwsl-shell .form-table th{ color: var(--iw-muted); font-weight: 600; font-size: 13px; padding: 14px 16px 14px 0; width: 190px; vertical-align: top; }
.iwsl-shell .form-table td{ padding: 10px 0; }
.iwsl-shell .form-table td p.description,
.iwsl-shell .form-table td .description{ color: var(--iw-faint); font-size: 12.5px; }

/* Inputs */
.iwsl-shell input[type="text"],
.iwsl-shell input[type="number"],
.iwsl-shell input[type="password"],
.iwsl-shell input[type="url"],
.iwsl-shell input[type="email"],
.iwsl-shell select,
.iwsl-shell textarea{
	background: var(--iw-field); color: var(--iw-ink);
	border: 1px solid var(--iw-line-2); border-radius: var(--iw-r-sm);
	padding: 9px 12px; font-size: 13.5px; line-height: 1.4; min-height: 40px; box-shadow: none;
	transition: border-color .15s var(--iw-ease), box-shadow .15s var(--iw-ease);
}
.iwsl-shell textarea{ min-height: 72px; }
.iwsl-shell select{ padding-right: 30px; color-scheme: dark; }
.iwsl-shell select option,
.iwsl-shell select optgroup{ background: var(--iw-panel-2); color: var(--iw-ink); }
.iwsl-shell input::placeholder,
.iwsl-shell textarea::placeholder{ color: var(--iw-faint); }
.iwsl-shell input:focus,
.iwsl-shell select:focus,
.iwsl-shell textarea:focus{
	border-color: var(--iw-signal); outline: none;
	box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-signal) 26%, transparent);
}
.iwsl-shell label{ color: var(--iw-muted); font-size: 13px; }

/* Buttons */
.iwsl-shell .button,
.iwsl-shell .button-primary,
.iwsl-shell .button-secondary{
	display: inline-flex; align-items: center; gap: 7px; height: auto; min-height: 40px;
	padding: 9px 17px; border-radius: var(--iw-r-sm); font-size: 13.5px; font-weight: 600;
	line-height: 1.2; border: 1px solid var(--iw-line-2); background: var(--iw-panel-2);
	color: var(--iw-ink); text-shadow: none; box-shadow: none; cursor: pointer;
	transition: transform .12s var(--iw-ease), background .16s var(--iw-ease), border-color .16s var(--iw-ease), box-shadow .16s var(--iw-ease);
}
.iwsl-shell .button:hover{ background: color-mix(in oklch, white 9%, var(--iw-panel-2)); border-color: var(--iw-line-2); color: var(--iw-ink); transform: translateY(-1px); }
.iwsl-shell .button-primary{
	background: linear-gradient(155deg, var(--iw-signal-2), var(--iw-signal));
	color: var(--iw-signal-ink); border-color: transparent;
	box-shadow: 0 8px 20px -10px color-mix(in oklch, var(--iw-signal) 80%, transparent);
}
.iwsl-shell .button-primary:hover{ color: var(--iw-signal-ink); transform: translateY(-1px); box-shadow: 0 12px 26px -10px color-mix(in oklch, var(--iw-signal) 90%, transparent); filter: brightness(1.04); }
.iwsl-shell .button:active,
.iwsl-shell .button-primary:active{ transform: translateY(0); }
.iwsl-shell .button:focus-visible,
.iwsl-shell .button-primary:focus-visible{ outline: 2px solid var(--iw-signal); outline-offset: 2px; box-shadow: none; }
.iwsl-shell .button-link-delete{
	background: transparent; border-color: transparent; color: var(--iw-bad); min-height: 0; padding: 4px 8px; box-shadow: none;
}
.iwsl-shell .button-link-delete:hover{ background: color-mix(in oklch, var(--iw-bad) 16%, transparent); color: var(--iw-bad); transform: none; }
.iwsl-shell .button.is-busy{ pointer-events: none; opacity: 0.75; }
.iwsl-shell .button.is-busy::after{
	content: ""; width: 14px; height: 14px; border-radius: 50%; margin-left: 2px;
	border: 2px solid color-mix(in oklch, currentColor 35%, transparent); border-top-color: currentColor;
	animation: iwsl-spin .7s linear infinite;
}

/* Notices */
.iwsl-shell .notice{
	border: 1px solid var(--iw-line-2); border-left-width: 1px; border-radius: var(--iw-r-sm);
	background: var(--iw-panel); color: var(--iw-ink); box-shadow: none;
}
.iwsl-shell .notice p{ color: var(--iw-ink); }
.iwsl-shell .notice ul{ color: var(--iw-muted); }
.iwsl-shell .notice-success{ background: color-mix(in oklch, var(--iw-good) 12%, var(--iw-panel)); border-color: color-mix(in oklch, var(--iw-good) 45%, transparent); }
.iwsl-shell .notice-warning{ background: color-mix(in oklch, var(--iw-warn) 11%, var(--iw-panel)); border-color: color-mix(in oklch, var(--iw-warn) 42%, transparent); }
.iwsl-shell .notice-error{ background: color-mix(in oklch, var(--iw-bad) 12%, var(--iw-panel)); border-color: color-mix(in oklch, var(--iw-bad) 45%, transparent); }
.iwsl-shell .notice-warning ul{ margin-top: 6px; }

/* Checkboxes / labels inline */
.iwsl-shell input[type="checkbox"]{ accent-color: var(--iw-signal); width: 17px; height: 17px; }

/* ── Motion ───────────────────────────────────────────────────────────── */
@keyframes iwsl-spin{ to{ transform: rotate(360deg); } }
@keyframes iwsl-pulse{ 0%,100%{ box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-good) 24%, transparent); } 50%{ box-shadow: 0 0 0 6px color-mix(in oklch, var(--iw-good) 6%, transparent); } }
@keyframes iwsl-rise{ from{ opacity: 0; transform: translateY(10px); } to{ opacity: 1; transform: translateY(0); } }
/* Entrance is opt-in (JS adds .is-entering on a user-initiated switch), so
   panel content is fully visible by default — never gated behind an animation
   that could stall on a headless/print render or with JS disabled. */
@media (prefers-reduced-motion: no-preference){
	.iwsl-tabpanel.is-entering > *{ animation: iwsl-rise .45s var(--iw-ease) both; }
	.iwsl-tabpanel.is-entering > *:nth-child(1){ animation-delay: .02s; }
	.iwsl-tabpanel.is-entering > *:nth-child(2){ animation-delay: .07s; }
	.iwsl-tabpanel.is-entering > *:nth-child(3){ animation-delay: .12s; }
	.iwsl-tabpanel.is-entering > *:nth-child(4){ animation-delay: .17s; }
	.iwsl-tabpanel.is-entering > *:nth-child(n+5){ animation-delay: .2s; }
}
@media (prefers-reduced-motion: reduce){
	.iwsl-shell *,
	.iwsl-shell *::before,
	.iwsl-shell *::after{ animation-duration: .001ms !important; transition-duration: .001ms !important; }
}

/* ── Responsive ───────────────────────────────────────────────────────── */
@media (max-width: 782px){
	#wpcontent .iwsl-shell{ margin: 0; min-height: calc(100vh - 46px); }
	.iwsl-hero{ padding: 22px 18px; }
	.iwsl-tabnav{ top: 46px; }
	.iwsl-panels{ padding: 20px 16px 28px; }
	.iwsl-shell table.form-table th{ width: auto; display: block; padding-bottom: 4px; }
	.iwsl-shell table.form-table td{ display: block; }
}
CSS;
		echo "\n</style>\n";
	}

	/**
	 * Tab interaction: WAI-ARIA tablist keyboard model, hash deep-linking, and
	 * a lightweight busy state on form submit. Progressive enhancement — with
	 * JS off, a <noscript> rule reveals every panel and hides the rail.
	 */
	private static function render_shell_script(): void {
		echo "<noscript><style>.iwsl-shell .iwsl-tabpanel[hidden]{display:block!important}.iwsl-shell .iwsl-tabnav{display:none}</style></noscript>\n";
		echo "<script>\n";
		echo <<<'JS'
(function(){
	var shell = document.querySelector('.iwsl-shell');
	if (!shell) { return; }
	var tabs = Array.prototype.slice.call(shell.querySelectorAll('.iwsl-tab'));
	var panels = Array.prototype.slice.call(shell.querySelectorAll('.iwsl-tabpanel'));
	if (!tabs.length) { return; }

	function enter(panel){
		panel.classList.remove('is-entering');
		void panel.offsetWidth; // restart the stagger
		panel.classList.add('is-entering');
		panel.addEventListener('animationend', function done(){
			panel.classList.remove('is-entering');
			panel.removeEventListener('animationend', done);
		});
	}

	function activate(id, focusTab, push, animate){
		var matched = false;
		tabs.forEach(function(tab){
			var on = tab.dataset.tab === id;
			tab.classList.toggle('is-active', on);
			tab.setAttribute('aria-selected', on ? 'true' : 'false');
			tab.tabIndex = on ? 0 : -1;
			if (on) {
				matched = true;
				if (focusTab) { tab.focus(); }
				tab.scrollIntoView({ block: 'nearest', inline: 'center' });
			}
		});
		if (!matched) { return; }
		panels.forEach(function(panel){
			var on = panel.id === 'iwsl-tab-' + id;
			panel.hidden = !on;
			panel.classList.toggle('is-active', on);
			if (on && animate) { enter(panel); }
		});
		if (push && history.replaceState) { history.replaceState(null, '', '#iwsl-' + id); }
		// Remember the tab so a full-page form POST + server redirect (which drops
		// the hash) returns the operator to the same section, not back to Overview.
		try { localStorage.setItem('iwsl_tab', id); } catch (e) {}
	}

	tabs.forEach(function(tab){
		tab.addEventListener('click', function(){ activate(tab.dataset.tab, false, true, true); });
	});

	var rail = shell.querySelector('.iwsl-tabnav');
	if (rail) {
		rail.addEventListener('keydown', function(e){
			var i = tabs.indexOf(document.activeElement);
			if (i < 0) { return; }
			var n = null;
			if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { n = (i + 1) % tabs.length; }
			else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { n = (i - 1 + tabs.length) % tabs.length; }
			else if (e.key === 'Home') { n = 0; }
			else if (e.key === 'End') { n = tabs.length - 1; }
			if (n === null) { return; }
			e.preventDefault();
			activate(tabs[n].dataset.tab, true, true, true);
		});
	}

	// Busy state on any submit inside a panel (visual only; never blocks POST).
	shell.addEventListener('submit', function(e){
		var btn = e.submitter || e.target.querySelector('[type="submit"]');
		if (btn && btn.classList && !btn.classList.contains('button-link-delete')) {
			btn.classList.add('is-busy');
		}
	});

	// Deep-link: open the tab named in the URL hash (#iwsl-images) without an
	// entrance animation, so the first paint is always the visible content.
	// No hash → the default Overview panel is already shown in the markup.
	var hash = (location.hash || '').replace(/^#iwsl-/, '');
	if (hash && shell.querySelector('#iwsl-tab-' + hash)) {
		activate(hash, false, false, false);
	} else {
		var saved = null;
		try { saved = localStorage.getItem('iwsl_tab'); } catch (e) {}
		if (saved && saved !== 'overview' && shell.querySelector('#iwsl-tab-' + saved)) {
			activate(saved, false, false, false);
		}
	}
})();
JS;
		echo "\n</script>\n";
	}

	/** One row per gate with a pass/fail marker and the live detail. */
	private static function render_gate_table( array $gate ): void {
		$heartbeat_detail = self::heartbeat_detail( $gate );
		$rows             = array(
			array(
				'label'  => 'Linked',
				'ok'     => ! empty( $gate['linked'] ),
				'detail' => 'Enrollment state: ' . (string) $gate['state'],
			),
			array(
				'label'  => 'Heartbeat fresh',
				'ok'     => ! empty( $gate['heartbeat_fresh'] ),
				'detail' => $heartbeat_detail,
			),
			array(
				'label'  => 'Plus granted',
				'ok'     => ! empty( $gate['plus'] ),
				'detail' => ! empty( $gate['plus'] ) ? 'Entitlement present' : 'Not granted from the console',
			),
		);

		echo '<table class="widefat striped" style="max-width:640px;margin-top:12px;"><thead><tr>';
		echo '<th>Gate</th><th>State</th><th>Detail</th></tr></thead><tbody>';
		foreach ( $rows as $row ) {
			$marker = $row['ok']
				? '<span style="color:#1a7f37;font-weight:600;">&#10004; pass</span>'
				: '<span style="color:#b3261e;font-weight:600;">&#10008; blocked</span>';
			echo '<tr><th scope="row">' . esc_html( $row['label'] ) . '</th><td>' . $marker . '</td><td>' . esc_html( $row['detail'] ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	private static function heartbeat_detail( array $gate ): string {
		if ( null === $gate['last_verified_at'] ) {
			return 'No verified signed contact yet';
		}
		$age_ms    = (int) $gate['heartbeat_age_ms'];
		$age_min   = (int) floor( $age_ms / 60000 );
		$limit_min = (int) floor( (int) $gate['heartbeat_threshold_ms'] / 60000 );
		return sprintf( 'Last verified contact %d min ago (fresh window: %d min)', max( 0, $age_min ), $limit_min );
	}

	/** Human, one-line-per-reason explanation of the Plus lock. */
	private static function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The Plus entitlement is not granted. Grant it from the console (per-site toggle).',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 Plus feature locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	// ── Section 2: Lossless Image Optimization ─────────────────────────────────

	/**
	 * Render the image-optimization section, driven by the
	 * `image_optimization` gate. Locked → reasons only, no form. Unlocked →
	 * capability table + run form + last-run summary + the coming-soon roadmap.
	 */
	private function render_image_optimization_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Media_Optimizer::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>Image Optimization</h2>';
		echo '<p>Re-encode this site&#8217;s images to WebP — lossless for PNG, GIF, BMP and TIFF; near-lossless for JPEG. Smaller files, identical-looking pixels, run entirely on this server — no external service is called.</p>';

		// A redirect from the handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_mo_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . esc_html__( 'The Image Optimization entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_optimization_locked_notice( $gate );
			return;
		}

		$this->render_capability_table();
		$this->render_optimization_form();
		$this->render_last_run_summary();

		echo '<p class="description" style="margin-top:8px;">' . esc_html__( 'Originals are never modified; derivatives are written alongside them.', 'infraweaver-connector' ) . '</p>';
	}

	/** Reason lines for a locked image-optimization gate (no form). */
	private static function render_optimization_locked_notice( array $gate ): void {
		// NOTE: `requires-plus` is a HISTORICAL reason token that fires for ANY
		// flag; here it maps to the image-optimization-specific message.
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The Image Optimization entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 Image Optimization is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Engine capability table — one row per registered converter. */
	private function render_capability_table(): void {
		$caps = $this->optimizer()->capabilities();
		echo '<table class="widefat striped" style="max-width:720px;margin-top:12px;"><thead><tr>';
		echo '<th>Converter</th><th>Accepts</th><th>Engine</th><th>Status</th></tr></thead><tbody>';
		foreach ( $caps as $cap ) {
			$avail  = is_array( $cap['availability'] ) ? $cap['availability'] : array();
			$ok     = ! empty( $avail['ok'] );
			$engine = isset( $avail['engine'] ) ? (string) $avail['engine'] : 'none';
			$marker = $ok
				? '<span style="color:#1a7f37;font-weight:600;">&#10004; ready</span>'
				: '<span style="color:#b3261e;font-weight:600;">&#10008; blocked</span>';
			$detail = $ok ? $engine : ( $engine . ' (' . (string) ( $avail['reason'] ?? 'unavailable' ) . ')' );
			echo '<tr>';
			echo '<th scope="row">' . esc_html( (string) $cap['label'] ) . '</th>';
			echo '<td>' . esc_html( implode( ', ', array_map( 'strval', (array) $cap['accepts'] ) ) ) . '</td>';
			echo '<td>' . esc_html( $detail ) . '</td>';
			echo '<td>' . $marker . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
	}

	/** The nonce-protected run form (POST → admin-post.php). */
	private function render_optimization_form(): void {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="iwsl-mo-form" style="margin-top:16px;max-width:640px;">';
		wp_nonce_field( self::OPTIMIZE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::OPTIMIZE_ACTION ) . '">';

		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row"><label for="iwsl-mo-types">' . esc_html__( 'Image types', 'infraweaver-connector' ) . '</label></th><td>';
		echo '<select id="iwsl-mo-types" name="types">';
		echo '<option value="auto">' . esc_html__( 'Auto — all types (PNG, JPEG, GIF, BMP, TIFF)', 'infraweaver-connector' ) . '</option>';
		foreach ( array( 'image/png' => 'PNG', 'image/jpeg' => 'JPEG', 'image/gif' => 'GIF', 'image/bmp' => 'BMP', 'image/tiff' => 'TIFF' ) as $iwsl_mime => $iwsl_lbl ) {
			echo '<option value="' . esc_attr( $iwsl_mime ) . '">' . esc_html( $iwsl_lbl ) . '</option>';
		}
		echo '</select><br><span class="description">' . esc_html__( 'Auto picks the best WebP mode per type — lossless for PNG/GIF/BMP/TIFF, near-lossless for JPEG. Only smaller results are kept.', 'infraweaver-connector' ) . '</span></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-mo-count">' . esc_html__( 'Images this run', 'infraweaver-connector' ) . '</label></th><td>';
		echo '<input type="number" id="iwsl-mo-count" name="count" min="1" max="' . (int) IWSL_Media_Optimizer::MAX_REQUEST . '" value="25" style="width:100px;"> ';
		echo '<span class="description">' . esc_html( sprintf(
			/* translators: %d is the per-run image ceiling. */
			__( 'Up to %d. Bigger requests self-queue across batches (each run is time-bounded — just run again to continue).', 'infraweaver-connector' ),
			IWSL_Media_Optimizer::MAX_REQUEST
		) ) . '</span></td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Output', 'infraweaver-connector' ) . '</th><td>';
		echo '<label style="display:block;margin-bottom:8px;"><input type="radio" name="mode" value="copy" checked> <strong>' . esc_html__( 'Keep original + add WebP copy', 'infraweaver-connector' ) . '</strong><br><span class="description" style="margin-left:24px;">' . esc_html__( 'Safe. Nothing is deleted — the WebP sits beside the original.', 'infraweaver-connector' ) . '</span></label>';
		echo '<label style="display:block;"><input type="radio" name="mode" value="replace"> <strong>' . esc_html__( 'Replace original with WebP', 'infraweaver-connector' ) . '</strong><br><span class="description" style="margin-left:24px;">' . esc_html__( 'Smaller storage and faster pages. Deletes the original file — any hardcoded .png link in post content will break.', 'infraweaver-connector' ) . '</span></label>';
		echo '</td></tr>';

		echo '</tbody></table>';

		echo '<p style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">';
		echo '<button type="submit" name="op" value="preview" class="button">' . esc_html__( 'Estimate savings', 'infraweaver-connector' ) . '</button>';
		echo '<button type="submit" name="op" value="run" class="button button-primary">' . esc_html__( 'Optimize now', 'infraweaver-connector' ) . '</button>';
		echo '<span class="description">' . esc_html__( 'Estimate is a dry run — it changes nothing.', 'infraweaver-connector' ) . '</span>';
		echo '</p>';
		echo '</form>';
	}

	/** Render (then clear) the current user's last-run summary transient. */
	private function render_last_run_summary(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key     = 'iwsl_mo_result_' . (int) get_current_user_id();
		$summary = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $summary ) ) {
			return;
		}

		echo '<div style="border:1px solid var(--iw-line-2);background:var(--iw-panel);border-radius:12px;padding:18px;margin-top:16px;max-width:720px;">';
		$dry = ! empty( $summary['dry'] );
		echo '<h3 style="margin-top:0;">' . esc_html( $dry ? __( 'Savings estimate', 'infraweaver-connector' ) : __( 'Last run', 'infraweaver-connector' ) ) . '</h3>';

		if ( empty( $summary['ok'] ) ) {
			echo '<p>' . esc_html( sprintf( 'Run refused: %s', (string) ( $summary['reason'] ?? 'unknown' ) ) ) . '</p></div>';
			return;
		}

		$converted = (int) ( $summary['converted'] ?? 0 );
		$skipped   = (int) ( $summary['skipped'] ?? 0 );
		$refused   = (int) ( $summary['refused'] ?? 0 );
		$saved     = (int) ( $summary['saved_bytes'] ?? 0 );
		$bytes_in  = (int) ( $summary['bytes_in'] ?? 0 );
		$pct       = $bytes_in > 0 ? (int) round( $saved / $bytes_in * 100 ) : 0;

		$items    = isset( $summary['items'] ) && is_array( $summary['items'] ) ? $summary['items'] : array();
		$replaced = 0;
		foreach ( $items as $it ) {
			if ( ! empty( $it['replaced'] ) ) {
				++$replaced;
			}
		}

		if ( $dry ) {
			echo '<p style="font-size:15px;">' . esc_html( sprintf(
				/* translators: 1: image count, 2: human size, 3: percent. */
				__( 'Converting %1$d image(s) would save %2$s (~%3$d%% smaller). Nothing was changed.', 'infraweaver-connector' ),
				$converted,
				self::format_bytes( $saved ),
				$pct
			) ) . '</p>';
		} else {
			$msg = sprintf(
				/* translators: 1: converted, 2: skipped, 3: refused, 4: size, 5: percent. */
				__( 'Converted %1$d, skipped %2$d, refused %3$d. Saved %4$s (~%5$d%% smaller).', 'infraweaver-connector' ),
				$converted,
				$skipped,
				$refused,
				self::format_bytes( $saved ),
				$pct
			);
			if ( IWSL_Media_Optimizer::MODE_REPLACE === ( $summary['mode'] ?? '' ) ) {
				/* translators: %d is the number of originals replaced. */
				$msg .= ' ' . sprintf( __( '%d original(s) replaced.', 'infraweaver-connector' ), $replaced );
			}
			echo '<p style="font-size:15px;">' . esc_html( $msg ) . '</p>';
		}

		if ( ! empty( $summary['partial'] ) ) {
			echo '<p><strong>' . esc_html__( 'Time budget reached — more images remain. Run the same action again to continue the queue.', 'infraweaver-connector' ) . '</strong></p>';
		}

		if ( array() !== $items ) {
			echo '<table class="widefat striped" style="max-width:640px;"><thead><tr><th>File</th><th>Result</th></tr></thead><tbody>';
			foreach ( array_slice( $items, 0, 60 ) as $item ) {
				$basename = isset( $item['basename'] ) ? (string) $item['basename'] : '';
				$outcome  = isset( $item['outcome'] ) ? (string) $item['outcome'] : '';
				if ( 'converted' === $outcome && isset( $item['saving'] ) ) {
					$detail = ( $dry ? 'would save ' : 'saved ' ) . self::format_bytes( (int) $item['saving'] );
					if ( ! empty( $item['replaced'] ) ) {
						$detail .= ' · replaced';
					} elseif ( isset( $item['replace_reason'] ) ) {
						$detail .= ' · replace failed: ' . (string) $item['replace_reason'];
					}
				} elseif ( isset( $item['reason'] ) ) {
					$detail = $outcome . ' — ' . (string) $item['reason'];
				} else {
					$detail = $outcome;
				}
				echo '<tr><td>' . esc_html( $basename ) . '</td><td>' . esc_html( $detail ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}
		echo '</div>';
	}

	/** Inert roadmap rows — greyed, "Coming soon" pill, NO form, NO handler. */
	private static function render_coming_soon(): void {
		$rows = array(
			array( 'Broken Link Scanner', 'Crawl posts & pages for dead internal and external links.', 'Pro' ),
			array( 'SEO Meta Audit', 'Flag missing titles, descriptions, and thin content.', 'Pro' ),
			array( 'Scheduled Auto-Convert', 'Automatically losslessly convert new uploads on a schedule.', 'Ultimate' ),
		);
		echo '<ul style="list-style:none;margin:8px 0 0;padding:0;max-width:720px;">';
		foreach ( $rows as $row ) {
			list( $title, $desc, $tier ) = $row;
			echo '<li style="opacity:0.7;border:1px solid var(--iw-line);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:color-mix(in oklch, var(--iw-panel) 60%, transparent);">';
			echo '<span style="display:inline-block;background:color-mix(in oklch, var(--iw-warn) 22%, transparent);color:var(--iw-warn);border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600;margin-right:8px;">' . esc_html__( 'Coming soon', 'infraweaver-connector' ) . '</span>';
			echo '<strong>' . esc_html( $title ) . '</strong> ';
			echo '<span style="display:inline-block;background:color-mix(in oklch, var(--iw-signal) 16%, transparent);color:var(--iw-signal-2);border-radius:10px;padding:1px 8px;font-size:11px;margin-left:4px;">' . esc_html( $tier ) . '</span>';
			echo '<br><span class="description">' . esc_html( $desc ) . '</span>';
			echo '</li>';
		}
		echo '</ul>';
	}

	private static function format_bytes( int $bytes ): string {
		if ( $bytes < 1024 ) {
			return $bytes . ' B';
		}
		if ( $bytes < 1048576 ) {
			return round( $bytes / 1024, 1 ) . ' KB';
		}
		return round( $bytes / 1048576, 2 ) . ' MB';
	}

	/**
	 * admin-post handler for the image-optimization run. LAYER 2 of the gate:
	 * capability + nonce, then re-check the entitlement before doing any work,
	 * then run() (whose first statement is the authoritative LAYER 3 gate).
	 * POST-redirect-GET: stash the summary in a per-user transient and redirect.
	 */
	public function handle_media_optimize(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::OPTIMIZE_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		// LAYER 2: re-check the gate before touching any file.
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Media_Optimizer::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_mo_locked', '1', $redirect ) );
			exit;
		}

		// Only inputs that cross the boundary: nonce + an allow-listed converter
		// id validated against the registry keys, an integer count, and two closed
		// enums (mode, op). NO attachment ids ever cross the request boundary.
		$requested = isset( $_POST['converter'] ) ? sanitize_key( wp_unslash( $_POST['converter'] ) ) : 'webp_lossless';
		$optimizer = $this->optimizer();
		$converter = in_array( $requested, $optimizer->converter_ids(), true ) ? $requested : 'webp_lossless';

		$count = isset( $_POST['count'] ) ? (int) $_POST['count'] : IWSL_Media_Optimizer::MAX_BATCH;
		$count = max( 1, min( IWSL_Media_Optimizer::MAX_REQUEST, $count ) );
		$mode  = ( isset( $_POST['mode'] ) && IWSL_Media_Optimizer::MODE_REPLACE === $_POST['mode'] )
			? IWSL_Media_Optimizer::MODE_REPLACE
			: IWSL_Media_Optimizer::MODE_COPY;
		$is_preview = isset( $_POST['op'] ) && 'preview' === $_POST['op'];

		// Source-type filter: 'auto' (every accepted type) or one exact MIME,
		// validated against a closed list before it reaches the engine.
		$allowed_types = array( 'auto', 'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/tiff' );
		$types         = isset( $_POST['types'] ) ? sanitize_text_field( wp_unslash( $_POST['types'] ) ) : 'auto';
		if ( ! in_array( $types, $allowed_types, true ) ) {
			$types = 'auto';
		}

		// LAYER 3 (authoritative gate) is inside run()/preview().
		$summary = $is_preview
			? $optimizer->preview( $converter, $count, $types )
			: $optimizer->run( $converter, $count, $mode, false, $types );

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_mo_result_' . (int) get_current_user_id(), $summary, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 3: SMTP Email Delivery & Log ───────────────────────────────────

	/**
	 * Render the email-delivery section (LAYER 1 of the gate), driven by the
	 * `email_delivery` flag. Locked → reasons only, no form and no log. Unlocked →
	 * settings form + per-user PRG result notice + the bounded email log + a
	 * clear-log button.
	 */
	private function render_email_delivery_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Email_Delivery::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'SMTP Email Delivery & Log', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( "Route this site's outgoing mail through an SMTP server and keep a bounded local log of what was sent. Runs entirely on this server; the message body is never stored — only recipients and subjects are recorded.", 'infraweaver-connector' ) . '</p>';

		// A redirect from a handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_ed_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . esc_html__( 'The Email Delivery entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_email_locked_notice( $gate );
			return;
		}

		$this->render_email_result_notice();
		$this->render_email_settings_form();
		$this->render_email_test_form();
		$this->render_email_log_table();
	}

	/** Reason lines for a locked email-delivery gate (no form). */
	private static function render_email_locked_notice( array $gate ): void {
		// NOTE: `requires-plus` is a HISTORICAL reason token that fires for ANY
		// flag; here it maps to the email-delivery-specific message (Pro tier).
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The Email Delivery entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 Email Delivery is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_email_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = 'iwsl_ed_result_' . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			if ( ! empty( $result['tested'] ) ) {
				$msg = esc_html( sprintf(
					/* translators: %s is the recipient email address. */
					__( 'Test email sent to %s. Check the inbox (and spam) — the result is in the log below.', 'infraweaver-connector' ),
					(string) ( $result['to'] ?? '' )
				) );
			} elseif ( ! empty( $result['cleared'] ) ) {
				$msg = esc_html__( 'Email log cleared.', 'infraweaver-connector' );
			} else {
				$msg = esc_html__( 'SMTP settings saved.', 'infraweaver-connector' );
			}
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>' . $msg . '</p></div>';
		} else {
			$reason = (string) ( $result['reason'] ?? 'unknown' );
			if ( 'invalid-recipient' === $reason ) {
				$err = esc_html__( 'Enter a valid recipient email address.', 'infraweaver-connector' );
			} elseif ( 'send-failed' === $reason ) {
				$err = esc_html__( 'Test send failed — check the SMTP settings above and the log below.', 'infraweaver-connector' );
			} else {
				$err = esc_html( sprintf( 'Could not save: %s', $reason ) );
			}
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>' . $err . '</p></div>';
		}
	}

	/** The nonce-protected SMTP settings form (POST → admin-post.php). */
	private function render_email_settings_form(): void {
		$settings         = $this->email_delivery()->settings_for_render();
		$host             = isset( $settings['host'] ) ? (string) $settings['host'] : '';
		$port             = isset( $settings['port'] ) ? (int) $settings['port'] : 0;
		$username         = isset( $settings['username'] ) ? (string) $settings['username'] : '';
		$secure           = isset( $settings['secure'] ) ? (string) $settings['secure'] : '';
		$auth             = ! empty( $settings['auth'] );
		$allow_password   = ! empty( $settings['allow_option_password'] );
		$has_password     = ! empty( $settings['has_password'] );
		$password_source  = isset( $settings['password_source'] ) ? (string) $settings['password_source'] : 'none';
		$constant_defined = ( 'constant' === $password_source );

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:16px;max-width:640px;">';
		wp_nonce_field( self::EMAIL_SETTINGS_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::EMAIL_SETTINGS_ACTION ) . '">';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row"><label for="iwsl-ed-host">' . esc_html__( 'SMTP Host', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><input type="text" id="iwsl-ed-host" name="host" class="regular-text" value="' . esc_attr( $host ) . '"></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-ed-port">' . esc_html__( 'Port', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><input type="number" id="iwsl-ed-port" name="port" min="1" max="65535" value="' . esc_attr( $port > 0 ? (string) $port : '' ) . '"></td></tr>';

		$mode_labels = array(
			''    => esc_html__( 'None', 'infraweaver-connector' ),
			'ssl' => 'SSL',
			'tls' => 'TLS',
		);
		echo '<tr><th scope="row"><label for="iwsl-ed-secure">' . esc_html__( 'Encryption', 'infraweaver-connector' ) . '</label></th><td>';
		echo '<select id="iwsl-ed-secure" name="secure">';
		foreach ( IWSL_Email_Delivery::SECURE_MODES as $mode ) {
			$label = isset( $mode_labels[ $mode ] ) ? $mode_labels[ $mode ] : $mode;
			echo '<option value="' . esc_attr( $mode ) . '"' . selected( $secure, $mode, false ) . '>' . esc_html( $label ) . '</option>';
		}
		echo '</select></td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Authentication', 'infraweaver-connector' ) . '</th><td>';
		echo '<label><input type="checkbox" name="auth" value="1"' . checked( $auth, true, false ) . '> ' . esc_html__( 'Server requires authentication', 'infraweaver-connector' ) . '</label></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-ed-username">' . esc_html__( 'Username', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><input type="text" id="iwsl-ed-username" name="username" class="regular-text" value="' . esc_attr( $username ) . '"></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-ed-password">' . esc_html__( 'Password', 'infraweaver-connector' ) . '</label></th><td>';
		$placeholder = $has_password ? '****' : '';
		echo '<input type="password" id="iwsl-ed-password" name="password" class="regular-text" value="" placeholder="' . esc_attr( $placeholder ) . '" autocomplete="new-password">';
		echo '<p class="description">' . esc_html__( 'Leave blank to keep the current password. Prefer defining IWSL_SMTP_PASS in wp-config.php to keep the secret out of the database.', 'infraweaver-connector' ) . '</p>';
		if ( $constant_defined ) {
			echo '<p class="description"><strong>' . esc_html__( 'IWSL_SMTP_PASS is defined in wp-config.php — that value is used and no database password is stored.', 'infraweaver-connector' ) . '</strong></p>';
		}
		echo '</td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Password storage', 'infraweaver-connector' ) . '</th><td>';
		$disabled = $constant_defined ? ' disabled' : '';
		echo '<label><input type="checkbox" name="allow_option_password" value="1"' . checked( $allow_password, true, false ) . $disabled . '> ' . esc_html__( 'Store password in the database (I understand the risk)', 'infraweaver-connector' ) . '</label>';
		if ( $constant_defined ) {
			echo '<p class="description">' . esc_html__( 'Disabled because IWSL_SMTP_PASS is defined in wp-config.php.', 'infraweaver-connector' ) . '</p>';
		}
		echo '</td></tr>';

		echo '</tbody></table>';
		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Save SMTP settings', 'infraweaver-connector' ) . '</button></p>';
		echo '</form>';
	}

	/** A send-a-test-email form so the operator can verify SMTP end-to-end. */
	private function render_email_test_form(): void {
		$default = '';
		if ( function_exists( 'wp_get_current_user' ) ) {
			$user = wp_get_current_user();
			if ( $user && isset( $user->user_email ) ) {
				$default = (string) $user->user_email;
			}
		}
		echo '<h3 style="margin-top:24px;">' . esc_html__( 'Send a test email', 'infraweaver-connector' ) . '</h3>';
		echo '<p class="description" style="margin-bottom:8px;">' . esc_html__( 'Sends a real message through the SMTP settings above so you can confirm delivery. The outcome is recorded in the log below.', 'infraweaver-connector' ) . '</p>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="max-width:640px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">';
		wp_nonce_field( self::EMAIL_TEST_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::EMAIL_TEST_ACTION ) . '">';
		echo '<input type="email" name="test_to" class="regular-text" value="' . esc_attr( $default ) . '" placeholder="you@example.com" required style="flex:1;min-width:220px;">';
		echo '<button type="submit" class="button">' . esc_html__( 'Send test email', 'infraweaver-connector' ) . '</button>';
		echo '</form>';
	}

	/**
	 * admin-post handler for the SMTP test send. Same gate discipline as the
	 * other email actions: capability + nonce + re-checked entitlement, then a
	 * validated recipient and a plain wp_mail() (routed through the configured
	 * SMTP by the registered phpmailer_init hook). PRG via the shared transient.
	 */
	public function handle_email_test(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::EMAIL_TEST_NONCE );
		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Email_Delivery::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_ed_locked', '1', $redirect ) );
			exit;
		}

		$to = isset( $_POST['test_to'] ) ? sanitize_email( wp_unslash( $_POST['test_to'] ) ) : '';
		if ( '' === $to || ( function_exists( 'is_email' ) && ! is_email( $to ) ) ) {
			$this->stash_email_result( array( 'ok' => false, 'reason' => 'invalid-recipient' ) );
			wp_safe_redirect( $redirect );
			exit;
		}

		$subject = 'InfraWeaver SMTP test';
		$body    = "This is a test email from the InfraWeaver Connector, sent to verify your SMTP settings.\n\nIf you received it, outgoing mail is working.";
		$sent    = function_exists( 'wp_mail' ) ? (bool) wp_mail( $to, $subject, $body ) : false;

		$this->stash_email_result(
			$sent
				? array( 'ok' => true, 'tested' => true, 'to' => $to )
				: array( 'ok' => false, 'reason' => 'send-failed' )
		);
		wp_safe_redirect( $redirect );
		exit;
	}

	/** Stash a per-user PRG result for the email section's result notice. */
	private function stash_email_result( array $result ): void {
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_ed_result_' . (int) get_current_user_id(), $result, 60 );
		}
	}

	/** The bounded email log table + the nonce-protected clear-log form. */
	private function render_email_log_table(): void {
		$log = $this->email_delivery()->log();

		echo '<h3 style="margin-top:24px;">' . esc_html__( 'Email log', 'infraweaver-connector' ) . '</h3>';

		if ( array() === $log ) {
			echo '<p>' . esc_html__( 'No email activity recorded yet.', 'infraweaver-connector' ) . '</p>';
		} else {
			echo '<table class="widefat striped" style="max-width:900px;"><thead><tr>';
			echo '<th>' . esc_html__( 'Time', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'To', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Subject', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Status', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Detail', 'infraweaver-connector' ) . '</th>';
			echo '</tr></thead><tbody>';
			foreach ( array_reverse( $log ) as $entry ) {
				$at      = isset( $entry['at'] ) ? (int) $entry['at'] : 0;
				$time    = $at > 0 ? self::format_time( $at ) : '';
				$to      = ( isset( $entry['to'] ) && is_array( $entry['to'] ) ) ? implode( ', ', array_map( 'strval', $entry['to'] ) ) : '';
				$subject = isset( $entry['subject'] ) ? (string) $entry['subject'] : '';
				$type    = isset( $entry['type'] ) ? (string) $entry['type'] : '';
				$detail  = isset( $entry['error'] ) ? (string) $entry['error'] : '';
				$marker  = ( 'sent' === $type )
					? '<span style="color:#1a7f37;font-weight:600;">&#10004; sent</span>'
					: '<span style="color:#b3261e;font-weight:600;">&#10008; failed</span>';
				echo '<tr>';
				echo '<td>' . esc_html( $time ) . '</td>';
				echo '<td>' . esc_html( $to ) . '</td>';
				echo '<td>' . esc_html( $subject ) . '</td>';
				echo '<td>' . $marker . '</td>';
				echo '<td>' . esc_html( $detail ) . '</td>';
				echo '</tr>';
			}
			echo '</tbody></table>';
		}

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:12px;">';
		wp_nonce_field( self::EMAIL_LOG_CLEAR_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::EMAIL_LOG_CLEAR_ACTION ) . '">';
		echo '<button type="submit" class="button">' . esc_html__( 'Clear log', 'infraweaver-connector' ) . '</button>';
		echo '</form>';
	}

	/** Format a unix-second stamp with the site's date/time format (UTC fallback). */
	private static function format_time( int $unix ): string {
		if ( function_exists( 'wp_date' ) && function_exists( 'get_option' ) ) {
			$fmt = (string) get_option( 'date_format', 'Y-m-d' ) . ' ' . (string) get_option( 'time_format', 'H:i' );
			$out = wp_date( $fmt, $unix );
			if ( is_string( $out ) ) {
				return $out;
			}
		}
		return gmdate( 'Y-m-d H:i', $unix );
	}

	/**
	 * admin-post handler for the SMTP settings save. LAYER 2 of the gate: capability
	 * + nonce, then re-check the entitlement before doing any work, then
	 * save_settings() (whose first statement is the authoritative LAYER 3 gate).
	 * The password field is passed through unsanitized (only unslashed) so the exact
	 * secret is preserved; the engine validates it. POST-redirect-GET.
	 */
	public function handle_email_settings_save(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::EMAIL_SETTINGS_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		// LAYER 2: re-check the gate before touching any stored setting.
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Email_Delivery::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_ed_locked', '1', $redirect ) );
			exit;
		}

		$input = array(
			'host'                  => isset( $_POST['host'] ) ? sanitize_text_field( wp_unslash( $_POST['host'] ) ) : '',
			'port'                  => isset( $_POST['port'] ) ? absint( wp_unslash( $_POST['port'] ) ) : 0,
			'secure'                => isset( $_POST['secure'] ) ? sanitize_text_field( wp_unslash( $_POST['secure'] ) ) : '',
			'auth'                  => isset( $_POST['auth'] ),
			'username'              => isset( $_POST['username'] ) ? sanitize_text_field( wp_unslash( $_POST['username'] ) ) : '',
			// Password is the ONE field we must not sanitize (that would alter the
			// secret) — unslash only; save_settings() validates + policy-gates it.
			'password'              => isset( $_POST['password'] ) ? (string) wp_unslash( $_POST['password'] ) : '', // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
			'allow_option_password' => isset( $_POST['allow_option_password'] ),
		);

		$result = $this->email_delivery()->save_settings( $input ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_ed_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	/**
	 * admin-post handler for clearing the email log. Same LAYER 2 skeleton
	 * (capability + nonce + gate re-check), then clear_log() (LAYER 3 inside). PRG.
	 */
	public function handle_email_log_clear(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::EMAIL_LOG_CLEAR_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Email_Delivery::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_ed_locked', '1', $redirect ) );
			exit;
		}

		$result = $this->email_delivery()->clear_log(); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_ed_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 4: 301 Redirect Manager ────────────────────────────────────────

	/**
	 * Render the redirect-manager section (LAYER 1 of the gate), driven by the
	 * `redirect_manager` flag. Locked → reasons only, no forms and no tables.
	 * Unlocked → per-user PRG result notice + rules table + add-rule form + the
	 * bounded 404 log with its toggle.
	 */
	private function render_redirects_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Redirects::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( '301 Redirect Manager', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Send visitors from old URLs to new ones with permanent (301) or temporary (302) redirects — evaluated entirely on this server.', 'infraweaver-connector' ) . '</p>';

		// A redirect from a handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_rd_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . esc_html__( 'The Redirect Manager entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_redirects_locked_notice( $gate );
			return;
		}

		$this->render_redirects_result_notice();
		$this->render_redirects_table();
		$this->render_redirects_add_form();
		$this->render_redirects_404_log();
	}

	/** Reason lines for a locked redirect-manager gate (no forms). */
	private static function render_redirects_locked_notice( array $gate ): void {
		// NOTE: `requires-plus` is a HISTORICAL reason token that fires for ANY
		// flag; here it maps to the redirect-manager-specific message (Pro tier).
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The Redirect Manager entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 Redirect Manager is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_redirects_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = 'iwsl_rd_result_' . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			if ( ! empty( $result['deleted'] ) ) {
				$msg = esc_html__( 'Rule deleted.', 'infraweaver-connector' );
			} elseif ( array_key_exists( 'enabled', $result ) ) {
				$msg = esc_html__( '404 logging preference saved.', 'infraweaver-connector' );
			} else {
				$msg = esc_html__( 'Rule saved.', 'infraweaver-connector' );
			}
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>' . $msg . '</p></div>';
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>' . esc_html( sprintf( 'Rule refused: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p></div>';
		}
	}

	/** The rules table — targets rendered as PLAIN TEXT, each with an inline delete form. */
	private function render_redirects_table(): void {
		$rules = $this->redirects()->rules();
		$count = count( $rules );

		echo '<h3 style="margin-top:24px;">' . esc_html__( 'Redirects', 'infraweaver-connector' ) . '</h3>';

		if ( array() === $rules ) {
			echo '<p>' . esc_html__( 'No redirects defined yet.', 'infraweaver-connector' ) . '</p>';
		} else {
			echo '<table class="widefat striped" style="max-width:900px;"><thead><tr>';
			echo '<th>' . esc_html__( 'Source', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Target', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Type', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Hits', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Action', 'infraweaver-connector' ) . '</th>';
			echo '</tr></thead><tbody>';
			foreach ( $rules as $rule ) {
				$source = isset( $rule['source'] ) ? (string) $rule['source'] : '';
				$target = isset( $rule['target'] ) ? (string) $rule['target'] : '';
				$type   = isset( $rule['type'] ) ? (int) $rule['type'] : 301;
				$hits   = isset( $rule['hits'] ) ? (int) $rule['hits'] : 0;
				$id     = isset( $rule['id'] ) ? (string) $rule['id'] : '';
				echo '<tr>';
				echo '<td>' . esc_html( $source ) . '</td>';
				// Target is plain text, never an anchor — an admin page must not
				// link to an arbitrary stored URL.
				echo '<td>' . esc_html( $target ) . '</td>';
				echo '<td>' . esc_html( (string) $type ) . '</td>';
				echo '<td>' . esc_html( (string) $hits ) . '</td>';
				echo '<td>';
				echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin:0;">';
				wp_nonce_field( self::REDIRECT_DELETE_NONCE );
				echo '<input type="hidden" name="action" value="' . esc_attr( self::REDIRECT_DELETE_ACTION ) . '">';
				echo '<input type="hidden" name="rule_id" value="' . esc_attr( $id ) . '">';
				echo '<button type="submit" class="button button-link-delete">' . esc_html__( 'Delete', 'infraweaver-connector' ) . '</button>';
				echo '</form>';
				echo '</td>';
				echo '</tr>';
			}
			echo '</tbody></table>';
		}

		echo '<p class="description">' . esc_html( sprintf( '%d of %d rules used.', $count, IWSL_Redirects::MAX_RULES ) ) . '</p>';
	}

	/** The nonce-protected add-rule form (POST → admin-post.php). */
	private function render_redirects_add_form(): void {
		echo '<h3 style="margin-top:24px;">' . esc_html__( 'Add redirect', 'infraweaver-connector' ) . '</h3>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:8px;max-width:640px;">';
		wp_nonce_field( self::REDIRECT_ADD_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::REDIRECT_ADD_ACTION ) . '">';
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th scope="row"><label for="iwsl-rd-source">' . esc_html__( 'Source path', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><input type="text" id="iwsl-rd-source" name="source" class="regular-text" placeholder="/old-page" value=""></td></tr>';
		echo '<tr><th scope="row"><label for="iwsl-rd-target">' . esc_html__( 'Target', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><input type="text" id="iwsl-rd-target" name="target" class="regular-text" placeholder="' . esc_attr__( '/new-page or https://…', 'infraweaver-connector' ) . '" value=""></td></tr>';
		echo '<tr><th scope="row"><label for="iwsl-rd-type">' . esc_html__( 'Type', 'infraweaver-connector' ) . '</label></th><td>';
		echo '<select id="iwsl-rd-type" name="type">';
		echo '<option value="301">' . esc_html__( '301 (permanent)', 'infraweaver-connector' ) . '</option>';
		echo '<option value="302">' . esc_html__( '302 (temporary)', 'infraweaver-connector' ) . '</option>';
		echo '</select></td></tr>';
		echo '</tbody></table>';
		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Add redirect', 'infraweaver-connector' ) . '</button></p>';
		echo '</form>';
	}

	/** The 404-logging toggle + the bounded 404 log table. */
	private function render_redirects_404_log(): void {
		$enabled = $this->redirects()->is_404_logging_enabled();
		$log     = $this->redirects()->log_entries();

		echo '<h3 style="margin-top:24px;">' . esc_html__( '404 log', 'infraweaver-connector' ) . '</h3>';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:8px;">';
		wp_nonce_field( self::REDIRECT_LOG_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::REDIRECT_LOG_ACTION ) . '">';
		echo '<input type="hidden" name="enabled" value="' . esc_attr( $enabled ? '0' : '1' ) . '">';
		$label = $enabled
			? esc_html__( 'Disable 404 logging', 'infraweaver-connector' )
			: esc_html__( 'Enable 404 logging', 'infraweaver-connector' );
		echo '<button type="submit" class="button">' . $label . '</button>';
		echo ' <span class="description">' . ( $enabled ? esc_html__( 'Logging is on.', 'infraweaver-connector' ) : esc_html__( 'Logging is off.', 'infraweaver-connector' ) ) . '</span>';
		echo '</form>';

		if ( array() === $log ) {
			echo '<p>' . esc_html__( 'No not-found paths recorded yet.', 'infraweaver-connector' ) . '</p>';
		} else {
			echo '<table class="widefat striped" style="max-width:720px;margin-top:12px;"><thead><tr>';
			echo '<th>' . esc_html__( 'Path', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Count', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Last seen', 'infraweaver-connector' ) . '</th>';
			echo '</tr></thead><tbody>';
			foreach ( array_reverse( $log ) as $entry ) {
				$path      = isset( $entry['path'] ) ? (string) $entry['path'] : '';
				$entry_cnt = isset( $entry['count'] ) ? (int) $entry['count'] : 0;
				$last_seen = isset( $entry['last_seen'] ) ? (int) $entry['last_seen'] : 0;
				$time      = $last_seen > 0 ? self::format_time( $last_seen ) : '';
				echo '<tr>';
				echo '<td>' . esc_html( $path ) . '</td>';
				echo '<td>' . esc_html( (string) $entry_cnt ) . '</td>';
				echo '<td>' . esc_html( $time ) . '</td>';
				echo '</tr>';
			}
			echo '</tbody></table>';
		}

		echo '<p class="description">' . esc_html( sprintf( 'Logs at most %d recent not-found paths.', IWSL_Redirects::MAX_404_LOG ) ) . '</p>';
	}

	/**
	 * admin-post handler: add a rule. LAYER 2 of the gate (capability + nonce +
	 * gate re-check), then add_rule() (LAYER 3 inside). Source/target cross the
	 * boundary ONLY into the validators — never sanitize_text_field, which would
	 * mangle URLs; the engine's validators are stricter. POST-redirect-GET.
	 */
	public function handle_redirects_add(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::REDIRECT_ADD_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		// LAYER 2: re-check the gate before touching any stored rule.
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Redirects::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_rd_locked', '1', $redirect ) );
			exit;
		}

		$source = isset( $_POST['source'] ) ? (string) wp_unslash( $_POST['source'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$target = isset( $_POST['target'] ) ? (string) wp_unslash( $_POST['target'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$type   = isset( $_POST['type'] ) ? (int) $_POST['type'] : 301;

		$result = $this->redirects()->add_rule( $source, $target, $type ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_rd_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	/**
	 * admin-post handler: delete a rule. Same LAYER 2 skeleton, then delete_rule()
	 * (LAYER 3 inside). The rule id is sanitize_key'd and re-validated against
	 * RULE_ID_RE inside the engine. POST-redirect-GET.
	 */
	public function handle_redirects_delete(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::REDIRECT_DELETE_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Redirects::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_rd_locked', '1', $redirect ) );
			exit;
		}

		$rule_id = isset( $_POST['rule_id'] ) ? sanitize_key( wp_unslash( $_POST['rule_id'] ) ) : '';
		$result  = $this->redirects()->delete_rule( $rule_id ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_rd_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	/**
	 * admin-post handler: toggle 404 logging. Same LAYER 2 skeleton, then
	 * set_404_logging() (LAYER 3 inside). POST-redirect-GET.
	 */
	public function handle_redirects_log(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::REDIRECT_LOG_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Redirects::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_rd_locked', '1', $redirect ) );
			exit;
		}

		$enabled = ! empty( $_POST['enabled'] ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$result  = $this->redirects()->set_404_logging( $enabled ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_rd_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 5: Custom Login & Admin White-Label ────────────────────────────

	/**
	 * Render the white-label section (LAYER 1 of the gate), driven by the
	 * `white_label` flag. Locked → reasons only, no form. Unlocked → per-user PRG
	 * result notice + the surface/hook capability table + the settings form. The
	 * behavior itself is applied by IWSL_White_Label's passive login/admin hooks
	 * (wired unconditionally in the plugin bootstrap); this page only edits settings.
	 */
	private function render_white_label_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_White_Label::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'Custom Login & Admin White-Label', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Replace the WordPress login logo, header link, login message, and admin footer credit with your own brand — applied entirely on this server. Revoking the entitlement instantly restores the default WordPress chrome.', 'infraweaver-connector' ) . '</p>';

		// A redirect from the handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_wl_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . esc_html__( 'The White-Label entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_white_label_locked_notice( $gate );
			return;
		}

		$this->render_white_label_result_notice();
		$this->render_white_label_capability_table();
		$this->render_white_label_form();
	}

	/** Reason lines for a locked white-label gate (no form). */
	private static function render_white_label_locked_notice( array $gate ): void {
		// NOTE: `requires-plus` is a HISTORICAL reason token that fires for ANY
		// flag; here it maps to the white-label-specific message (Ultimate tier).
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The White-Label entitlement is not granted — assign the Ultimate tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 White-Label is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_white_label_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = 'iwsl_wl_result_' . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>' . esc_html__( 'White-label settings saved.', 'infraweaver-connector' ) . '</p></div>';
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>' . esc_html( sprintf( 'Could not save: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p></div>';
		}
	}

	/** Surface → WordPress-hooks capability table (one row per registered surface). */
	private function render_white_label_capability_table(): void {
		$caps = $this->white_label()->capabilities();
		echo '<table class="widefat striped" style="max-width:720px;margin-top:12px;"><thead><tr>';
		echo '<th>' . esc_html__( 'Surface', 'infraweaver-connector' ) . '</th><th>' . esc_html__( 'WordPress hooks', 'infraweaver-connector' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $caps as $cap ) {
			$hooks = implode( ', ', array_map( 'strval', (array) $cap['hooks'] ) );
			echo '<tr><th scope="row">' . esc_html( (string) $cap['label'] ) . '</th><td><code>' . esc_html( $hooks ) . '</code></td></tr>';
		}
		echo '</tbody></table>';
	}

	/** The nonce-protected white-label settings form (POST → admin-post.php). */
	private function render_white_label_form(): void {
		$settings = $this->white_label()->settings_for_render();
		$logo     = isset( $settings['login_logo_url'] ) ? (string) $settings['login_logo_url'] : '';
		$hdr_url  = isset( $settings['login_header_url'] ) ? (string) $settings['login_header_url'] : '';
		$hdr_text = isset( $settings['login_header_text'] ) ? (string) $settings['login_header_text'] : '';
		$message  = isset( $settings['login_message'] ) ? (string) $settings['login_message'] : '';
		$footer   = isset( $settings['admin_footer_text'] ) ? (string) $settings['admin_footer_text'] : '';
		$hide     = ! empty( $settings['hide_wp_logo'] );

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:16px;max-width:640px;">';
		wp_nonce_field( self::WHITE_LABEL_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::WHITE_LABEL_ACTION ) . '">';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row"><label for="iwsl-wl-logo">' . esc_html__( 'Login logo URL', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><input type="text" id="iwsl-wl-logo" name="login_logo_url" class="regular-text" value="' . esc_attr( $logo ) . '" placeholder="/wp-content/uploads/brand/logo.png">';
		echo '<p class="description">' . esc_html__( 'A same-site path or https URL to your logo image. Leave blank for the WordPress logo.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-wl-hdr-url">' . esc_html__( 'Logo link URL', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><input type="text" id="iwsl-wl-hdr-url" name="login_header_url" class="regular-text" value="' . esc_attr( $hdr_url ) . '" placeholder="https://example.com">';
		echo '<p class="description">' . esc_html__( 'Where the login logo links to. Leave blank for your site home.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-wl-hdr-text">' . esc_html__( 'Logo link text', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><input type="text" id="iwsl-wl-hdr-text" name="login_header_text" class="regular-text" value="' . esc_attr( $hdr_text ) . '"></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-wl-message">' . esc_html__( 'Login message', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><textarea id="iwsl-wl-message" name="login_message" class="large-text" rows="2">' . esc_textarea( $message ) . '</textarea>';
		echo '<p class="description">' . esc_html__( 'Shown above the login form. Plain text only.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-wl-footer">' . esc_html__( 'Admin footer text', 'infraweaver-connector' ) . '</label></th>';
		echo '<td><input type="text" id="iwsl-wl-footer" name="admin_footer_text" class="regular-text" value="' . esc_attr( $footer ) . '">';
		echo '<p class="description">' . esc_html__( 'Replaces the "Thank you for creating with WordPress" credit.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Admin bar', 'infraweaver-connector' ) . '</th><td>';
		echo '<label><input type="checkbox" name="hide_wp_logo" value="1"' . checked( $hide, true, false ) . '> ' . esc_html__( 'Remove the WordPress logo from the admin bar', 'infraweaver-connector' ) . '</label></td></tr>';

		echo '</tbody></table>';
		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Save white-label settings', 'infraweaver-connector' ) . '</button></p>';
		echo '</form>';
	}

	/**
	 * admin-post handler for the white-label settings save. LAYER 2 of the gate:
	 * capability + nonce, then re-check the entitlement before doing any work, then
	 * save_settings() (whose first statement is the authoritative LAYER 3 gate). URL
	 * fields are unslashed only (sanitize_text_field would mangle them — the engine's
	 * URL gauntlet validates them); text fields are sanitized. POST-redirect-GET.
	 */
	public function handle_white_label_save(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::WHITE_LABEL_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		// LAYER 2: re-check the gate before touching any stored setting.
		$gate = $this->plugin->entitlements()->evaluate( IWSL_White_Label::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_wl_locked', '1', $redirect ) );
			exit;
		}

		$input = array(
			// URLs: unslash only — the engine's URL gauntlet validates them.
			'login_logo_url'    => isset( $_POST['login_logo_url'] ) ? (string) wp_unslash( $_POST['login_logo_url'] ) : '', // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
			'login_header_url'  => isset( $_POST['login_header_url'] ) ? (string) wp_unslash( $_POST['login_header_url'] ) : '', // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
			'login_header_text' => isset( $_POST['login_header_text'] ) ? sanitize_text_field( wp_unslash( $_POST['login_header_text'] ) ) : '',
			'login_message'     => isset( $_POST['login_message'] ) ? sanitize_textarea_field( wp_unslash( $_POST['login_message'] ) ) : '',
			'admin_footer_text' => isset( $_POST['admin_footer_text'] ) ? sanitize_text_field( wp_unslash( $_POST['admin_footer_text'] ) ) : '',
			'hide_wp_logo'      => isset( $_POST['hide_wp_logo'] ),
		);

		$result = $this->white_label()->save_settings( $input ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_wl_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 6: Database Cleanup & Optimization ─────────────────────────────

	/**
	 * Render the database-cleanup section (LAYER 1 of the gate), driven by the
	 * `db_optimization` flag. Locked → reasons only, no forms and no preview.
	 * Unlocked → a live per-cleaner preview table (read-only counts), a Preview
	 * form and a separate Clean-now form (with an explicit confirmation), and the
	 * last-run summary from a per-user transient. The default is always a DRY RUN:
	 * nothing is deleted without the confirmed Clean-now submit.
	 */
	private function render_db_optimizer_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_DB_Optimizer::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'Database Cleanup & Optimization', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Reclaim space by clearing expired transients, old post revisions, auto-drafts, trashed posts and comments, spam, and orphaned metadata — then optimize the core tables. Runs entirely on this server; Preview never changes anything.', 'infraweaver-connector' ) . '</p>';

		// A redirect from the handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_db_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . esc_html__( 'The Database Optimization entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p></div>';
		}
		// A redirect from the handler when Clean now was submitted without confirming.
		if ( isset( $_GET['iwsl_db_confirm'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p>' . esc_html__( 'Tick the confirmation box before running Clean now.', 'infraweaver-connector' ) . '</p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_db_locked_notice( $gate );
			return;
		}

		$this->render_db_last_run_summary();
		$this->render_db_preview_table();
		$this->render_db_forms();

		echo '<p class="description" style="margin-top:8px;">' . esc_html( sprintf( 'Each cleaner removes at most %d rows per run; run again to continue on large sites. Nothing is ever dropped, truncated, or altered.', IWSL_DB_Optimizer::MAX_ROWS ) ) . '</p>';
	}

	/** Reason lines for a locked db-optimization gate (no forms). */
	private static function render_db_locked_notice( array $gate ): void {
		// NOTE: `requires-plus` is a HISTORICAL reason token that fires for ANY
		// flag; here it maps to the db-optimization-specific message (Pro tier).
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The Database Optimization entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 Database Cleanup & Optimization is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Live, read-only per-cleaner preview counts (a dry run issued on render). */
	private function render_db_preview_table(): void {
		$summary = $this->db_optimizer()->run( 'preview' ); // LAYER 3 inside; preview mutates nothing.

		echo '<h3 style="margin-top:24px;">' . esc_html__( 'Preview', 'infraweaver-connector' ) . '</h3>';

		if ( empty( $summary['ok'] ) ) {
			echo '<div class="notice notice-error inline" style="margin-top:8px;padding:12px;"><p>' . esc_html( sprintf( 'Preview unavailable: %s', (string) ( $summary['reason'] ?? 'unknown' ) ) ) . '</p></div>';
			return;
		}

		$cleaners = ( isset( $summary['cleaners'] ) && is_array( $summary['cleaners'] ) ) ? $summary['cleaners'] : array();
		echo '<table class="widefat striped" style="max-width:640px;margin-top:8px;"><thead><tr>';
		echo '<th>' . esc_html__( 'Cleaner', 'infraweaver-connector' ) . '</th><th>' . esc_html__( 'Rows to clean', 'infraweaver-connector' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $cleaners as $row ) {
			$label = isset( $row['label'] ) ? (string) $row['label'] : '';
			$count = isset( $row['count'] ) ? (int) $row['count'] : 0;
			echo '<tr><th scope="row">' . esc_html( $label ) . '</th><td>' . esc_html( (string) $count ) . '</td></tr>';
		}
		echo '<tr><th scope="row"><strong>' . esc_html__( 'Total', 'infraweaver-connector' ) . '</strong></th><td><strong>' . esc_html( (string) (int) ( $summary['total'] ?? 0 ) ) . '</strong></td></tr>';
		echo '</tbody></table>';
	}

	/** The Preview (re-scan) form + the confirmed Clean-now form (both nonce-protected). */
	private function render_db_forms(): void {
		$action = esc_url( admin_url( 'admin-post.php' ) );

		// Preview: a harmless re-scan (mode=preview).
		echo '<form method="post" action="' . $action . '" style="margin-top:16px;display:inline-block;">';
		wp_nonce_field( self::DB_OPTIMIZE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::DB_OPTIMIZE_ACTION ) . '">';
		echo '<input type="hidden" name="iwsl_db_mode" value="preview">';
		echo '<button type="submit" class="button">' . esc_html__( 'Refresh preview', 'infraweaver-connector' ) . '</button>';
		echo '</form>';

		// Clean now: the ONLY mutating path — gated behind an explicit confirmation.
		echo '<form method="post" action="' . $action . '" style="margin-top:16px;">';
		wp_nonce_field( self::DB_OPTIMIZE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::DB_OPTIMIZE_ACTION ) . '">';
		echo '<input type="hidden" name="iwsl_db_mode" value="run">';
		echo '<p><label><input type="checkbox" name="iwsl_db_confirm" value="1"> ' . esc_html__( 'Yes, permanently delete the items counted above.', 'infraweaver-connector' ) . '</label></p>';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'Clean now', 'infraweaver-connector' ) . '</button>';
		echo '</form>';
	}

	/** Render (then clear) the current user's last-run summary transient. */
	private function render_db_last_run_summary(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key     = 'iwsl_db_result_' . (int) get_current_user_id();
		$summary = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $summary ) ) {
			return;
		}

		if ( empty( $summary['ok'] ) ) {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>' . esc_html( sprintf( 'Run refused: %s', (string) ( $summary['reason'] ?? 'unknown' ) ) ) . '</p></div>';
			return;
		}

		$mode  = ( isset( $summary['mode'] ) && 'run' === $summary['mode'] ) ? 'run' : 'preview';
		$total = (int) ( $summary['total'] ?? 0 );
		$title = ( 'run' === $mode )
			? esc_html__( 'Last cleanup', 'infraweaver-connector' )
			: esc_html__( 'Last preview', 'infraweaver-connector' );
		$col   = ( 'run' === $mode )
			? esc_html__( 'Rows removed', 'infraweaver-connector' )
			: esc_html__( 'Rows found', 'infraweaver-connector' );
		$lead  = ( 'run' === $mode )
			? sprintf( 'Removed %d rows.', $total )
			: sprintf( 'Found %d rows to clean.', $total );

		echo '<div style="border:1px solid #c3e6cb;background:#f4fbf6;border-radius:8px;padding:16px;margin-top:16px;max-width:640px;">';
		echo '<h3 style="margin-top:0;">' . $title . '</h3>';
		echo '<p>' . esc_html( $lead ) . '</p>';

		$cleaners = ( isset( $summary['cleaners'] ) && is_array( $summary['cleaners'] ) ) ? $summary['cleaners'] : array();
		if ( array() !== $cleaners ) {
			echo '<table class="widefat striped" style="max-width:600px;"><thead><tr><th>' . esc_html__( 'Cleaner', 'infraweaver-connector' ) . '</th><th>' . $col . '</th></tr></thead><tbody>';
			foreach ( $cleaners as $row ) {
				$label = isset( $row['label'] ) ? (string) $row['label'] : '';
				$value = ( 'run' === $mode ) ? (int) ( $row['deleted'] ?? 0 ) : (int) ( $row['count'] ?? 0 );
				echo '<tr><td>' . esc_html( $label ) . '</td><td>' . esc_html( (string) $value ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}
		echo '</div>';
	}

	/**
	 * admin-post handler for the database cleanup/optimize run. LAYER 2 of the
	 * gate: capability + nonce, then re-check the entitlement before touching the
	 * database, then run() (whose first statement is the authoritative LAYER 3
	 * gate). The ONLY inputs that cross the boundary are the nonce, an allow-listed
	 * mode ('preview' | 'run'), and — for 'run' — a confirmation checkbox. No SQL,
	 * no table names, no cleaner ids ever cross the boundary. POST-redirect-GET.
	 */
	public function handle_db_optimize(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::DB_OPTIMIZE_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		// LAYER 2: re-check the gate before touching the database.
		$gate = $this->plugin->entitlements()->evaluate( IWSL_DB_Optimizer::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_db_locked', '1', $redirect ) );
			exit;
		}

		$requested = isset( $_POST['iwsl_db_mode'] ) ? sanitize_key( wp_unslash( $_POST['iwsl_db_mode'] ) ) : 'preview';

		// Deletion requires an explicit confirmation — a missing tick falls back to a
		// safe re-preview rather than deleting anything.
		if ( 'run' === $requested && empty( $_POST['iwsl_db_confirm'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_db_confirm', '1', $redirect ) );
			exit;
		}

		$mode    = ( 'run' === $requested ) ? 'run' : 'preview';
		$summary = $this->db_optimizer()->run( $mode ); // LAYER 3 (authoritative) is inside run().

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_db_result_' . (int) get_current_user_id(), $summary, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 7: Page Cache ──────────────────────────────────────────────────

	/**
	 * Render the page-cache section (LAYER 1 of the gate), driven by the
	 * `page_cache` flag. Locked → reasons only, no controls. Unlocked → per-user
	 * PRG result notice + the status table + an enable/disable toggle + a Purge-all
	 * button. The serve/store engine itself is the drop-in (installed by enable());
	 * this page only manages it and reports status.
	 */
	private function render_page_cache_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Page_Cache::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'Page Cache', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Serve a static HTML copy of public pages to anonymous visitors — faster loads with no external service. Logged-in users, password-protected posts and carts always bypass the cache, and content changes purge it automatically.', 'infraweaver-connector' ) . '</p>';

		// A redirect from a handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_pc_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . esc_html__( 'The Page Cache entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_page_cache_locked_notice( $gate );
			return;
		}

		$this->render_page_cache_result_notice();
		$this->render_page_cache_status_and_controls();
	}

	/** Reason lines for a locked page-cache gate (no controls). */
	private static function render_page_cache_locked_notice( array $gate ): void {
		// NOTE: `requires-plus` is a HISTORICAL reason token that fires for ANY
		// flag; here it maps to the page-cache-specific message (Pro tier).
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The Page Cache entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 Page Cache is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_page_cache_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = 'iwsl_pc_result_' . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			if ( ! empty( $result['purged_msg'] ) ) {
				$msg = esc_html( (string) $result['purged_msg'] );
			} elseif ( ! empty( $result['enabled'] ) ) {
				$msg = esc_html__( 'Page cache enabled.', 'infraweaver-connector' );
			} else {
				$msg = esc_html__( 'Page cache disabled.', 'infraweaver-connector' );
			}
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>' . $msg . '</p></div>';
			if ( ! empty( $result['manual_step'] ) ) {
				echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p>' . esc_html( (string) $result['manual_step'] ) . '</p></div>';
			}
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>' . esc_html( sprintf( 'Action failed: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p></div>';
		}
	}

	/** The status table + enable/disable toggle + purge-all button + the plain note. */
	private function render_page_cache_status_and_controls(): void {
		$status  = $this->page_cache()->status();
		$enabled = ! empty( $status['enabled'] );

		echo '<table class="widefat striped" style="max-width:640px;margin-top:12px;"><thead><tr>';
		echo '<th>' . esc_html__( 'Status', 'infraweaver-connector' ) . '</th><th>' . esc_html__( 'Value', 'infraweaver-connector' ) . '</th></tr></thead><tbody>';
		self::render_page_cache_status_row( esc_html__( 'Cache active', 'infraweaver-connector' ), $enabled );
		self::render_page_cache_status_row( esc_html__( 'Drop-in installed', 'infraweaver-connector' ), ! empty( $status['dropin_present'] ) && ! empty( $status['dropin_is_ours'] ) );
		self::render_page_cache_status_row( esc_html__( 'WP_CACHE set in wp-config.php', 'infraweaver-connector' ), ! empty( $status['wp_cache_defined'] ) );
		self::render_page_cache_status_row( esc_html__( 'wp-config.php writable', 'infraweaver-connector' ), ! empty( $status['wp_config_writable'] ) );
		echo '<tr><th scope="row">' . esc_html__( 'Cached pages', 'infraweaver-connector' ) . '</th><td>' . esc_html( (string) (int) $status['entries'] ) . '</td></tr>';
		echo '<tr><th scope="row">' . esc_html__( 'Cache size', 'infraweaver-connector' ) . '</th><td>' . esc_html( self::format_bytes( (int) $status['total_bytes'] ) ) . '</td></tr>';
		echo '<tr><th scope="row">' . esc_html__( 'Freshness (TTL)', 'infraweaver-connector' ) . '</th><td>' . esc_html( sprintf( '%d seconds', (int) $status['ttl'] ) ) . '</td></tr>';
		echo '</tbody></table>';

		// If WP_CACHE cannot be set automatically, show the exact manual step.
		if ( empty( $status['wp_cache_defined'] ) && empty( $status['wp_config_writable'] ) ) {
			echo '<div class="notice notice-warning inline" style="margin-top:12px;padding:12px;"><p>' . esc_html__( "wp-config.php is not writable. Add define('WP_CACHE', true); near the top of wp-config.php to activate the cache; the drop-in stays inert until then.", 'infraweaver-connector' ) . '</p></div>';
		}

		// Enable / disable toggle.
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:16px;display:inline-block;">';
		wp_nonce_field( self::PAGE_CACHE_TOGGLE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::PAGE_CACHE_TOGGLE_ACTION ) . '">';
		echo '<input type="hidden" name="enable" value="' . esc_attr( $enabled ? '0' : '1' ) . '">';
		$label = $enabled
			? esc_html__( 'Disable page cache', 'infraweaver-connector' )
			: esc_html__( 'Enable page cache', 'infraweaver-connector' );
		echo '<button type="submit" class="button button-primary">' . $label . '</button>';
		echo '</form> ';

		// Purge-all button.
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:16px;display:inline-block;">';
		wp_nonce_field( self::PAGE_CACHE_PURGE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::PAGE_CACHE_PURGE_ACTION ) . '">';
		echo '<button type="submit" class="button">' . esc_html__( 'Purge all', 'infraweaver-connector' ) . '</button>';
		echo '</form>';

		echo '<p class="description" style="margin-top:8px;">' . esc_html__( 'Only anonymous visitors are served cached pages; logged-in users and carts always bypass. Content changes purge the cache automatically.', 'infraweaver-connector' ) . '</p>';
	}

	/** One yes/no status row. */
	private static function render_page_cache_status_row( string $label, bool $ok ): void {
		$marker = $ok
			? '<span style="color:#1a7f37;font-weight:600;">&#10004; yes</span>'
			: '<span style="color:#b3261e;font-weight:600;">&#10008; no</span>';
		echo '<tr><th scope="row">' . esc_html( $label ) . '</th><td>' . $marker . '</td></tr>';
	}

	/**
	 * admin-post handler: enable/disable the page cache. LAYER 2 of the gate
	 * (capability + nonce + gate re-check), then enable()/disable() (whose own
	 * STATEMENT 1 is the authoritative LAYER 3 gate). The only input that crosses
	 * the boundary is the nonce + a boolean intent. POST-redirect-GET.
	 */
	public function handle_page_cache_toggle(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::PAGE_CACHE_TOGGLE_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Page_Cache::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_pc_locked', '1', $redirect ) );
			exit;
		}

		$enable = ! empty( $_POST['enable'] ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$pc     = $this->page_cache();
		if ( $enable ) {
			$out              = $pc->enable(); // LAYER 3 inside.
			$result           = array( 'ok' => ! empty( $out['ok'] ), 'enabled' => ! empty( $out['ok'] ) );
			if ( isset( $out['reason'] ) ) {
				$result['reason'] = (string) $out['reason'];
			}
			if ( ! empty( $out['manual_step'] ) ) {
				$result['manual_step'] = (string) $out['manual_step'];
			}
		} else {
			$out    = $pc->disable(); // LAYER 3 inside (signature-verified teardown).
			$result = array( 'ok' => ! empty( $out['ok'] ), 'enabled' => false );
			if ( isset( $out['reason'] ) ) {
				$result['reason'] = (string) $out['reason'];
			}
		}

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_pc_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	/**
	 * admin-post handler: purge the whole page cache. Same LAYER 2 skeleton, then
	 * purge_all(). Purging is harmless, so no further inputs cross the boundary.
	 * POST-redirect-GET.
	 */
	public function handle_page_cache_purge(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::PAGE_CACHE_PURGE_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Page_Cache::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_pc_locked', '1', $redirect ) );
			exit;
		}

		$out    = $this->page_cache()->purge_all();
		$result = array(
			'ok'         => ! empty( $out['ok'] ),
			'purged_msg' => sprintf( 'Purged %d cached pages.', (int) ( $out['purged'] ?? 0 ) ),
		);

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_pc_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}
}
