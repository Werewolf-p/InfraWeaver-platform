<?php
/**
 * Maintenance Mode (gate flag `maintenance_mode`): the pure block decision
 * (should_block) + the gated effect (maybe_block) + the settings gauntlet.
 *
 * Runs under the zero-dependency harness: IWSL_Maintenance_Mode takes a shared
 * in-memory IWSL_Store (so a single entitlement flip re-locks instantly), a fixed
 * injected clock, injected is_admin / is_front probes, and a RECORDING RESPONDER
 * fake that captures (status, headers, body) and does NOT exit. No WordPress
 * output helpers are defined here, so the engine's local esc (htmlspecialchars)
 * is authoritative and the holding-page escaping is asserted directly.
 */

// ── recording responder fake (records, never exits) ───────────────────────────

final class IWSL_MM_Recording_Responder {

	/** @var array<int, array{status:int, headers:array, body:string}> */
	public $calls = array();

	public function __invoke( int $status, array $headers, string $body ): void {
		$this->calls[] = array(
			'status'  => $status,
			'headers' => $headers,
			'body'    => $body,
		);
	}
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function iwsl_mm_clock( int $now ): callable {
	return static function () use ( $now ): int {
		return $now;
	};
}

/** Seed a shared store as unlocked (active + fresh heartbeat + maintenance_mode). */
function iwsl_mm_unlocked_store( IWSL_Store $store, int $now ): void {
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'plus' => true, 'maintenance_mode' => true ) );
}

/** Unlocked-entitlements helper over a shared store (mirrors the other suites). */
function iwsl_mm_unlocked_entitlements( IWSL_Store $store, int $now ): IWSL_Entitlements {
	iwsl_mm_unlocked_store( $store, $now );
	return new IWSL_Entitlements( $store, iwsl_mm_clock( $now ) );
}

/** Build an engine over $store with a recorder + explicit is_admin / is_front. */
function iwsl_mm_engine( IWSL_Store $store, IWSL_Entitlements $ent, int $now, IWSL_MM_Recording_Responder $rec, bool $is_admin, bool $is_front ): IWSL_Maintenance_Mode {
	return new IWSL_Maintenance_Mode(
		$ent,
		$store,
		iwsl_mm_clock( $now ),
		$rec,
		static function () use ( $is_admin ): bool {
			return $is_admin;
		},
		static function () use ( $is_front ): bool {
			return $is_front;
		}
	);
}

$MM_NOW = 40000000;

// ── 1. should_block: the pure decision table (no gate, no side effects) ───────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$mm    = new IWSL_Maintenance_Mode( $ent, $store, iwsl_mm_clock( $MM_NOW ) );
iwsl_assert_same( true, $mm->should_block( true, false, true ), 'should_block: enabled + non-admin + front → block' );
iwsl_assert_same( false, $mm->should_block( false, false, true ), 'should_block: disabled → never block' );
iwsl_assert_same( false, $mm->should_block( true, true, true ), 'should_block: admin bypasses even when enabled' );
iwsl_assert_same( false, $mm->should_block( true, false, false ), 'should_block: non-front request (admin/REST/cron/login) → never block' );

// ── 2. Locked: flag missing → maybe_block serves NOTHING (even when enabled) ──

$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $MM_NOW - 60000 );
$store->set( 'entitlements', array( 'plus' => true ) ); // maintenance_mode ABSENT
$store->set( 'maintenance_mode', array( 'enabled' => true, 'headline' => 'Down', 'message' => 'later', 'retry_after' => true, 'saved_at' => 1 ) );
$ent = new IWSL_Entitlements( $store, iwsl_mm_clock( $MM_NOW ) );
$rec = new IWSL_MM_Recording_Responder();
$mm  = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec, false, true ); // non-admin, front
$mm->maybe_block();
iwsl_assert_same( 0, count( $rec->calls ), 'locked (flag missing): maybe_block serves no response despite enabled' );

// ── 3. Locked: not linked (state != active) → no response ─────────────────────

$store = new IWSL_Memory_Store();
$store->set( 'state', 'pending' );
$store->set( 'last_verified_at', $MM_NOW - 60000 );
$store->set( 'entitlements', array( 'maintenance_mode' => true ) );
$store->set( 'maintenance_mode', array( 'enabled' => true ) );
$ent = new IWSL_Entitlements( $store, iwsl_mm_clock( $MM_NOW ) );
$rec = new IWSL_MM_Recording_Responder();
$mm  = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec, false, true );
$mm->maybe_block();
iwsl_assert_same( 0, count( $rec->calls ), 'locked (not linked): no response despite the flag' );

// ── 4. Locked: stale heartbeat → no response ──────────────────────────────────

$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $MM_NOW - 10800000 ); // 3h — stale
$store->set( 'entitlements', array( 'maintenance_mode' => true ) );
$store->set( 'maintenance_mode', array( 'enabled' => true ) );
$ent = new IWSL_Entitlements( $store, iwsl_mm_clock( $MM_NOW ) );
$rec = new IWSL_MM_Recording_Responder();
$mm  = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec, false, true );
$mm->maybe_block();
iwsl_assert_same( 0, count( $rec->calls ), 'locked (stale heartbeat): no response despite the flag' );

