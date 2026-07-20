<?php
/**
 * IWSL response builder — §6.2. Ed25519-only (v1.2), domain tag IWSL-v1-resp,
 * bound to the command nonce via in_reply_to. Signing epoch comes from
 * IWSL_Rotation::signing_kid() so a pending rotation proves the new epoch.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Responder {

	/** @var IWSL_Store */
	private $store;

	/** @var IWSL_Rotation */
	private $rotation;

	/** @var callable():int */
	private $now_ms;

	public function __construct( IWSL_Store $store, IWSL_Rotation $rotation, ?callable $now_ms = null ) {
		$this->store    = $store;
		$this->rotation = $rotation;
		$this->now_ms   = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/**
	 * @param array    $result JSON-shaped result (use empty array for {} — it is
	 *                         converted to an object below).
	 * @param int|null $kid    Explicit signing epoch. §8 chain of custody: the
	 *                         key.rotate.self response MUST be signed by the OLD
	 *                         key, so IWSL_Plugin passes the pre-rotation kid
	 *                         there. Default: current signing epoch.
	 * @return array|null Wire-shaped response, null if keys are missing.
	 */
	public function build( string $in_reply_to, bool $ok, array $result, ?int $kid = null ): ?array {
		$kid  = $kid ?? $this->rotation->signing_kid();
		$pair = $this->store->get( 'wp_keys.' . $kid );
		if ( ! is_array( $pair ) ) {
			// Epoch vanished between capture and signing (e.g. abort) — fall
			// back to the current signing epoch.
			$kid  = $this->rotation->signing_kid();
			$pair = $this->store->get( 'wp_keys.' . $kid );
		}
		$site = $this->store->get( 'site_id' );
		if ( ! is_array( $pair ) || ! is_string( $site ) ) {
			return null;
		}
		$envelope = array(
			'v'           => 1,
			'typ'         => 'resp',
			'site_id'     => $site,
			'in_reply_to' => $in_reply_to,
			'kid'         => $kid,
			'ts'          => ( $this->now_ms )(),
			'ok'          => $ok,
			'result'      => array() === $result ? new stdClass() : $result,
			'alg'         => array( IWSL_Crypto::ALG_ED25519 ),
		);
		$message = IWSL_Crypto::domain_message(
			IWSL_Crypto::DOMAIN_RESP,
			IWSL_JCS::canonicalize( $envelope )
		);
		return array(
			'envelope' => $envelope,
			'sigs'     => array(
				IWSL_Crypto::ALG_ED25519 => IWSL_Crypto::ed_sign( $message, $pair['sk'] ),
			),
		);
	}
}
