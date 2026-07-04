<?php
/** JCS canonicalization — must match the TS canonicalizer byte-for-byte. */

$f = iwsl_fixtures();

foreach ( $f->jcs_vectors as $i => $vector ) {
	iwsl_assert_same( $vector->canon, IWSL_JCS::canonicalize( $vector->value ), "TS/PHP canon parity vector {$i}" );
}

iwsl_assert_same( '{"a":2,"b":1}', IWSL_JCS::canonicalize( array( 'b' => 1, 'a' => 2 ) ), 'assoc array as object, sorted' );
iwsl_assert_same( '{}', IWSL_JCS::canonicalize( new stdClass() ), 'empty stdClass is an object' );
iwsl_assert_same( '[]', IWSL_JCS::canonicalize( array() ), 'empty PHP array is a list' );
iwsl_assert_same( '[1,2]', IWSL_JCS::canonicalize( array( 1, 2 ) ), 'sequential array is a list' );

$threw = false;
try {
	IWSL_JCS::canonicalize( 1.5 );
} catch ( InvalidArgumentException $e ) {
	$threw = true;
}
iwsl_assert( $threw, 'floats rejected' );

$threw = false;
try {
	IWSL_JCS::canonicalize( array( "k\u{00e9}y" => 1 ) );
} catch ( InvalidArgumentException $e ) {
	$threw = true;
}
iwsl_assert( $threw, 'non-ASCII object keys rejected' );
