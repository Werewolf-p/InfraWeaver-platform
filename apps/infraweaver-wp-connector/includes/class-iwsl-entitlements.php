<?php
/**
 * IWSL paid-feature entitlements + the client-side feature gate.
 *
 * Two responsibilities, both plugin-local and both trust-critical:
 *
 *  1. ENTITLEMENTS STORE. A console-authoritative boolean flag map
 *     (`{ plus: true, ... }`) written ONLY by the signed `entitlements.set`
 *     command (§7). There is deliberately no public/self-set path: the site
 *     cannot grant itself a paid flag, because the map is only ever replaced by
 *     a dual-signed (Ed25519 + SLH-DSA) command the verifier has already proven
 *     came from the console. Designed as a general map so future paid flags slot
 *     in with no new method — the console pushes the whole intended set and this
 *     replaces it wholesale.
 *
 *  2. FEATURE GATE. `evaluate()` judges — locally, with no network call — whether
 *     a gated client-side feature may run. A feature unlocks only when ALL hold:
 *       - linked:          state === 'active' (enrolled + active with the console)
 *       - heartbeat_fresh:  a dual-signed command was verified within
 *                           HEARTBEAT_FRESH_MS (see `record_verified_contact`)
 *       - plus:             the entitlement flag is granted
 *     Each failing gate yields a §12.5-style reason string so the admin test
 *     page can show WHY a feature is locked.
 *
 * The heartbeat is tamper-resistant by construction: `record_verified_contact()`
 * is called by IWSL_Plugin ONLY after the verifier accepts a dual-signed command,
 * so the freshness timestamp can never be advanced without a valid signature.
 */

final class IWSL_Entitlements {

	/** Option key (via IWSL_Store) for the boolean flag map. */
	const STORE_KEY = 'entitlements';
	/** Option key for the unix-ms stamp of the last entitlements write. */
	const UPDATED_KEY = 'entitlements_updated_at';
	/** Option key for the last verified signed-contact heartbeat (unix ms). */
	const HEARTBEAT_KEY = 'last_verified_at';

	/**
	 * Heartbeat freshness window. The console health-sweep contacts every live
	 * link hourly over the signed channel, and each success stamps the heartbeat.
	 * Two hours = one full sweep interval plus a one-miss tolerance, so a single
	 * skipped/slow sweep doesn't spuriously lock the feature, while a genuinely
	 * unmanaged site (no signed contact for hours) locks as intended.
	 */
	const HEARTBEAT_FRESH_MS = 7200000; // 2h

	/** Upper bound on distinct flags in the map (§6.3 payload bound). */
	const MAX_FLAGS = 32;
	/** Allowed flag-name shape — short, lower snake/alnum. Bounds the wire key. */
	const FLAG_RE = '/^[a-z0-9_]{1,64}$/';

