<?php
/**
 * Command verifier — the §12 fail-closed matrix, attack by attack:
 * replay, seq rollback, downgrade-strip, signature tamper, clock, kid epochs.
 */

$f       = iwsl_fixtures();
$methods = IWSL_Plugin::allowed_methods();

$fresh = static function ( int $now_offset = 5000 ) use ( $methods ): array {
	$store    = iwsl_seed_store();
	$verifier = new IWSL_Verifier( $store, $methods, iwsl_now_t0( $now_offset ) );
	return array( $store, $verifier );
};

// --- happy path -------------------------------------------------------------
list( $store, $verifier ) = $fresh();
$verdict = $verifier->verify_command( $f->commands->valid );
iwsl_assert( $verdict['ok'], 'valid dual-signed command accepted' );
iwsl_assert_same( 10, $store->get( 'last_seq' ), 'last_seq committed' );
iwsl_assert( isset( $store->get( 'nonces' )[ 'fixture-nonce-valid-1' ] ), 'nonce cached' );

// --- replay (verbatim re-send) ---------------------------------------------
$verdict = $verifier->verify_command( $f->commands->valid );
iwsl_assert_same( 'seq-rollback', $verdict['reason'], 'verbatim replay rejected (seq primary defense)' );

// --- replay after nonce-cache wipe (the v1.0 hole) ---------------------------
$store->set( 'nonces', array() );
$verdict = $verifier->verify_command( $f->commands->valid );
iwsl_assert_same( 'seq-rollback', $verdict['reason'], 'replay after cache wipe still rejected via seq' );

// --- replayed nonce with fresh seq -------------------------------------------
list( $store, $verifier ) = $fresh();
$verifier->verify_command( $f->commands->valid );
$verdict = $verifier->verify_command( $f->commands->nonceReuse );
iwsl_assert_same( 'replayed-nonce', $verdict['reason'], 'nonce reuse rejected even with higher seq' );

// --- concurrency: the atomic per-nonce claim catches a reused nonce even when
//     the aggregate `nonces` ledger is empty. Clearing the ledger after a commit
//     simulates the pre-commit window a second parallel worker observes — the
//     isset() pre-filter misses it, so only the atomic add() guard can reject.
list( $store, $verifier ) = $fresh();
$verifier->verify_command( $f->commands->valid );
$store->set( 'nonces', array() );
$verdict = $verifier->verify_command( $f->commands->nonceReuse );
iwsl_assert_same( 'replayed-nonce', $verdict['reason'], 'atomic nonce claim rejects reuse when aggregate ledger is empty (race window)' );

// --- seq rollback -------------------------------------------------------------
list( $store, $verifier ) = $fresh();
$verifier->verify_command( $f->commands->valid );
$verdict = $verifier->verify_command( $f->commands->seqRollback );
iwsl_assert_same( 'seq-rollback', $verdict['reason'], 'lower seq rejected' );

// --- downgrade: strip the PQ signature from the wire --------------------------
list( , $verifier ) = $fresh();
$stripped = iwsl_clone( $f->commands->valid );
unset( $stripped->sigs->{'slh-dsa-192s'} );
$verdict = $verifier->verify_command( $stripped );
iwsl_assert_same( 'pq-required', $verdict['reason'], 'downgrade-strip (missing PQ sig) rejected' );

// --- downgrade: strip the PQ layer from alg -----------------------------------
$stripped = iwsl_clone( $f->commands->valid );
$stripped->envelope->alg = array( 'ed25519' );
$verdict = $verifier->verify_command( $stripped );
iwsl_assert_same( 'pq-required', $verdict['reason'], 'downgrade-strip (alg edited) rejected' );

// --- signature tampering -------------------------------------------------------
$flip_b64u_char = static function ( string $text ): string {
	$text[3] = 'A' === $text[3] ? 'B' : 'A';
	return $text;
};

list( , $verifier ) = $fresh();
$tampered = iwsl_clone( $f->commands->valid );
$tampered->sigs->ed25519 = $flip_b64u_char( $tampered->sigs->ed25519 );
$verdict = $verifier->verify_command( $tampered );
iwsl_assert_same( 'bad-sig-ed25519', $verdict['reason'], 'corrupted Ed25519 signature rejected' );

list( , $verifier ) = $fresh();
$tampered = iwsl_clone( $f->commands->valid );
$tampered->sigs->{'slh-dsa-192s'} = $flip_b64u_char( $tampered->sigs->{'slh-dsa-192s'} );
$verdict = $verifier->verify_command( $tampered );
iwsl_assert_same( 'bad-sig-pq', $verdict['reason'], 'corrupted SLH-DSA signature rejected' );

list( , $verifier ) = $fresh();

$tampered = iwsl_clone( $f->commands->valid );
$tampered->envelope->params->privilege = 'admin';
$verdict = $verifier->verify_command( $tampered );
iwsl_assert_same( 'bad-sig-ed25519', $verdict['reason'], 'tampered params break both signatures' );

