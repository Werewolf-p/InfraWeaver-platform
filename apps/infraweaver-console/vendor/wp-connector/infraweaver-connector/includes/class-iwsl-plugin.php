<?php
/**
 * IWSL Connector runtime — wires verifier + enrollment + rotation + responder
 * to the REST surface. Allow-listed ops only (§7); phase 1–2 ships the
 * protocol/enrollment/rotation set, fleet ops arrive with phase 4 dispatch.
 */

final class IWSL_Plugin {

	/** @var IWSL_Store */
	private $store;

	/** @var IWSL_Verifier */
	private $verifier;

	/** @var IWSL_Enrollment */
	private $enrollment;

	/** @var IWSL_Rotation */
	private $rotation;

	/** @var IWSL_Responder */
	private $responder;

	public function __construct( IWSL_Store $store, ?callable $now_ms = null ) {
		$this->store      = $store;
		$this->enrollment = new IWSL_Enrollment( $store, $now_ms );
		$this->rotation   = new IWSL_Rotation( $store );
		$this->responder  = new IWSL_Responder( $store, $this->rotation, $now_ms );
		$this->verifier   = new IWSL_Verifier( $store, self::allowed_methods(), $now_ms );
	}

	public function store(): IWSL_Store {
		return $this->store;
	}

	public function enrollment(): IWSL_Enrollment {
		return $this->enrollment;
	}

	public function rotation(): IWSL_Rotation {
		return $this->rotation;
	}

	/** @return array<string, callable|null> */
	public static function allowed_methods(): array {
		$rotation_params = static function ( $params ): bool {
			$vars = get_object_vars( $params );
			return isset( $vars['rotation_id'] ) && is_string( $vars['rotation_id'] )
				&& '' !== $vars['rotation_id']
				&& ( ! isset( $vars['new_kid'] ) || is_int( $vars['new_kid'] ) )
				&& array() === array_diff_key( $vars, array( 'rotation_id' => 1, 'new_kid' => 1 ) );
		};
		return array(
			'health.check'       => null,
			'debug.status'       => null,
			'key.rotate.self'    => $rotation_params,
			'key.rotate.confirm' => $rotation_params,
			'key.rotate.abort'   => $rotation_params,
			'site.deactivate'    => null,
		);
	}

	/**
	 * Handle a signed command wire object (decoded JSON, stdClass mode).
	 *
	 * @return array ['status' => int, 'body' => array]
	 */
	public function handle_command( $wire ): array {
		$state = $this->store->get( 'state', 'unenrolled' );
		if ( 'pending' !== $state && 'active' !== $state ) {
			return array( 'status' => 403, 'body' => array( 'ok' => false, 'reason' => 'not-enrolled' ) );
		}
		$verdict = $this->verifier->verify_command( $wire );
		if ( ! $verdict['ok'] ) {
			return array( 'status' => 403, 'body' => array( 'ok' => false, 'reason' => $verdict['reason'] ) );
		}
		$envelope = $verdict['envelope'];

		// First verified command completes §5 step 3–4: burn secret, drop proof.
		$this->enrollment->activate();

		// §8 chain of custody: the PREPARE response is always signed by the
		// current CONFIRMED key — the new key only proves itself in VERIFY.
		$sign_kid = 'key.rotate.self' === $envelope->method
			? (int) $this->store->get( 'wp_current_kid', 1 )
			: null;

		list( $ok, $result ) = $this->execute( $envelope );
		$response = $this->responder->build( $envelope->nonce, $ok, $result, $sign_kid );
		if ( null === $response ) {
			return array( 'status' => 500, 'body' => array( 'ok' => false, 'reason' => 'internal' ) );
		}
		if ( 'site.deactivate' === $envelope->method ) {
			$this->wipe(); // §8 kill switch — respond, then forget everything.
		}
		return array( 'status' => 200, 'body' => $response );
	}

