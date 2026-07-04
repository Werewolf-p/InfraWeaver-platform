<?php
/** Enrollment — §5/§5.1: TOFU pinning, binding, TTL, shred, activation. */

$f = iwsl_fixtures();

// --- happy path: bundle → pending → proof --------------------------------------
$store      = new IWSL_Memory_Store();
$enrollment = new IWSL_Enrollment( $store, iwsl_now_t0( 1000 ) );
$result     = $enrollment->handle_bundle( iwsl_clone( $f->enrollment->signed ) );
iwsl_assert( $result['ok'], 'valid bundle accepted' );
iwsl_assert_same( 'pending', $store->get( 'state' ), 'state pending after bundle' );

$iw_keys = $store->get( 'iw_keys.1' );
iwsl_assert_same( 32, strlen( $iw_keys[ IWSL_Crypto::ALG_ED25519 ] ), 'pinned Ed25519 IW-PK' );
iwsl_assert_same( 48, strlen( $iw_keys[ IWSL_Crypto::ALG_SLHDSA ] ), 'pinned SLH-DSA IW-PK' );
iwsl_assert( is_array( $store->get( 'wp_keys.1' ) ), 'WP keypair generated locally' );

$proof = $enrollment->build_proof();
iwsl_assert( is_array( $proof ), 'proof document published while pending' );
$secret   = IWSL_Crypto::b64u_decode( $f->keys->enroll_secret );
$expected = IWSL_Crypto::b64u_encode(
	IWSL_Crypto::enroll_binding( $secret, $f->site_id, $proof['proof']['wp_pk'] )
);
iwsl_assert_same( $expected, $proof['proof']['binding'], 'binding = HMAC(enroll_secret, site_id || wp_pk)' );

$message = IWSL_Crypto::domain_message(
	IWSL_Crypto::DOMAIN_ENROLL_PROOF,
	IWSL_JCS::canonicalize( $proof['proof'] )
);
iwsl_assert(
	IWSL_Crypto::ed_verify_raw(
		$message,
		IWSL_Crypto::b64u_decode( $proof['sigs'][ IWSL_Crypto::ALG_ED25519 ] ),
		IWSL_Crypto::b64u_decode( $proof['proof']['wp_pk'] )
	),
	'proof self-signature verifies against published WP-PK'
);

// --- TOFU: exactly one enrollment -----------------------------------------------
$result = $enrollment->handle_bundle( iwsl_clone( $f->enrollment->signed ) );
iwsl_assert_same( 'already-enrolled', $result['reason'], 'second bundle rejected (TOFU)' );

// --- activation: burn secret, retire proof endpoint ------------------------------
$enrollment->activate();
iwsl_assert_same( 'active', $store->get( 'state' ), 'state active after first verified command' );
iwsl_assert_same( null, $store->get( 'enroll_secret' ), 'enroll_secret burned' );
iwsl_assert_same( null, $enrollment->build_proof(), 'proof endpoint gone once active' );

// --- tampered bundle ---------------------------------------------------------------
$store      = new IWSL_Memory_Store();
$enrollment = new IWSL_Enrollment( $store, iwsl_now_t0( 1000 ) );
$tampered   = iwsl_clone( $f->enrollment->signed );
$tampered->bundle->site_id = 'evil-site';
$result = $enrollment->handle_bundle( $tampered );
iwsl_assert_same( 'bad-sig-ed25519', $result['reason'], 'tampered bundle rejected' );

// --- downgrade-strip on the bundle ---------------------------------------------------
$stripped = iwsl_clone( $f->enrollment->signed );
unset( $stripped->sigs->{'slh-dsa-192s'} );
$result = $enrollment->handle_bundle( $stripped );
iwsl_assert_same( 'pq-required', $result['reason'], 'bundle without PQ signature rejected' );

// --- TTL --------------------------------------------------------------------------------
$late_enrollment = new IWSL_Enrollment( new IWSL_Memory_Store(), iwsl_now_t0( 16 * 60 * 1000 ) );
$result          = $late_enrollment->handle_bundle( iwsl_clone( $f->enrollment->signed ) );
iwsl_assert_same( 'enroll-expired', $result['reason'], 'bundle past 15m TTL rejected' );

// --- §5.1 wp-cli path: file consumed once, then shredded ---------------------------------
$store      = new IWSL_Memory_Store();
$enrollment = new IWSL_Enrollment( $store, iwsl_now_t0( 1000 ) );
$path       = sys_get_temp_dir() . '/iwsl-test-' . getmypid() . '.iwenroll';
file_put_contents( $path, json_encode( $f->enrollment->signed ) );
$result = $enrollment->enroll_from_file( $path );
iwsl_assert( $result['ok'], 'enroll_from_file succeeds' );
iwsl_assert( ! file_exists( $path ), 'bundle file shredded after use' );
iwsl_assert_same( 'pending', $store->get( 'state' ), 'file path lands in pending like manual path' );

// --- malformed bundle: non-string IW-PK member fails closed (no fatal) -----------------
$store      = new IWSL_Memory_Store();
$enrollment = new IWSL_Enrollment( $store, iwsl_now_t0( 1000 ) );
$malformed  = iwsl_clone( $f->enrollment->signed );
$malformed->bundle->iw_pk->ed25519 = new stdClass(); // was a b64u string
$result = $enrollment->handle_bundle( $malformed );
iwsl_assert_same( 'schema-fail', $result['reason'], 'non-string IW-PK member rejected, not fatal' );

// --- concurrent enrollment: the atomic claim blocks a racing second upload -------------
$store = new IWSL_Memory_Store();
$store->add( 'enroll_claim', 1 ); // simulate an in-flight peer that claimed first
$enrollment = new IWSL_Enrollment( $store, iwsl_now_t0( 1000 ) );
$result     = $enrollment->handle_bundle( iwsl_clone( $f->enrollment->signed ) );
iwsl_assert_same( 'enroll-in-progress', $result['reason'], 'racing second bundle rejected by claim' );

// --- a FAILED enrollment releases the claim so a corrected retry can proceed ------------
$store      = new IWSL_Memory_Store();
$enrollment = new IWSL_Enrollment( $store, iwsl_now_t0( 1000 ) );
$bad        = iwsl_clone( $f->enrollment->signed );
$bad->bundle->site_id = 'evil-site';
iwsl_assert_same( 'bad-sig-ed25519', $enrollment->handle_bundle( $bad )['reason'], 'first (bad) attempt fails' );
iwsl_assert_same( null, $store->get( 'enroll_claim' ), 'claim released after failure' );
$result = $enrollment->handle_bundle( iwsl_clone( $f->enrollment->signed ) );
iwsl_assert( $result['ok'], 'valid retry succeeds after prior failure released the claim' );
