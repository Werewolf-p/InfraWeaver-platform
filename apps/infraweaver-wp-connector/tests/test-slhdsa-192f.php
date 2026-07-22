<?php
/**
 * Pure-PHP SLH-DSA-SHA2-192f verify vs a @noble/post-quantum known-answer vector.
 *
 * IWSL_SLHDSA_192f is the fast-signing re-enroll profile (FIPS 205 Table 2:
 * n=24, h=66, d=22, h'=3, a=8, k=33, m=42; publicKey=48, signature=35664). It is
 * VERIFY-ONLY in PHP (the whole SLH-DSA base class is — the Connector never signs
 * post-quantum), and it is NOT in the harness preload list, so this suite
 * requires it and drives it against an externally-produced vector.
 *
 * The vector (tests/fixtures/slhdsa-192f-vector.json) is emitted by
 * tests/gen-192f-vector.mjs using @noble/post-quantum — the same KAT-backed lib
 * whose 192s vectors the sibling test-slhdsa suite is cross-checked against — via
 * the exact sign(msg, secretKey) convention the console's crypto.ts uses. PHP
 * independently re-deriving the same accept/reject verdicts is a genuine
 * cross-implementation KAT: it proves the 192f tree params + digest split above.
 */

// 192f is intentionally excluded from run-tests.php's preload (only 192s ships in
// the base class); load the subclass under test here. Its IWSL_SLHDSA base is
// already loaded by the harness bootstrap.
require_once __DIR__ . '/../includes/class-iwsl-slhdsa-192f.php';

$raw = file_get_contents( __DIR__ . '/fixtures/slhdsa-192f-vector.json' );
if ( false === $raw ) {
	fwrite( STDERR, "192f vector missing — run: node tests/gen-192f-vector.mjs (from apps/infraweaver-console)\n" );
	exit( 2 );
}
$v = json_decode( $raw );

$msg = base64_decode( $v->msg_b64 );
$sig = base64_decode( $v->sig_b64 );
$pk  = base64_decode( $v->pk_b64 );

// Parameter-set shape: these are the constants under test — a wrong override
// would desync PHP from the FIPS 205 192f set and every verify below would fail.
iwsl_assert_same( 35664, IWSL_SLHDSA_192f::SIG_BYTES, 'SIG_BYTES = 35664 (192f)' );
iwsl_assert_same( 48, IWSL_SLHDSA_192f::PK_BYTES, 'PK_BYTES = 48 (inherited)' );
iwsl_assert_same( IWSL_SLHDSA_192f::SIG_BYTES, strlen( $sig ), 'vector signature length matches SIG_BYTES' );
iwsl_assert_same( IWSL_SLHDSA_192f::PK_BYTES, strlen( $pk ), 'vector public key length matches PK_BYTES' );

// Round-trip: the pure-PHP 192f verifier accepts the noble-signed vector.
iwsl_assert( IWSL_SLHDSA_192f::verify( $sig, $msg, $pk ), 'valid noble 192f signature accepted' );

// Negative: a flipped message byte fails closed.
iwsl_assert( ! IWSL_SLHDSA_192f::verify( $sig, $msg . 'x', $pk ), 'modified message rejected' );

// Negative: a single flipped signature bit fails closed.
$bad_sig       = $sig;
$bad_sig[5000] = chr( ord( $bad_sig[5000] ) ^ 0x01 );
iwsl_assert( ! IWSL_SLHDSA_192f::verify( $bad_sig, $msg, $pk ), 'flipped signature bit rejected' );

// Negative: a wrong public key (bit flipped inside PK.root) fails closed.
$bad_pk     = $pk;
$bad_pk[40] = chr( ord( $bad_pk[40] ) ^ 0x01 );
iwsl_assert( ! IWSL_SLHDSA_192f::verify( $sig, $msg, $bad_pk ), 'wrong public key rejected' );

// Negative: structurally malformed inputs fail closed on the length guard, never fatal.
iwsl_assert( ! IWSL_SLHDSA_192f::verify( substr( $sig, 0, 100 ), $msg, $pk ), 'truncated signature rejected' );
iwsl_assert( ! IWSL_SLHDSA_192f::verify( $sig, $msg, substr( $pk, 0, 24 ) ), 'truncated public key rejected' );

// Guard against a 192s/192f mix-up: a 192s-sized (16224B) signature must NOT verify
// under the 192f profile — the length gate rejects it before any crypto work.
iwsl_assert( ! IWSL_SLHDSA_192f::verify( str_repeat( "\x00", 16224 ), $msg, $pk ), '192s-sized signature rejected under 192f profile' );
