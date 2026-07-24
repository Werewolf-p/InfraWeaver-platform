<?php
/**
 * Plugin Name: InfraWeaver Connector
 * Description: Signed, IW-initiated management link (IWSL v1) — Ed25519 + SLH-DSA-192s dual-verified commands, zero standing WP→IW path.
 * Version: 0.21.0
 * Author: InfraWeaver
 * Requires at least: 5.9
 * Requires PHP: 7.4
 * License: AGPL-3.0-only
 * Text Domain: infraweaver-connector
 *
 * Spec: docs/infraweaver-wp-remote-management-design.md (platform repo, FINAL v1.2).
 */

defined( 'ABSPATH' ) || exit;

define( 'IWSL_CONNECTOR_VERSION', '0.21.0' );

/**
 * Hard ceiling on request bodies for the public REST surface. A dual-signed
 * command carries a ~22 KB SLH-DSA-192s signature, so 64 KB leaves headroom
 * while capping the JSON parse an unauthenticated POST can force (§6.3 DoS).
 */
define( 'IWSL_MAX_BODY_BYTES', 65536 );

/** True when the request body is within IWSL_MAX_BODY_BYTES. */
function iwsl_body_within_limit( WP_REST_Request $request ): bool {
	return strlen( (string) $request->get_body() ) <= IWSL_MAX_BODY_BYTES;
}

/**
 * Load the connector's translations so the wp-admin UI auto-adapts to the site
 * language (e.g. a Dutch nl_NL install shows Dutch out of the box). The compiled
 * catalogs live in languages/ as infraweaver-connector-{locale}.mo. Every admin
 * string is wrapped with the 'infraweaver-connector' text domain; without this
 * call none of those translations would ever load. Hooked on `init` so the
 * current locale (which WordPress resolves before `init`) is already known.
 * Guarded for the zero-dependency test harness, which loads classes directly
 * without a WordPress runtime and never fires `init`.
 */
function iwsl_load_textdomain(): void {
	load_plugin_textdomain(
		'infraweaver-connector',
		false,
		dirname( plugin_basename( __FILE__ ) ) . '/languages'
	);
}
if ( function_exists( 'add_action' ) ) {
	add_action( 'init', 'iwsl_load_textdomain' );
}

