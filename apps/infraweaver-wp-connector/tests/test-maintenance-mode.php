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

// ── 13. purge(): teardown removes the settings option key (idempotent, ungated) ─

$store13 = new IWSL_Memory_Store();
$ent13   = iwsl_mm_unlocked_entitlements( $store13, $MM_NOW );
$mm13    = new IWSL_Maintenance_Mode( $ent13, $store13, iwsl_mm_clock( $MM_NOW ) );
$mm13->save_settings( array( 'enabled' => true, 'headline' => 'Down for maintenance' ) );
iwsl_assert_same( true, $mm13->is_enabled(), 'purge: enabled before teardown' );
$p13 = $mm13->purge();
iwsl_assert_same( true, $p13['ok'], 'purge: ok=true' );
iwsl_assert_same( array( IWSL_Maintenance_Mode::SETTINGS_KEY ), $p13['options_removed'], 'purge: reports the removed settings option key' );
iwsl_assert_same( null, $store13->get( IWSL_Maintenance_Mode::SETTINGS_KEY ), 'purge: settings option removed from the store' );
iwsl_assert_same( false, $mm13->is_enabled(), 'purge: is_enabled() reads back false (defaults) after teardown' );

// idempotent + cheap on an already-clean store.
$p13b = $mm13->purge();
iwsl_assert_same( true, $p13b['ok'], 'purge: idempotent — second call on a clean store still ok' );

// purge is NOT gated by the entitlement — teardown works on a revoked/locked site.
$store13l = new IWSL_Memory_Store();
$store13l->set( IWSL_Maintenance_Mode::SETTINGS_KEY, array( 'enabled' => true, 'saved_at' => 123 ) );
$store13l->set( 'state', 'active' );
$store13l->set( 'last_verified_at', $MM_NOW - 60000 );
$store13l->set( 'entitlements', array( 'plus' => true ) ); // maintenance_mode ABSENT
$ent13l = new IWSL_Entitlements( $store13l, iwsl_mm_clock( $MM_NOW ) );
$mm13l  = new IWSL_Maintenance_Mode( $ent13l, $store13l, iwsl_mm_clock( $MM_NOW ) );
$p13l   = $mm13l->purge();
iwsl_assert_same( true, $p13l['ok'], 'purge: works even when the entitlement is locked/revoked' );
iwsl_assert_same( null, $store13l->get( IWSL_Maintenance_Mode::SETTINGS_KEY ), 'purge (locked): settings removed despite the lock' );

// ── 14. Content-cache invalidation: save_settings() flushes any page cache whose
//         markup depended on the old settings (2026-07-22 teardown wave) ───────

// IWSL_Teardown is a peer engine (owned separately); not present in this harness,
// so a fixture double records calls the same way the real class would be invoked
// via the class_exists-guarded call inside save_settings().
if ( ! class_exists( 'IWSL_Teardown' ) ) {
	final class IWSL_Teardown {
		/** @var int */
		public static $flush_calls = 0;
		public static function flush_page_cache(): void {
			self::$flush_calls++;
		}
	}
}

$store14 = new IWSL_Memory_Store();
$ent14   = iwsl_mm_unlocked_entitlements( $store14, $MM_NOW );
$mm14    = new IWSL_Maintenance_Mode( $ent14, $store14, iwsl_mm_clock( $MM_NOW ) );

$before14 = IWSL_Teardown::$flush_calls;
$save14   = $mm14->save_settings( array( 'enabled' => true ) );
iwsl_assert_same( true, $save14['ok'], 'cache-flush: save_settings succeeded' );
iwsl_assert_same( $before14 + 1, IWSL_Teardown::$flush_calls, 'cache-flush: a successful save_settings() flushes the page cache' );