	/** @var IWSL_Store */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	public function __construct( IWSL_Store $store, ?callable $now_ms = null ) {
		$this->store  = $store;
		$this->now_ms = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/**
	 * Params validator for the signed `entitlements.set` command (§7). Shape:
	 * `{ entitlements: { <flag>: bool, ... } }` and nothing else. Static so the
	 * command registry can reference it as the verifier's allow-list validator.
	 * An empty `entitlements` object is valid — it means "revoke everything".
	 *
	 * @param mixed $params The signed envelope's `params` (stdClass).
	 */
	public static function validate_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		// Exactly one key: `entitlements`. A stray signed-but-ignored field is
		// padding — refuse it (mirrors the rotation/aud validators).
		if ( array() !== array_diff_key( $vars, array( 'entitlements' => 1 ) ) ) {
			return false;
		}
		if ( ! isset( $vars['entitlements'] ) || ! $vars['entitlements'] instanceof stdClass ) {
			return false;
		}
		$flags = get_object_vars( $vars['entitlements'] );
		if ( count( $flags ) > self::MAX_FLAGS ) {
			return false;
		}
		foreach ( $flags as $key => $value ) {
			if ( ! is_string( $key ) || ! preg_match( self::FLAG_RE, $key ) || ! is_bool( $value ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Apply a console-authoritative entitlement map (the runner for
	 * `entitlements.set`). Wholesale replace: the console always pushes the full
	 * intended set, so a flag it omits is off. Re-normalizes defensively even
	 * though the validator already vetted the shape. Returns the stored map.
	 *
	 * @param mixed $entitlements stdClass of flag => bool.
	 * @return array<string, bool>
	 */
	public function apply( $entitlements ): array {
		$normalized = array();
		if ( $entitlements instanceof stdClass ) {
			foreach ( get_object_vars( $entitlements ) as $key => $value ) {
				if ( is_string( $key ) && preg_match( self::FLAG_RE, $key ) && is_bool( $value ) ) {
					$normalized[ $key ] = $value;
				}
			}
		}
		$this->store->set( self::STORE_KEY, $normalized );
		$this->store->set( self::UPDATED_KEY, ( $this->now_ms )() );
		return $normalized;
	}

	/** The stored flag map (flag => bool), or an empty map. @return array<string, bool> */
	public function all(): array {
		$value = $this->store->get( self::STORE_KEY, array() );
		return is_array( $value ) ? $value : array();
	}

	/** Whether a specific flag is granted. */
	public function has( string $flag ): bool {
		$all = $this->all();
		return isset( $all[ $flag ] ) && true === $all[ $flag ];
	}

	/**
	 * Record a verified signed contact — the heartbeat. Called by IWSL_Plugin
	 * ONLY after the verifier accepts a dual-signed command, so the timestamp is
	 * as trustworthy as a signature: it cannot be advanced by an unauthenticated
	 * request. This is the freshness signal the client-side gate checks.
	 */
	public function record_verified_contact(): void {
		$this->store->set( self::HEARTBEAT_KEY, ( $this->now_ms )() );
	}

	/** The last verified-contact stamp (unix ms), or null before any. @return int|null */
	public function last_verified_at() {
		$value = $this->store->get( self::HEARTBEAT_KEY );
		return is_int( $value ) && $value > 0 ? $value : null;
	}

	/**
	 * Evaluate the client-side feature gate for a flag (default `plus`). Pure,
	 * local, no network — the whole point: the gated admin page reads only this.
	 *
	 * @return array{
	 *   feature:string, unlocked:bool, linked:bool, heartbeat_fresh:bool, plus:bool,
	 *   state:string, last_verified_at:int|null, heartbeat_age_ms:int|null,
	 *   heartbeat_threshold_ms:int, reasons:string[]
	 * }
	 */
	public function evaluate( string $feature = 'plus' ): array {
		$state  = (string) $this->store->get( 'state', 'unenrolled' );
		$linked = 'active' === $state;

		$last            = $this->last_verified_at();
		$now             = ( $this->now_ms )();
		$age             = null === $last ? null : $now - $last;
		$heartbeat_fresh = null !== $age && $age >= 0 && $age < self::HEARTBEAT_FRESH_MS;

		$plus = $this->has( $feature );

		$reasons = array();
		if ( ! $linked ) {
			$reasons[] = 'not-linked';
		}
		if ( ! $heartbeat_fresh ) {
			$reasons[] = 'heartbeat-stale';
		}
		if ( ! $plus ) {
			$reasons[] = 'requires-plus';
		}

		return array(
			'feature'                => $feature,
			'unlocked'               => $linked && $heartbeat_fresh && $plus,
			'linked'                 => $linked,
			'heartbeat_fresh'        => $heartbeat_fresh,
			'plus'                   => $plus,
			'state'                  => $state,
			'last_verified_at'       => $last,
			'heartbeat_age_ms'       => $age,
			'heartbeat_threshold_ms' => self::HEARTBEAT_FRESH_MS,
			'reasons'                => $reasons,
		);
	}
}