require_once __DIR__ . '/includes/class-iwsl-jcs.php';
require_once __DIR__ . '/includes/class-iwsl-slhdsa.php';
require_once __DIR__ . '/includes/class-iwsl-slhdsa-192f.php';
require_once __DIR__ . '/includes/class-iwsl-crypto.php';
require_once __DIR__ . '/includes/class-iwsl-store.php';
require_once __DIR__ . '/includes/class-iwsl-wp-store.php';
require_once __DIR__ . '/includes/class-iwsl-verifier.php';
require_once __DIR__ . '/includes/class-iwsl-enrollment.php';
require_once __DIR__ . '/includes/class-iwsl-rotation.php';
require_once __DIR__ . '/includes/class-iwsl-responder.php';
require_once __DIR__ . '/includes/class-iwsl-command-handler.php';
require_once __DIR__ . '/includes/class-iwsl-entitlements.php';
require_once __DIR__ . '/includes/class-iwsl-feature-switches.php';
require_once __DIR__ . '/includes/iwsl-ui-help.php';
require_once __DIR__ . '/includes/class-iwsl-plugin.php';
require_once __DIR__ . '/includes/class-iwsl-plus-feature.php';
require_once __DIR__ . '/includes/class-iwsl-media-converter.php';
require_once __DIR__ . '/includes/class-iwsl-webp-lossless-converter.php';
require_once __DIR__ . '/includes/class-iwsl-media-optimizer.php';
require_once __DIR__ . '/includes/class-iwsl-s3-client.php';
require_once __DIR__ . '/includes/class-iwsl-redirect-matcher.php';
require_once __DIR__ . '/includes/class-iwsl-exact-path-matcher.php';
require_once __DIR__ . '/includes/class-iwsl-prefix-path-matcher.php';
require_once __DIR__ . '/includes/class-iwsl-redirects.php';
require_once __DIR__ . '/includes/class-iwsl-redirect-suggestions.php';
require_once __DIR__ . '/includes/iwsl-page-cache-helpers.php';
require_once __DIR__ . '/includes/class-iwsl-page-cache.php';
require_once __DIR__ . '/includes/class-iwsl-mail-transport.php';
require_once __DIR__ . '/includes/class-iwsl-smtp-transport.php';
require_once __DIR__ . '/includes/class-iwsl-email-delivery.php';
require_once __DIR__ . '/includes/class-iwsl-brand-surface.php';
require_once __DIR__ . '/includes/class-iwsl-login-brand-surface.php';
require_once __DIR__ . '/includes/class-iwsl-admin-brand-surface.php';
require_once __DIR__ . '/includes/class-iwsl-email-brand-surface.php';
require_once __DIR__ . '/includes/class-iwsl-white-label.php';
require_once __DIR__ . '/includes/class-iwsl-db-cleaner.php';
require_once __DIR__ . '/includes/class-iwsl-db-cleaners.php';
require_once __DIR__ . '/includes/class-iwsl-db-history.php';
require_once __DIR__ . '/includes/class-iwsl-db-optimizer.php';
require_once __DIR__ . '/includes/class-iwsl-db-analyzer.php';
require_once __DIR__ . '/includes/class-iwsl-config-editor.php';
// ── Plus feature engines (wave 2): each gated, self-contained, console-granted ──
require_once __DIR__ . '/includes/class-iwsl-lazy-load.php';
require_once __DIR__ . '/includes/class-iwsl-media-protection.php';
require_once __DIR__ . '/includes/class-iwsl-elementor-blocks.php';
require_once __DIR__ . '/includes/class-iwsl-cdn-rewrite.php';
require_once __DIR__ . '/includes/class-iwsl-duplicate-post.php';
require_once __DIR__ . '/includes/class-iwsl-seo-audit.php';
require_once __DIR__ . '/includes/class-iwsl-svg-upload.php';
require_once __DIR__ . '/includes/class-iwsl-broken-link-scan.php';
require_once __DIR__ . '/includes/class-iwsl-maintenance-mode.php';
require_once __DIR__ . '/includes/class-iwsl-site-health.php';
require_once __DIR__ . '/includes/class-iwsl-scheduled-db-cleanup.php';
require_once __DIR__ . '/includes/class-iwsl-activity-log.php';
require_once __DIR__ . '/includes/class-iwsl-auto-convert.php';
require_once __DIR__ . '/includes/class-iwsl-media-offload.php';
require_once __DIR__ . '/includes/class-iwsl-media-folders.php';
require_once __DIR__ . '/includes/class-iwsl-media-folders-ui.php';
require_once __DIR__ . '/includes/class-iwsl-media-library.php';
require_once __DIR__ . '/includes/class-iwsl-speed-pack.php';
require_once __DIR__ . '/includes/class-iwsl-stats-classifier.php';
require_once __DIR__ . '/includes/class-iwsl-statistics.php';
require_once __DIR__ . '/includes/class-iwsl-consent-classifier.php';
require_once __DIR__ . '/includes/class-iwsl-cookie-consent.php';
require_once __DIR__ . '/includes/class-iwsl-seo-analyzer.php';
require_once __DIR__ . '/includes/class-iwsl-seo-head.php';
require_once __DIR__ . '/includes/class-iwsl-seo-sitemap.php';
require_once __DIR__ . '/includes/class-iwsl-seo-alt-text.php';
require_once __DIR__ . '/includes/class-iwsl-seo-suite.php';
require_once __DIR__ . '/includes/class-iwsl-seo-console.php';
require_once __DIR__ . '/includes/class-iwsl-perf-audit.php';
require_once __DIR__ . '/includes/class-iwsl-response-scan.php';
require_once __DIR__ . '/includes/class-iwsl-security-headers.php';
require_once __DIR__ . '/includes/class-iwsl-teardown.php';
require_once __DIR__ . '/includes/class-iwsl-admin.php';

function iwsl_plugin(): IWSL_Plugin {
	static $instance = null;
	if ( null === $instance ) {
		$instance = new IWSL_Plugin( new IWSL_WP_Store() );
	}
	return $instance;
}

