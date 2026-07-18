<?php
/**
 * IWSL WP-key rotation — plugin side of §8 v1.2.
 * PREPARE / CONFIRM / ABORT are idempotent on rotation_id: a re-sent step
 * (lost ack) returns the same result instead of minting a second key.
 * Epoch floor is monotonic — once confirmed, older kids are rejected forever;
 * rollback past a commit does not exist in the protocol.
 */

final class IWSL_Rotation {

	/** @var IWSL_Store */
	private $store;

	public function __construct( IWSL_Store $store ) {
		$this->store = $store;
	}

	/**
	 * key.rotate.self — generate (or re-serve) the prepared keypair.
	 *
	 * @return array ['ok' => bool, 'reason' => string|null, 'new_wp_pk' => string|null]
	 */
	public function prepare( string $rotation_id, int $new_kid ): array {
		$current = (int) $this->store->get( 'wp_current_kid', 1 );
		$pending = $this->store->get( 'pending_rotation' );

		if ( is_array( $pending ) && $pending['rotation_id'] === $rotation_id ) {
			// Lost-ack retry: same rotation, same key.
			$pair = $this->store->get( 'wp_keys.' . $pending['new_kid'] );
			return array(
				'ok'        => true,
				'reason'    => null,
				'new_wp_pk' => IWSL_Crypto::b64u_encode( $pair['pk'] ),
			);
		}
		if ( $rotation_id === $this->store->get( 'last_confirmed_rotation' ) ) {
			// PREPARE replayed after CONFIRM already ratcheted — refuse to
			// reopen a committed epoch.
			return array( 'ok' => false, 'reason' => 'rotation-committed', 'new_wp_pk' => null );
		}
		if ( $new_kid !== $current + 1 ) {
			return array( 'ok' => false, 'reason' => 'bad-epoch', 'new_wp_pk' => null );
		}

		// A new PREPARE discards any older uncommitted rotation (§8 ABORT note).
		if ( is_array( $pending ) ) {
			$this->store->delete( 'wp_keys.' . $pending['new_kid'] );
		}
		$pair = IWSL_Crypto::ed_keypair();
		$this->store->set( 'wp_keys.' . $new_kid, $pair );
		$this->store->set(
			'pending_rotation',
			array( 'rotation_id' => $rotation_id, 'new_kid' => $new_kid )
		);
		return array(
			'ok'        => true,
			'reason'    => null,
			'new_wp_pk' => IWSL_Crypto::b64u_encode( $pair['pk'] ),
		);
	}

	/** key.rotate.confirm — retire the old epoch, ratchet the floor. Idempotent. */
	public function confirm( string $rotation_id ): array {
		$pending = $this->store->get( 'pending_rotation' );
		if ( ! is_array( $pending ) || $pending['rotation_id'] !== $rotation_id ) {
			if ( $rotation_id === $this->store->get( 'last_confirmed_rotation' ) ) {
				return array( 'ok' => true, 'reason' => null ); // lost-ack CONFIRM retry
			}
			return array( 'ok' => false, 'reason' => 'unknown-rotation' );
		}
		$old_kid = (int) $this->store->get( 'wp_current_kid', 1 );
		$new_kid = (int) $pending['new_kid'];
		$this->store->set( 'wp_current_kid', $new_kid );
		$this->store->set( 'wp_epoch_floor', $new_kid );
		$this->store->delete( 'wp_keys.' . $old_kid );
		$this->store->delete( 'pending_rotation' );
		$this->store->set( 'last_confirmed_rotation', $rotation_id );
		$this->store->set( 'last_reroll', array( 'at' => time(), 'kid' => $new_kid, 'ok' => true ) );
		return array( 'ok' => true, 'reason' => null );
	}

	/** key.rotate.abort — discard the uncommitted new key; old key was never invalidated. */
	public function abort( string $rotation_id ): array {
		$pending = $this->store->get( 'pending_rotation' );
		if ( is_array( $pending ) && $pending['rotation_id'] === $rotation_id ) {
			$this->store->delete( 'wp_keys.' . $pending['new_kid'] );
			$this->store->delete( 'pending_rotation' );
			// §8 observability: record the failed reroll so the console can show
			// "last reroll: failed" (old key stayed live). Only stamped when a
			// matching pending was actually rolled back, not on a no-op replay.
			$this->store->set(
				'last_reroll',
				array( 'at' => time(), 'kid' => (int) $pending['new_kid'], 'ok' => false, 'reason' => 'aborted' )
			);
		}
		return array( 'ok' => true, 'reason' => null );
	}

	/**
	 * Last completed reroll outcome for operator visibility (§8), surfaced in the
	 * signed health.check / debug.status. {at:int(unix), kid:int, ok:bool, reason?:string}
	 * or null before the first reroll.
	 *
	 * @return array|null
	 */
	public function last_reroll() {
		$value = $this->store->get( 'last_reroll' );
		return is_array( $value ) ? $value : null;
	}

	/**
	 * Epoch to sign responses with: the prepared key once a rotation is
	 * pending (so IW can prove the new epoch end-to-end — §8 VERIFY), else
	 * the confirmed current key.
	 */
	public function signing_kid(): int {
		$pending = $this->store->get( 'pending_rotation' );
		if ( is_array( $pending ) ) {
			return (int) $pending['new_kid'];
		}
		return (int) $this->store->get( 'wp_current_kid', 1 );
	}
}
