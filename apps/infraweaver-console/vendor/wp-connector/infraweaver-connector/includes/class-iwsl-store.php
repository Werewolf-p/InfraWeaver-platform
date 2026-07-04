<?php
/**
 * IWSL state persistence. The Connector's state machine (enrollment state,
 * pinned IW keys, seq/nonce replay defenses, key epochs) sits behind a small
 * KV interface so the verifier and enrollment logic run identically in
 * WordPress ($wpdb/options — class-iwsl-wp-store.php) and in the test
 * harness (in-memory store below).
 *
 * Well-known keys:
 *  state              'unenrolled' | 'pending' | 'active' | 'quarantined'
 *  site_id            string
 *  enroll_secret      raw bytes (burned at activation)
 *  iw_keys.<kid>      ['ed25519' => raw, 'slh-dsa-192s' => raw]
 *  iw_current_kid     int
 *  iw_epoch_floor     int (commands with kid < floor rejected forever)
 *  last_seq           int
 *  nonces             [nonce => expires_ts_ms]
 *  wp_keys.<kid>      ['sk' => raw 64B, 'pk' => raw 32B]
 *  wp_current_kid     int
 *  wp_epoch_floor     int
 *  pending_rotation   ['rotation_id' => string, 'new_kid' => int] | null
 *  last_confirmed_rotation  string (idempotent CONFIRM acks)
 */

interface IWSL_Store {
	/** @return mixed */
	public function get( string $key, $default = null );

	/** @param mixed $value */
	public function set( string $key, $value ): void;

	public function delete( string $key ): void;
}

/** In-memory store — tests and selftest. */
final class IWSL_Memory_Store implements IWSL_Store {

	/** @var array<string, mixed> */
	private $data = array();

	public function get( string $key, $default = null ) {
		return array_key_exists( $key, $this->data ) ? $this->data[ $key ] : $default;
	}

	public function set( string $key, $value ): void {
		$this->data[ $key ] = $value;
	}

	public function delete( string $key ): void {
		unset( $this->data[ $key ] );
	}
}