// ── 5. Unlocked + enabled + non-admin + front → 503 holding page served ───────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$rec   = new IWSL_MM_Recording_Responder();
$mm    = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec, false, true );
$save  = $mm->save_settings( array( 'enabled' => true, 'headline' => 'Back soon', 'message' => 'Scheduled work', 'retry_after' => true ) );
iwsl_assert_same( true, $save['ok'], 'served: settings saved (ok=true)' );
$mm->maybe_block();
iwsl_assert_same( 1, count( $rec->calls ), 'served: exactly one response issued' );
iwsl_assert_same( 503, $rec->calls[0]['status'], 'served: HTTP status is 503' );
iwsl_assert( false !== strpos( $rec->calls[0]['body'], 'Back soon' ), 'served: body carries the headline' );
iwsl_assert( false !== strpos( $rec->calls[0]['body'], 'Scheduled work' ), 'served: body carries the message' );
iwsl_assert( isset( $rec->calls[0]['headers']['Retry-After'] ), 'served: Retry-After header present when the flag is on' );
iwsl_assert_same( (string) IWSL_Maintenance_Mode::RETRY_AFTER_SECONDS, $rec->calls[0]['headers']['Retry-After'], 'served: Retry-After advertises the fixed window' );

// ── 6. Admin bypass: enabled + is_admin → no response ─────────────────────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$rec   = new IWSL_MM_Recording_Responder();
$mm    = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec, true, true ); // IS admin, front
$mm->save_settings( array( 'enabled' => true ) );
$mm->maybe_block();
iwsl_assert_same( 0, count( $rec->calls ), 'admin bypass: a manage_options user is never blocked' );

// ── 7. Non-front request (admin area / REST / cron / login) → no response ──────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$rec   = new IWSL_MM_Recording_Responder();
$mm    = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec, false, false ); // non-admin, NOT front
$mm->save_settings( array( 'enabled' => true ) );
$mm->maybe_block();
iwsl_assert_same( 0, count( $rec->calls ), 'non-front: admin/REST/cron/login requests are never blocked' );

// ── 8. Enabled but not blocked when disabled ──────────────────────────────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$rec   = new IWSL_MM_Recording_Responder();
$mm    = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec, false, true );
$mm->save_settings( array( 'enabled' => false, 'headline' => 'x' ) );
$mm->maybe_block();
iwsl_assert_same( 0, count( $rec->calls ), 'disabled: unlocked but switched off → no response' );

// ── 9. save_settings is gated: a locked site cannot write settings ────────────

$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $MM_NOW - 60000 );
$store->set( 'entitlements', array( 'plus' => true ) ); // no maintenance_mode
$ent = new IWSL_Entitlements( $store, iwsl_mm_clock( $MM_NOW ) );
$mm  = new IWSL_Maintenance_Mode( $ent, $store, iwsl_mm_clock( $MM_NOW ) );
$r   = $mm->save_settings( array( 'enabled' => true, 'headline' => 'Nope' ) );
iwsl_assert_same( false, $r['ok'], 'locked save: ok=false' );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'locked save: entitlement-locked' );
iwsl_assert_same( null, $store->get( 'maintenance_mode' ), 'locked save: store untouched (nothing written)' );

// ── 10. Holding page escapes untrusted headline/message (XSS defence) ─────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$mm    = new IWSL_Maintenance_Mode( $ent, $store, iwsl_mm_clock( $MM_NOW ) );
$resp  = $mm->build_response( array( 'headline' => '<script>alert(1)</script>', 'message' => 'a & b <b>c</b>', 'retry_after' => false ) );
iwsl_assert_same( 503, $resp['status'], 'escape: build_response status is 503' );
iwsl_assert( false === strpos( $resp['body'], '<script>alert(1)</script>' ), 'escape: raw <script> never appears in the body' );
iwsl_assert( false !== strpos( $resp['body'], '&lt;script&gt;' ), 'escape: headline is HTML-escaped' );
iwsl_assert( false !== strpos( $resp['body'], 'a &amp; b' ), 'escape: message ampersand is escaped' );
iwsl_assert( ! isset( $resp['headers']['Retry-After'] ), 'escape: Retry-After absent when the flag is off' );

// ── 11. Revocation is instant ─────────────────────────────────────────────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$rec   = new IWSL_MM_Recording_Responder();
$mm    = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec, false, true );
$mm->save_settings( array( 'enabled' => true ) );
$mm->maybe_block();
iwsl_assert_same( 1, count( $rec->calls ), 'revocation: unlocked enabled request blocks once' );
$store->set( 'entitlements', array( 'maintenance_mode' => false ) ); // console revokes the flag
$mm->maybe_block();
iwsl_assert_same( 1, count( $rec->calls ), 'revocation: identical request after revoke adds NO response (site public again)' );

// ── 12. Settings sanitizer: control-strip + length cap, newlines kept ─────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$mm    = new IWSL_Maintenance_Mode( $ent, $store, iwsl_mm_clock( $MM_NOW ) );
$clean = $mm->sanitize_settings( array( 'enabled' => '1', 'headline' => "Hi\x00there", 'message' => "line1\nline2", 'retry_after' => '' ) );
iwsl_assert_same( true, $clean['enabled'], 'sanitize: truthy enabled cast to true' );
iwsl_assert_same( 'Hithere', $clean['headline'], 'sanitize: NUL control byte stripped from headline' );
iwsl_assert_same( "line1\nline2", $clean['message'], 'sanitize: newlines preserved in the message' );
iwsl_assert_same( false, $clean['retry_after'], 'sanitize: empty retry_after cast to false' );
$long = str_repeat( 'x', IWSL_Maintenance_Mode::MAX_HEADLINE_LEN + 50 );
iwsl_assert_same( IWSL_Maintenance_Mode::MAX_HEADLINE_LEN, strlen( $mm->sanitize_settings( array( 'headline' => $long ) )['headline'] ), 'sanitize: headline hard-truncated to the cap' );

// no globals installed by this suite — nothing to unset.
