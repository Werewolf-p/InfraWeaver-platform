<?php
/**
 * IWSL crypto helpers — Ed25519 via libsodium (PHP core since 7.2),
 * SLH-DSA verify via IWSL_SLHDSA / IWSL_SLHDSA_192f (pure PHP), domain
 * separation, enrollment HMAC binding. Byte-compatible with the IW TS lib
 * (apps/infraweaver-console/src/lib/iwsl/crypto.ts).
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Crypto {

	const ALG_ED25519      = 'ed25519';
	const ALG_SLHDSA_192S  = 'slh-dsa-192s';
	const ALG_SLHDSA_192F  = 'slh-dsa-192f';
	// Back-compat alias: pre-migration code + the 192s enroll path still name this.
	const ALG_SLHDSA       = self::ALG_SLHDSA_192S;

	const DOMAIN_CMD           = 'IWSL-v1-cmd';
	const DOMAIN_RESP          = 'IWSL-v1-resp';
	const DOMAIN_ENROLL_BUNDLE = 'IWSL-v1-enroll-bundle';
	const DOMAIN_ENROLL_PROOF  = 'IWSL-v1-enroll-proof';

	const ENROLL_BINDING_LABEL = 'IWSL-enroll-v1';

	/** Verifier class for a pinned SLH-DSA algorithm, or null if unrecognised. */
	private static function slhdsa_verifier( string $alg ): ?string {
		if ( self::ALG_SLHDSA_192S === $alg ) {
			return 'IWSL_SLHDSA';
		}
		if ( self::ALG_SLHDSA_192F === $alg ) {
			return 'IWSL_SLHDSA_192f';
		}
		return null;
	}

	/**
	 * Which SLH-DSA parameter set a key/pubkey map pins, or null. Exactly one of
	 * 192s/192f must be present (both is ambiguous, neither is unpinned). Shared
	 * by verify_dual, enrollment pinning, and the verifier's key resolution so
	 * "which alg does this link use" has a single definition.
	 */
	public static function pinned_slhdsa_alg( array $keys ): ?string {
		$has_s = isset( $keys[ self::ALG_SLHDSA_192S ] );
		$has_f = isset( $keys[ self::ALG_SLHDSA_192F ] );
		if ( $has_s === $has_f ) {
			return null;
		}
		return $has_f ? self::ALG_SLHDSA_192F : self::ALG_SLHDSA_192S;
	}

	/** A signed `alg` array is valid iff it lists ed25519 + exactly one SLH-DSA set. */
	public static function is_command_alg( array $alg ): bool {
		return array( self::ALG_ED25519, self::ALG_SLHDSA_192S ) === $alg
			|| array( self::ALG_ED25519, self::ALG_SLHDSA_192F ) === $alg;
	}

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
	 * @param array    $iw_pks  ['ed25519' => raw 32B, ('slh-dsa-192s'|'slh-dsa-192f') => raw 48B].
	 * @return array   ['ok' => bool, 'reason' => string|null]
	 */
	public static function verify_dual( string $message, $sigs, array $iw_pks ): array {
		$sigs = is_object( $sigs ) ? get_object_vars( $sigs ) : $sigs;

		// The pinned key dictates which SLH-DSA parameter set this link uses:
		// exactly one of 192s/192f is pinned (192f arrives via re-enroll during
		// the migration). The command's PQ signature MUST be presented under that
		// same algorithm — a 192s signature can never satisfy a 192f-pinned link
		// (or vice-versa), so a downgrade/confusion attempt is rejected here
		// rather than silently verified against the wrong verifier.
		$pq_alg   = self::pinned_slhdsa_alg( $iw_pks );
		$verifier = null === $pq_alg ? null : self::slhdsa_verifier( $pq_alg );
		if ( null === $verifier ) {
			return array( 'ok' => false, 'reason' => 'pq-key-unpinned' );
		}

		$pq_sig = isset( $sigs[ $pq_alg ] ) && is_string( $sigs[ $pq_alg ] )
			? self::b64u_decode( $sigs[ $pq_alg ] )
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
		if ( ! $verifier::verify( $pq_sig, $message, $iw_pks[ $pq_alg ] ) ) {
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

	/**
	 * Display fingerprint (§5 step 3) — first 64 bits of SHA-256 in 4-hex
	 * groups, matching the console's `wpKeyFingerprint`/`iwKeysFingerprint`.
	 */
	public static function fingerprint( string $key_material ): string {
		return implode( ':', str_split( substr( hash( 'sha256', $key_material ), 0, 16 ), 4 ) );
	}

	/**
	 * Display fingerprint of a pinned IW key map (ed25519 || pinned-SLH-DSA bytes),
	 * alg-agnostic so a 192s or 192f link both render. Null if not fully pinned.
	 * Mirrors the console's iwKeysFingerprint over the same byte concatenation.
	 */
	public static function iw_fingerprint( array $iw_keys ): ?string {
		$pq_alg = self::pinned_slhdsa_alg( $iw_keys );
		if ( ! isset( $iw_keys[ self::ALG_ED25519 ] ) || null === $pq_alg ) {
			return null;
		}
		return self::fingerprint( $iw_keys[ self::ALG_ED25519 ] . $iw_keys[ $pq_alg ] );
	}
}
