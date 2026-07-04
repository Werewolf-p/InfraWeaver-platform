<?php
/** Pure-PHP SLH-DSA-SHA2-192s verify vs @noble/post-quantum vector. */

$f   = iwsl_fixtures();
$msg = base64_decode( $f->slh_vector->msg_b64 );
$sig = IWSL_Crypto::b64u_decode( $f->slh_vector->sig_b64u );
$pk  = IWSL_Crypto::b64u_decode( $f->slh_vector->pk_b64u );

iwsl_assert_same( IWSL_SLHDSA::SIG_BYTES, strlen( $sig ), 'signature length 16224' );
iwsl_assert_same( IWSL_SLHDSA::PK_BYTES, strlen( $pk ), 'public key length 48' );
iwsl_assert( IWSL_SLHDSA::verify( $sig, $msg, $pk ), 'valid noble signature accepted' );

iwsl_assert( ! IWSL_SLHDSA::verify( $sig, $msg . 'x', $pk ), 'modified message rejected' );

$bad_sig       = $sig;
$bad_sig[2000] = chr( ord( $bad_sig[2000] ) ^ 0x01 );
iwsl_assert( ! IWSL_SLHDSA::verify( $bad_sig, $msg, $pk ), 'flipped signature bit rejected' );

$bad_pk     = $pk;
$bad_pk[40] = chr( ord( $bad_pk[40] ) ^ 0x01 ); // flip inside PK.root
iwsl_assert( ! IWSL_SLHDSA::verify( $sig, $msg, $bad_pk ), 'wrong public key rejected' );

iwsl_assert( ! IWSL_SLHDSA::verify( substr( $sig, 0, 100 ), $msg, $pk ), 'truncated signature rejected' );
iwsl_assert( ! IWSL_SLHDSA::verify( $sig, $msg, substr( $pk, 0, 24 ) ), 'truncated public key rejected' );
