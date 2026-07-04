<?php
/**
 * RFC 8785 (JCS) canonicalization — IWSL wire profile, mirroring the TS
 * canonicalizer byte-for-byte:
 *  - numbers MUST be integers (floats rejected — §6.1)
 *  - object keys MUST be ASCII (byte sort == UTF-16 code-unit sort)
 *  - JSON objects are represented as stdClass (json_decode WITHOUT assoc mode),
 *    or as PHP assoc arrays with string keys; empty PHP arrays canonicalize as
 *    JSON arrays, so builders must use `new stdClass()` for empty objects.
 */

final class IWSL_JCS {

	/**
	 * @param mixed $value Decoded JSON value (stdClass for objects).
	 * @throws InvalidArgumentException On floats, invalid UTF-8, non-ASCII keys.
	 */
	public static function canonicalize( $value ): string {
		if ( null === $value ) {
			return 'null';
		}
		if ( is_bool( $value ) ) {
			return $value ? 'true' : 'false';
		}
		if ( is_int( $value ) ) {
			return (string) $value;
		}
		if ( is_float( $value ) ) {
			throw new InvalidArgumentException( 'IWSL JCS: only integers are allowed on the wire' );
		}
		if ( is_string( $value ) ) {
			return self::encode_string( $value );
		}
		if ( is_array( $value ) ) {
			return self::is_list( $value )
				? self::canonicalize_list( $value )
				: self::canonicalize_object( $value );
		}
		if ( $value instanceof stdClass ) {
			return self::canonicalize_object( get_object_vars( $value ) );
		}
		throw new InvalidArgumentException( 'IWSL JCS: unsupported value type ' . gettype( $value ) );
	}

	private static function canonicalize_list( array $values ): string {
		$parts = array();
		foreach ( $values as $item ) {
			$parts[] = self::canonicalize( $item );
		}
		return '[' . implode( ',', $parts ) . ']';
	}

	private static function canonicalize_object( array $entries ): string {
		$keys = array_keys( $entries );
		foreach ( $keys as $key ) {
			$key = (string) $key;
			if ( ! preg_match( '/^[\x00-\x7f]*$/', $key ) ) {
				throw new InvalidArgumentException( 'IWSL JCS: object keys must be ASCII' );
			}
		}
		usort( $keys, 'strcmp' );
		$parts = array();
		foreach ( $keys as $key ) {
			$parts[] = self::encode_string( (string) $key ) . ':' . self::canonicalize( $entries[ $key ] );
		}
		return '{' . implode( ',', $parts ) . '}';
	}

	/** Matches ES JSON.stringify escaping (minimal, JCS-compliant). */
	private static function encode_string( string $value ): string {
		$encoded = json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( false === $encoded ) {
			throw new InvalidArgumentException( 'IWSL JCS: string is not valid UTF-8' );
		}
		return $encoded;
	}

	private static function is_list( array $value ): bool {
		if ( function_exists( 'array_is_list' ) ) {
			return array_is_list( $value );
		}
		return array_keys( $value ) === range( 0, count( $value ) - 1 ) || array() === $value;
	}
}