// --- freshness -----------------------------------------------------------------
list( , $verifier ) = $fresh();
$verdict = $verifier->verify_command( $f->commands->staleTs );
iwsl_assert_same( 'stale-ts', $verdict['reason'], 'ts outside ±300s rejected' );

$verdict = $verifier->verify_command( $f->commands->expired );
iwsl_assert_same( 'expired', $verdict['reason'], 'exp in the past rejected' );

// --- allow-list & schema --------------------------------------------------------
$verdict = $verifier->verify_command( $f->commands->unknownMethod );
iwsl_assert_same( 'unknown-method', $verdict['reason'], 'method outside allow-list rejected' );

$verdict = $verifier->verify_command( $f->commands->schemaFail );
iwsl_assert_same( 'schema-fail', $verdict['reason'], 'params failing method schema rejected' );

$malformed = iwsl_clone( $f->commands->valid );
$malformed->envelope->ts = 1.5;
$verdict = $verifier->verify_command( $malformed );
iwsl_assert_same( 'schema-fail', $verdict['reason'], 'float ts rejected structurally' );

// --- key epochs ------------------------------------------------------------------
$moved = iwsl_clone( $f->commands->valid );
$moved->envelope->kid = 9;
$verdict = $verifier->verify_command( $moved );
iwsl_assert_same( 'kid-unknown', $verdict['reason'], 'unknown kid rejected before signature work' );

list( $store, $verifier ) = $fresh();
$store->set( 'iw_epoch_floor', 2 );
$verdict = $verifier->verify_command( $f->commands->valid );
iwsl_assert_same( 'kid-retired', $verdict['reason'], 'kid below epoch floor rejected forever' );

// --- site binding ------------------------------------------------------------------
list( $store, $verifier ) = $fresh();
$store->set( 'site_id', 'some-other-site' );
$verdict = $verifier->verify_command( $f->commands->valid );
iwsl_assert_same( 'site-mismatch', $verdict['reason'], 'command for another site rejected' );

// --- input bounds (§6.3 pre-crypto hardening) -------------------------------------
list( , $verifier ) = $fresh();
$oversized = iwsl_clone( $f->commands->valid );
$oversized->envelope->nonce = str_repeat( 'x', IWSL_Verifier::MAX_STRING_LEN + 1 );
$verdict = $verifier->verify_command( $oversized );
iwsl_assert_same( 'schema-fail', $verdict['reason'], 'oversized envelope string field rejected before crypto' );

$long_ttl = iwsl_clone( $f->commands->valid );
$long_ttl->envelope->exp = $long_ttl->envelope->ts + IWSL_Verifier::MAX_CMD_TTL_MS + 1;
$verdict = $verifier->verify_command( $long_ttl );
iwsl_assert_same( 'schema-fail', $verdict['reason'], 'command TTL beyond ceiling rejected' );

// --- §6.4 channel / audience binding ----------------------------------------------
// The default `valid` fixture is bound to the exec channel.
list( , $verifier ) = $fresh();
$verdict = $verifier->verify_command( $f->commands->valid, 'https' );
iwsl_assert_same( 'channel-mismatch', $verdict['reason'], 'exec-bound command rejected over https' );

// An https-bound command: rejected over exec (and NO replay state committed, so
// it stays deliverable), accepted over its own channel.
list( $store, $verifier ) = $fresh();
$verdict = $verifier->verify_command( $f->commands->httpsHealth, 'exec' );
iwsl_assert_same( 'channel-mismatch', $verdict['reason'], 'https-bound command rejected over exec' );
iwsl_assert_same( 0, $store->get( 'last_seq' ), 'channel-mismatch commits no replay state (verify-before-act)' );
$verdict = $verifier->verify_command( $f->commands->httpsHealth, 'https' );
iwsl_assert( $verdict['ok'], 'same command accepted on its bound (https) channel' );
iwsl_assert_same( 19, $store->get( 'last_seq' ), 'accepted command commits its seq' );

// aud is signed — relabeling chan to match the ingress breaks the signature
// (a captured command can't be redirected onto another channel).
list( , $verifier ) = $fresh();
$relabel = iwsl_clone( $f->commands->httpsHealth );
$relabel->envelope->aud->chan = 'exec';
$verdict = $verifier->verify_command( $relabel, 'exec' );
iwsl_assert_same( 'bad-sig-ed25519', $verdict['reason'], 'editing aud.chan breaks the signature' );

// Malformed aud fails closed BEFORE the signature (structure gate).
list( , $verifier ) = $fresh();
$bad_aud = iwsl_clone( $f->commands->valid );
$bad_aud->envelope->aud->chan = 'carrier-pigeon';
iwsl_assert_same( 'schema-fail', $verifier->verify_command( $bad_aud )['reason'], 'unknown aud.chan value rejected structurally' );

