<?php
/**
 * IWSL enrollment — plugin side of §5 (manual upload) and §5.1 (automated /
 * wp-cli). One code path for both: automation changes bundle TRANSPORT only.
 *
 * Flow: verify bundle_sig against the IW-PK inside the bundle (TOFU — first
 * upload pins), generate WP-SK locally, publish the passive enroll-proof
 * document. enroll_secret itself is never published — only the HMAC binding.
 */

final class IWSL_Enrollment {

	/** @var IWSL_Store */
	private $store;

	/** @var callable():int */
	private $now_ms;

	public function __construct( IWSL_Store $store, ?callable $now_ms = null ) {
		$this->store  = $store;
		$this->now_ms = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/**
	 * Handle an uploaded `.iwenroll` bundle (decoded JSON, objects as stdClass).
	 *
	 * @return array ['ok' => bool, 'reason' => string|null]
	 */
	public function handle_bundle( $signed ): array {
		if ( 'unenrolled' !== $this->store->get( 'state', 'unenrolled' ) ) {
			return array( 'ok' => false, 'reason' => 'already-enrolled' );
		}
		// Atomic claim (§5): only one concurrent bundle upload may drive the
		// unenrolled → pending transition. Check-then-act on `state` alone races;
		// the loser is told to retry. Released below on any failure so a
		// corrected retry can proceed; a successful claim is left in place because
		// `state` is now 'pending', which the guard above already blocks on.
		if ( ! $this->store->add( 'enroll_claim', ( $this->now_ms )() ) ) {
			return array( 'ok' => false, 'reason' => 'enroll-in-progress' );
		}
		$result = $this->process_bundle( $signed );
		if ( ! $result['ok'] ) {
			$this->store->delete( 'enroll_claim' );
		}
		return $result;
	}

	/** @return array ['ok' => bool, 'reason' => string|null] */
	private function process_bundle( $signed ): array {
		if ( ! $signed instanceof stdClass || ! isset( $signed->bundle, $signed->sigs ) ) {
			return array( 'ok' => false, 'reason' => 'schema-fail' );
		}
		$bundle = $signed->bundle;
		if (
			! $bundle instanceof stdClass ||
			! isset( $bundle->v, $bundle->typ, $bundle->site_id, $bundle->iw_kid, $bundle->iw_pk, $bundle->enroll_secret, $bundle->expires_ts ) ||
			1 !== $bundle->v || 'enroll-bundle' !== $bundle->typ ||
			! is_string( $bundle->site_id ) || '' === $bundle->site_id ||
			! is_int( $bundle->iw_kid ) || $bundle->iw_kid < 1 ||
			! is_int( $bundle->expires_ts ) ||
			! $bundle->iw_pk instanceof stdClass
		) {
			return array( 'ok' => false, 'reason' => 'schema-fail' );
		}

		$iw_pks = $this->decode_iw_pks( $bundle->iw_pk );
		if ( null === $iw_pks ) {
			return array( 'ok' => false, 'reason' => 'schema-fail' );
		}
		$enroll_secret = IWSL_Crypto::b64u_decode( (string) $bundle->enroll_secret );
		if ( null === $enroll_secret || strlen( $enroll_secret ) < 32 ) {
			return array( 'ok' => false, 'reason' => 'schema-fail' );
		}

		// TOFU trust anchor: the bundle is self-certified by the IW-PK it
		// carries; possession-proof comes later via the enroll_secret binding.
		try {
			$canonical = IWSL_JCS::canonicalize( $bundle );
		} catch ( InvalidArgumentException $e ) {
			return array( 'ok' => false, 'reason' => 'schema-fail' );
		}
		$message = IWSL_Crypto::domain_message( IWSL_Crypto::DOMAIN_ENROLL_BUNDLE, $canonical );
		$sig_ok  = IWSL_Crypto::verify_dual( $message, $signed->sigs, $iw_pks );
		if ( ! $sig_ok['ok'] ) {
			return array( 'ok' => false, 'reason' => $sig_ok['reason'] );
		}

		if ( ( $this->now_ms )() > $bundle->expires_ts ) {
			return array( 'ok' => false, 'reason' => 'enroll-expired' );
		}

		// Pin IW-PK, generate WP-SK (never leaves this box), go pending.
		$wp_pair = IWSL_Crypto::ed_keypair();
		$this->store->set( 'site_id', $bundle->site_id );
		$this->store->set( 'iw_keys.' . $bundle->iw_kid, $iw_pks );
		$this->store->set( 'iw_current_kid', $bundle->iw_kid );
		$this->store->set( 'iw_epoch_floor', $bundle->iw_kid );
		$this->store->set( 'enroll_secret', $enroll_secret );
		$this->store->set( 'wp_keys.1', $wp_pair );
		$this->store->set( 'wp_current_kid', 1 );
		$this->store->set( 'wp_epoch_floor', 1 );
		$this->store->set( 'last_seq', 0 );
		$this->store->set( 'nonces', array() );
		$this->store->set( 'state', 'pending' );

		return array( 'ok' => true, 'reason' => null );
	}

	/**
	 * The passive proof document served at GET /wp-json/infraweaver/v1/enroll-proof
	 * while state is pending (§5 step 2). Removed once ACTIVE (§5 step 4).
	 *
	 * @return array|null Wire-shaped array (json_encode-ready) or null.
	 */
	public function build_proof(): ?array {
		if ( 'pending' !== $this->store->get( 'state' ) ) {
			return null;
		}
		$secret  = $this->store->get( 'enroll_secret' );
		$wp_pair = $this->store->get( 'wp_keys.1' );
		$site_id = $this->store->get( 'site_id' );
		if ( ! is_string( $secret ) || ! is_array( $wp_pair ) || ! is_string( $site_id ) ) {
			return null;
		}
		$wp_pk_b64u = IWSL_Crypto::b64u_encode( $wp_pair['pk'] );
		$proof      = array(
			'v'       => 1,
			'typ'     => 'enroll-proof',
			'site_id' => $site_id,
			'wp_pk'   => $wp_pk_b64u,
			'ts'      => ( $this->now_ms )(),
			'binding' => IWSL_Crypto::b64u_encode(
				IWSL_Crypto::enroll_binding( $secret, $site_id, $wp_pk_b64u )
			),
		);
		$message = IWSL_Crypto::domain_message(
			IWSL_Crypto::DOMAIN_ENROLL_PROOF,
			IWSL_JCS::canonicalize( $proof )
		);
		return array(
			'proof' => $proof,
			'sigs'  => array(
				IWSL_Crypto::ALG_ED25519 => IWSL_Crypto::ed_sign( $message, $wp_pair['sk'] ),
			),
		);
	}

	/**
	 * First verified command flips pending → active: burn the enroll secret and
	 * retire the proof endpoint (§5 steps 3–4).
	 */
	public function activate(): void {
		if ( 'pending' === $this->store->get( 'state' ) ) {
			$this->store->delete( 'enroll_secret' );
			$this->store->set( 'state', 'active' );
		}
	}

	/**
	 * §5.1 — `wp infraweaver enroll --file=<path>`: consume the bundle once,
	 * then shred the file (best-effort overwrite + unlink).
	 */
	public function enroll_from_file( string $path ): array {
		$raw = @file_get_contents( $path );
		if ( false === $raw ) {
			return array( 'ok' => false, 'reason' => 'file-unreadable' );
		}
		$decoded = json_decode( $raw );
		$result  = $this->handle_bundle( $decoded );
		if ( $result['ok'] ) {
			$this->shred_file( $path, strlen( $raw ) );
		}
		return $result;
	}

	private function shred_file( string $path, int $length ): void {
		$handle = @fopen( $path, 'r+b' );
		if ( false !== $handle ) {
			fwrite( $handle, str_repeat( "\x00", $length ) );
			fflush( $handle );
			fclose( $handle );
		}
		@unlink( $path );
	}

	/** @return array|null ['ed25519' => raw 32B, 'slh-dsa-192s' => raw 48B] */
	private function decode_iw_pks( stdClass $iw_pk ): ?array {
		$vars = get_object_vars( $iw_pk );
		if ( ! isset( $vars[ IWSL_Crypto::ALG_ED25519 ], $vars[ IWSL_Crypto::ALG_SLHDSA ] ) ) {
			return null;
		}
		// Sub-properties are attacker-controlled; a non-string (e.g. a nested
		// object) would fatal on the (string) cast below rather than fail closed.
		if ( ! is_string( $vars[ IWSL_Crypto::ALG_ED25519 ] ) || ! is_string( $vars[ IWSL_Crypto::ALG_SLHDSA ] ) ) {
			return null;
		}
		$ed = IWSL_Crypto::b64u_decode( $vars[ IWSL_Crypto::ALG_ED25519 ] );
		$pq = IWSL_Crypto::b64u_decode( $vars[ IWSL_Crypto::ALG_SLHDSA ] );
		if ( null === $ed || SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES !== strlen( $ed ) ) {
			return null;
		}
		if ( null === $pq || IWSL_SLHDSA::PK_BYTES !== strlen( $pq ) ) {
			return null;
		}
		return array(
			IWSL_Crypto::ALG_ED25519 => $ed,
			IWSL_Crypto::ALG_SLHDSA  => $pq,
		);
	}
}
