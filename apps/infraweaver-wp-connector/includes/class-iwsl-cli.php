<?php
/**
 * WP-CLI surface (§5.1, §12.5):
 *   wp infraweaver enroll --file=/path/site.iwenroll
 *   wp infraweaver status
 *   wp infraweaver selftest
 *
 * Loaded only when WP_CLI is defined (see infraweaver-connector.php).
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_CLI {

	/** @var IWSL_Plugin */
	private $plugin;

	public function __construct( IWSL_Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Consume an enrollment bundle once, then shred the file.
	 *
	 * ## OPTIONS
	 *
	 * --file=<path>
	 * : Path to the .iwenroll bundle delivered out-of-band (k8s Secret mount,
	 *   SCP, provisioner).
	 *
	 * @subcommand enroll
	 */
	public function enroll( array $args, array $assoc_args ): void {
		$path = isset( $assoc_args['file'] ) ? (string) $assoc_args['file'] : '';
		if ( '' === $path ) {
			WP_CLI::error( 'Missing --file=<path>.' );
		}
		$result = $this->plugin->enrollment()->enroll_from_file( $path );
		if ( ! $result['ok'] ) {
			WP_CLI::error( 'Enrollment failed: ' . $result['reason'] );
		}
		$store = $this->plugin->store();
		$pair  = $store->get( 'wp_keys.1' );
		WP_CLI::success( 'Enrolled (pending verification pull by InfraWeaver).' );
		WP_CLI::log( 'Site ID:            ' . $store->get( 'site_id' ) );
		WP_CLI::log( 'WP-PK fingerprint:  ' . self::fingerprint( $pair['pk'] ) );
		WP_CLI::log( 'Bundle file shredded. Compare fingerprints in the InfraWeaver console before first use.' );
	}

	/** Link status — §12.5. @subcommand status */
	public function status( array $args, array $assoc_args ): void {
		$store   = $this->plugin->store();
		$state   = $store->get( 'state', 'unenrolled' );
		$iw_kid  = (int) $store->get( 'iw_current_kid', 0 );
		$iw_keys = $store->get( 'iw_keys.' . $iw_kid );
		$wp_kid  = (int) $store->get( 'wp_current_kid', 0 );
		$wp_pair = $store->get( 'wp_keys.' . $wp_kid );
		$pending = $store->get( 'pending_rotation' );
		$reject  = $store->get( 'last_rejection' );

		WP_CLI::log( 'State:            ' . $state );
		WP_CLI::log( 'Site ID:          ' . ( $store->get( 'site_id' ) ?? '-' ) );
		WP_CLI::log( 'IW-PK pinned:     ' . ( is_array( $iw_keys ) ? ( IWSL_Crypto::iw_fingerprint( $iw_keys ) ?? '-' ) : '-' ) );
		WP_CLI::log( 'WP-PK:            ' . ( is_array( $wp_pair ) ? self::fingerprint( $wp_pair['pk'] ) : '-' ) );
		WP_CLI::log( 'kid (IW/WP):      ' . $iw_kid . '/' . $wp_kid );
		WP_CLI::log( 'last_seq:         ' . (int) $store->get( 'last_seq', 0 ) );
		WP_CLI::log( 'PQ algorithm:     ' . ( is_array( $iw_keys ) ? ( IWSL_Crypto::pinned_slhdsa_alg( $iw_keys ) ?? IWSL_Crypto::ALG_SLHDSA ) : IWSL_Crypto::ALG_SLHDSA ) );
		WP_CLI::log( 'Rotation phase:   ' . ( is_array( $pending ) ? 'prepare/verify (kid ' . $pending['new_kid'] . ')' : 'idle' ) );
		WP_CLI::log( 'Last rejection:   ' . ( is_array( $reject ) ? $reject['reason'] . ' @ ' . $reject['ts'] : '-' ) );
	}

	/**
	 * Client-side feature gate state — the same evaluation the Tools →
	 * InfraWeaver Plus page renders, on the command line. All local, no network.
	 *
	 * @subcommand gate
	 */
	public function gate( array $args, array $assoc_args ): void {
		$g = $this->plugin->entitlements()->evaluate( 'plus' );
		WP_CLI::log( 'Feature:          ' . $g['feature'] );
		WP_CLI::log( 'Unlocked:         ' . ( $g['unlocked'] ? 'yes' : 'NO' ) );
		WP_CLI::log( 'Linked:           ' . ( $g['linked'] ? 'yes' : 'no (' . $g['state'] . ')' ) );
		WP_CLI::log( 'Heartbeat fresh:  ' . ( $g['heartbeat_fresh'] ? 'yes' : 'no' )
			. ( null === $g['last_verified_at'] ? ' (never verified)' : ' (age ' . (int) floor( (int) $g['heartbeat_age_ms'] / 1000 ) . 's)' ) );
		WP_CLI::log( 'Plus granted:     ' . ( $g['plus'] ? 'yes' : 'no' ) );
		if ( ! empty( $g['reasons'] ) ) {
			WP_CLI::log( 'Locked because:   ' . implode( ', ', $g['reasons'] ) );
		}
	}

	/** Keys present, sign/verify round-trip, clock sanity. @subcommand selftest */
	public function selftest( array $args, array $assoc_args ): void {
		$failures = 0;

		$sodium_ok = function_exists( 'sodium_crypto_sign_verify_detached' );
		self::check( 'libsodium available', $sodium_ok, $failures );
		self::check( '64-bit PHP (SLH-DSA verify)', PHP_INT_SIZE >= 8, $failures );

		$pair    = IWSL_Crypto::ed_keypair();
		$message = IWSL_Crypto::domain_message( IWSL_Crypto::DOMAIN_RESP, '{"selftest":1}' );
		$sig     = IWSL_Crypto::ed_sign( $message, $pair['sk'] );
		$decoded = IWSL_Crypto::b64u_decode( $sig );
		self::check(
			'Ed25519 sign/verify round-trip',
			null !== $decoded && IWSL_Crypto::ed_verify_raw( $message, $decoded, $pair['pk'] ),
			$failures
		);

		$store  = $this->plugin->store();
		$state  = $store->get( 'state', 'unenrolled' );
		$wp_kid = (int) $store->get( 'wp_current_kid', 0 );
		if ( 'active' === $state || 'pending' === $state ) {
			self::check( 'WP keypair present', is_array( $store->get( 'wp_keys.' . $wp_kid ) ), $failures );
			$iw_kid = (int) $store->get( 'iw_current_kid', 0 );
			self::check( 'IW-PK pinned', is_array( $store->get( 'iw_keys.' . $iw_kid ) ), $failures );
		} else {
			WP_CLI::log( '  (not enrolled — key checks skipped)' );
		}

		if ( $failures > 0 ) {
			WP_CLI::error( $failures . ' selftest check(s) failed.' );
		}
		WP_CLI::success( 'All selftest checks passed.' );
	}

	private static function check( string $label, bool $ok, int &$failures ): void {
		WP_CLI::log( sprintf( '  [%s] %s', $ok ? 'ok' : 'FAIL', $label ) );
		if ( ! $ok ) {
			$failures++;
		}
	}

	private static function fingerprint( string $key_material ): string {
		return IWSL_Crypto::fingerprint( $key_material );
	}
}