// wp-admin test surface for the client-side feature gate (Tools → InfraWeaver
// Plus). Only wired in admin context so a plain front-end request never forces
// the full command-handler object graph to build — it is constructed lazily
// inside the REST/CLI paths that actually need it. Registers an admin_menu hook
// only; renders purely from local state.
// Operator kill-switches (tier-aware). A LOCAL on/off layered on top of the
// signed entitlement — it can turn a granted feature off, and back on, but can
// never enable a feature the tier doesn't grant (see IWSL_Feature_Switches::set).
// Each engine below registers only when its switch is on; the two disk-artifact
// engines (page cache, speed pack) also tear their artifact down when off.
$iwsl_switches = new IWSL_Feature_Switches( iwsl_plugin()->entitlements(), new IWSL_WP_Store() );

if ( is_admin() ) {
	( new IWSL_Admin( iwsl_plugin(), switches: $iwsl_switches ) )->register();
	// Self-heal at init (admin-only): purge the footprint of any tier-gated
	// feature that is switched OFF or no longer entitled, so a disabled feature
	// leaves nothing behind and the plugin is clean at init. Each engine purge is
	// cheap when there's nothing to remove, so the all-active case is near-free;
	// the front-end hot path never runs this.
	IWSL_Teardown::clean_at_init( $iwsl_switches, iwsl_plugin()->entitlements(), new IWSL_WP_Store() );
}

// Load-Time Audit (FREE — no entitlement gate, no feature switch). The passive
// collector times real front-end page views with WordPress's own request timer;
// register() wires a single late `shutdown` hook whose FIRST checks are "enabled?"
// and "measurable front-end GET?", so admin / AJAX / cron / REST / bot / admin-user
// requests pay nothing. Registered on every request because the hook fires on the
// front end. Its two admin-post controls (toggle + reset) are wired in admin only.
$iwsl_perf_audit = new IWSL_Perf_Audit( new IWSL_WP_Store() );
$iwsl_perf_audit->register();
if ( is_admin() ) {
	add_action( 'admin_post_' . IWSL_Perf_Audit::TOGGLE_ACTION, array( $iwsl_perf_audit, 'handle_toggle' ) );
	add_action( 'admin_post_' . IWSL_Perf_Audit::RESET_ACTION, array( $iwsl_perf_audit, 'handle_reset' ) );
}

// 301 Redirect Manager (gated, Pro). Registered on every request because the
// matcher runs on template_redirect; the callback's FIRST statement is the
// entitlement gate, so a locked or revoked site gets default behavior instantly.
if ( $iwsl_switches->is_on( IWSL_Redirects::FEATURE ) ) {
	( new IWSL_Redirects( iwsl_plugin()->entitlements(), new IWSL_WP_Store() ) )->register();
}

// Page Cache (gated, Pro/Ultimate, flag `page_cache`). Registered on every
// request: register() wires the purge hooks (each self-gates on is_enabled(), so
// a locked/disabled site pays nothing) and the admin_init revocation check.
// maybe_revoke() is ALSO invoked once here at bootstrap so the signed-command /
// heartbeat request path (non-admin) tears the serve-time drop-in down the moment
// the console revokes the flag — the drop-in itself runs before plugins load and
// cannot re-check the gate, so presence-based enforcement lives here. The common
// case is one is_file(): maybe_revoke() only touches disk when OUR drop-in exists.
$iwsl_page_cache = new IWSL_Page_Cache( iwsl_plugin()->entitlements() );
if ( $iwsl_switches->is_on( IWSL_Page_Cache::FEATURE ) ) {
	$iwsl_page_cache->register();
	$iwsl_page_cache->maybe_revoke();
} else {
	// Switched off while still entitled → tear the serve-time drop-in down now.
	$iwsl_page_cache->disable();
}

// Custom login + admin white-label (gated, `white_label`, Ultimate). Passive
// login/admin presentation hooks only; every callback re-checks the gate as its
// FIRST statement, so revoking the flag from the console instantly restores
// default WordPress login and admin chrome. Registered on every request because
// the login hooks fire on wp-login.php (not an admin context); the engine is cheap
// and reads only local state.
$iwsl_white_label = null;
if ( $iwsl_switches->is_on( IWSL_White_Label::FEATURE ) ) {
	$iwsl_white_label = new IWSL_White_Label( iwsl_plugin()->entitlements(), new IWSL_WP_Store() );
	$iwsl_white_label->register();
	// Brand kit → outgoing email (ONE brand identity, every surface). Prepend the
	// resolved brand header to HTML mail. Gated INSIDE email_brand_header() on the
	// `white_label` entitlement + the `apply_to_email` toggle (so revoking the flag
	// restores stock mail instantly); email delivery's brand_mail() only touches HTML
	// mail and never mutates the args. Deliberately wired here (white-label), not in
	// the email-delivery block, so email branding rides `white_label` ALONE — it must
	// not require the separate `email_delivery` (SMTP) feature to be on.
	add_filter(
		'wp_mail',
		static function ( $args ) use ( $iwsl_white_label ) {
			return iwsl_plugin()->email_delivery()->brand_mail( $args, $iwsl_white_label->email_brand_header() );
		},
		1001
	);
}

