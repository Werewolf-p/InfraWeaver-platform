<?php
/**
 * Media Explorer — the presentation layer for the gated `media_folders` engine.
 *
 * A Windows-Explorer-style two-pane UI for the WordPress Media Library: a nestable
 * folder tree on the left, a responsive thumbnail grid on the right, with drag-drop
 * filing, tag filtering and sorting. This class is PURE PRESENTATION — it owns all
 * inline CSS + inline JS and depends ONLY on the CONSTANTS of IWSL_Media_Folders
 * (the AJAX action names + the shared nonce name); it never touches the model bodies.
 *
 * GATE. Statement 1 of every public render method is the entitlement gate. A locked /
 * revoked / heartbeat-stale site renders a short "locked" notice and NOTHING else — no
 * tree, no grid, no AJAX config — so the surface is byte-identical to stock WordPress
 * behaviour (the engine's register() has already declined to wire any AJAX handler).
 *
 * SECURITY. All server-echoed dynamic text is escaped (esc_html / esc_attr / esc_url,
 * with harness-safe fallbacks). The client driver builds the entire tree + grid with
 * document.createElement / textContent / setAttribute — it NEVER assigns innerHTML from
 * server-supplied values. The only markup the browser trusts is the static shell this
 * file prints; every folder name, file title, tag and URL that came from the server is
 * injected as text, so a malicious attachment title can never execute. Every request
 * the driver makes is a same-origin urlencoded POST carrying the shared nonce; the
 * engine re-checks capability + nonce + gate on every handler.
 *
 * SELF-CONTAINED. No assets/ directory, no build step, no CDN: the page ships one
 * scoped <style> and one <script> inline, matching the rest of the connector's admin UI.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Media_Folders_UI {

	/** The full-page Explorer admin slug (registered by IWSL_Admin::add_menu()). */
	const EXPLORER_PAGE = 'infraweaver-plus-explorer';

	/** @var IWSL_Entitlements The gate — evaluated as statement 1 of every render. */
	private $entitlements;

	/**
	 * @param IWSL_Entitlements $entitlements The media_folders gate.
	 */
	public function __construct( IWSL_Entitlements $entitlements ) {
		$this->entitlements = $entitlements;
	}

	// ── card-body section (inside the Media category page; already .iwsl-shell) ────

	/**
	 * The compact panel shown inside the Media category card. Locked → a short notice.
	 * Unlocked → a one-line intro + a prominent button that opens the full-page Explorer.
	 * Plain markup only — the card page already opens `.iwsl-shell`, so nothing is
	 * re-wrapped and no shell styles are re-emitted here.
	 */
	public function render_section(): void {
		$gate = $this->entitlements->evaluate( IWSL_Media_Folders::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate, 'Media Folders' );
			return;
		}

		$url = function_exists( 'admin_url' )
			? admin_url( 'admin.php?page=' . self::EXPLORER_PAGE )
			: 'admin.php?page=' . self::EXPLORER_PAGE;

		echo "<style id='iwx-intro-css'>\n";
		echo <<<'CSS'
