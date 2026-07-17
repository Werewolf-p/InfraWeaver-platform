<?php
/**
 * IWSL command verifier — the plugin-side enforcement point for §6/§12.
 * Every rejection maps 1:1 to a §12.5 reason string so each deny is
 * explainable in the status panel:
 *   schema-fail | pq-required | site-mismatch | kid-retired | kid-unknown |
 *   bad-sig-ed25519 | bad-sig-pq | stale-ts | expired | seq-rollback |
 *   replayed-nonce | unknown-method
 *
 * Default posture everywhere: deny.
 */

final class IWSL_Verifier {

	const MAX_CLOCK_SKEW_MS = 300000; // ±300s (§6.3)

	/**
	 * Pre-crypto input bounds (§6.3 hardening). Envelope string fields are tiny
	 * by construction — site_id is a UUID, nonce a short b64u token, method a
	 * dotted verb — so a generous 256B cap rejects abusive payloads before any
	 * JCS/signature work. MAX_CMD_TTL_MS bounds command lifetime: the console
	 * signs exp = ts + DEFAULT_COMMAND_TTL_MS (120s), so 300s leaves headroom
	 * while refusing a command minted valid for an unbounded window.
	 */
	const MAX_STRING_LEN = 256;
	const MAX_CMD_TTL_MS = 300000;

	/** @var IWSL_Store */
	private $store;

	/** @var array<string, callable|null> method => params validator (null = require empty params). */
	private $allowed_methods;

	/** @var callable():int current unix ms. */
	private $now_ms;

