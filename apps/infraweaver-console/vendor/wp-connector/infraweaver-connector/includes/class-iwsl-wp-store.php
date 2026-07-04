<?php
/**
 * WordPress-backed IWSL store. Options table, `iwsl_` prefix, autoload off.
 * Values are base64-wrapped serialized blobs: key material is raw bytes and
 * must survive utf8mb4 column round-trips untouched.
 */

final class IWSL_WP_Store implements IWSL_Store {

	const PREFIX = 'iwsl_';

	public function get( string $key, $default = null ) {
		$raw = get_option( self::PREFIX . $key, null );
		if ( null === $raw || ! is_string( $raw ) ) {
			return $default;
		}
		$decoded = base64_decode( $raw, true );
		if ( false === $decoded ) {
			return $default;
		}
		$value = unserialize( $decoded, array( 'allowed_classes' => false ) );
		return false === $value && 'b:0;' !== $decoded ? $default : $value;
	}

	public function set( string $key, $value ): void {
		update_option( self::PREFIX . $key, base64_encode( serialize( $value ) ), false );
	}

	public function delete( string $key ): void {
		delete_option( self::PREFIX . $key );
	}

	public function add( string $key, $value ): bool {
		// add_option INSERTs and relies on the options table's UNIQUE key on
		// option_name, so a concurrent loser fails the insert and returns false —
		// the atomic claim the enrollment guard needs.
		return add_option( self::PREFIX . $key, base64_encode( serialize( $value ) ), '', false );
	}
}
