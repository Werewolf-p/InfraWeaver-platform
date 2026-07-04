<?php
/**
 * IWSL crypto helpers — Ed25519 via libsodium (PHP core since 7.2),
 * SLH-DSA-192s verify via IWSL_SLHDSA (pure PHP), domain separation,
 * enrollment HMAC binding. Byte-compatible with the IW TS lib
 * (apps/infraweaver-console/src/lib/iwsl/crypto.ts).
 */

final class IWSL_Crypto {

	const ALG_ED25519 = 'ed25519';
	const ALG_SLHDSA  = 'slh-dsa-192s';

	const DOMAIN_CMD           = 'IWSL-v1-cmd';
	const DOMAIN_RESP          = 'IWSL-v1-resp';
	const DOMAIN_ENROLL_BUNDLE = 'IWSL-v1-enroll-bundle';
	const DOMAIN_ENROLL_PROOF  = 'IWSL-v1-enroll-proof';

	const ENROLL_BINDING_LABEL = 'IWSL-enroll-v1';

	public static function b64u_encode( string $bytes ): string {
		return rtrim( strtr( base64_encode( $bytes ), '+/', '-_' ), '=' );
	}

	/** Strict decode; null on malformed input. */
	public static function b64u_decode( string $text ) {
		if ( ! preg_match( '/^[A-Za-z0-9_-]*$/', $text ) ) {
			return null;
		}
		$b64     = strtr( $text, '-_', '+/' );
		$padding = strlen( $b64 ) % 4;
		if ( 1 === $padding ) {
			return null;
		}
		if ( $padding > 0 ) {
			$b64 .= str_repeat( '=', 4 - $padding );
		}
		$decoded = base64_decode( $b64, true );
		return false === $decoded ? null : $decoded;
	}

	/** `tag || 0x00 || canonicalJson` — §6.1 domain separation. */
	public static function domain_message( string $tag, string $canonical ): string {
		return $tag . "\x00" . $canonical;
	}

	/**
	 * Verify BOTH command signatures against the pinned IW public keys.
	 * AND semantics — either missing or invalid rejects (§6.1, fail closed).
	 *
	 * @param string   $message Domain-separated message bytes.
	 * @param stdClass|array $sigs Signature set (alg => base64url).
	 * @param array    $iw_pks  ['ed25519' => raw 32B, 'slh-dsa-192s' => raw 48B].
	 * @return array   ['ok' => bool, 'reason' => string|null]
	 */
	public static function verify_dual( string $message, $sigs, array $iw_pks ): array {
		$sigs   = is_object( $sigs ) ? get_object_vars( $sigs ) : $sigs;
		$pq_sig = isset( $sigs[ self::ALG_SLHDSA ] ) && is_string( $sigs[ self::ALG_SLHDSA ] )
			? self::b64u_decode( $sigs[ self::ALG_SLHDSA ] )
			: null;
		if ( null === $pq_sig || '' === $pq_sig ) {
			return array( 'ok' => false, 'reason' => 'pq-required' );
		}
		$ed_sig = isset( $sigs[ self::ALG_ED25519 ] ) && is_string( $sigs[ self::ALG_ED25519 ] )
			? self::b64u_decode( $sigs[ self::ALG_ED25519 ] )
			: null;
		if ( null === $ed_sig || ! self::ed_verify_raw( $message, $ed_sig, $iw_pks[ self::ALG_ED25519 ] ) ) {
			return array( 'ok' => false, 'reason' => 'bad-sig-ed25519' );
		}
		if ( ! IWSL_SLHDSA::verify( $pq_sig, $message, $iw_pks[ self::ALG_SLHDSA ] ) ) {
			return array( 'ok' => false, 'reason' => 'bad-sig-pq' );
		}
		return array( 'ok' => true, 'reason' => null );
	}

	public static function ed_verify_raw( string $message, string $signature, string $public_key ): bool {
		if ( strlen( $signature ) !== SODIUM_CRYPTO_SIGN_BYTES || strlen( $public_key ) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES ) {
			return false;
		}
		try {
			return sodium_crypto_sign_verify_detached( $signature, $message, $public_key );
		} catch ( SodiumException $e ) {
			return false;
		}
	}

	/** Sign with a 64-byte libsodium secret key; returns base64url. */
	public static function ed_sign( string $message, string $secret_key ): string {
		return self::b64u_encode( sodium_crypto_sign_detached( $message, $secret_key ) );
	}

	/** New Ed25519 keypair: ['sk' => 64B sodium secret, 'pk' => 32B]. */
	public static function ed_keypair(): array {
		$pair = sodium_crypto_sign_keypair();
		return array(
			'sk' => sodium_crypto_sign_secretkey( $pair ),
			'pk' => sodium_crypto_sign_publickey( $pair ),
		);
	}

	/**
	 * Enrollment binding (§5 step 2) — mirrors the TS `enrollBinding`:
	 * HMAC-SHA-384(secret, label || 0x00 || site_id || 0x00 || wp_pk_b64u).
	 */
	public static function enroll_binding( string $enroll_secret, string $site_id, string $wp_pk_b64u ): string {
		$data = self::ENROLL_BINDING_LABEL . "\x00" . $site_id . "\x00" . $wp_pk_b64u;
		return hash_hmac( 'sha384', $data, $enroll_secret, true );
	}
}