	public function __construct( IWSL_Store $store, array $allowed_methods, ?callable $now_ms = null ) {
		$this->store           = $store;
		$this->allowed_methods = $allowed_methods;
		$this->now_ms          = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/**
	 * Verify a signed command wire object (decoded JSON, objects as stdClass).
	 * On success, commits the replay state (last_seq, nonce cache).
	 *
	 * @param mixed $wire Expected: { envelope: {...}, sigs: {...} }.
	 * @return array ['ok' => bool, 'reason' => string|null, 'envelope' => stdClass|null]
	 */
	public function verify_command( $wire ): array {
		if ( ! $wire instanceof stdClass || ! isset( $wire->envelope, $wire->sigs ) ) {
			return $this->reject( 'schema-fail' );
		}
		$envelope = $wire->envelope;
		if ( ! $envelope instanceof stdClass || ! $wire->sigs instanceof stdClass ) {
			return $this->reject( 'schema-fail' );
		}

		$structural = $this->check_structure( $envelope );
		if ( null !== $structural ) {
			return $this->reject( $structural );
		}

		if ( $envelope->site_id !== $this->store->get( 'site_id' ) ) {
			return $this->reject( 'site-mismatch' );
		}

		$kid_check = $this->resolve_iw_keys( $envelope->kid );
		if ( is_string( $kid_check ) ) {
			return $this->reject( $kid_check );
		}

		try {
			$canonical = IWSL_JCS::canonicalize( $envelope );
		} catch ( InvalidArgumentException $e ) {
			return $this->reject( 'schema-fail' );
		}
		$message = IWSL_Crypto::domain_message( IWSL_Crypto::DOMAIN_CMD, $canonical );
		$sig_ok  = IWSL_Crypto::verify_dual( $message, $wire->sigs, $kid_check );
		if ( ! $sig_ok['ok'] ) {
			return $this->reject( $sig_ok['reason'] );
		}

		// Signature is authentic from here — now freshness and replay (§6.3).
		$now = ( $this->now_ms )();
		if ( abs( $now - $envelope->ts ) > self::MAX_CLOCK_SKEW_MS ) {
			return $this->reject( 'stale-ts' );
		}
		if ( $now > $envelope->exp ) {
			return $this->reject( 'expired' );
		}
		if ( $envelope->seq <= (int) $this->store->get( 'last_seq', 0 ) ) {
			return $this->reject( 'seq-rollback' );
		}
		$nonces = $this->store->get( 'nonces', array() );
		if ( isset( $nonces[ $envelope->nonce ] ) ) {
			return $this->reject( 'replayed-nonce' );
		}

		if ( ! array_key_exists( $envelope->method, $this->allowed_methods ) ) {
			return $this->reject( 'unknown-method' );
		}
		$validator = $this->allowed_methods[ $envelope->method ];
		$params_ok = null === $validator
			? array() === get_object_vars( $envelope->params )
			: (bool) call_user_func( $validator, $envelope->params );
		if ( ! $params_ok ) {
			return $this->reject( 'schema-fail' );
		}

		// Atomic replay claim (§6.3 concurrency hardening). The isset() pre-filter
		// above rejects sequential replays cheaply, but two workers handling the
		// same command in parallel can both pass every check above before either
		// commits `nonces`/`last_seq` — a check-then-act race that lets one signed
		// command execute twice. add() is insert-if-absent (the options table's
		// UNIQUE index in WP, an array guard in the test store), so exactly one
		// concurrent claim of a given nonce wins; the loser is rejected here
		// instead of double-executing.
		if ( ! $this->store->add( 'nonce.' . $envelope->nonce, $envelope->exp ) ) {
			return $this->reject( 'replayed-nonce' );
		}

		// Commit replay state — persisted BEFORE execution so a crash mid-op can
		// never reopen the window. The aggregate `nonces` map is the GC ledger
		// (pruning, debug count, and wipe() enumeration); the per-nonce option
		// claimed above is the authoritative concurrency guard.
		$this->store->set( 'last_seq', $envelope->seq );
		foreach ( $nonces as $nonce => $expires ) {
			if ( $expires < $now ) {
				unset( $nonces[ $nonce ] );
				$this->store->delete( 'nonce.' . $nonce );
			}
		}
		$nonces[ $envelope->nonce ] = $envelope->exp;
		$this->store->set( 'nonces', $nonces );

		return array( 'ok' => true, 'reason' => null, 'envelope' => $envelope );
	}

	/** @return string|null Reason on failure, null when structurally valid. */
	private function check_structure( stdClass $envelope ): ?string {
		$ints    = array( 'seq', 'kid', 'ts', 'exp' );
		$strings = array( 'site_id', 'nonce', 'method' );
		if ( ! isset( $envelope->v, $envelope->typ ) || 1 !== $envelope->v || 'cmd' !== $envelope->typ ) {
			return 'schema-fail';
		}
		foreach ( $strings as $field ) {
			if (
				! isset( $envelope->$field ) || ! is_string( $envelope->$field ) || '' === $envelope->$field
				|| strlen( $envelope->$field ) > self::MAX_STRING_LEN
			) {
				return 'schema-fail';
			}
		}
		foreach ( $ints as $field ) {
			if ( ! isset( $envelope->$field ) || ! is_int( $envelope->$field ) || $envelope->$field < 0 ) {
				return 'schema-fail';
			}
		}
		// Bound command lifetime (§6.3). A negative TTL (exp < ts) is left to the
		// freshness check so it still surfaces as `expired`, not `schema-fail`.
		if ( $envelope->exp - $envelope->ts > self::MAX_CMD_TTL_MS ) {
			return 'schema-fail';
		}
		if ( ! isset( $envelope->params ) || ! $envelope->params instanceof stdClass ) {
			return 'schema-fail';
		}
		// Downgrade defense (§6.3): alg must list exactly both command algorithms.
		if (
			! isset( $envelope->alg ) ||
			! is_array( $envelope->alg ) ||
			array( IWSL_Crypto::ALG_ED25519, IWSL_Crypto::ALG_SLHDSA ) !== $envelope->alg
		) {
			return 'pq-required';
		}
		return null;
	}

	/** @return array|string Pinned keys for the epoch, or a reason string. */
	private function resolve_iw_keys( int $kid ) {
		if ( $kid < (int) $this->store->get( 'iw_epoch_floor', 1 ) ) {
			return 'kid-retired';
		}
		$keys = $this->store->get( 'iw_keys.' . $kid );
		if ( ! is_array( $keys ) || ! isset( $keys[ IWSL_Crypto::ALG_ED25519 ], $keys[ IWSL_Crypto::ALG_SLHDSA ] ) ) {
			return 'kid-unknown';
		}
		return $keys;
	}

	private function reject( string $reason ): array {
		$this->store->set(
			'last_rejection',
			array( 'reason' => $reason, 'ts' => ( $this->now_ms )() )
		);
		return array( 'ok' => false, 'reason' => $reason, 'envelope' => null );
	}
}