$store14l = new IWSL_Memory_Store();
$store14l->set( 'state', 'active' );
$store14l->set( 'last_verified_at', $MM_NOW - 60000 );
$store14l->set( 'entitlements', array( 'plus' => true ) ); // maintenance_mode ABSENT
$ent14l    = new IWSL_Entitlements( $store14l, iwsl_mm_clock( $MM_NOW ) );
$mm14l     = new IWSL_Maintenance_Mode( $ent14l, $store14l, iwsl_mm_clock( $MM_NOW ) );
$before14l = IWSL_Teardown::$flush_calls;
$locked14  = $mm14l->save_settings( array( 'enabled' => true ) );
iwsl_assert_same( false, $locked14['ok'], 'cache-flush: locked save refused' );
iwsl_assert_same( $before14l, IWSL_Teardown::$flush_calls, 'cache-flush: a locked/refused save does not flush' );

// ── 15. Auto-off window (S8): is_active_now expiry boundary ───────────────────

$MM_NOW_S = (int) floor( $MM_NOW / 1000 ); // the engine's now_seconds()
$store    = new IWSL_Memory_Store();
$ent      = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$mm       = new IWSL_Maintenance_Mode( $ent, $store, iwsl_mm_clock( $MM_NOW ) );
iwsl_assert_same( true, $mm->is_active_now( array( 'enabled' => true, 'until' => 0 ) ), 'until: enabled with no window → active' );
iwsl_assert_same( true, $mm->is_active_now( array( 'enabled' => true, 'until' => $MM_NOW_S + 10 ) ), 'until: a future window → active' );
iwsl_assert_same( false, $mm->is_active_now( array( 'enabled' => true, 'until' => $MM_NOW_S ) ), 'until: window == now → elapsed (boundary, not active)' );
iwsl_assert_same( false, $mm->is_active_now( array( 'enabled' => true, 'until' => $MM_NOW_S - 1 ) ), 'until: a past window → not active' );
iwsl_assert_same( false, $mm->is_active_now( array( 'enabled' => false, 'until' => $MM_NOW_S + 100 ) ), 'until: disabled → never active' );

// ── 16. maybe_block honours the window ────────────────────────────────────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$store->set( 'maintenance_mode', array( 'enabled' => true, 'until' => $MM_NOW_S - 1, 'saved_at' => 1 ) );
$rec = new IWSL_MM_Recording_Responder();
$mm  = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec, false, true );
$mm->maybe_block();
iwsl_assert_same( 0, count( $rec->calls ), 'maybe_block: an elapsed window serves the site (no 503)' );
$store->set( 'maintenance_mode', array( 'enabled' => true, 'until' => $MM_NOW_S + 100, 'saved_at' => 1 ) );
$rec2 = new IWSL_MM_Recording_Responder();
$mm2  = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec2, false, true );
$mm2->maybe_block();
iwsl_assert_same( 1, count( $rec2->calls ), 'maybe_block: a future window still blocks' );

// ── 17. IP allow-list (S7): REMOTE_ADDR only, canonicalized ───────────────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$store->set( 'maintenance_mode', array( 'enabled' => true, 'allow_ips' => array( '203.0.113.7', '::1' ), 'saved_at' => 1 ) );
$mm = new IWSL_Maintenance_Mode( $ent, $store, iwsl_mm_clock( $MM_NOW ) );
iwsl_assert_same( true, $mm->is_ip_allowed( $mm->settings(), '203.0.113.7' ), 'allowlist: an exact listed IP is allowed' );
iwsl_assert_same( true, $mm->is_ip_allowed( $mm->settings(), '0:0:0:0:0:0:0:1' ), 'allowlist: IPv6 canonicalized (::1 == its long form)' );
iwsl_assert_same( false, $mm->is_ip_allowed( $mm->settings(), '203.0.113.8' ), 'allowlist: a non-listed IP is not allowed' );
iwsl_assert_same( false, $mm->is_ip_allowed( array( 'enabled' => true, 'allow_ips' => array() ), '203.0.113.7' ), 'allowlist: an empty list allows nobody' );
iwsl_assert_same( false, $mm->is_ip_allowed( $mm->settings(), 'not-an-ip' ), 'allowlist: an unparseable client address is refused (fail-closed)' );

