<?php
/** Full plugin flow: enroll → first command activates → replay blocked → kill switch. */

$f = iwsl_fixtures();

$store  = new IWSL_Memory_Store();
$plugin = new IWSL_Plugin( $store, iwsl_now_t0( 5000 ) );

// Unenrolled: everything refused.
$refused = $plugin->handle_command( iwsl_clone( $f->commands->valid ) );
iwsl_assert_same( 403, $refused['status'], 'commands refused before enrollment' );
iwsl_assert_same( 'not-enrolled', $refused['body']['reason'], 'reason: not-enrolled' );

// Enroll (bundle) → pending.
$enrolled = $plugin->enrollment()->handle_bundle( iwsl_clone( $f->enrollment->signed ) );
iwsl_assert( $enrolled['ok'], 'bundle enrolls plugin' );

// First verified command flips pending → active and answers signed.
$handled = $plugin->handle_command( iwsl_clone( $f->commands->valid ) );
iwsl_assert_same( 200, $handled['status'], 'valid command executes' );
iwsl_assert_same( 'active', $store->get( 'state' ), 'first verified command activates the site' );
$envelope = $handled['body']['envelope'];
iwsl_assert_same( 'fixture-nonce-valid-1', $envelope['in_reply_to'], 'response bound to command nonce' );
iwsl_assert_same( array( 'ed25519' ), $envelope['alg'], 'response is Ed25519-only (v1.2)' );

$wp_pair = $store->get( 'wp_keys.1' );
$message = IWSL_Crypto::domain_message( IWSL_Crypto::DOMAIN_RESP, IWSL_JCS::canonicalize( $envelope ) );
iwsl_assert(
	IWSL_Crypto::ed_verify_raw(
		$message,
		IWSL_Crypto::b64u_decode( $handled['body']['sigs'][ IWSL_Crypto::ALG_ED25519 ] ),
		$wp_pair['pk']
	),
	'response signature verifies against site WP-PK'
);

// Replay through the full plugin stack.
$replayed = $plugin->handle_command( iwsl_clone( $f->commands->valid ) );
iwsl_assert_same( 403, $replayed['status'], 'replayed command refused' );
iwsl_assert_same( 'seq-rollback', $replayed['body']['reason'], 'replay reason surfaced (§12.5)' );

// §8 rotation over the full stack — PREPARE answer signed by the OLD key
// (chain of custody), CONFIRM ratchets the epoch.
$old_pair = $store->get( 'wp_keys.1' );
$prepared = $plugin->handle_command( iwsl_clone( $f->commands->rotatePrepare ) );
iwsl_assert_same( 200, $prepared['status'], 'key.rotate.self executes' );
iwsl_assert_same( 1, $prepared['body']['envelope']['kid'], 'PREPARE response carries the OLD epoch' );
$message = IWSL_Crypto::domain_message( IWSL_Crypto::DOMAIN_RESP, IWSL_JCS::canonicalize( $prepared['body']['envelope'] ) );
iwsl_assert(
	IWSL_Crypto::ed_verify_raw(
		$message,
		IWSL_Crypto::b64u_decode( $prepared['body']['sigs'][ IWSL_Crypto::ALG_ED25519 ] ),
		$old_pair['pk']
	),
	'PREPARE response verifies under the OLD WP-SK (§8 chain of custody)'
);
$new_pk = IWSL_Crypto::b64u_decode( $prepared['body']['envelope']['result']['new_wp_pk'] );

$confirmed = $plugin->handle_command( iwsl_clone( $f->commands->rotateConfirm ) );
iwsl_assert_same( 200, $confirmed['status'], 'key.rotate.confirm executes' );
iwsl_assert_same( 2, $confirmed['body']['envelope']['kid'], 'CONFIRM response under the new epoch' );
$message = IWSL_Crypto::domain_message( IWSL_Crypto::DOMAIN_RESP, IWSL_JCS::canonicalize( $confirmed['body']['envelope'] ) );
iwsl_assert(
	IWSL_Crypto::ed_verify_raw(
		$message,
		IWSL_Crypto::b64u_decode( $confirmed['body']['sigs'][ IWSL_Crypto::ALG_ED25519 ] ),
		$new_pk
	),
	'CONFIRM response verifies under the NEW WP-SK'
);
iwsl_assert_same( 2, $store->get( 'wp_current_kid' ), 'epoch ratcheted through full stack' );
iwsl_assert_same( null, $store->get( 'wp_keys.1' ), 'old WP key destroyed at confirm' );

// debug.status — structured §12.5 diagnostics over the signed channel.
$debugged = $plugin->handle_command( iwsl_clone( $f->commands->debugStatus ) );
iwsl_assert_same( 200, $debugged['status'], 'debug.status executes' );
$debug = $debugged['body']['envelope']['result'];
iwsl_assert_same( 'active', $debug['state'], 'debug.status reports link state' );
iwsl_assert_same( 2, $debug['wp_kid'], 'debug.status reports the rotated WP epoch' );
iwsl_assert_same( 18, $debug['last_seq'], 'debug.status reports last_seq' );
iwsl_assert( is_string( $debug['plugin'] ) && '' !== $debug['plugin'], 'debug.status reports plugin version' );
$wp_pair2 = $store->get( 'wp_keys.2' );
iwsl_assert_same(
	IWSL_Crypto::fingerprint( $wp_pair2['pk'] ),
	$debug['wp_fingerprint'],
	'debug.status fingerprint matches the active WP-PK'
);
iwsl_assert( ! isset( $debug['wp_sk'] ) && ! isset( $debug['sk'] ), 'debug.status leaks no key material' );

// Kill switch: respond, then forget everything (§8).
$deactivated = $plugin->handle_command( iwsl_clone( $f->commands->deactivate ) );
iwsl_assert_same( 200, $deactivated['status'], 'site.deactivate executes' );
iwsl_assert_same( 'unenrolled', $store->get( 'state' ), 'state wiped to unenrolled' );
iwsl_assert_same( null, $store->get( 'wp_keys.1' ), 'WP-SK wiped' );
iwsl_assert_same( null, $store->get( 'iw_keys.1' ), 'pinned IW-PK wiped' );

$after = $plugin->handle_command( iwsl_clone( $f->commands->valid ) );
iwsl_assert_same( 'not-enrolled', $after['body']['reason'], 'dead link stays dead' );
