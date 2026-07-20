<?php
/**
 * Plugin Name: InfraWeaver Connector
 * Description: Signed, IW-initiated management link (IWSL v1) — Ed25519 + SLH-DSA-192s dual-verified commands, zero standing WP→IW path.
 * Version: 0.7.0
 * Author: InfraWeaver
 * Requires at least: 5.9
 * Requires PHP: 7.4
 * License: AGPL-3.0-only
 * Text Domain: infraweaver-connector
 *
 * Spec: docs/infraweaver-wp-remote-management-design.md (platform repo, FINAL v1.2).
 */

defined( 'ABSPATH' ) || exit;

define( 'IWSL_CONNECTOR_VERSION', '0.7.0' );

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
require_once __DIR__ . '/includes/class-iwsl-plugin.php';
require_once __DIR__ . '/includes/class-iwsl-plus-feature.php';
require_once __DIR__ . '/includes/class-iwsl-media-converter.php';
require_once __DIR__ . '/includes/class-iwsl-webp-lossless-converter.php';
require_once __DIR__ . '/includes/class-iwsl-media-optimizer.php';
require_once __DIR__ . '/includes/class-iwsl-redirect-matcher.php';
require_once __DIR__ . '/includes/class-iwsl-exact-path-matcher.php';
require_once __DIR__ . '/includes/class-iwsl-redirects.php';
require_once __DIR__ . '/includes/iwsl-page-cache-helpers.php';
require_once __DIR__ . '/includes/class-iwsl-page-cache.php';
require_once __DIR__ . '/includes/class-iwsl-mail-transport.php';
require_once __DIR__ . '/includes/class-iwsl-smtp-transport.php';
require_once __DIR__ . '/includes/class-iwsl-email-delivery.php';
require_once __DIR__ . '/includes/class-iwsl-brand-surface.php';
require_once __DIR__ . '/includes/class-iwsl-login-brand-surface.php';
require_once __DIR__ . '/includes/class-iwsl-admin-brand-surface.php';
require_once __DIR__ . '/includes/class-iwsl-white-label.php';
require_once __DIR__ . '/includes/class-iwsl-db-cleaner.php';
require_once __DIR__ . '/includes/class-iwsl-db-cleaners.php';
require_once __DIR__ . '/includes/class-iwsl-db-optimizer.php';
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
if ( is_admin() ) {
	( new IWSL_Admin( iwsl_plugin() ) )->register();
}

// 301 Redirect Manager (gated, Pro). Registered on every request because the
// matcher runs on template_redirect; the callback's FIRST statement is the
// entitlement gate, so a locked or revoked site gets default behavior instantly.
( new IWSL_Redirects( iwsl_plugin()->entitlements(), new IWSL_WP_Store() ) )->register();

// Page Cache (gated, Pro/Ultimate, flag `page_cache`). Registered on every
// request: register() wires the purge hooks (each self-gates on is_enabled(), so
// a locked/disabled site pays nothing) and the admin_init revocation check.
// maybe_revoke() is ALSO invoked once here at bootstrap so the signed-command /
// heartbeat request path (non-admin) tears the serve-time drop-in down the moment
// the console revokes the flag — the drop-in itself runs before plugins load and
// cannot re-check the gate, so presence-based enforcement lives here. The common
// case is one is_file(): maybe_revoke() only touches disk when OUR drop-in exists.
$iwsl_page_cache = new IWSL_Page_Cache( iwsl_plugin()->entitlements() );
$iwsl_page_cache->register();
$iwsl_page_cache->maybe_revoke();

// Custom login + admin white-label (gated, `white_label`, Ultimate). Passive
// login/admin presentation hooks only; every callback re-checks the gate as its
// FIRST statement, so revoking the flag from the console instantly restores
// default WordPress login and admin chrome. Registered on every request because
// the login hooks fire on wp-login.php (not an admin context); the engine is cheap
// and reads only local state.
( new IWSL_White_Label( iwsl_plugin()->entitlements(), new IWSL_WP_Store() ) )->register();

// SMTP delivery & email log (`email_delivery`, Pro). Passive core hooks only;
// every callback re-checks the gate as its first statement, so revoking the flag
// from the console instantly restores default WordPress mail behavior. Registered
// unconditionally (mail sends from the front end too — password resets, etc.); the
// engine is built lazily so a request that never sends mail forces no object graph.
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