// ── Plus feature engines (wave 2) ──────────────────────────────────────────────
// Each is gated: every hook callback re-checks the entitlement as its FIRST
// statement, so a locked/revoked site pays nothing and behaves like stock WP.
// Registered on every request because their hooks fire on the front end and cron.
$iwsl_ent = iwsl_plugin()->entitlements();

// Small helper: the PRG admin-post handler shared shape for settings-style saves
// that expose an update_settings()/handler method. cap + nonce + gate, then run,
// stash a per-user result transient, and redirect back to the Plus page.
$iwsl_plus_redirect = static function ( string $feature_id = '' ): string {
	// Return to the SAME category sub-page the settings form was submitted from,
	// anchored to the acting feature's card (see IWSL_Admin::iwsl_plus_return_url),
	// so a save keeps the operator exactly where they were instead of bouncing to
	// the Overview dashboard. Falls back to the shared referer-based base if the
	// admin class is somehow unavailable on this request.
	if ( class_exists( 'IWSL_Admin' ) && method_exists( 'IWSL_Admin', 'iwsl_plus_return_url' ) ) {
		return IWSL_Admin::iwsl_plus_return_url( $feature_id );
	}
	return iwsl_plus_redirect_base();
};

// Lazy-Load Media (Pro, `lazy_load`).
$iwsl_lazy_load = new IWSL_Lazy_Load( $iwsl_ent, new IWSL_WP_Store() );
if ( $iwsl_switches->is_on( IWSL_Lazy_Load::FEATURE ) ) {
	$iwsl_lazy_load->register();
	add_action( 'admin_post_' . IWSL_Lazy_Load::SETTINGS_ACTION, static function () use ( $iwsl_lazy_load, $iwsl_plus_redirect ): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( IWSL_Lazy_Load::SETTINGS_NONCE );
		$result = $iwsl_lazy_load->update_settings( $_POST );
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( IWSL_Lazy_Load::RESULT_PREFIX . get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $iwsl_plus_redirect( 'lazy-load' ) );
		exit;
	} );
}

// Media Protection (Pro, `media_protection`). Marks selected images harder to
// right-click-save / drag-copy; register() self-wires its attachment-field + the
// front-end deterrent filters, each gating on the entitlement as statement 1.
$iwsl_media_protection = new IWSL_Media_Protection( $iwsl_ent, new IWSL_WP_Store() );
if ( $iwsl_switches->is_on( IWSL_Media_Protection::FEATURE ) ) {
	$iwsl_media_protection->register();
	add_action( 'admin_post_' . IWSL_Media_Protection::SETTINGS_ACTION, static function () use ( $iwsl_media_protection, $iwsl_plus_redirect ): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( IWSL_Media_Protection::SETTINGS_NONCE );
		$result = $iwsl_media_protection->update_settings( $_POST );
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( IWSL_Media_Protection::RESULT_PREFIX . get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $iwsl_plus_redirect( 'media-protect' ) );
		exit;
	} );
	add_action( 'admin_post_' . IWSL_Media_Protection::MARK_ALL_ACTION, static function () use ( $iwsl_media_protection, $iwsl_plus_redirect ): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( IWSL_Media_Protection::MARK_ALL_NONCE );
		$protect = ! ( isset( $_POST['mode'] ) && 'unprotect' === $_POST['mode'] );
		$result  = $iwsl_media_protection->bulk_mark_all( $protect );
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( IWSL_Media_Protection::BULK_RESULT_PREFIX . get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $iwsl_plus_redirect( 'media-protect' ) );
		exit;
	} );
}