	/** @return array{0: bool, 1: array} */
	private function execute( stdClass $envelope ): array {
		$params = get_object_vars( $envelope->params );
		switch ( $envelope->method ) {
			case 'health.check':
				return array(
					true,
					array(
						'status' => 'ok',
						'php'    => PHP_VERSION,
						'plugin' => defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : 'dev',
						'kid'    => $this->rotation->signing_kid(),
						'seq'    => (int) $this->store->get( 'last_seq', 0 ),
					),
				);
			case 'debug.status':
				return array( true, $this->debug_status() );
			case 'key.rotate.self':
				$result = $this->rotation->prepare(
					(string) $params['rotation_id'],
					isset( $params['new_kid'] ) ? (int) $params['new_kid'] : (int) $this->store->get( 'wp_current_kid', 1 ) + 1
				);
				return array(
					$result['ok'],
					$result['ok']
						? array( 'new_wp_pk' => $result['new_wp_pk'] )
						: array( 'reason' => $result['reason'] ),
				);
			case 'key.rotate.confirm':
				$result = $this->rotation->confirm( (string) $params['rotation_id'] );
				return array( $result['ok'], $result['ok'] ? array() : array( 'reason' => $result['reason'] ) );
			case 'key.rotate.abort':
				$result = $this->rotation->abort( (string) $params['rotation_id'] );
				return array( true, array() );
			case 'site.deactivate':
				return array( true, array( 'deactivated' => true ) );
			default: // Unreachable — verifier enforces the allow-list.
				return array( false, array( 'reason' => 'unknown-method' ) );
		}
	}

	/**
	 * Structured link diagnostics over the signed channel (§12.5) — everything
	 * `wp infraweaver status` prints, plus runtime facts, as data the console
	 * can render. Read-only; exposes no key material (fingerprints only).
	 */
	private function debug_status(): array {
		$wp_kid  = (int) $this->store->get( 'wp_current_kid', 0 );
		$iw_kid  = (int) $this->store->get( 'iw_current_kid', 0 );
		$wp_pair = $this->store->get( 'wp_keys.' . $wp_kid );
		$iw_keys = $this->store->get( 'iw_keys.' . $iw_kid );
		$pending = $this->store->get( 'pending_rotation' );
		$reject  = $this->store->get( 'last_rejection' );
		$nonces  = $this->store->get( 'nonces', array() );
		return array(
			'state'          => (string) $this->store->get( 'state', 'unenrolled' ),
			'plugin'         => defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : 'dev',
			'php'            => PHP_VERSION,
			'wp'             => function_exists( 'get_bloginfo' ) ? (string) get_bloginfo( 'version' ) : null,
			'time_ms'        => (int) round( microtime( true ) * 1000 ),
			'sodium'         => function_exists( 'sodium_crypto_sign_verify_detached' ),
			'wp_kid'         => $wp_kid,
			'iw_kid'         => $iw_kid,
			'wp_epoch_floor' => (int) $this->store->get( 'wp_epoch_floor', 0 ),
			'iw_epoch_floor' => (int) $this->store->get( 'iw_epoch_floor', 0 ),
			'wp_fingerprint' => is_array( $wp_pair ) ? IWSL_Crypto::fingerprint( $wp_pair['pk'] ) : null,
			'iw_fingerprint' => is_array( $iw_keys )
				? IWSL_Crypto::fingerprint( $iw_keys[ IWSL_Crypto::ALG_ED25519 ] . $iw_keys[ IWSL_Crypto::ALG_SLHDSA ] )
				: null,
			'last_seq'       => (int) $this->store->get( 'last_seq', 0 ),
			'nonce_cache'    => is_array( $nonces ) ? count( $nonces ) : 0,
			'rotation'       => is_array( $pending )
				? array( 'phase' => 'pending', 'new_kid' => (int) $pending['new_kid'] )
				: null,
			'last_rejection' => is_array( $reject )
				? array( 'reason' => (string) $reject['reason'], 'ts' => (int) $reject['ts'] )
				: null,
		);
	}

	/** §8 kill switch: wipe WP-SK, pinned IW-PK, and all local IWSL state. */
	private function wipe(): void {
		$pending  = $this->store->get( 'pending_rotation' );
		$max_kid  = max(
			(int) $this->store->get( 'wp_current_kid', 1 ),
			(int) $this->store->get( 'iw_current_kid', 1 ),
			is_array( $pending ) ? (int) $pending['new_kid'] : 1
		) + 1;
		for ( $kid = 1; $kid <= $max_kid; $kid++ ) {
			$this->store->delete( 'wp_keys.' . $kid );
			$this->store->delete( 'iw_keys.' . $kid );
		}
		foreach (
			array(
				'state', 'site_id', 'enroll_secret', 'last_seq', 'nonces',
				'wp_current_kid', 'wp_epoch_floor', 'iw_current_kid',
				'iw_epoch_floor', 'pending_rotation', 'last_confirmed_rotation',
				'last_rejection', 'enroll_claim',
			) as $key
		) {
			$this->store->delete( $key );
		}
		$this->store->set( 'state', 'unenrolled' );
	}
}