.iwsl-shell .iwx-intro{ display: flex; flex-direction: column; gap: 14px; }
.iwsl-shell .iwx-intro__feats{ list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.iwsl-shell .iwx-intro__feats li{ display: inline-flex; align-items: center; gap: 7px; padding: 7px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--iw-muted, #b9bec7); border: 1px solid var(--iw-line-2, rgba(255,255,255,.2)); background: var(--iw-panel-2, #2c2f3a); }
.iwsl-shell .iwx-intro__feats li::before{ content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--iw-signal, #3fc9d4); flex: 0 0 auto; }
.iwsl-shell .iwx-intro__cta{ display: inline-flex; align-items: center; gap: 8px; align-self: flex-start; }
CSS;
		echo "\n</style>\n";

		echo '<div class="iwx-intro">';
		echo '<p class="description">' . self::esc_html_safe(
			'Organize the Media Library like Windows Explorer — nestable folders on the left, a thumbnail grid on the right. Drag files into folders, tag them, filter and sort. Purely organizational: your files are never moved on disk and nothing is ever deleted.'
		) . '</p>';

		echo '<ul class="iwx-intro__feats">';
		foreach ( array(
			'Nestable folders',
			'Drag-and-drop filing',
			'Tags & filtering',
			'Zero file changes',
		) as $feat ) {
			echo '<li>' . self::esc_html_safe( $feat ) . '</li>';
		}
		echo '</ul>';

		echo '<p class="iwx-intro__cta"><a class="button button-primary" href="' . self::esc_url_safe( (string) $url ) . '">'
			. self::esc_html_safe( 'Open Media Explorer' ) . '</a></p>';
		echo '</div>';
	}

	// ── full-page flagship Explorer ────────────────────────────────────────────────

	/**
	 * The full-page Explorer. Locked → a full-page locked notice. Unlocked → opens the
	 * `.iwsl-shell` wrap, prints the shared design-system styles (guarded, only when
	 * IWSL_Admin exposes them), then the explorer's own scoped layout styles, the two-pane
	 * markup, and one inline config-object + driver <script>.
	 */
	public function render_explorer_page(): void {
		$gate = $this->entitlements->evaluate( IWSL_Media_Folders::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_full_locked( $gate );
			return;
		}

		echo '<div class="wrap iwsl-shell" data-iwsl-scope="explorer">';
		// Re-use the shared design tokens + native-control restyle when available. Guarded
		// with is_callable so a private/removed method can never fatal — the explorer's own
		// scoped <style> below re-declares every token it uses (with literal fallbacks), so
		// the page is fully self-sufficient either way.
		if ( class_exists( 'IWSL_Admin' ) && is_callable( array( 'IWSL_Admin', 'render_shell_styles' ) ) ) {
			IWSL_Admin::render_shell_styles();
		}

		$this->enqueue_viewer_assets();
		$this->render_explorer_styles();
		$this->render_explorer_markup();
		$this->render_explorer_script();

		echo '</div>'; // .wrap.iwsl-shell
	}

	// ── shared viewer enqueue (the "open an image" bridge) ─────────────────────────

	/** Script handles for the shared viewer module + the Explorer bridge module. */
	const HANDLE_VIEWER = 'iwsl-media-viewer';
	const HANDLE_BRIDGE = 'iwsl-explorer-viewer';

	/**
	 * Enqueue the shared media-viewer ES module + the Explorer bridge module and print
	 * the localized viewer config (window.IWSL_EXPLORER_VIEWER). Mirrors how
	 * IWSL_Media_Native enqueues: prefer the module API (WP 6.5+, keeps the ES `import`
	 * intact), else a classic footer enqueue; the config rides a tiny inline classic
	 * script so the module can read it off window. Fully guarded — the harness (and any
	 * pre-6.5 site) never fatals, and a missing module just means the viewer won't open.
	 */
	private function enqueue_viewer_assets(): void {
		if ( ! function_exists( 'wp_enqueue_script' ) ) {
			return;
		}
		$base    = defined( 'IWSL_PLUGIN_URL' ) ? IWSL_PLUGIN_URL : self::plugin_base_url();
		$viewer  = $base . 'includes/assets/iwsl-media-viewer.js';
		$bridge  = $base . 'includes/assets/iwsl-explorer-viewer.js';
		$version = defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : '0';

		if ( function_exists( 'wp_enqueue_script_module' ) ) {
			wp_enqueue_script_module( self::HANDLE_VIEWER, $viewer, array(), $version );
			wp_enqueue_script_module(
				self::HANDLE_BRIDGE,
				$bridge,
				array( array( 'id' => self::HANDLE_VIEWER ) ),
				$version
			);
		} else {
			wp_enqueue_script( self::HANDLE_VIEWER, $viewer, array(), $version, true );
			wp_enqueue_script( self::HANDLE_BRIDGE, $bridge, array( self::HANDLE_VIEWER ), $version, true );
		}

		$config = $this->viewer_config();
		if ( function_exists( 'wp_add_inline_script' ) ) {
			$json = function_exists( 'wp_json_encode' ) ? wp_json_encode( $config ) : json_encode( $config );
			wp_add_inline_script( self::HANDLE_VIEWER, 'window.IWSL_EXPLORER_VIEWER = ' . $json . ';', 'before' );
		} elseif ( function_exists( 'wp_localize_script' ) ) {
			wp_localize_script( self::HANDLE_VIEWER, 'IWSL_EXPLORER_VIEWER', $config );
		}
	}

	/**
	 * The viewer config: the three detail AJAX actions (same explorer nonce), the
	 * feature flags the viewer gates panels on, and the current-user capability map so
	 * the UI hides verbs the user cannot perform. Pure (no echo) — the enqueue prints it.
	 *
	 * @return array<string,mixed>
	 */
	private function viewer_config(): array {
		return array(
			'ajaxUrl'  => function_exists( 'admin_url' ) ? admin_url( 'admin-ajax.php' ) : 'admin-ajax.php',
			'nonce'    => function_exists( 'wp_create_nonce' ) ? wp_create_nonce( IWSL_Media_Folders::NONCE ) : '',
			'actions'  => array(
				'get'  => IWSL_Media_Folders::AJAX_DETAIL_GET,
				'save' => IWSL_Media_Folders::AJAX_DETAIL_SAVE,
				'del'  => IWSL_Media_Folders::AJAX_DETAIL_DELETE,
			),
			'features' => array(
				'media_folders'      => true, // the page gate already unlocked it.
				'image_optimization' => $this->feature_unlocked( 'image_optimization' ),
				'media_protection'   => $this->feature_unlocked( 'media_protection' ),
				'cdn_rewrite'        => $this->feature_unlocked( 'cdn_rewrite' ),
			),
			'can'      => array(
				'manage_options' => ! function_exists( 'current_user_can' ) || current_user_can( 'manage_options' ),
				'edit_post'      => ! function_exists( 'current_user_can' ) || current_user_can( 'manage_options' ),
				'upload_files'   => ! function_exists( 'current_user_can' ) || current_user_can( 'upload_files' ),
			),
		);
	}

	/** True when a sibling feature's gate is unlocked (cheap, guarded). */
	private function feature_unlocked( string $feature ): bool {
		$gate = $this->entitlements->evaluate( $feature );
		return ! empty( $gate['unlocked'] );
	}

	/** The plugin's base URL, harness-safe. Only used when IWSL_PLUGIN_URL is unset. */
	private static function plugin_base_url(): string {
		if ( function_exists( 'plugins_url' ) ) {
			return rtrim( plugins_url( '', dirname( __DIR__ ) . '/infraweaver-connector.php' ), '/\\' ) . '/';
		}
		return '/wp-content/plugins/infraweaver-wp-connector/';
	}

	/** The full-page locked state (still inside a shell wrap so it looks intentional). */
	private function render_full_locked( array $gate ): void {
		echo '<div class="wrap iwsl-shell" data-iwsl-scope="explorer">';
		if ( class_exists( 'IWSL_Admin' ) && is_callable( array( 'IWSL_Admin', 'render_shell_styles' ) ) ) {
			IWSL_Admin::render_shell_styles();
		}
		echo '<div style="padding:28px 26px;">';
		echo '<h1 style="margin:0 0 12px;font-size:22px;">' . self::esc_html_safe( 'Media Explorer' ) . '</h1>';
		$this->render_locked_notice( $gate, 'Media Explorer' );
		echo '</div></div>';
	}

	/** The shared locked notice — human gate reasons, escaped. */
	private function render_locked_notice( array $gate, string $label ): void {
		$reasons = isset( $gate['reasons'] ) && is_array( $gate['reasons'] ) ? $gate['reasons'] : array();
		echo '<div class="notice notice-warning"><p>';
		echo self::esc_html_safe( $label . ' is locked. It needs an active InfraWeaver Plus (Pro or Ultimate) plan.' );
		if ( array() !== $reasons ) {
			echo ' ' . self::esc_html_safe( 'Reasons: ' . implode( ', ', array_map( 'strval', $reasons ) ) );
		}
		echo '</p></div>';
	}

	// ── scoped explorer styles ─────────────────────────────────────────────────────

	/**
	 * The explorer's scoped layout stylesheet. Namespaced under `.iwx` and self-sufficient:
	 * it re-declares every design token it consumes (matching the shared palette) so the
	 * page renders identically whether or not the shared shell styles were printed above,
	 * and every token usage additionally carries a literal fallback.
	 */
	private function render_explorer_styles(): void {
		echo "<style id='iwx-explorer-css'>\n";
		echo <<<'CSS'
.iwx{
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
	--iw-good: oklch(0.82 0.15 156);
	--iw-bad: oklch(0.74 0.16 25);
	--iw-warn: oklch(0.84 0.13 85);
	--iw-r: 16px;
	--iw-r-sm: 10px;
	--iw-ease: cubic-bezier(0.22, 1, 0.36, 1);
	display: grid;
	grid-template-columns: minmax(230px, 300px) minmax(0, 1fr);
	gap: 16px;
	align-items: start;
	padding: 20px 24px 132px;
	color: var(--iw-ink, #f2f3f5);
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", sans-serif;
}
.iwx *, .iwx *::before, .iwx *::after{ box-sizing: border-box; }
.iwx__panel{ background: var(--iw-panel, #23262f); border: 1px solid var(--iw-line, rgba(255,255,255,.11)); border-radius: var(--iw-r, 16px); }

/* ── Left pane: folder tree ─────────────────────────────────────────────── */
.iwx__tree{ position: sticky; top: 52px; display: flex; flex-direction: column; max-height: calc(100vh - 96px); overflow: hidden; }
.iwx__tree-head{ display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 13px 14px 11px; border-bottom: 1px solid var(--iw-line, rgba(255,255,255,.11)); }
.iwx__tree-title{ font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--iw-faint, #8b909b); }
.iwx__mini-btn{ display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; font-size: 12px; font-weight: 600; cursor: pointer; color: var(--iw-signal-ink, #0f2b33); border: 1px solid transparent; border-radius: 8px; background: linear-gradient(155deg, var(--iw-signal-2, #7fdfe8), var(--iw-signal, #3fc9d4)); }
.iwx__mini-btn:hover{ filter: brightness(1.05); }
.iwx__mini-btn:focus-visible{ outline: 2px solid var(--iw-signal, #3fc9d4); outline-offset: 2px; }
.iwx__tree-body{ flex: 1 1 auto; overflow: auto; padding: 8px 8px 12px; scrollbar-width: thin; }
.iwx__node{ display: flex; align-items: center; gap: 4px; padding: 6px 7px; border-radius: 8px; cursor: pointer; color: var(--iw-muted, #b9bec7); user-select: none; position: relative; }
.iwx__node:hover{ background: var(--iw-panel-2, #2c2f3a); color: var(--iw-ink, #f2f3f5); }
.iwx__node:focus-visible{ outline: 2px solid var(--iw-signal, #3fc9d4); outline-offset: -1px; }
.iwx__node.is-active{ background: color-mix(in oklch, var(--iw-signal, #3fc9d4) 18%, transparent); color: var(--iw-ink, #f2f3f5); }
.iwx__node.is-drop{ outline: 2px dashed var(--iw-signal, #3fc9d4); outline-offset: -2px; background: color-mix(in oklch, var(--iw-signal, #3fc9d4) 12%, transparent); }
.iwx__twist{ flex: 0 0 auto; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; border: 0; background: none; color: var(--iw-faint, #8b909b); cursor: pointer; font-size: 10px; line-height: 1; padding: 0; transition: transform .12s var(--iw-ease); }
.iwx__twist.is-open{ transform: rotate(90deg); }
.iwx__twist--spacer{ visibility: hidden; }
.iwx__node-ico{ flex: 0 0 auto; width: 16px; height: 16px; opacity: .9; }
.iwx__node-label{ flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; }
.iwx__count{ flex: 0 0 auto; min-width: 20px; text-align: center; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; color: var(--iw-faint, #8b909b); background: color-mix(in oklch, white 7%, transparent); }
.iwx__node-menu{ flex: 0 0 auto; opacity: 0; width: 22px; height: 22px; border: 0; border-radius: 6px; background: none; color: var(--iw-muted, #b9bec7); cursor: pointer; font-size: 15px; line-height: 1; }
.iwx__node:hover .iwx__node-menu, .iwx__node:focus-within .iwx__node-menu{ opacity: 1; }
.iwx__node-menu:hover{ background: color-mix(in oklch, white 12%, transparent); color: var(--iw-ink, #f2f3f5); }
.iwx__children{ margin-left: 15px; padding-left: 5px; border-left: 1px solid var(--iw-line, rgba(255,255,255,.11)); }
.iwx__tree-sep{ height: 1px; margin: 6px 6px; background: var(--iw-line, rgba(255,255,255,.11)); }

/* ── Right pane: toolbar + grid ─────────────────────────────────────────── */
.iwx__main{ min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.iwx__toolbar{ display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; padding: 12px 14px; }
.iwx__crumbs{ display: flex; flex-wrap: wrap; gap: 3px; align-items: center; flex: 1 1 260px; min-width: 0; font-size: 13.5px; }
.iwx__crumb{ background: none; border: 0; padding: 2px 3px; cursor: pointer; color: var(--iw-signal-2, #7fdfe8); font-size: 13.5px; border-radius: 5px; }
.iwx__crumb:hover{ text-decoration: underline; }
.iwx__crumb.is-current{ color: var(--iw-ink, #f2f3f5); cursor: default; font-weight: 600; }
.iwx__crumb-sep{ color: var(--iw-faint, #8b909b); }
.iwx__controls{ display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.iwx__field{ display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--iw-faint, #8b909b); }
.iwx input[type="search"], .iwx select{
	height: 34px; padding: 0 10px; font-size: 13px; color: var(--iw-ink, #f2f3f5);
	background: var(--iw-field, #262932); border: 1px solid var(--iw-line-2, rgba(255,255,255,.2));
	border-radius: 8px; max-width: 100%; color-scheme: dark;
}
.iwx select{ padding-right: 26px; }
.iwx select option, .iwx select optgroup{ background: var(--iw-panel-2, #2c2f3a); color: var(--iw-ink, #f2f3f5); }
.iwx input[type="search"]{ min-width: 150px; }
.iwx input:focus, .iwx select:focus{ outline: 0; border-color: var(--iw-signal, #3fc9d4); box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-signal, #3fc9d4) 26%, transparent); }
.iwx__chips{ display: flex; flex-wrap: wrap; gap: 6px; }
.iwx__chips:empty{ display: none; }
.iwx__chip{ display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 999px; font-size: 12px; font-weight: 600; cursor: pointer; color: var(--iw-muted, #b9bec7); border: 1px solid var(--iw-line-2, rgba(255,255,255,.2)); background: var(--iw-panel-2, #2c2f3a); }
.iwx__chip:hover{ color: var(--iw-ink, #f2f3f5); border-color: var(--iw-signal, #3fc9d4); }
.iwx__chip.is-active{ color: var(--iw-signal-ink, #0f2b33); border-color: transparent; background: linear-gradient(155deg, var(--iw-signal-2, #7fdfe8), var(--iw-signal, #3fc9d4)); }
.iwx__chip .iwx__count{ background: color-mix(in oklch, black 18%, transparent); }

/* ── Media grid ─────────────────────────────────────────────────────────── */
.iwx__gridwrap{ padding: 4px 2px; }
.iwx__grid{ display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 14px; }
.iwx__grid.is-compact{ grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; }
.iwx__card{ position: relative; display: flex; flex-direction: column; border: 1px solid var(--iw-line, rgba(255,255,255,.11)); border-radius: 12px; overflow: hidden; background: var(--iw-panel, #23262f); cursor: pointer; transition: transform .12s var(--iw-ease), border-color .14s var(--iw-ease), box-shadow .14s var(--iw-ease); }
.iwx__card:hover{ transform: translateY(-2px); border-color: var(--iw-line-2, rgba(255,255,255,.2)); box-shadow: 0 12px 26px -18px rgba(0,0,0,.9); }
.iwx__card:focus-visible{ outline: 2px solid var(--iw-signal, #3fc9d4); outline-offset: 2px; }
.iwx__card.is-selected{ border-color: transparent; box-shadow: 0 0 0 2px var(--iw-signal, #3fc9d4), 0 12px 26px -18px rgba(0,0,0,.9); }
.iwx__card.is-dragging{ opacity: .5; }
.iwx__thumb{ position: relative; aspect-ratio: 1 / 1; background: var(--iw-field, #262932); display: grid; place-items: center; overflow: hidden; }
.iwx__thumb img{ width: 100%; height: 100%; object-fit: cover; display: block; }
.iwx__thumb-ph{ display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--iw-faint, #8b909b); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.iwx__thumb-ph svg{ width: 30px; height: 30px; opacity: .7; }
.iwx__card-check{ position: absolute; top: 8px; left: 8px; width: 18px; height: 18px; margin: 0; cursor: pointer; accent-color: var(--iw-signal, #3fc9d4); z-index: 2; }
.iwx__card-type{ position: absolute; top: 7px; right: 7px; padding: 2px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: .03em; color: var(--iw-ink, #f2f3f5); background: color-mix(in oklch, black 55%, transparent); backdrop-filter: blur(3px); }
.iwx__meta{ padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 5px; }
.iwx__title{ font-size: 12.5px; line-height: 1.3; color: var(--iw-ink, #f2f3f5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iwx__badges{ display: flex; flex-wrap: wrap; gap: 4px; }
.iwx__badge{ display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 7px; border-radius: 6px; font-size: 10.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iwx__badge--folder{ color: var(--iw-signal-2, #7fdfe8); background: color-mix(in oklch, var(--iw-signal, #3fc9d4) 16%, transparent); }
.iwx__badge--tag{ color: var(--iw-muted, #b9bec7); background: color-mix(in oklch, white 8%, transparent); }
.iwx__empty{ padding: 60px 20px; text-align: center; color: var(--iw-faint, #8b909b); font-size: 14px; }
.iwx__empty strong{ display: block; margin-bottom: 6px; color: var(--iw-muted, #b9bec7); font-size: 15px; }

/* ── Pagination ─────────────────────────────────────────────────────────── */
.iwx__pager{ display: flex; align-items: center; justify-content: center; gap: 12px; padding: 6px 0 2px; font-size: 13px; color: var(--iw-muted, #b9bec7); }
.iwx__pg-btn{ display: inline-flex; align-items: center; gap: 5px; height: 34px; padding: 0 14px; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--iw-ink, #f2f3f5); border: 1px solid var(--iw-line-2, rgba(255,255,255,.2)); border-radius: 8px; background: var(--iw-panel-2, #2c2f3a); }
.iwx__pg-btn:hover:not([disabled]){ border-color: var(--iw-signal, #3fc9d4); }
.iwx__pg-btn[disabled]{ opacity: .45; cursor: default; }

/* ── Selection action bar ───────────────────────────────────────────────── */
.iwx__actionbar{ position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 12px 24px; color: var(--iw-ink, #f2f3f5); background: color-mix(in oklch, var(--iw-panel, #23262f) 94%, transparent); backdrop-filter: blur(10px); border-top: 1px solid var(--iw-line-2, rgba(255,255,255,.2)); box-shadow: 0 -14px 34px -22px rgba(0,0,0,.9); transform: translateY(130%); transition: transform .22s var(--iw-ease); }
.iwx__actionbar.is-visible{ transform: translateY(0); }
.iwx__selcount{ font-size: 13.5px; font-weight: 650; }
.iwx__selcount b{ color: var(--iw-signal-2, #7fdfe8); }
.iwx__ab-spacer{ margin-left: auto; }
.iwx__ab-btn{ display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 15px; font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 9px; border: 1px solid var(--iw-line-2, rgba(255,255,255,.2)); background: var(--iw-panel-2, #2c2f3a); color: var(--iw-ink, #f2f3f5); }
.iwx__ab-btn:hover{ border-color: var(--iw-signal, #3fc9d4); }
.iwx__ab-btn--primary{ color: var(--iw-signal-ink, #0f2b33); border-color: transparent; background: linear-gradient(155deg, var(--iw-signal-2, #7fdfe8), var(--iw-signal, #3fc9d4)); }
.iwx__ab-btn--ghost{ background: none; border-color: transparent; color: var(--iw-faint, #8b909b); }
.iwx__ab-btn--ghost:hover{ color: var(--iw-ink, #f2f3f5); background: color-mix(in oklch, white 8%, transparent); }

/* ── Context menu ───────────────────────────────────────────────────────── */
.iwx__menu{ position: fixed; z-index: 70; min-width: 168px; padding: 6px; border-radius: 10px; background: var(--iw-panel-2, #2c2f3a); border: 1px solid var(--iw-line-2, rgba(255,255,255,.2)); box-shadow: 0 22px 50px -18px rgba(0,0,0,.85); }
.iwx__menu-item{ display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 10px; border: 0; border-radius: 7px; background: none; color: var(--iw-ink, #f2f3f5); font-size: 13px; text-align: left; cursor: pointer; }
.iwx__menu-item:hover{ background: color-mix(in oklch, var(--iw-signal, #3fc9d4) 20%, transparent); }
.iwx__menu-item--danger{ color: var(--iw-bad, #ef7a6b); }
.iwx__menu-item--danger:hover{ background: color-mix(in oklch, var(--iw-bad, #ef7a6b) 18%, transparent); }

/* ── Toasts ─────────────────────────────────────────────────────────────── */
.iwx__toasts{ position: fixed; right: 18px; bottom: 84px; z-index: 80; display: flex; flex-direction: column; gap: 8px; max-width: min(360px, calc(100vw - 36px)); pointer-events: none; }
.iwx__toast{ padding: 11px 15px; border-radius: 10px; font-size: 13px; font-weight: 550; color: var(--iw-ink, #f2f3f5); background: var(--iw-panel-2, #2c2f3a); border: 1px solid var(--iw-line-2, rgba(255,255,255,.2)); box-shadow: 0 16px 38px -16px rgba(0,0,0,.85); opacity: 1; transform: translateY(0); transition: opacity .3s var(--iw-ease), transform .3s var(--iw-ease); }
.iwx__toast.is-out{ opacity: 0; transform: translateY(8px); }
.iwx__toast--ok{ border-color: color-mix(in oklch, var(--iw-good, #43d19b) 55%, transparent); }
.iwx__toast--bad{ border-color: color-mix(in oklch, var(--iw-bad, #ef7a6b) 55%, transparent); }

/* ── Responsive: collapse to one column on narrow widths ────────────────── */
@media (max-width: 880px){
	.iwx{ grid-template-columns: 1fr; padding: 16px 14px 128px; }
	.iwx__tree{ position: static; max-height: 340px; }
}
@media (max-width: 600px){
	.iwx__controls{ width: 100%; }
	.iwx__actionbar{ padding: 10px 14px; }
	.iwx__ab-spacer{ margin-left: 0; }
}
@media (prefers-reduced-motion: reduce){
	.iwx__card, .iwx__actionbar, .iwx__toast, .iwx__twist{ transition: none; }
}

/* ── Toolbar buttons: Folders drawer toggle + Select mode toggle ─────────── */
.iwx__toolbtn{ display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--iw-ink, #f2f3f5); border: 1px solid var(--iw-line-2, rgba(255,255,255,.2)); border-radius: 8px; background: var(--iw-panel-2, #2c2f3a); }
.iwx__toolbtn:hover{ border-color: var(--iw-signal, #3fc9d4); }
.iwx__toolbtn:focus-visible{ outline: 2px solid var(--iw-signal, #3fc9d4); outline-offset: 2px; }
.iwx__toolbtn.is-active{ color: var(--iw-signal-ink, #0f2b33); border-color: transparent; background: linear-gradient(155deg, var(--iw-signal-2, #7fdfe8), var(--iw-signal, #3fc9d4)); }
.iwx__drawer-toggle{ display: none; }
.iwx__drawer-back{ display: none; }

/* ── Folder accent (colour dot / emoji) on tree nodes + card badges ──────── */
.iwx__accent{ flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; font-size: 13px; line-height: 1; }
.iwx__accent--dot{ width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 0 2px color-mix(in oklch, black 30%, transparent); }
.iwx__badge .iwx__accent{ width: 12px; height: 12px; font-size: 11px; }
.iwx__badge .iwx__accent--dot{ width: 8px; height: 8px; }

/* ── Touch drag ghost (Pointer-Events layer) ─────────────────────────────── */
.iwx__ghost{ position: fixed; z-index: 90; top: 0; left: 0; transform: translate(10px, 10px); padding: 7px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 650; color: var(--iw-signal-ink, #0f2b33); background: linear-gradient(155deg, var(--iw-signal-2, #7fdfe8), var(--iw-signal, #3fc9d4)); box-shadow: 0 12px 30px -10px rgba(0,0,0,.8); pointer-events: none; white-space: nowrap; }
.iwx__card.is-grabbed, .iwx__node.is-grabbed{ opacity: .55; }

/* ── Bottom-sheet / centered-dialog modal (Move picker + Colour picker) ──── */
.iwx__sheet-back{ position: fixed; inset: 0; z-index: 85; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,.55); opacity: 0; transition: opacity .18s var(--iw-ease); }
.iwx__sheet-back.is-open{ opacity: 1; }
.iwx__sheet{ width: min(440px, 100%); max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; border-radius: var(--iw-r, 16px); background: var(--iw-panel, #23262f); border: 1px solid var(--iw-line-2, rgba(255,255,255,.2)); box-shadow: 0 30px 70px -20px rgba(0,0,0,.85); transform: translateY(10px); transition: transform .2s var(--iw-ease); }
.iwx__sheet-back.is-open .iwx__sheet{ transform: translateY(0); }
.iwx__sheet-head{ display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--iw-line, rgba(255,255,255,.11)); }
.iwx__sheet-title{ font-size: 14px; font-weight: 700; color: var(--iw-ink, #f2f3f5); }
.iwx__sheet-close{ width: 36px; height: 36px; border: 0; border-radius: 8px; background: none; color: var(--iw-muted, #b9bec7); font-size: 22px; line-height: 1; cursor: pointer; }
.iwx__sheet-close:hover{ background: color-mix(in oklch, white 10%, transparent); color: var(--iw-ink, #f2f3f5); }
.iwx__sheet-body{ padding: 10px; overflow: auto; }
.iwx__picker{ display: flex; flex-direction: column; gap: 2px; }
.iwx__picker-row{ display: flex; align-items: center; gap: 9px; width: 100%; min-height: 44px; padding: 8px 12px; border: 0; border-radius: 9px; background: none; color: var(--iw-ink, #f2f3f5); font-size: 13.5px; text-align: left; cursor: pointer; }
.iwx__picker-row:hover{ background: color-mix(in oklch, var(--iw-signal, #3fc9d4) 18%, transparent); }
.iwx__picker-row:focus-visible{ outline: 2px solid var(--iw-signal, #3fc9d4); outline-offset: -2px; }
.iwx__swatches{ display: flex; flex-wrap: wrap; gap: 10px; padding: 8px; }
.iwx__swatch{ display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; padding: 0; font-size: 20px; border: 1px solid var(--iw-line-2, rgba(255,255,255,.2)); border-radius: 12px; background: var(--iw-panel-2, #2c2f3a); cursor: pointer; color: var(--iw-ink, #f2f3f5); }
.iwx__swatch:hover{ border-color: var(--iw-signal, #3fc9d4); }
.iwx__swatch:focus-visible{ outline: 2px solid var(--iw-signal, #3fc9d4); outline-offset: 2px; }
.iwx__swatch--none{ font-size: 12px; font-weight: 600; padding: 0 14px; }

/* ── Narrow: folder tree becomes a slide-in drawer; ≥44px tap targets ────── */
@media (max-width: 880px){
	.iwx__drawer-toggle{ display: inline-flex; }
	.iwx__tree{ position: fixed; top: 0; left: 0; bottom: 0; z-index: 60; width: min(84vw, 320px); max-height: none; border-radius: 0; transform: translateX(-104%); transition: transform .22s var(--iw-ease); box-shadow: 0 0 44px -6px rgba(0,0,0,.85); }
	.iwx.is-drawer-open .iwx__tree{ transform: translateX(0); }
	.iwx__drawer-back{ display: block; position: fixed; inset: 0; z-index: 55; background: rgba(0,0,0,.5); opacity: 0; visibility: hidden; transition: opacity .2s var(--iw-ease); }
	.iwx.is-drawer-open .iwx__drawer-back{ opacity: 1; visibility: visible; }
	.iwx__node{ min-height: 44px; padding: 8px 8px; }
	.iwx__node-menu{ opacity: 1; width: 40px; height: 40px; font-size: 18px; }
	.iwx__twist{ width: 34px; height: 40px; }
	.iwx__card-check{ width: 26px; height: 26px; top: 6px; left: 6px; }
	.iwx__toolbtn, .iwx__mini-btn, .iwx__ab-btn, .iwx__pg-btn, .iwx input[type="search"], .iwx select{ min-height: 44px; }
	.iwx__chip{ min-height: 38px; }
}

@media (prefers-reduced-motion: reduce){
	.iwx__tree, .iwx__drawer-back, .iwx__sheet, .iwx__sheet-back{ transition: none; }
}

/* ── CDN + lossless fusion: per-card status pills ────────────────────────── */
.iwx__pills{ display: flex; flex-wrap: wrap; gap: 4px; }
.iwx__pill{ display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 6px; font-size: 10px; font-weight: 700; letter-spacing: .02em; white-space: nowrap; border: 1px solid transparent; }
.iwx__pill::before{ content: ""; width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: currentColor; }
.iwx__pill--on{ color: var(--iw-good, #43d19b); background: color-mix(in oklch, var(--iw-good, #43d19b) 15%, transparent); }
.iwx__pill--off{ color: var(--iw-faint, #8b909b); background: color-mix(in oklch, white 7%, transparent); }
.iwx__pill--cdn.iwx__pill--on{ color: var(--iw-signal-2, #7fdfe8); background: color-mix(in oklch, var(--iw-signal, #3fc9d4) 16%, transparent); }

/* ── Status filter bar (Not-lossless / Not-on-CDN chips + select-all) ─────── */
.iwx__statusbar{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; width: 100%; }
.iwx__statusbar[hidden]{ display: none; }
.iwx__statuslabel{ font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--iw-faint, #8b909b); }
.iwx__selectall{ display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 4px 12px; font-size: 12.5px; font-weight: 650; cursor: pointer; color: var(--iw-signal-ink, #0f2b33); border: 1px solid transparent; border-radius: 8px; background: linear-gradient(155deg, var(--iw-signal-2, #7fdfe8), var(--iw-signal, #3fc9d4)); }
.iwx__selectall[hidden]{ display: none; }
.iwx__selectall:hover{ filter: brightness(1.05); }
.iwx__selectall:focus-visible{ outline: 2px solid var(--iw-signal, #3fc9d4); outline-offset: 2px; }

/* ── Action-bar fusion verbs (only when image_optimization is unlocked) ───── */
.iwx__ab-opt{ display: inline-flex; flex-wrap: wrap; gap: 8px; }
.iwx__ab-opt[hidden]{ display: none; }
@media (max-width: 880px){
	.iwx__selectall{ min-height: 44px; }
}
CSS;
		echo "\n</style>\n";
	}

	// ── static two-pane markup ─────────────────────────────────────────────────────

	/**
	 * The static shell the browser trusts: the two panes, the toolbar controls, the empty
	 * grid + pager, the (hidden) selection action bar, and the toast region. Every list is
	 * filled at runtime by the driver with textContent — there is no server data in here.
	 */
	private function render_explorer_markup(): void {
		echo '<div class="iwx">';

		// Drawer backdrop (narrow screens only; tap to close the folder drawer).
		echo '<div class="iwx__drawer-back" id="iwx-drawer-back" aria-hidden="true"></div>';

		// Left pane — folder tree.
		echo '<aside class="iwx__panel iwx__tree" aria-label="' . self::esc_attr_safe( 'Folders' ) . '">';
		echo '<div class="iwx__tree-head">';
		echo '<span class="iwx__tree-title">' . self::esc_html_safe( 'Folders' ) . '</span>';
		echo '<button type="button" class="iwx__mini-btn" id="iwx-newfolder">+ ' . self::esc_html_safe( 'New folder' ) . '</button>';
		echo '</div>';
		echo '<div class="iwx__tree-body" id="iwx-tree-body" role="tree"></div>';
		echo '</aside>';

		// Right pane — toolbar + grid + pager.
		echo '<section class="iwx__main">';

		echo '<div class="iwx__panel iwx__toolbar">';
		echo '<button type="button" class="iwx__toolbtn iwx__drawer-toggle" id="iwx-folders-toggle" aria-expanded="false" aria-controls="iwx-tree-body">' . self::esc_html_safe( 'Folders' ) . '</button>';
		echo '<nav class="iwx__crumbs" id="iwx-crumbs" aria-label="' . self::esc_attr_safe( 'Breadcrumb' ) . '"></nav>';
		echo '<div class="iwx__controls">';
		echo '<input type="search" id="iwx-search" placeholder="' . self::esc_attr_safe( 'Search media…' ) . '" autocomplete="off" aria-label="' . self::esc_attr_safe( 'Search media' ) . '" />';

		echo '<label class="iwx__field">' . self::esc_html_safe( 'Type' ) . ' <select id="iwx-mime">';
		echo '<option value="all">' . self::esc_html_safe( 'All types' ) . '</option>';
		echo '<option value="image">' . self::esc_html_safe( 'Images' ) . '</option>';
		echo '<option value="video">' . self::esc_html_safe( 'Video' ) . '</option>';
		echo '<option value="audio">' . self::esc_html_safe( 'Audio' ) . '</option>';
		echo '<option value="document">' . self::esc_html_safe( 'Documents' ) . '</option>';
		echo '</select></label>';

		echo '<label class="iwx__field">' . self::esc_html_safe( 'Sort' ) . ' <select id="iwx-orderby">';
		echo '<option value="date">' . self::esc_html_safe( 'Date' ) . '</option>';
		echo '<option value="title">' . self::esc_html_safe( 'Title' ) . '</option>';
		echo '<option value="filename">' . self::esc_html_safe( 'Filename' ) . '</option>';
		echo '<option value="size">' . self::esc_html_safe( 'Size' ) . '</option>';
		echo '</select></label>';

		echo '<select id="iwx-order" aria-label="' . self::esc_attr_safe( 'Sort direction' ) . '">';
		echo '<option value="desc">' . self::esc_html_safe( 'Descending' ) . '</option>';
		echo '<option value="asc">' . self::esc_html_safe( 'Ascending' ) . '</option>';
		echo '</select>';

		echo '<select id="iwx-density" aria-label="' . self::esc_attr_safe( 'View density' ) . '">';
		echo '<option value="comfortable">' . self::esc_html_safe( 'Comfortable' ) . '</option>';
		echo '<option value="compact">' . self::esc_html_safe( 'Compact' ) . '</option>';
		echo '</select>';
		echo '<button type="button" class="iwx__toolbtn iwx__select-toggle" id="iwx-select-toggle" aria-pressed="false">' . self::esc_html_safe( 'Select' ) . '</button>';
		echo '</div>'; // .iwx__controls
		echo '<div class="iwx__chips" id="iwx-chips" aria-label="' . self::esc_attr_safe( 'Filter by tag' ) . '"></div>';

		// CDN + lossless status filter bar (populated + revealed by the driver only when
		// the image_optimization flag is unlocked; stays hidden + empty otherwise).
		echo '<div class="iwx__statusbar" id="iwx-statusbar" hidden>';
		echo '<span class="iwx__statuslabel">' . self::esc_html_safe( 'Status' ) . '</span>';
		echo '<div class="iwx__chips" id="iwx-status-chips" aria-label="' . self::esc_attr_safe( 'Filter by optimization / CDN status' ) . '"></div>';
		echo '<button type="button" class="iwx__selectall" id="iwx-selectall" hidden></button>';
		echo '</div>';
		echo '</div>'; // .iwx__toolbar

		echo '<div class="iwx__panel iwx__gridwrap">';
		echo '<div class="iwx__grid" id="iwx-grid" aria-busy="true"></div>';
		echo '</div>';

		echo '<div class="iwx__pager">';
		echo '<button type="button" class="iwx__pg-btn" id="iwx-prev" disabled>' . self::esc_html_safe( '‹ Prev' ) . '</button>';
		echo '<span id="iwx-pageinfo" aria-live="polite"></span>';
		echo '<button type="button" class="iwx__pg-btn" id="iwx-next" disabled>' . self::esc_html_safe( 'Next ›' ) . '</button>';
		echo '</div>';

		echo '</section>'; // .iwx__main

		// Selection action bar (hidden until a selection exists).
		echo '<div class="iwx__actionbar" id="iwx-actionbar" role="region" aria-label="' . self::esc_attr_safe( 'Selection actions' ) . '">';
		echo '<span class="iwx__selcount" id="iwx-selcount"></span>';
		// The flat <select> is kept as a hidden, scriptable fallback; the Move button now
		// opens the nested "Move to" folder picker sheet (see openMovePicker in the driver).
		echo '<select id="iwx-move-target" hidden aria-hidden="true" tabindex="-1"></select>';
		echo '<button type="button" class="iwx__ab-btn iwx__ab-btn--primary" id="iwx-move-btn">' . self::esc_html_safe( 'Move to…' ) . '</button>';
		echo '<button type="button" class="iwx__ab-btn" id="iwx-tag-btn">' . self::esc_html_safe( 'Tag…' ) . '</button>';
		// CDN + lossless bulk verbs — revealed by the driver only when image_optimization is unlocked.
		echo '<span class="iwx__ab-opt" id="iwx-ab-opt" hidden>';
		echo '<button type="button" class="iwx__ab-btn" id="iwx-lossless-btn">' . self::esc_html_safe( 'Make lossless' ) . '</button>';
		echo '<button type="button" class="iwx__ab-btn" id="iwx-offload-btn">' . self::esc_html_safe( 'Offload to CDN' ) . '</button>';
		echo '<button type="button" class="iwx__ab-btn" id="iwx-restore-btn">' . self::esc_html_safe( 'Restore local' ) . '</button>';
		echo '</span>';
		echo '<span class="iwx__ab-spacer"></span>';
		echo '<button type="button" class="iwx__ab-btn iwx__ab-btn--ghost" id="iwx-clear-btn">' . self::esc_html_safe( 'Clear selection' ) . '</button>';
		echo '</div>';

		echo '</div>'; // .iwx

		echo '<div class="iwx__toasts" id="iwx-toasts" aria-live="polite" aria-atomic="false"></div>';
	}

	// ── config object + vanilla-JS driver ──────────────────────────────────────────

	/**
	 * The single inline <script>: a wp_json_encode'd config object (AJAX url + shared
	 * nonce + the action names, all sourced from the IWSL_Media_Folders constants, plus
	 * per-page + localized strings), followed by a dependency-free vanilla driver that
	 * loads the tree + grid, renders both entirely via createElement/textContent, and
	 * wires drag-drop filing, multi-select, filters/sort, a context menu, keyboard nav
	 * and toasts. No server value is ever assigned to innerHTML.
	 */
	private function render_explorer_script(): void {
		$cfg  = array(
			'ajaxUrl' => function_exists( 'admin_url' ) ? admin_url( 'admin-ajax.php' ) : 'admin-ajax.php',
			'nonce'   => function_exists( 'wp_create_nonce' ) ? wp_create_nonce( IWSL_Media_Folders::NONCE ) : '',
			'act'     => array(
				'tree'   => IWSL_Media_Folders::AJAX_TREE,
				'list'   => IWSL_Media_Folders::AJAX_LIST,
				'create' => IWSL_Media_Folders::AJAX_FOLDER_CREATE,
				'rename' => IWSL_Media_Folders::AJAX_FOLDER_RENAME,
				'del'    => IWSL_Media_Folders::AJAX_FOLDER_DELETE,
				'move'   => IWSL_Media_Folders::AJAX_FOLDER_MOVE,
				'assign' => IWSL_Media_Folders::AJAX_ASSIGN,
				'tag'    => IWSL_Media_Folders::AJAX_TAG,
				'detailDel' => IWSL_Media_Folders::AJAX_DETAIL_DELETE,
				'style'     => IWSL_Media_Folders::AJAX_FOLDER_STYLE,
				'selectAll' => IWSL_Media_Folders::AJAX_SELECT_ALL,
				'bulkOpt'   => IWSL_Media_Folders::AJAX_BULK_OPTIMIZE,
				'optStatus' => IWSL_Media_Folders::AJAX_OPTIMIZE_STATUS,
				'bulkOff'   => IWSL_Media_Folders::AJAX_BULK_OFFLOAD,
				'bulkRestore' => IWSL_Media_Folders::AJAX_BULK_RESTORE,
			),
			// The sibling image_optimization gate — the driver reveals the status pills,
			// the status-filter chips and the three bulk verbs ONLY when this is true.
			'optOn'   => $this->feature_unlocked( IWSL_Media_Folders::FEATURE_OPT ),
			'perPage' => IWSL_Media_Folders::LIST_PER_PAGE_DEFAULT,
			'accents' => array(
				'colors' => IWSL_Media_Folders::FOLDER_COLORS,
				'emoji'  => IWSL_Media_Folders::FOLDER_EMOJI,
			),
			'i18n'    => array(
				'allMedia'         => 'All Media',
				'unfiled'          => 'Unfiled',
				'newFolder'        => 'New folder',
				'newSubfolder'     => 'New subfolder',
				'rename'           => 'Rename',
				'delete'           => 'Delete',
				'newFolderPrompt'  => 'Name for the new folder:',
				'renamePrompt'     => 'New name for this folder:',
				'deleteConfirm'    => 'Delete this folder? Files inside become Unfiled — no files are deleted.',
				'tagPrompt'        => 'Add tags (comma-separated):',
				'created'          => 'Folder created.',
				'createFail'       => 'Could not create folder:',
				'renamed'          => 'Folder renamed.',
				'renameFail'       => 'Could not rename folder:',
				'deleted'          => 'Folder deleted.',
				'deleteFail'       => 'Could not delete folder:',
				'folderMoved'      => 'Folder moved.',
				'folderMoveFail'   => 'Could not move folder:',
				'moved'            => 'Files moved.',
				'moveFail'         => 'Could not move files:',
				'tagged'           => 'Tags updated.',
				'tagFail'          => 'Could not update tags:',
				'treeErr'          => 'Could not load folders.',
				'gridErr'          => 'Could not load media.',
				'netErr'           => 'Network error — please retry.',
				'empty'            => 'No media here yet',
				'emptyHint'        => 'Drag files onto a folder to file them, or change your filters.',
				'selected'         => 'selected',
				'pageOf'           => 'Page %1 of %2',
				'items'            => 'items',
				'pickTarget'       => 'Pick a destination folder first.',
				'open'             => 'Open',
				'moveTo'           => 'Move to…',
				'tagRow'           => 'Tag…',
				'colour'           => 'Colour…',
				'colourTitle'      => 'Folder colour',
				'colourNone'       => 'None',
				'moveTitle'        => 'Move to folder',
				'close'            => 'Close',
				'styled'           => 'Folder colour updated.',
				'styleFail'        => 'Could not update colour:',
				'assetDeleted'     => 'File deleted.',
				'assetDeleteFail'  => 'Could not delete the file.',
				'deleteAssetConfirm' => 'Permanently delete this file and its thumbnails? This is NOT the folder delete — the file itself is removed.',
				'dragOne'          => '1 item',
				'lossless'         => 'Lossless',
				'notLossless'      => 'Not lossless',
				'onCdn'            => 'CDN',
				'localOnly'        => 'Local',
				'filtAll'          => 'All',
				'filtNotLossless'  => 'Not lossless',
				'filtNotCdn'       => 'Not on CDN',
				'selectAllN'       => 'Select all %1 matching',
				'selectedAllN'     => 'Selected %1 matching (library-wide).',
				'selectAllCapped'  => 'Selected the first %1 (more match — narrow the filter).',
				'makeLossless'     => 'Make lossless',
				'offloadCdn'       => 'Offload to CDN',
				'restoreLocal'     => 'Restore local',
				'optQueued'        => 'Queued %1 for lossless conversion…',
				'optProgress'      => 'Converting… %1 of %2 optimized.',
				'optDone'          => 'Lossless conversion finished.',
				'optStalled'       => 'Conversion stopped — some items could not be converted.',
				'optFail'          => 'Could not start conversion:',
				'offloadDone'      => 'Offloaded %1, %2 failed.',
				'restoreDone'      => 'Restored %1, %2 failed.',
				'bulkFail'         => 'Bulk action failed:',
				'confirmOptimize'  => 'Make %1 selected files lossless? Conversion runs in the background.',
				'confirmOffload'   => 'Offload %1 selected files to the CDN?',
				'confirmRestore'   => 'Restore %1 selected files from the CDN back to local?',
			),
		);
		$json = function_exists( 'wp_json_encode' ) ? wp_json_encode( $cfg ) : json_encode( $cfg );

		echo "<script>(function(){\nvar CFG=" . $json . ";\n";
		echo <<<'JS'
var A=CFG.act,I=CFG.i18n;
var ALL=-1,UNFILED=0;
var state={folderId:ALL,search:'',mime:'all',tagIds:[],orderby:'date',order:'desc',page:1,perPage:CFG.perPage||60,pages:1,total:0,
	folders:[],counts:{all:0,unfiled:0},tags:[],byId:{},items:[],sel:[],anchor:-1,expanded:{},drag:null,selectMode:false,
	optFilter:'all',offFilter:'all',optPoll:null};
var OPT_ON=!!CFG.optOn,CONFIRM_AT=8;
var menuEl=null,searchTimer=null;
/* Pointer-drag (touch/pen) engine + modal-sheet state — the phone-first layer. */
var LONG_MS=350,SLOP=8,EDGE=52,EDGE_SPEED=14;
var ptr=null,pointerHandledAt=0,scrollRAF=0;
var sheetEl=null,sheetPrevFocus=null;
function pointerAvail(){return typeof window!=='undefined'&&!!window.PointerEvent;}
function pointerJustHandled(){return (Date.now()-pointerHandledAt)<700;}

function $(id){return document.getElementById(id);}
function el(t,c){var e=document.createElement(t);if(c){e.className=c;}return e;}
function clear(n){while(n&&n.firstChild){n.removeChild(n.firstChild);}}
function num(v){return Number(v)||0;}

function post(action,params){
	var b=new URLSearchParams();b.set('action',action);b.set('nonce',CFG.nonce);
	if(params){Object.keys(params).forEach(function(k){var v=params[k];if(v===undefined||v===null){return;}
		if(Array.isArray(v)){for(var i=0;i<v.length;i++){b.append(k+'[]',v[i]);}}else{b.set(k,v);}});}
	return fetch(CFG.ajaxUrl,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString()}).then(function(r){return r.json();});
}
function ok(j){return !!(j&&j.success!==false&&(!j.data||j.data.ok!==false));}
function payload(j){return (j&&j.data)?j.data:{};}
function why(j){var d=payload(j);return d.reason||'error';}

function toast(msg,kind){var w=$('iwx-toasts');if(!w){return;}var t=el('div','iwx__toast iwx__toast--'+(kind||'info'));t.textContent=msg;w.appendChild(t);
	setTimeout(function(){t.classList.add('is-out');},3200);setTimeout(function(){if(t.parentNode){t.parentNode.removeChild(t);}},3600);}

/* ── tree ──────────────────────────────────────────────────────────────── */
function folderSvg(){var ns='http://www.w3.org/2000/svg';var svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.7');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('class','iwx__node-ico');var p=document.createElementNS(ns,'path');p.setAttribute('d','M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z');svg.appendChild(p);return svg;}

function childrenOf(parent){var out=[];for(var i=0;i<state.folders.length;i++){if(num(state.folders[i].parent)===num(parent)){out.push(state.folders[i]);}}
	out.sort(function(a,b){return (num(a.order)-num(b.order))||String(a.name).localeCompare(String(b.name));});return out;}

function selectFolder(id){state.folderId=id;state.page=1;state.sel=[];state.anchor=-1;renderTree();loadGrid();updateSelUI();if(isNarrow()){closeDrawer();}}

function makeNode(opts){
	// opts: {id,name,count,hasKids,open,depth,real,virtual}
	var node=el('div','iwx__node');node.setAttribute('role','treeitem');node.setAttribute('tabindex','-1');node.dataset.id=opts.id;
	if(num(state.folderId)===num(opts.id)){node.classList.add('is-active');node.setAttribute('aria-selected','true');}
	if(opts.hasKids){node.setAttribute('aria-expanded',opts.open?'true':'false');}
	var tw=el('button','iwx__twist'+(opts.open?' is-open':'')+(opts.hasKids?'':' iwx__twist--spacer'));tw.type='button';tw.textContent='▸';tw.setAttribute('tabindex','-1');tw.setAttribute('aria-hidden','true');
	if(opts.hasKids){tw.addEventListener('click',function(e){e.stopPropagation();state.expanded[opts.id]=!state.expanded[opts.id];renderTree();});}
	node.appendChild(tw);
	node.appendChild(folderSvg());
	if(opts.color){node.appendChild(accentEl(opts.color));}
	var lab=el('span','iwx__node-label');lab.textContent=opts.name;node.appendChild(lab);
	var cnt=el('span','iwx__count');cnt.textContent=String(num(opts.count));node.appendChild(cnt);
	if(opts.real){
		var mb=el('button','iwx__node-menu');mb.type='button';mb.textContent='⋯';mb.setAttribute('aria-label',I.rename+' / '+I.delete);mb.setAttribute('tabindex','-1');
		mb.addEventListener('click',function(e){e.stopPropagation();var r=node.getBoundingClientRect();openMenu(r.right-8,r.bottom-4,opts);});
		node.appendChild(mb);
	}
	node.addEventListener('click',function(){selectFolder(opts.id);});
	node.addEventListener('keydown',function(e){onNodeKey(e,node,opts);});
	if(opts.real){node.addEventListener('contextmenu',function(e){e.preventDefault();openMenu(e.clientX,e.clientY,opts);});}
	// drop targets: real folders accept files+folders; Unfiled accepts files; All accepts folders.
	if(opts.id!==ALL||opts.acceptFolder){wireDrop(node,opts);}
	if(opts.real){wireFolderDrag(node,opts);}
	if(pointerAvail()){wireNodePointer(node,opts);}
	return node;
}

function wireDrop(node,opts){
	node.addEventListener('dragover',function(e){var d=state.drag;if(!d){return;}
		if(d.type==='files'&&opts.id===ALL){return;}
		if(d.type==='folder'){if(opts.id===UNFILED){return;}if(num(d.id)===num(opts.id)){return;}}
		e.preventDefault();try{e.dataTransfer.dropEffect='move';}catch(err){}node.classList.add('is-drop');});
	node.addEventListener('dragleave',function(){node.classList.remove('is-drop');});
	node.addEventListener('drop',function(e){e.preventDefault();node.classList.remove('is-drop');var d=state.drag;if(!d){return;}
		if(d.type==='files'){if(opts.id===ALL){return;}assignFiles(d.ids,opts.id);}
		else if(d.type==='folder'){if(opts.id===UNFILED){return;}var parent=(opts.id===ALL)?0:opts.id;if(num(d.id)===num(parent)){return;}moveFolder(d.id,parent);}
		state.drag=null;});
}
function wireFolderDrag(node,opts){node.setAttribute('draggable','true');
	node.addEventListener('dragstart',function(e){state.drag={type:'folder',id:opts.id};try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','folder:'+opts.id);}catch(err){}});
	node.addEventListener('dragend',function(){state.drag=null;});
}

function renderTree(){
	var body=$('iwx-tree-body');if(!body){return;}clear(body);
	body.appendChild(makeNode({id:ALL,name:I.allMedia,count:state.counts.all,hasKids:false,real:false,acceptFolder:true}));
	body.appendChild(makeNode({id:UNFILED,name:I.unfiled,count:state.counts.unfiled,hasKids:false,real:false}));
	var sep=el('div','iwx__tree-sep');body.appendChild(sep);
	var roots=childrenOf(0);
	for(var i=0;i<roots.length;i++){appendBranch(body,roots[i],0);}
}
function appendBranch(container,folder,depth){
	var kids=childrenOf(folder.id);var open=!!state.expanded[folder.id];
	container.appendChild(makeNode({id:folder.id,name:folder.name,count:folder.count,hasKids:kids.length>0,open:open,depth:depth,real:true,color:folder.color}));
	if(kids.length&&open){var wrap=el('div','iwx__children');for(var i=0;i<kids.length;i++){appendBranch(wrap,kids[i],depth+1);}container.appendChild(wrap);}
}

function onNodeKey(e,node,opts){
	var k=e.key;
	if(k==='Enter'||k===' '){e.preventDefault();selectFolder(opts.id);return;}
	if(opts.real&&k==='F2'){e.preventDefault();renameFolder(opts.id,opts.name);return;}
	if(opts.real&&(k==='Delete')){e.preventDefault();deleteFolder(opts.id);return;}
	if(k==='ArrowRight'){if(opts.hasKids&&!state.expanded[opts.id]){e.preventDefault();state.expanded[opts.id]=true;renderTree();focusNode(opts.id);}return;}
	if(k==='ArrowLeft'){if(opts.hasKids&&state.expanded[opts.id]){e.preventDefault();state.expanded[opts.id]=false;renderTree();focusNode(opts.id);}return;}
	if(k==='ArrowDown'||k==='ArrowUp'){e.preventDefault();var nodes=Array.prototype.slice.call(document.querySelectorAll('.iwx__node'));var idx=nodes.indexOf(node);var n=idx+(k==='ArrowDown'?1:-1);if(n>=0&&n<nodes.length){nodes[n].focus();}}
}
function focusNode(id){var n=document.querySelector('.iwx__node[data-id="'+id+'"]');if(n){n.focus();}}

/* ── context menu ──────────────────────────────────────────────────────── */
function closeMenu(){if(menuEl&&menuEl.parentNode){menuEl.parentNode.removeChild(menuEl);}menuEl=null;}
function openMenu(x,y,opts){closeMenu();var m=el('div','iwx__menu');
	var rows=[{label:I.newSubfolder,fn:function(){createFolder(opts.id);}},
		{label:I.rename,fn:function(){renameFolder(opts.id,opts.name);}},
		{label:I.colour,fn:function(){openColorPicker(opts);}},
		{label:I.delete,danger:true,fn:function(){deleteFolder(opts.id);}}];
	rows.forEach(function(row){var b=el('button','iwx__menu-item'+(row.danger?' iwx__menu-item--danger':''));b.type='button';b.textContent=row.label;
		b.addEventListener('click',function(ev){ev.stopPropagation();closeMenu();row.fn();});m.appendChild(b);});
	document.body.appendChild(m);var w=m.offsetWidth,h=m.offsetHeight;
	m.style.left=Math.max(8,Math.min(x,window.innerWidth-w-8))+'px';
	m.style.top=Math.max(8,Math.min(y,window.innerHeight-h-8))+'px';menuEl=m;
}

/* ── folder mutations ──────────────────────────────────────────────────── */
function createFolder(parent){var name=window.prompt(I.newFolderPrompt,'');if(name===null){return;}name=name.trim();if(!name){return;}
	post(A.create,{name:name,parent:parent||0}).then(function(j){if(ok(j)){toast(I.created,'ok');if(parent>0){state.expanded[parent]=true;}loadTree();}else{toast(I.createFail+' '+why(j),'bad');}}).catch(function(){toast(I.netErr,'bad');});}
function renameFolder(id,cur){var name=window.prompt(I.renamePrompt,cur||'');if(name===null){return;}name=name.trim();if(!name){return;}
	post(A.rename,{id:id,name:name}).then(function(j){if(ok(j)){toast(I.renamed,'ok');loadTree().then(loadGrid);}else{toast(I.renameFail+' '+why(j),'bad');}}).catch(function(){toast(I.netErr,'bad');});}
function deleteFolder(id){if(!window.confirm(I.deleteConfirm)){return;}
	post(A.del,{id:id}).then(function(j){if(ok(j)){toast(I.deleted,'ok');if(num(state.folderId)===num(id)){state.folderId=ALL;}loadTree().then(loadGrid);}else{toast(I.deleteFail+' '+why(j),'bad');}}).catch(function(){toast(I.netErr,'bad');});}
function moveFolder(id,parent){
	post(A.move,{id:id,parent:parent}).then(function(j){if(ok(j)){toast(I.folderMoved,'ok');state.expanded[parent]=true;loadTree();}else{toast(I.folderMoveFail+' '+why(j),'bad');}}).catch(function(){toast(I.netErr,'bad');});}

/* ── file mutations ────────────────────────────────────────────────────── */
function assignFiles(ids,folderId){if(!ids||!ids.length){return;}
	post(A.assign,{ids:ids,folder_id:folderId}).then(function(j){if(ok(j)){toast(I.moved,'ok');reload();}else{toast(I.moveFail+' '+why(j),'bad');}}).catch(function(){toast(I.netErr,'bad');});}
function tagFiles(ids,addNames){if(!ids||!ids.length||!addNames.length){return;}
	post(A.tag,{ids:ids,add:addNames,remove:[]}).then(function(j){if(ok(j)){toast(I.tagged,'ok');reload();}else{toast(I.tagFail+' '+why(j),'bad');}}).catch(function(){toast(I.netErr,'bad');});}

/* ── grid ──────────────────────────────────────────────────────────────── */
function shortType(mime){mime=String(mime||'');if(mime.indexOf('/')<0){return mime.toUpperCase();}var sub=mime.split('/')[1]||'';sub=sub.split('+')[0];if(sub.length>5){var top=mime.split('/')[0];return top.toUpperCase();}return sub.toUpperCase();}
function placeholderThumb(mime){var wrap=el('div','iwx__thumb-ph');var ns='http://www.w3.org/2000/svg';var svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');var p=document.createElementNS(ns,'path');p.setAttribute('d','M6 2h8l4 4v16H6Z');var p2=document.createElementNS(ns,'path');p2.setAttribute('d','M14 2v4h4');svg.appendChild(p);svg.appendChild(p2);wrap.appendChild(svg);var lbl=el('span');lbl.textContent=shortType(mime);wrap.appendChild(lbl);return wrap;}

function makeCard(item,idx){
	var card=el('div','iwx__card');card.setAttribute('tabindex','0');card.dataset.id=item.id;card.dataset.idx=idx;card.setAttribute('draggable','true');
	var chk=el('input','iwx__card-check');chk.type='checkbox';chk.setAttribute('aria-label','Select '+(item.title||item.filename||''));
	chk.checked=inSel(item.id);
	chk.addEventListener('click',function(e){e.stopPropagation();});
	chk.addEventListener('change',function(){toggleSel(item.id,idx);});
	card.appendChild(chk);
	var type=el('span','iwx__card-type');type.textContent=shortType(item.mime);card.appendChild(type);
	var thumb=el('div','iwx__thumb');var src=item.thumb||item.url||'';
	if(src&&String(item.mime||'').indexOf('image/')===0){var img=el('img');img.setAttribute('src',src);img.setAttribute('alt','');img.setAttribute('loading','lazy');thumb.appendChild(img);}
	else if(src&&item.thumb){var img2=el('img');img2.setAttribute('src',src);img2.setAttribute('alt','');img2.setAttribute('loading','lazy');thumb.appendChild(img2);}
	else{thumb.appendChild(placeholderThumb(item.mime));}
	card.appendChild(thumb);
	var meta=el('div','iwx__meta');
	var title=el('div','iwx__title');title.textContent=item.title||item.filename||('#'+item.id);title.title=item.filename||'';meta.appendChild(title);
	var badges=el('div','iwx__badges');
	if(num(item.folder_id)>0&&state.byId[item.folder_id]){var fdef=state.byId[item.folder_id];var fb=el('span','iwx__badge iwx__badge--folder');if(fdef.color){fb.appendChild(accentEl(fdef.color));}var ft=el('span');ft.textContent=fdef.name;fb.appendChild(ft);badges.appendChild(fb);}
	var tags=Array.isArray(item.tags)?item.tags:[];
	for(var t=0;t<tags.length&&t<4;t++){var tb=el('span','iwx__badge iwx__badge--tag');tb.textContent='#'+(tags[t].name||'');badges.appendChild(tb);}
	if(badges.childNodes.length){meta.appendChild(badges);}
	if(OPT_ON&&typeof item.lossless!=='undefined'){var pills=el('div','iwx__pills');
		pills.appendChild(statusPill(item.lossless?I.lossless:I.notLossless,!!item.lossless,'opt'));
		pills.appendChild(statusPill(item.cdn?I.onCdn:I.localOnly,!!item.cdn,'cdn'));meta.appendChild(pills);}
	card.appendChild(meta);
	card.addEventListener('click',function(e){if(e.target===chk){return;}if(pointerJustHandled()){return;}onCardClick(e,item.id,idx);});
	card.addEventListener('dblclick',function(e){e.preventDefault();openViewer(item.id);});
	card.addEventListener('contextmenu',function(e){e.preventDefault();openCardMenu(e.clientX,e.clientY,item,idx);});
	card.addEventListener('keydown',function(e){onCardKey(e,card,item.id,idx);});
	card.addEventListener('dragstart',function(e){onCardDrag(e,card,item.id);});
	card.addEventListener('dragend',function(){card.classList.remove('is-dragging');state.drag=null;});
	if(pointerAvail()){wireCardPointer(card,item,idx);}
	return card;
}

function renderGrid(){
	var g=$('iwx-grid');if(!g){return;}g.setAttribute('aria-busy','false');clear(g);
	// keep only still-present selections.
	var present={};state.items.forEach(function(it){present[it.id]=true;});state.sel=state.sel.filter(function(id){return present[id];});
	if(!state.items.length){var e=el('div','iwx__empty');var s=el('strong');s.textContent=I.empty;e.appendChild(s);var p=document.createTextNode(I.emptyHint);e.appendChild(p);g.appendChild(e);updateSelUI();return;}
	for(var i=0;i<state.items.length;i++){g.appendChild(makeCard(state.items[i],i));}
	updateSelUI();
}

/* ── multi-select ──────────────────────────────────────────────────────── */
function inSel(id){return state.sel.indexOf(id)>=0||state.sel.indexOf(String(id))>=0;}
function toggleSel(id,idx){var pos=state.sel.indexOf(id);if(pos>=0){state.sel.splice(pos,1);}else{state.sel.push(id);}state.anchor=idx;updateSelUI();}
function onCardClick(e,id,idx){
	if(state.selectMode){toggleSel(id,idx);return;}
	if(e.shiftKey&&state.anchor>=0){var lo=Math.min(state.anchor,idx),hi=Math.max(state.anchor,idx);var range=[];for(var i=lo;i<=hi;i++){if(state.items[i]){range.push(state.items[i].id);}}state.sel=range;}
	else if(e.ctrlKey||e.metaKey){toggleSel(id,idx);return;}
	else{state.sel=[id];state.anchor=idx;}
	updateSelUI();
}
function onCardKey(e,card,id,idx){
	var k=e.key;
	if(k===' '){e.preventDefault();toggleSel(id,idx);return;}
	if(k==='Enter'){e.preventDefault();state.sel=[id];state.anchor=idx;updateSelUI();return;}
	if(k==='ArrowLeft'||k==='ArrowRight'||k==='ArrowUp'||k==='ArrowDown'){e.preventDefault();moveCardFocus(card,k);}
}
function gridCols(){var cards=document.querySelectorAll('.iwx__card');if(!cards.length){return 1;}var top=cards[0].offsetTop,c=0;for(var i=0;i<cards.length;i++){if(cards[i].offsetTop===top){c++;}else{break;}}return Math.max(1,c);}
function moveCardFocus(card,k){var cards=Array.prototype.slice.call(document.querySelectorAll('.iwx__card'));var idx=cards.indexOf(card);if(idx<0){return;}var cols=gridCols();var n=idx;
	if(k==='ArrowLeft'){n=idx-1;}else if(k==='ArrowRight'){n=idx+1;}else if(k==='ArrowUp'){n=idx-cols;}else if(k==='ArrowDown'){n=idx+cols;}
	if(n>=0&&n<cards.length){cards[n].focus();}}
function onCardDrag(e,card,id){var ids=inSel(id)?state.sel.slice():[id];if(!inSel(id)){state.sel=[id];updateSelUI();}state.drag={type:'files',ids:ids};card.classList.add('is-dragging');try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','files:'+ids.join(','));}catch(err){}}

function updateSelUI(){
	var cards=document.querySelectorAll('.iwx__card');for(var i=0;i<cards.length;i++){var id=cards[i].dataset.id;var on=inSel(id)||inSel(num(id));cards[i].classList.toggle('is-selected',on);var cb=cards[i].querySelector('.iwx__card-check');if(cb){cb.checked=on;}}
	var bar=$('iwx-actionbar');var n=state.sel.length;if(bar){bar.classList.toggle('is-visible',n>0);}
	var sc=$('iwx-selcount');if(sc){clear(sc);var b=el('b');b.textContent=String(n);sc.appendChild(b);sc.appendChild(document.createTextNode(' '+I.selected));}
}

/* ── breadcrumb, chips, move-target ───────────────────────────────────── */
function folderPath(id){var out=[];var f=state.byId[id];var guard=0;while(f&&guard<64){out.unshift(f);f=num(f.parent)>0?state.byId[f.parent]:null;guard++;}return out;}
function crumb(label,current,fn){var b=el('button','iwx__crumb'+(current?' is-current':''));b.type='button';b.textContent=label;if(current){b.disabled=true;}else if(fn){b.addEventListener('click',fn);}return b;}
function renderCrumbs(){var c=$('iwx-crumbs');if(!c){return;}clear(c);
	var atAll=num(state.folderId)===ALL;
	c.appendChild(crumb(I.allMedia,atAll,function(){selectFolder(ALL);}));
	if(num(state.folderId)===UNFILED){c.appendChild(sepNode());c.appendChild(crumb(I.unfiled,true));return;}
	if(!atAll){var path=folderPath(state.folderId);for(var i=0;i<path.length;i++){c.appendChild(sepNode());var f=path[i];var last=(i===path.length-1);(function(fid,isLast){c.appendChild(crumb(f.name,isLast,isLast?null:function(){selectFolder(fid);}));})(f.id,last);}}
}
function sepNode(){var s=el('span','iwx__crumb-sep');s.textContent='/';return s;}

function renderChips(){var c=$('iwx-chips');if(!c){return;}clear(c);
	for(var i=0;i<state.tags.length;i++){(function(tag){var active=state.tagIds.indexOf(tag.id)>=0||state.tagIds.indexOf(String(tag.id))>=0;
		var chip=el('button','iwx__chip'+(active?' is-active':''));chip.type='button';chip.setAttribute('aria-pressed',active?'true':'false');
		var lbl=el('span');lbl.textContent='#'+tag.name;chip.appendChild(lbl);
		var cnt=el('span','iwx__count');cnt.textContent=String(num(tag.count));chip.appendChild(cnt);
		chip.addEventListener('click',function(){var pos=-1;for(var k=0;k<state.tagIds.length;k++){if(num(state.tagIds[k])===num(tag.id)){pos=k;break;}}if(pos>=0){state.tagIds.splice(pos,1);}else{state.tagIds.push(tag.id);}state.page=1;renderChips();loadGrid();});
		c.appendChild(chip);})(state.tags[i]);}
}

function buildMoveTarget(){var sel=$('iwx-move-target');if(!sel){return;}var prev=sel.value;clear(sel);
	var un=el('option');un.value=String(UNFILED);un.textContent=I.unfiled;sel.appendChild(un);
	var roots=childrenOf(0);function walk(f,depth){var o=el('option');o.value=String(f.id);var pad='';for(var d=0;d<depth;d++){pad+='— ';}o.textContent=pad+f.name;sel.appendChild(o);var kids=childrenOf(f.id);for(var i=0;i<kids.length;i++){walk(kids[i],depth+1);}}
	for(var r=0;r<roots.length;r++){walk(roots[r],0);}
	if(prev){sel.value=prev;}
}

/* ── loaders ───────────────────────────────────────────────────────────── */
function loadTree(){return post(A.tree,{}).then(function(j){var d=payload(j);
	state.folders=Array.isArray(d.folders)?d.folders:[];
	state.counts=d.counts||{all:0,unfiled:0};
	state.tags=Array.isArray(d.tags)?d.tags:[];
	state.byId={};state.folders.forEach(function(f){state.byId[f.id]=f;});
	renderTree();renderChips();buildMoveTarget();
	}).catch(function(){toast(I.treeErr,'bad');});}
function loadGrid(){var g=$('iwx-grid');if(g){g.setAttribute('aria-busy','true');}
	return post(A.list,{folder_id:state.folderId,search:state.search,mime_group:state.mime,tag_ids:state.tagIds,orderby:state.orderby,order:state.order,opt_filter:state.optFilter,off_filter:state.offFilter,page:state.page,per_page:state.perPage}).then(function(j){var d=payload(j);
	state.items=Array.isArray(d.items)?d.items:[];
	state.total=num(d.total);state.pages=Math.max(1,num(d.pages)||1);if(d.page){state.page=num(d.page);}
	renderGrid();renderPager();renderCrumbs();updateSelectAll();
	}).catch(function(){toast(I.gridErr,'bad');var gg=$('iwx-grid');if(gg){gg.setAttribute('aria-busy','false');}});}
function reload(){return loadTree().then(loadGrid);}

function renderPager(){var info=$('iwx-pageinfo');if(info){info.textContent=I.pageOf.replace('%1',state.page).replace('%2',state.pages)+' · '+state.total+' '+I.items;}
	var pv=$('iwx-prev');if(pv){pv.disabled=state.page<=1;}var nx=$('iwx-next');if(nx){nx.disabled=state.page>=state.pages;}}

/* ── wiring ────────────────────────────────────────────────────────────── */
function bind(){
	var nf=$('iwx-newfolder');if(nf){nf.addEventListener('click',function(){createFolder(0);});}
	var s=$('iwx-search');if(s){s.addEventListener('input',function(){if(searchTimer){clearTimeout(searchTimer);}searchTimer=setTimeout(function(){state.search=s.value;state.page=1;loadGrid();},320);});
		s.addEventListener('keydown',function(e){if(e.key==='Enter'){if(searchTimer){clearTimeout(searchTimer);}state.search=s.value;state.page=1;loadGrid();}});}
	var mm=$('iwx-mime');if(mm){mm.addEventListener('change',function(){state.mime=mm.value;state.page=1;loadGrid();});}
	var ob=$('iwx-orderby');if(ob){ob.addEventListener('change',function(){state.orderby=ob.value;state.page=1;loadGrid();});}
	var od=$('iwx-order');if(od){od.addEventListener('change',function(){state.order=od.value;state.page=1;loadGrid();});}
	var dn=$('iwx-density');if(dn){dn.addEventListener('change',function(){var g=$('iwx-grid');if(g){g.classList.toggle('is-compact',dn.value==='compact');}});}
	var pv=$('iwx-prev');if(pv){pv.addEventListener('click',function(){if(state.page>1){state.page--;loadGrid();}});}
	var nx=$('iwx-next');if(nx){nx.addEventListener('click',function(){if(state.page<state.pages){state.page++;loadGrid();}});}
	var mvb=$('iwx-move-btn');if(mvb){mvb.addEventListener('click',function(){openMovePicker();});}
	var tgb=$('iwx-tag-btn');if(tgb){tgb.addEventListener('click',function(){promptTag();});}
	var clr=$('iwx-clear-btn');if(clr){clr.addEventListener('click',function(){state.sel=[];state.anchor=-1;updateSelUI();});}
	var lsb=$('iwx-lossless-btn');if(lsb){lsb.addEventListener('click',bulkOptimize);}
	var ofb=$('iwx-offload-btn');if(ofb){ofb.addEventListener('click',bulkOffload);}
	var rsb=$('iwx-restore-btn');if(rsb){rsb.addEventListener('click',bulkRestore);}
	var sab=$('iwx-selectall');if(sab){sab.addEventListener('click',selectAllMatching);}
	var ft=$('iwx-folders-toggle');if(ft){ft.addEventListener('click',toggleDrawer);}
	var db=$('iwx-drawer-back');if(db){db.addEventListener('click',closeDrawer);}
	var stg=$('iwx-select-toggle');if(stg){stg.addEventListener('click',toggleSelectMode);}
	document.addEventListener('click',function(e){if(pointerJustHandled()){return;}if(menuEl&&!menuEl.contains(e.target)){closeMenu();}});
	document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeMenu();}});
	window.addEventListener('resize',closeMenu);
}

/* ── phone-first layer: accent, viewer, select-mode, drawer, pointer-drag ── */
function accentEl(c){var s=el('span','iwx__accent');if(String(c).charAt(0)==='#'){s.classList.add('iwx__accent--dot');s.style.background=c;}else{s.textContent=c;}s.setAttribute('aria-hidden','true');return s;}
function openViewer(id){if(typeof window!=='undefined'&&typeof window.IWSL_EXPLORER_OPEN==='function'){window.IWSL_EXPLORER_OPEN(id);}}
function ensureSel(id,idx){if(!inSel(id)){state.sel=[id];state.anchor=(typeof idx==='number'?idx:-1);updateSelUI();}}
function promptTag(){if(!state.sel.length){return;}var raw=window.prompt(I.tagPrompt,'');if(raw===null){return;}var names=raw.split(',').map(function(x){return x.trim();}).filter(function(x){return x.length;});if(!names.length){return;}tagFiles(state.sel.slice(),names);}
function deleteAsset(id){if(!window.confirm(I.deleteAssetConfirm)){return;}
	post(A.detailDel,{id:id,confirm:'1'}).then(function(j){var d=payload(j);if(ok(j)&&d.deleted){toast(I.assetDeleted,'ok');state.sel=state.sel.filter(function(s){return num(s)!==num(id);});reload();}else{toast(I.assetDeleteFail,'bad');}}).catch(function(){toast(I.netErr,'bad');});}
function setFolderStyle(id,color){post(A.style,{id:id,color:color}).then(function(j){if(ok(j)){toast(I.styled,'ok');loadTree();}else{toast(I.styleFail+' '+why(j),'bad');}}).catch(function(){toast(I.netErr,'bad');});}

function isNarrow(){return (window.innerWidth||document.documentElement.clientWidth||0)<=880;}
function iwxRoot(){return document.querySelector('.iwx');}
function isDrawerOpen(){var r=iwxRoot();return !!r&&r.classList.contains('is-drawer-open');}
function openDrawer(){var r=iwxRoot();if(r){r.classList.add('is-drawer-open');}var b=$('iwx-folders-toggle');if(b){b.setAttribute('aria-expanded','true');}}
function closeDrawer(){var r=iwxRoot();if(r){r.classList.remove('is-drawer-open');}var b=$('iwx-folders-toggle');if(b){b.setAttribute('aria-expanded','false');}}
function toggleDrawer(){if(isDrawerOpen()){closeDrawer();}else{openDrawer();}}
function toggleSelectMode(){state.selectMode=!state.selectMode;var b=$('iwx-select-toggle');var r=iwxRoot();
	if(b){b.setAttribute('aria-pressed',state.selectMode?'true':'false');b.classList.toggle('is-active',state.selectMode);}
	if(r){r.classList.toggle('is-select-mode',state.selectMode);}}
function onCardTap(item,idx){if(state.selectMode){toggleSel(item.id,idx);}else{openViewer(item.id);}}

function placeMenu(m,x,y){document.body.appendChild(m);var w=m.offsetWidth,h=m.offsetHeight;
	m.style.left=Math.max(8,Math.min(x,window.innerWidth-w-8))+'px';
	m.style.top=Math.max(8,Math.min(y,window.innerHeight-h-8))+'px';menuEl=m;}
function openCardMenu(x,y,item,idx){closeMenu();var m=el('div','iwx__menu');
	var rows=[{label:I.open,fn:function(){openViewer(item.id);}},
		{label:I.moveTo,fn:function(){ensureSel(item.id,idx);openMovePicker();}},
		{label:I.tagRow,fn:function(){ensureSel(item.id,idx);promptTag();}},
		{label:I.delete,danger:true,fn:function(){deleteAsset(item.id);}}];
	rows.forEach(function(row){var b=el('button','iwx__menu-item'+(row.danger?' iwx__menu-item--danger':''));b.type='button';b.textContent=row.label;
		b.addEventListener('click',function(ev){ev.stopPropagation();closeMenu();row.fn();});m.appendChild(b);});
	placeMenu(m,x,y);}
function openMenuForNode(sess,x,y){openMenu(x,y,{id:sess.id,name:sess.name,real:true});}

/* Pointer engine (touch/pen only; mouse keeps the untouched HTML5 drag path). */
function wireCardPointer(card,item,idx){card.addEventListener('pointerdown',function(e){if(e.target&&e.target.closest&&e.target.closest('.iwx__card-check')){return;}startSession(e,{kind:'card',el:card,id:item.id,idx:idx,item:item});});}
function wireNodePointer(node,opts){node.addEventListener('pointerdown',function(e){if(e.target&&e.target.closest&&(e.target.closest('.iwx__twist')||e.target.closest('.iwx__node-menu'))){return;}startSession(e,{kind:'node',el:node,id:opts.id,real:!!opts.real,name:opts.name});});}
function startSession(e,sess){
	if(!pointerAvail()||e.pointerType==='mouse'){return;}
	if(ptr){return;}
	ptr={pid:e.pointerId,x0:e.clientX,y0:e.clientY,phase:'pending',ghost:null,timer:null,cap:false,dropId:null,scrollDir:0,
		kind:sess.kind,el:sess.el,id:sess.id,idx:sess.idx,item:sess.item,real:sess.real,name:sess.name};
	document.addEventListener('pointermove',onPtrMove,{passive:false});
	document.addEventListener('pointerup',onPtrUp);
	document.addEventListener('pointercancel',onPtrCancel);
	ptr.timer=setTimeout(function(){if(ptr&&ptr.phase==='pending'){ptr.phase='armed';armCue();}},LONG_MS);
}
function armCue(){if(ptr&&ptr.el){ptr.el.classList.add('is-grabbed');}}
function onPtrMove(e){
	if(!ptr||e.pointerId!==ptr.pid){return;}
	var dx=e.clientX-ptr.x0,dy=e.clientY-ptr.y0,dist=Math.abs(dx)+Math.abs(dy);
	if(ptr.phase==='pending'){if(dist>SLOP){endPtr(false);}return;}
	if(ptr.phase==='armed'){if(dist>SLOP){beginDrag(e);}else{return;}}
	if(ptr.phase==='dragging'){e.preventDefault();moveGhost(e.clientX,e.clientY);hitTest(e.clientX,e.clientY);edgeScroll(e.clientY);}
}
function beginDrag(e){
	ptr.phase='dragging';
	if(ptr.kind==='card'){
		var ids=inSel(ptr.id)?state.sel.slice():[ptr.id];
		if(!inSel(ptr.id)){state.sel=[ptr.id];updateSelUI();}
		state.drag={type:'files',ids:ids};
		ptr.label=(ids.length===1)?I.dragOne:(ids.length+' '+I.items);
	}else{
		if(!ptr.real){endPtr(false);return;}
		state.drag={type:'folder',id:ptr.id};
		ptr.label=ptr.name;
	}
	makeGhost(ptr.label);moveGhost(e.clientX,e.clientY);
	if(ptr.el&&ptr.el.setPointerCapture){try{ptr.el.setPointerCapture(ptr.pid);ptr.cap=true;}catch(err){}}
}
function makeGhost(text){var g=el('div','iwx__ghost');g.textContent=text;document.body.appendChild(g);if(ptr){ptr.ghost=g;}}
function moveGhost(x,y){if(ptr&&ptr.ghost){ptr.ghost.style.left=x+'px';ptr.ghost.style.top=y+'px';}}
function clearDropHi(){var els=document.querySelectorAll('.iwx__node.is-drop');for(var i=0;i<els.length;i++){els[i].classList.remove('is-drop');}}
function nodeMeta(node){var id=num(node.dataset.id);var real=id>0&&!!state.byId[id];return {id:id,real:real};}
function validDrop(m){var d=state.drag;if(!d){return false;}
	if(d.type==='files'){return m.id!==ALL;}
	if(d.type==='folder'){if(m.id===UNFILED){return false;}if(num(d.id)===num(m.id)){return false;}var parent=(m.id===ALL)?0:m.id;return num(d.id)!==num(parent);}
	return false;}
function hitTest(x,y){clearDropHi();ptr.dropId=null;
	if(ptr.ghost){ptr.ghost.style.visibility='hidden';}
	var elx=document.elementFromPoint(x,y);
	if(ptr.ghost){ptr.ghost.style.visibility='';}
	var node=elx&&elx.closest?elx.closest('.iwx__node'):null;
	if(!node){return;}
	var m=nodeMeta(node);if(!validDrop(m)){return;}
	node.classList.add('is-drop');ptr.dropId=m.id;}
function edgeScroll(y){stopAutoScroll();var vh=window.innerHeight||document.documentElement.clientHeight||0;var dir=0;
	if(y<EDGE){dir=-1;}else if(y>vh-EDGE){dir=1;}
	if(!dir){return;}var speed=EDGE_SPEED*dir;ptr.scrollDir=dir;
	scrollRAF=requestAnimationFrame(function tick(){if(!ptr||ptr.phase!=='dragging'||!ptr.scrollDir){return;}
		var body=$('iwx-tree-body');if(body&&isNarrow()&&isDrawerOpen()){body.scrollTop+=speed;}else{window.scrollBy(0,speed);}
		scrollRAF=requestAnimationFrame(tick);});}
function stopAutoScroll(){if(scrollRAF){cancelAnimationFrame(scrollRAF);scrollRAF=0;}if(ptr){ptr.scrollDir=0;}}
function onPtrUp(e){
	if(!ptr||e.pointerId!==ptr.pid){return;}
	var phase=ptr.phase,drop=ptr.dropId,sess=ptr;
	if(phase==='dragging'){
		var d=state.drag;
		if(d&&drop!==null&&drop!==undefined){
			if(d.type==='files'&&drop!==ALL){assignFiles(d.ids,drop);}
			else if(d.type==='folder'){var parent=(drop===ALL)?0:drop;if(num(d.id)!==num(parent)){moveFolder(d.id,parent);}}
		}
		endPtr(true);return;
	}
	if(phase==='armed'){endPtr(true);
		if(sess.kind==='card'){openCardMenu(e.clientX,e.clientY,sess.item,sess.idx);}
		else if(sess.real){openMenuForNode(sess,e.clientX,e.clientY);}
		return;}
	endPtr(true);
	if(sess.kind==='card'){onCardTap(sess.item,sess.idx);}
	else{selectFolder(sess.id);}
}
function onPtrCancel(e){if(ptr&&e.pointerId===ptr.pid){endPtr(false);}}
function killGhost(){if(ptr&&ptr.ghost&&ptr.ghost.parentNode){ptr.ghost.parentNode.removeChild(ptr.ghost);}if(ptr){ptr.ghost=null;}}
function endPtr(handled){
	stopAutoScroll();
	if(ptr){if(ptr.timer){clearTimeout(ptr.timer);}if(ptr.el){ptr.el.classList.remove('is-grabbed');if(ptr.cap&&ptr.el.releasePointerCapture){try{ptr.el.releasePointerCapture(ptr.pid);}catch(err){}}}}
	killGhost();clearDropHi();
	document.removeEventListener('pointermove',onPtrMove,{passive:false});
	document.removeEventListener('pointerup',onPtrUp);
	document.removeEventListener('pointercancel',onPtrCancel);
	if(handled){pointerHandledAt=Date.now();}
	ptr=null;state.drag=null;
}

/* Bottom-sheet / centered-dialog modal — focus-trapped, Esc-closable. */
function focusables(root){return Array.prototype.slice.call(root.querySelectorAll('button,[href],input,select,textarea,[tabindex]')).filter(function(x){return !x.disabled&&x.getAttribute('tabindex')!=='-1'&&(x.offsetWidth>0||x.offsetHeight>0);});}
function sheetKey(e){if(!sheetEl){return;}
	if(e.key==='Escape'){e.preventDefault();closeSheet();return;}
	if(e.key==='Tab'){var f=focusables(sheetEl.sheet);if(!f.length){return;}var first=f[0],last=f[f.length-1];
		if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
		else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}
function buildSheet(title){
	var back=el('div','iwx__sheet-back');
	var sheet=el('div','iwx__sheet');sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label',title);
	var head=el('div','iwx__sheet-head');var h=el('span','iwx__sheet-title');h.textContent=title;head.appendChild(h);
	var x=el('button','iwx__sheet-close');x.type='button';x.setAttribute('aria-label',I.close);x.textContent='×';x.addEventListener('click',closeSheet);head.appendChild(x);
	var body=el('div','iwx__sheet-body');
	sheet.appendChild(head);sheet.appendChild(body);back.appendChild(sheet);
	back.addEventListener('click',function(e){if(e.target===back){closeSheet();}});
	return {back:back,sheet:sheet,body:body};
}
function openSheet(s){closeSheet();sheetPrevFocus=document.activeElement;document.body.appendChild(s.back);sheetEl=s;
	if(window.requestAnimationFrame){requestAnimationFrame(function(){if(sheetEl===s){s.back.classList.add('is-open');}});}else{s.back.classList.add('is-open');}
	document.addEventListener('keydown',sheetKey,true);
	var f=focusables(s.sheet);if(f.length){f[0].focus();}
}
function closeSheet(){if(!sheetEl){return;}var s=sheetEl;sheetEl=null;document.removeEventListener('keydown',sheetKey,true);if(s.back&&s.back.parentNode){s.back.parentNode.removeChild(s.back);}if(sheetPrevFocus&&sheetPrevFocus.focus){try{sheetPrevFocus.focus();}catch(err){}}sheetPrevFocus=null;}

function openMovePicker(){
	if(!state.sel.length){toast(I.pickTarget,'bad');return;}
	var s=buildSheet(I.moveTitle);var list=el('div','iwx__picker');
	list.appendChild(pickerRow(I.unfiled,UNFILED,0,''));
	var roots=childrenOf(0);function walk(f,depth){list.appendChild(pickerRow(f.name,f.id,depth,f.color));var kids=childrenOf(f.id);for(var i=0;i<kids.length;i++){walk(kids[i],depth+1);}}
	for(var r=0;r<roots.length;r++){walk(roots[r],0);}
	s.body.appendChild(list);openSheet(s);
}
function pickerRow(name,id,depth,color){var b=el('button','iwx__picker-row');b.type='button';b.style.paddingLeft=(12+depth*16)+'px';
	if(color){b.appendChild(accentEl(color));}
	var t=el('span');t.textContent=name;b.appendChild(t);
	b.addEventListener('click',function(){var sel=state.sel.slice();closeSheet();assignFiles(sel,id);});
	return b;}
function openColorPicker(opts){
	var s=buildSheet(I.colourTitle);var wrap=el('div','iwx__swatches');
	var none=el('button','iwx__swatch iwx__swatch--none');none.type='button';none.textContent=I.colourNone;none.setAttribute('aria-label',I.colourNone);
	none.addEventListener('click',function(){closeSheet();setFolderStyle(opts.id,'');});wrap.appendChild(none);
	var cols=(CFG.accents&&CFG.accents.colors)||[];
	for(var i=0;i<cols.length;i++){(function(c){var b=el('button','iwx__swatch iwx__swatch--dot');b.type='button';b.style.background=c;b.setAttribute('aria-label',c);b.addEventListener('click',function(){closeSheet();setFolderStyle(opts.id,c);});wrap.appendChild(b);})(cols[i]);}
	var ems=(CFG.accents&&CFG.accents.emoji)||[];
	for(var j=0;j<ems.length;j++){(function(em){var b=el('button','iwx__swatch iwx__swatch--emoji');b.type='button';b.textContent=em;b.setAttribute('aria-label',em);b.addEventListener('click',function(){closeSheet();setFolderStyle(opts.id,em);});wrap.appendChild(b);})(ems[j]);}
	s.body.appendChild(wrap);openSheet(s);
}

/* ── CDN + lossless fusion (pills, status filters, select-all, bulk verbs) ── */
function statusPill(label,on,kind){var p=el('span','iwx__pill iwx__pill--'+(on?'on':'off')+(kind==='cdn'?' iwx__pill--cdn':' iwx__pill--opt'));p.textContent=label;return p;}
function statusFilterActive(){return state.optFilter!=='all'||state.offFilter!=='all';}
function statusChip(label,active,fn){var c=el('button','iwx__chip'+(active?' is-active':''));c.type='button';c.setAttribute('aria-pressed',active?'true':'false');var s=el('span');s.textContent=label;c.appendChild(s);c.addEventListener('click',fn);return c;}
function setStatusFilter(opt,off){state.optFilter=opt;state.offFilter=off;state.page=1;state.sel=[];state.anchor=-1;renderStatusChips();updateSelUI();loadGrid();}
function renderStatusChips(){if(!OPT_ON){return;}var c=$('iwx-status-chips');if(!c){return;}clear(c);
	c.appendChild(statusChip(I.filtAll,!statusFilterActive(),function(){setStatusFilter('all','all');}));
	c.appendChild(statusChip(I.filtNotLossless,state.optFilter==='unoptimized',function(){setStatusFilter(state.optFilter==='unoptimized'?'all':'unoptimized','all');}));
	c.appendChild(statusChip(I.filtNotCdn,state.offFilter==='local',function(){setStatusFilter('all',state.offFilter==='local'?'all':'local');}));
	updateSelectAll();}
function updateSelectAll(){var b=$('iwx-selectall');if(!b){return;}if(OPT_ON&&statusFilterActive()&&state.total>0){b.textContent=I.selectAllN.replace('%1',state.total);b.hidden=false;}else{b.hidden=true;}}
function selectAllMatching(){post(A.selectAll,{folder_id:state.folderId,search:state.search,mime_group:state.mime,tag_ids:state.tagIds,opt_filter:state.optFilter,off_filter:state.offFilter}).then(function(j){if(!ok(j)){toast(I.gridErr,'bad');return;}var d=payload(j);var ids=(Array.isArray(d.ids)?d.ids:[]).map(num);state.sel=ids.slice();state.anchor=-1;updateSelUI();
	if(d.truncated){toast(I.selectAllCapped.replace('%1',ids.length),'info');}else{toast(I.selectedAllN.replace('%1',ids.length),'ok');}}).catch(function(){toast(I.netErr,'bad');});}
function confirmBig(tpl){if(state.sel.length<CONFIRM_AT){return true;}return window.confirm(tpl.replace('%1',state.sel.length));}
function bulkOptimize(){if(!state.sel.length){return;}if(!confirmBig(I.confirmOptimize)){return;}var ids=state.sel.slice();
	post(A.bulkOpt,{ids:ids}).then(function(j){if(ok(j)){var d=payload(j);toast(I.optQueued.replace('%1',num(d.queued)||ids.length),'ok');startOptPoll();}else{toast(I.optFail+' '+why(j),'bad');}}).catch(function(){toast(I.netErr,'bad');});}
function startOptPoll(){stopOptPoll();state.optPoll=setInterval(pollOpt,2000);}
function stopOptPoll(){if(state.optPoll){clearInterval(state.optPoll);state.optPoll=null;}}
function pollOpt(){post(A.optStatus,{}).then(function(j){if(!ok(j)){stopOptPoll();return;}var d=payload(j);var st=d.stats||{};var status=String(d.status||'idle');
	if(d.active||status==='running'){toast(I.optProgress.replace('%1',num(st.optimized)).replace('%2',num(st.total)),'info');return;}
	stopOptPoll();if(status==='stalled'){toast(I.optStalled,'bad');}else{toast(I.optDone,'ok');}reload();}).catch(function(){stopOptPoll();});}
function bulkOffload(){runBulkOffload(A.bulkOff,I.confirmOffload,I.offloadDone,'offloaded');}
function bulkRestore(){runBulkOffload(A.bulkRestore,I.confirmRestore,I.restoreDone,'restored');}
function runBulkOffload(action,confirmTpl,doneTpl,countKey){if(!state.sel.length){return;}if(!confirmBig(confirmTpl)){return;}var ids=state.sel.slice();
	post(action,{ids:ids}).then(function(j){if(ok(j)){var d=payload(j);toast(doneTpl.replace('%1',num(d[countKey])).replace('%2',num(d.failed)),num(d.failed)?'bad':'ok');reload();}else{toast(I.bulkFail+' '+why(j),'bad');}}).catch(function(){toast(I.netErr,'bad');});}
function initOpt(){if(!OPT_ON){return;}var sb=$('iwx-statusbar');if(sb){sb.hidden=false;}var ab=$('iwx-ab-opt');if(ab){ab.hidden=false;}renderStatusChips();}

bind();
initOpt();
loadTree().then(loadGrid);
})();</script>
JS;
		echo "\n";
	}

	// ── harness-safe escaping helpers ──────────────────────────────────────────────

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