list( , $verifier ) = $fresh();
$pad_aud = iwsl_clone( $f->commands->valid );
$pad_aud->envelope->aud->extra = 'padding';
iwsl_assert_same( 'schema-fail', $verifier->verify_command( $pad_aud )['reason'], 'unknown key in aud rejected (no signed padding)' );

// Backward-compatible rollout: a command with NO aud is accepted on any channel.
list( , $verifier ) = $fresh();
$verdict = $verifier->verify_command( $f->commands->legacyNoAud, 'https' );
iwsl_assert( $verdict['ok'], 'legacy command without aud accepted on any channel (rollout tolerance)' );

// --- algorithm lock (§6.1 — no attacker-chosen / dynamic algorithm) ----------------
// alg is a fixed pair in a fixed order; any deviation is a downgrade, and the
// verifier NEVER picks its verification algorithm from the wire.
list( , $verifier ) = $fresh();
$reordered = iwsl_clone( $f->commands->valid );
$reordered->envelope->alg = array( 'slh-dsa-192s', 'ed25519' );
iwsl_assert_same( 'pq-required', $verifier->verify_command( $reordered )['reason'], 'reordered alg rejected (fixed order)' );

$extra_alg = iwsl_clone( $f->commands->valid );
$extra_alg->envelope->alg = array( 'ed25519', 'slh-dsa-192s', 'rsa2048' );
iwsl_assert_same( 'pq-required', $verifier->verify_command( $extra_alg )['reason'], 'extra alg entry rejected' );

// A bogus extra signature under an unlisted algorithm is ignored — the command
// still verifies under the FIXED ed25519+slh-dsa pair (no dynamic-alg selection).
$extra_sig = iwsl_clone( $f->commands->valid );
$extra_sig->sigs->rsa2048 = 'Zm9v';
iwsl_assert( $verifier->verify_command( $extra_sig )['ok'], 'unknown extra sig key ignored, fixed-pair verify still passes' );

// --- verify-before-act: a rejected command mutates no replay state -------------------
list( $store, $verifier ) = $fresh();
$tampered = iwsl_clone( $f->commands->valid );
$tampered->envelope->params->privilege = 'admin'; // breaks the signature
$verifier->verify_command( $tampered );
iwsl_assert_same( 0, $store->get( 'last_seq' ), 'tampered command commits no seq' );
iwsl_assert_same( array(), $store->get( 'nonces' ), 'tampered command caches no nonce' );

// --- concurrency: last_seq advances by max() and the nonce ledger is merged ----------
// A decorating store that returns the REAL committed values on the freshness-check
// read, but a concurrent worker's HIGHER last_seq and a NON-EMPTY nonce ledger on
// the pre-write re-read. The commit must (a) never regress last_seq below the raced
// value, and (b) merge — not clobber — the ledger, so the racing worker's nonce
// survives alongside the newly claimed one.
final class IWSL_Race_Store implements IWSL_Store {
	private $inner;
	private $race_seq;
	private $race_nonces;
	private $seq_reads   = 0;
	private $nonce_reads = 0;
	public function __construct( IWSL_Store $inner, int $race_seq, array $race_nonces ) {
		$this->inner       = $inner;
		$this->race_seq    = $race_seq;
		$this->race_nonces = $race_nonces;
	}
	public function get( string $key, $default = null ) {
		if ( 'last_seq' === $key ) {
			$this->seq_reads++;
			return $this->seq_reads >= 2 ? $this->race_seq : $this->inner->get( $key, $default );
		}
		if ( 'nonces' === $key ) {
			$this->nonce_reads++;
			return $this->nonce_reads >= 2 ? $this->race_nonces : $this->inner->get( $key, $default );
		}
		return $this->inner->get( $key, $default );
	}
	public function set( string $key, $value ): void {
		$this->inner->set( $key, $value );
	}
	public function delete( string $key ): void {
		$this->inner->delete( $key );
	}
	public function add( string $key, $value ): bool {
		return $this->inner->add( $key, $value );
	}
}

$inner = iwsl_seed_store();
$race  = new IWSL_Race_Store( $inner, 500, array( 'concurrent-nonce' => 9999999999999 ) );
$rverifier = new IWSL_Verifier( $race, $methods, iwsl_now_t0() );
$verdict   = $rverifier->verify_command( $f->commands->valid );
iwsl_assert( $verdict['ok'], 'race: the valid command still verifies through the decorating store' );
iwsl_assert_same( 500, $inner->get( 'last_seq' ), 'race: last_seq advances by max() — a concurrent higher seq is NOT regressed' );
$final_nonces = $inner->get( 'nonces' );
iwsl_assert( isset( $final_nonces['concurrent-nonce'] ), 'race: a concurrent worker nonce is preserved (ledger merged, not clobbered)' );
iwsl_assert( isset( $final_nonces['fixture-nonce-valid-1'] ), 'race: the newly claimed nonce is also recorded' );