// Elementor Blocks (Pro, `elementor_blocks`). Registers a set of InfraWeaver
// Elementor widgets under their own category. register() self-gates on the
// entitlement as statement 1 AND on Elementor being loaded, so a locked site —
// or any site without Elementor — attaches no hooks and pays nothing. No settings
// form, so there is no admin-post handler to wire. Registered on every request
// because Elementor's registration hooks fire outside admin (the editor preview).
if ( $iwsl_switches->is_on( IWSL_Elementor_Blocks::FEATURE ) ) {
	( new IWSL_Elementor_Blocks( $iwsl_ent, new IWSL_WP_Store() ) )->register();
}

// CDN URL Rewrite (Ultimate, `cdn_rewrite`).
$iwsl_cdn = new IWSL_CDN_Rewrite( $iwsl_ent, new IWSL_WP_Store() );
if ( $iwsl_switches->is_on( IWSL_CDN_Rewrite::FEATURE ) ) {
	$iwsl_cdn->register();
	add_action( 'admin_post_' . IWSL_CDN_Rewrite::SETTINGS_ACTION, static function () use ( $iwsl_cdn, $iwsl_plus_redirect ): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( IWSL_CDN_Rewrite::SETTINGS_NONCE );
		$result = $iwsl_cdn->update_settings( $_POST );
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( IWSL_CDN_Rewrite::RESULT_PREFIX . get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $iwsl_plus_redirect( 'cdn' ) );
		exit;
	} );
}

// One-Click Duplicate (Pro) + SEO Meta Audit (Pro) + SVG Uploads (Pro) + Broken
// Link Scanner (Pro): register() self-wires their row/admin-post handlers.
if ( $iwsl_switches->is_on( IWSL_Duplicate_Post::FEATURE ) ) {
	( new IWSL_Duplicate_Post( $iwsl_ent, new IWSL_WP_Store() ) )->register();
}
if ( $iwsl_switches->is_on( IWSL_SEO_Audit::FEATURE ) ) {
	( new IWSL_SEO_Audit( $iwsl_ent, new IWSL_WP_Store() ) )->register();
}
if ( $iwsl_switches->is_on( IWSL_SVG_Upload::FEATURE ) ) {
	( new IWSL_SVG_Upload( $iwsl_ent ) )->register();
}
if ( $iwsl_switches->is_on( IWSL_Broken_Link_Scan::FEATURE ) ) {
	( new IWSL_Broken_Link_Scan( $iwsl_ent ) )->register();
}

// Maintenance Mode (Pro, `maintenance_mode`). The last constructor arg is the
// white-label brand-adoption provider: when the operator opted the holding page
// into the brand (`apply_to_maintenance`, gated on `white_label`), the page adopts
// the logo/name/accent — explicit local maintenance settings still win. null when
// white-label is switched off, so maintenance keeps its own default appearance.
$iwsl_maintenance = new IWSL_Maintenance_Mode(
	$iwsl_ent,
	new IWSL_WP_Store(),
	null,
	null,
	null,
	null,
	( null !== $iwsl_white_label )
		? static function () use ( $iwsl_white_label ): ?array {
			return $iwsl_white_label->maintenance_brand();
		}
		: null
);
if ( $iwsl_switches->is_on( IWSL_Maintenance_Mode::FEATURE ) ) {
	$iwsl_maintenance->register();
	add_action( 'admin_post_' . IWSL_Maintenance_Mode::ACTION, array( $iwsl_maintenance, 'handle_save' ) );
}

// Scheduled Database Cleanup (Pro, `scheduled_db_cleanup` — wraps the DB optimizer).
$iwsl_sched_db = new IWSL_Scheduled_DB_Cleanup( $iwsl_ent, new IWSL_WP_Store() );
if ( $iwsl_switches->is_on( IWSL_Scheduled_DB_Cleanup::FEATURE ) ) {
	$iwsl_sched_db->register();
	add_action( 'admin_post_' . IWSL_Scheduled_DB_Cleanup::SAVE_ACTION, array( $iwsl_sched_db, 'handle_save' ) );
	add_action( 'admin_post_' . IWSL_Scheduled_DB_Cleanup::RUN_ACTION, array( $iwsl_sched_db, 'handle_run_now' ) );
}

// Activity Log (Ultimate, `activity_log`).
$iwsl_activity = new IWSL_Activity_Log( $iwsl_ent, new IWSL_WP_Store() );
if ( $iwsl_switches->is_on( IWSL_Activity_Log::FEATURE ) ) {
	$iwsl_activity->register();
	add_action( 'admin_post_' . IWSL_Activity_Log::ACTION_CLEAR, array( $iwsl_activity, 'handle_clear' ) );
}