// ── 18. maybe_block: allow-listed REMOTE_ADDR bypasses; XFF is NEVER consulted ─

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$store->set( 'maintenance_mode', array( 'enabled' => true, 'allow_ips' => array( '203.0.113.7' ), 'saved_at' => 1 ) );
$rec = new IWSL_MM_Recording_Responder();
$mm  = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec, false, true );
$_SERVER['REMOTE_ADDR']          = '203.0.113.7';
$_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.9';
$mm->maybe_block();
iwsl_assert_same( 0, count( $rec->calls ), 'allowlist: an allow-listed REMOTE_ADDR bypasses the holding page' );

$rec2 = new IWSL_MM_Recording_Responder();
$mm2  = iwsl_mm_engine( $store, $ent, $MM_NOW, $rec2, false, true );
$_SERVER['REMOTE_ADDR']          = '198.51.100.5'; // NOT listed
$_SERVER['HTTP_X_FORWARDED_FOR'] = '203.0.113.7';  // spoofed to a listed IP — must not help
$mm2->maybe_block();
iwsl_assert_same( 1, count( $rec2->calls ), 'allowlist: XFF is ignored — a spoofed forwarded IP does not bypass' );
unset( $_SERVER['REMOTE_ADDR'], $_SERVER['HTTP_X_FORWARDED_FOR'] );

// ── 19. sanitize_settings: allow_ips cap/drop/dedupe + until clamp ─────────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_mm_unlocked_entitlements( $store, $MM_NOW );
$mm    = new IWSL_Maintenance_Mode( $ent, $store, iwsl_mm_clock( $MM_NOW ) );
$ips   = array();
for ( $i = 0; $i < 15; $i++ ) {
	$ips[] = '10.0.0.' . $i;
}
$ips[]  = '10.0.0.1';   // duplicate
$ips[]  = '10.0.0.0/8'; // CIDR — refused by FILTER_VALIDATE_IP
$ips[]  = 'garbage';    // not an IP
$clean  = $mm->sanitize_settings( array( 'enabled' => true, 'allow_ips' => $ips, 'until' => $MM_NOW_S + 999999999 ) );
iwsl_assert_same( IWSL_Maintenance_Mode::MAX_ALLOW_IPS, count( $clean['allow_ips'] ), 'sanitize: allow_ips capped at 10' );
iwsl_assert( ! in_array( '10.0.0.0/8', $clean['allow_ips'], true ), 'sanitize: a CIDR entry is dropped (no CIDR in v1)' );
iwsl_assert( ! in_array( 'garbage', $clean['allow_ips'], true ), 'sanitize: a non-IP entry is dropped' );
iwsl_assert_same( $MM_NOW_S + IWSL_Maintenance_Mode::MAX_UNTIL_AHEAD_S, $clean['until'], 'sanitize: a far-future window is clamped to 7 days ahead' );
$clean2 = $mm->sanitize_settings( array( 'enabled' => true, 'allow_ips' => "1.1.1.1, 2.2.2.2\n3.3.3.3" ) );
iwsl_assert_same( array( '1.1.1.1', '2.2.2.2', '3.3.3.3' ), $clean2['allow_ips'], 'sanitize: a comma/space/newline IP string is parsed' );
iwsl_assert_same( 0, $clean2['until'], 'sanitize: a missing until is 0 (no window)' );

// ── 20. Retry-After uses the real remaining window seconds (S8) ───────────────

$resp = $mm->build_response( array( 'retry_after' => true, 'until' => $MM_NOW_S + 120 ) );
iwsl_assert_same( '120', $resp['headers']['Retry-After'], 'retry-after: advertises the real remaining window seconds' );
$resp2 = $mm->build_response( array( 'retry_after' => true ) );
iwsl_assert_same( (string) IWSL_Maintenance_Mode::RETRY_AFTER_SECONDS, $resp2['headers']['Retry-After'], 'retry-after: no window → the flat default' );
$resp3 = $mm->build_response( array( 'retry_after' => true, 'until' => $MM_NOW_S - 5 ) );
iwsl_assert_same( (string) IWSL_Maintenance_Mode::RETRY_AFTER_SECONDS, $resp3['headers']['Retry-After'], 'retry-after: a past window → the flat default' );

// no globals installed by this suite — nothing to unset.
