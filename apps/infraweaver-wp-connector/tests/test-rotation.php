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

// --- last_reroll stamped on confirm (§8 observability) --------------------------------
$lr = $rotation->last_reroll();
iwsl_assert( is_array( $lr ), 'confirm stamps last_reroll' );
iwsl_assert_same( true, $lr['ok'], 'last_reroll marks success on confirm' );
iwsl_assert_same( 2, $lr['kid'], 'last_reroll records the new kid' );
iwsl_assert( is_int( $lr['at'] ) && $lr['at'] > 0, 'last_reroll carries a unix timestamp' );

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

// --- last_reroll marks a FAILED reroll on abort (old key stayed live) ------------------
$lr = $rotation->last_reroll();
iwsl_assert_same( false, $lr['ok'], 'abort marks last_reroll failed' );
iwsl_assert_same( 3, $lr['kid'], 'last_reroll records the aborted kid' );
iwsl_assert_same( 'aborted', $lr['reason'], 'aborted reroll carries a reason' );

// --- PREPARE is idempotent on new_kid under concurrency (no clobber) ------------------
// Two racing PREPAREs for the SAME new_kid must converge on ONE stored key. We
// model the pre-`pending_rotation` window a second worker observes by clearing
// pending after the first prepare: the second call must ADOPT the stored keypair,
// not regenerate and overwrite the one already returned to the console.
$store_i = new IWSL_Memory_Store();
$store_i->set( 'site_id', 'site-idem' );
$store_i->set( 'wp_keys.1', IWSL_Crypto::ed_keypair() );
$store_i->set( 'wp_current_kid', 1 );
$store_i->set( 'wp_epoch_floor', 1 );
$rot_i = new IWSL_Rotation( $store_i );

$p1 = $rot_i->prepare( 'rot-idem', 2 );
iwsl_assert( $p1['ok'], 'idempotent-prepare: first prepare stores a keypair' );
$key_after_first = $store_i->get( 'wp_keys.2' );

$store_i->delete( 'pending_rotation' ); // model a concurrent worker that saw pending=null
$p2 = $rot_i->prepare( 'rot-idem', 2 );
iwsl_assert( $p2['ok'], 'idempotent-prepare: racing prepare for the same new_kid accepted' );
iwsl_assert_same( $p1['new_wp_pk'], $p2['new_wp_pk'], 'idempotent-prepare: same public key — no second key minted' );
iwsl_assert_same( $key_after_first, $store_i->get( 'wp_keys.2' ), 'idempotent-prepare: stored keypair NOT overwritten' );

// --- responder fails CLOSED when the requested epoch key is missing --------------------
// §8 chain of custody: signing under the wrong epoch is forbidden. When the
// explicitly requested kid has no stored keypair, build() returns null (the
// caller emits an `internal` error) rather than silently signing with the
// current key.
$store_r = new IWSL_Memory_Store();
$store_r->set( 'site_id', 'site-resp' );
$store_r->set( 'wp_keys.5', IWSL_Crypto::ed_keypair() );
$store_r->set( 'wp_current_kid', 5 );
$store_r->set( 'wp_epoch_floor', 5 );
$rot_r  = new IWSL_Rotation( $store_r );
$resp_r = new IWSL_Responder( $store_r, $rot_r, iwsl_now_t0() );

$ok_resp = $resp_r->build( 'nonce-ok', true, array(), 5 );
iwsl_assert( is_array( $ok_resp ) && 5 === $ok_resp['envelope']['kid'], 'responder: signs under an existing requested kid' );

$missing_resp = $resp_r->build( 'nonce-x', true, array(), 6 );
iwsl_assert_same( null, $missing_resp, 'responder: fails closed (null) when the requested epoch key is missing — no fallback to the current key' );