// Scheduled Auto-Convert (Ultimate, `auto_convert` — wraps the image optimizer).
$iwsl_auto_convert = new IWSL_Auto_Convert( $iwsl_ent, new IWSL_WP_Store() );
if ( $iwsl_switches->is_on( IWSL_Auto_Convert::FEATURE ) ) {
	$iwsl_auto_convert->register();
	add_action( 'admin_post_' . IWSL_Auto_Convert::ACTION_SAVE, array( $iwsl_auto_convert, 'handle_save' ) );
	add_action( 'admin_post_' . IWSL_Auto_Convert::ACTION_BACKLOG, array( $iwsl_auto_convert, 'handle_backlog' ) );
}

// Media Offload to S3 / Hetzner Object Storage (gated on `image_optimization` — it
// only ships the optimizer's WebP derivatives, so no new console flag). Registered
// on every request because the URL-rewrite filters serve offloaded images on the
// FRONT END; register()'s STATEMENT 1 is the entitlement gate, so a locked/revoked
// site attaches no filters and no handlers and behaves like stock WordPress. Its
// AJAX (test/status/offload/remove/manual) + admin-post save handler are self-wired
// inside register() (each re-checks manage_options + nonce + the gate).
( new IWSL_Media_Offload( $iwsl_ent, new IWSL_WP_Store() ) )->register();

// Media Folders / Explorer (Pro/Ultimate, `media_folders`). Windows-Explorer-style
// folder tree + tag filtering over the Media Library. register() self-wires AJAX +
// taxonomies + native-library filters, each gating on the entitlement as statement 1.
$iwsl_media_folders = new IWSL_Media_Folders( $iwsl_ent, new IWSL_WP_Store() );
if ( $iwsl_switches->is_on( IWSL_Media_Folders::FEATURE ) ) {
	$iwsl_media_folders->register();
}

// Background image conversion tick (gated on `image_optimization` inside the
// callback). Registered UNCONDITIONALLY — WP-Cron fires outside admin, so the hook
// must exist on every request for a scheduled tick to resolve. The tick re-checks
// the entitlement as its first act and self-unschedules once the backlog is done,
// stalled, or the flag is revoked, so a locked/revoked site pays nothing.
if ( function_exists( 'add_action' ) ) {
	add_action(
		IWSL_Media_Optimizer::BG_TICK_HOOK,
		static function (): void {
			( new IWSL_Media_Optimizer( iwsl_plugin()->entitlements() ) )->run_background_tick();
		}
	);
}

// Speed Pack (Pro, `speed_pack`). Writes a managed .htaccess block; maybe_revoke()
// tears it down the moment the flag is revoked (presence-based, like page cache).
$iwsl_speed_pack = new IWSL_Speed_Pack( $iwsl_ent, new IWSL_WP_Store() );
if ( $iwsl_switches->is_on( IWSL_Speed_Pack::FEATURE ) ) {
	$iwsl_speed_pack->register();
	$iwsl_speed_pack->maybe_revoke();
	add_action( 'admin_post_' . IWSL_Speed_Pack::SAVE_ACTION, array( $iwsl_speed_pack, 'handle_save' ) );
} else {
	// Switched off while still entitled → strip the managed .htaccess block now.
	$iwsl_speed_pack->disable();
}

// Response Time Scanner (Pro, `response_scan`). Active loopback probe of the site's
// OWN public URLs via wp_remote_get; register() self-wires its two admin-post handlers.
if ( $iwsl_switches->is_on( IWSL_Response_Scan::FEATURE ) ) {
	( new IWSL_Response_Scan( $iwsl_ent, new IWSL_WP_Store() ) )->register();
}

// Security Headers (Pro, `security_headers`). register() wires a single `send_headers`
// emitter whose FIRST statement is the entitlement gate, so a locked/revoked or
// switched-off site emits nothing and behaves like stock WordPress. The emitter never
// duplicates a header already present (peer plugin / PHP-visible upstream). The scan
// + closed-set harden surface reaches the site over the signed command channel only.
if ( $iwsl_switches->is_on( IWSL_Security_Headers::FEATURE ) ) {
	( new IWSL_Security_Headers( $iwsl_ent, new IWSL_WP_Store() ) )->register();
}

