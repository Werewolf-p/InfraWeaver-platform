<?php
/**
 * Plugin Name: InfraWeaver Connector
 * Description: Signed, IW-initiated management link (IWSL v1) — Ed25519 + SLH-DSA-192s dual-verified commands, zero standing WP→IW path.
 * Version: 0.2.0
 * Requires PHP: 7.4
 * License: AGPL-3.0-only
 *
 * Spec: docs/infraweaver-wp-remote-management-design.md (platform repo, FINAL v1.2).
 */

defined( 'ABSPATH' ) || exit;

define( 'IWSL_CONNECTOR_VERSION', '0.2.0' );

require_once __DIR__ . '/includes/class-iwsl-jcs.php';
require_once __DIR__ . '/includes/class-iwsl-slhdsa.php';
require_once __DIR__ . '/includes/class-iwsl-crypto.php';
require_once __DIR__ . '/includes/class-iwsl-store.php';
require_once __DIR__ . '/includes/class-iwsl-wp-store.php';
require_once __DIR__ . '/includes/class-iwsl-verifier.php';
require_once __DIR__ . '/includes/class-iwsl-enrollment.php';
require_once __DIR__ . '/includes/class-iwsl-rotation.php';
require_once __DIR__ . '/includes/class-iwsl-responder.php';
require_once __DIR__ . '/includes/class-iwsl-plugin.php';

function iwsl_plugin(): IWSL_Plugin {
	static $instance = null;
	if ( null === $instance ) {
		$instance = new IWSL_Plugin( new IWSL_WP_Store() );
	}
	return $instance;
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
					$decoded = json_decode( $request->get_body() );
					$result  = iwsl_plugin()->handle_command( $decoded );
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
