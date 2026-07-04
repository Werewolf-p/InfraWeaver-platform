<?php
/**
 * Command verifier — the §12 fail-closed matrix, attack by attack:
 * replay, seq rollback, downgrade-strip, signature tamper, clock, kid epochs.
 */

$f       = iwsl_fixtures();
$methods = IWSL_Plugin::allowed_methods();

$fresh = static function ( int $now_offset = 5000 ) use ( $methods ): array {
	$store    = iwsl_seed_store();
	$verifier = new IWSL_Verifier( $store, $methods, iwsl_now_t0( $now_offset ) );
	return array( $store, $verifier );
};

// --- happy path -------------------------------------------------------------
list( $store, $verifier ) = $fresh();
$verdict = $verifier->verify_command( $f->commands->valid );
iwsl_assert( $verdict['ok'], 'valid dual-signed command accepted' );
iwsl_assert_same( 10, $store->get( 'last_seq' ), 'last_seq committed' );
iwsl_assert( isset( $store->get( 'nonces' )[ 'fixture-nonce-valid-1' ] ), 'nonce cached' );

// --- replay (verbatim re-send) ---------------------------------------------
$verdict = $verifier->verify_command( $f->commands->valid );
iwsl_assert_same( 'seq-rollback', $verdict['reason'], 'verbatim replay rejected (seq primary defense)' );

// --- replay after nonce-cache wipe (the v1.0 hole) ---------------------------
$store->set( 'nonces', array() );
$verdict = $verifier->verify_command( $f->commands->valid );
iwsl_assert_same( 'seq-rollback', $verdict['reason'], 'replay after cache wipe still rejected via seq' );

// --- replayed nonce with fresh seq -------------------------------------------
list( $store, $verifier ) = $fresh();
$verifier->verify_command( $f->commands->valid );
$verdict = $verifier->verify_command( $f->commands->nonceReuse );
iwsl_assert_same( 'replayed-nonce', $verdict['reason'], 'nonce reuse rejected even with higher seq' );

// --- seq rollback -------------------------------------------------------------
list( $store, $verifier ) = $fresh();
$verifier->verify_command( $f->commands->valid );
$verdict = $verifier->verify_command( $f->commands->seqRollback );
iwsl_assert_same( 'seq-rollback', $verdict['reason'], 'lower seq rejected' );

// --- downgrade: strip the PQ signature from the wire --------------------------
list( , $verifier ) = $fresh();
$stripped = iwsl_clone( $f->commands->valid );
unset( $stripped->sigs->{'slh-dsa-192s'} );
$verdict = $verifier->verify_command( $stripped );
iwsl_assert_same( 'pq-required', $verdict['reason'], 'downgrade-strip (missing PQ sig) rejected' );

// --- downgrade: strip the PQ layer from alg -----------------------------------
$stripped = iwsl_clone( $f->commands->valid );
$stripped->envelope->alg = array( 'ed25519' );
$verdict = $verifier->verify_command( $stripped );
iwsl_assert_same( 'pq-required', $verdict['reason'], 'downgrade-strip (alg edited) rejected' );

// --- signature tampering -------------------------------------------------------
$flip_b64u_char = static function ( string $text ): string {
	$text[3] = 'A' === $text[3] ? 'B' : 'A';
	return $text;
};

list( , $verifier ) = $fresh();
$tampered = iwsl_clone( $f->commands->valid );
$tampered->sigs->ed25519 = $flip_b64u_char( $tampered->sigs->ed25519 );
$verdict = $verifier->verify_command( $tampered );
iwsl_assert_same( 'bad-sig-ed25519', $verdict['reason'], 'corrupted Ed25519 signature rejected' );

list( , $verifier ) = $fresh();
$tampered = iwsl_clone( $f->commands->valid );
$tampered->sigs->{'slh-dsa-192s'} = $flip_b64u_char( $tampered->sigs->{'slh-dsa-192s'} );
$verdict = $verifier->verify_command( $tampered );
iwsl_assert_same( 'bad-sig-pq', $verdict['reason'], 'corrupted SLH-DSA signature rejected' );

list( , $verifier ) = $fresh();

$tampered = iwsl_clone( $f->commands->valid );
$tampered->envelope->params->privilege = 'admin';
$verdict = $verifier->verify_command( $tampered );
iwsl_assert_same( 'bad-sig-ed25519', $verdict['reason'], 'tampered params break both signatures' );

// --- freshness -----------------------------------------------------------------
list( , $verifier ) = $fresh();
$verdict = $verifier->verify_command( $f->commands->staleTs );
iwsl_assert_same( 'stale-ts', $verdict['reason'], 'ts outside ±300s rejected' );

$verdict = $verifier->verify_command( $f->commands->expired );
iwsl_assert_same( 'expired', $verdict['reason'], 'exp in the past rejected' );

// --- allow-list & schema --------------------------------------------------------
$verdict = $verifier->verify_command( $f->commands->unknownMethod );
iwsl_assert_same( 'unknown-method', $verdict['reason'], 'method outside allow-list rejected' );

$verdict = $verifier->verify_command( $f->commands->schemaFail );
iwsl_assert_same( 'schema-fail', $verdict['reason'], 'params failing method schema rejected' );

$malformed = iwsl_clone( $f->commands->valid );
$malformed->envelope->ts = 1.5;
$verdict = $verifier->verify_command( $malformed );
iwsl_assert_same( 'schema-fail', $verdict['reason'], 'float ts rejected structurally' );

// --- key epochs ------------------------------------------------------------------
$moved = iwsl_clone( $f->commands->valid );
$moved->envelope->kid = 9;
$verdict = $verifier->verify_command( $moved );
iwsl_assert_same( 'kid-unknown', $verdict['reason'], 'unknown kid rejected before signature work' );

list( $store, $verifier ) = $fresh();
$store->set( 'iw_epoch_floor', 2 );
$verdict = $verifier->verify_command( $f->commands->valid );
iwsl_assert_same( 'kid-retired', $verdict['reason'], 'kid below epoch floor rejected forever' );

// --- site binding ------------------------------------------------------------------
list( $store, $verifier ) = $fresh();
$store->set( 'site_id', 'some-other-site' );
$verdict = $verifier->verify_command( $f->commands->valid );
iwsl_assert_same( 'site-mismatch', $verdict['reason'], 'command for another site rejected' );