// Site Statistics (Ultimate, `statistics`) + Cookie Consent (Ultimate,
// `cookie_consent`): register() self-wires their admin-post handlers.
if ( $iwsl_switches->is_on( IWSL_Statistics::FEATURE ) ) {
	( new IWSL_Statistics( $iwsl_ent, new IWSL_WP_Store() ) )->register();
}
if ( $iwsl_switches->is_on( IWSL_Cookie_Consent::FEATURE ) ) {
	( new IWSL_Cookie_Consent( $iwsl_ent, new IWSL_WP_Store() ) )->register();
}

// SEO Suite (Ultimate, `seo_suite`). register() wires wp_head / wp_robots /
// pre_get_document_title / template_redirect (sitemap) / add_meta_boxes /
// save_post / robots_txt / the breadcrumb shortcode AND its admin-post save —
// every callback gates as STATEMENT 1, so a locked site emits no SEO output.
if ( $iwsl_switches->is_on( IWSL_SEO_Suite::FEATURE ) ) {
	( new IWSL_SEO_Suite( $iwsl_ent, new IWSL_WP_Store() ) )->register();
}

// SMTP delivery & email log (`email_delivery`, Pro). Passive core hooks only;
// every callback re-checks the gate as its first statement, so revoking the flag
// from the console instantly restores default WordPress mail behavior. Registered
// unconditionally (mail sends from the front end too — password resets, etc.); the
// engine is built lazily so a request that never sends mail forces no object graph.
if ( $iwsl_switches->is_on( IWSL_Email_Delivery::FEATURE ) ) {
	add_action(
		'phpmailer_init',
		function ( $phpmailer ): void {
			iwsl_plugin()->email_delivery()->configure_mailer( $phpmailer );
		},
		1000
	);
	add_filter(
		'wp_mail',
		function ( $args ) {
			return iwsl_plugin()->email_delivery()->capture_mail( $args );
		},
		1000
	);
	add_action(
		'wp_mail_failed',
		function ( $error ): void {
			iwsl_plugin()->email_delivery()->capture_failure( $error );
		}
	);
}

add_action(
	'rest_api_init',
	function (): void {
		// Passive proof document (§5 step 2) — public while pending, gone once active.
		register_rest_route(
			'infraweaver/v1',
			'/enroll-proof',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => function () {
					$proof = iwsl_plugin()->enrollment()->build_proof();
					if ( null === $proof ) {
						return new WP_REST_Response( array( 'error' => 'not-pending' ), 404 );
					}
					return new WP_REST_Response( $proof, 200 );
				},
			)
		);

		// Manual bundle upload (§5 step 2) — wp-admin credentialed operators only.
		register_rest_route(
			'infraweaver/v1',
			'/enroll',
			array(
				'methods'             => 'POST',
				'permission_callback' => function () {
					return current_user_can( 'manage_options' );
				},
				'callback'            => function ( WP_REST_Request $request ) {
					if ( ! iwsl_body_within_limit( $request ) ) {
						return new WP_REST_Response( array( 'ok' => false, 'reason' => 'too-large' ), 413 );
					}
					$decoded = json_decode( $request->get_body() );
					$result  = iwsl_plugin()->enrollment()->handle_bundle( $decoded );
					return new WP_REST_Response( $result, $result['ok'] ? 200 : 400 );
				},
			)
		);

		// Signed command channel (§6) — authentication IS the dual signature.
		register_rest_route(
			'infraweaver/v1',
			'/command',
			array(
				'methods'             => 'POST',
				'permission_callback' => '__return_true',
				'callback'            => function ( WP_REST_Request $request ) {
					if ( ! iwsl_body_within_limit( $request ) ) {
						return new WP_REST_Response( array( 'ok' => false, 'reason' => 'too-large' ), 413 );
					}
					$decoded = json_decode( $request->get_body() );
					// Public REST ingress → §6.4 channel tag 'https'; the verifier
					// rejects a command whose signed aud.chan says 'exec'.
					$result  = iwsl_plugin()->handle_command( $decoded, 'https' );
					return new WP_REST_Response( $result['body'], $result['status'] );
				},
			)
		);
	}
);

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	require_once __DIR__ . '/includes/class-iwsl-cli.php';
	WP_CLI::add_command( 'infraweaver', new IWSL_CLI( iwsl_plugin() ) );
}
