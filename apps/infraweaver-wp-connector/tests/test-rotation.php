<?php
/** Rotation — §8 v1.2: idempotent PREPARE/CONFIRM (lost-ack), monotonic floor, abort. */

$store = new IWSL_Memory_Store();
$store->set( 'site_id', 'site-fixture-1' );
$store->set( 'wp_keys.1', IWSL_Crypto::ed_keypair() );
$store->set( 'wp_current_kid', 1 );
$store->set( 'wp_epoch_floor', 1 );

$rotation  = new IWSL_Rotation( $store );
$responder = new IWSL_Responder( $store, $rotation, iwsl_now_t0() );

// --- PREPARE is idempotent on rotation_id (lost-ack recovery) --------------------
$first = $rotation->prepare( 'rot-1', 2 );
iwsl_assert( $first['ok'], 'prepare generates new keypair' );
$retry = $rotation->prepare( 'rot-1', 2 );
iwsl_assert( $retry['ok'], 'prepare retry accepted' );
iwsl_assert_same( $first['new_wp_pk'], $retry['new_wp_pk'], 'lost-ack retry returns the SAME key — no second key minted' );

// --- pending rotation signs under the new epoch (§8 VERIFY) -----------------------
iwsl_assert_same( 2, $rotation->signing_kid(), 'responses signed under prepared epoch' );
$response = $responder->build( 'nonce-x', true, array() );
iwsl_assert_same( 2, $response['envelope']['kid'], 'response envelope carries new kid' );
$message = IWSL_Crypto::domain_message( IWSL_Crypto::DOMAIN_RESP, IWSL_JCS::canonicalize( $response['envelope'] ) );
$new_pk  = IWSL_Crypto::b64u_decode( $first['new_wp_pk'] );
iwsl_assert(
	IWSL_Crypto::ed_verify_raw( $message, IWSL_Crypto::b64u_decode( $response['sigs'][ IWSL_Crypto::ALG_ED25519 ] ), $new_pk ),
	'response verifies under the NEW key'
);

// --- CONFIRM ratchets the floor, idempotently ---------------------------------------
$confirm = $rotation->confirm( 'rot-1' );
iwsl_assert( $confirm['ok'], 'confirm succeeds' );
iwsl_assert_same( 2, $store->get( 'wp_current_kid' ), 'current kid advanced' );
iwsl_assert_same( 2, $store->get( 'wp_epoch_floor' ), 'epoch floor ratcheted' );
iwsl_assert_same( null, $store->get( 'wp_keys.1' ), 'old key destroyed at retire' );
$confirm = $rotation->confirm( 'rot-1' );
iwsl_assert( $confirm['ok'], 'confirm retry (lost ack) still ok' );

// --- committed epochs never reopen ----------------------------------------------------
$replayed = $rotation->prepare( 'rot-1', 3 );
iwsl_assert_same( 'rotation-committed', $replayed['reason'], 'PREPARE replay after commit refused' );

// --- epoch discipline -------------------------------------------------------------------
$skip = $rotation->prepare( 'rot-2', 4 );
iwsl_assert_same( 'bad-epoch', $skip['reason'], 'non-contiguous epoch refused' );

// --- ABORT discards the uncommitted key, old key keeps working ----------------------------
$prep = $rotation->prepare( 'rot-2', 3 );
iwsl_assert( $prep['ok'], 'second rotation prepares' );
$rotation->abort( 'rot-2' );
iwsl_assert_same( null, $store->get( 'pending_rotation' ), 'abort clears pending rotation' );
iwsl_assert_same( null, $store->get( 'wp_keys.3' ), 'abort destroys the uncommitted key' );
iwsl_assert_same( 2, $rotation->signing_kid(), 'signing falls back to committed epoch' );
iwsl_assert( is_array( $store->get( 'wp_keys.2' ) ), 'committed key untouched by abort' );
