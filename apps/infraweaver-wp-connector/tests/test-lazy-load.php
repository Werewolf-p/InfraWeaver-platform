<?php
/**
 * Lazy-Load Media (gate flag `lazy_load`): the passive the_content / iframe
 * augmenter (IWSL_Lazy_Load).
 *
 * Runs under the zero-dependency harness: no WordPress output helpers are
 * defined, so the class's LOCAL append-only transform is authoritative. The gate
 * is proved to BLOCK before any augmentation runs (the filter callback returns
 * the content byte-identical), and the pure transform is exercised directly.
 */

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Unlocked gate: active + fresh heartbeat + lazy_load flag. */
function iwsl_ll_unlocked_entitlements( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'plus' => true, 'lazy_load' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** A gate seeded with an explicit state + flag map (for the blocked cases). */
function iwsl_ll_entitlements( int $now, string $state, array $flags, int $last_offset = 60000 ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $now - $last_offset );
	$store->set( 'entitlements', $flags );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

$LL_NOW = 20000000;
$LL_IMG = '<p><img src="/a.jpg" alt="a"><img src="/b.jpg"><img src="/c.jpg" /></p>';

// ── 1. Gate BLOCKS: the filter must never augment for a lower tier ─────────────

// (a) flag absent.
$ll = new IWSL_Lazy_Load( iwsl_ll_entitlements( $LL_NOW, 'active', array( 'plus' => true ) ), new IWSL_Memory_Store() );
$out = $ll->filter_the_content( $LL_IMG );
iwsl_assert_same( $LL_IMG, $out, 'gate (flag absent): content byte-identical' );
iwsl_assert( false === strpos( $out, 'loading=' ), 'gate (flag absent): no loading attr injected' );

// (b) state != active, even WITH the flag true.
$ll = new IWSL_Lazy_Load( iwsl_ll_entitlements( $LL_NOW, 'pending', array( 'plus' => true, 'lazy_load' => true ) ), new IWSL_Memory_Store() );
iwsl_assert_same( $LL_IMG, $ll->filter_the_content( $LL_IMG ), 'gate (not active): unchanged despite flag' );

// (c) stale heartbeat (3h), even WITH the flag true.
$ll = new IWSL_Lazy_Load( iwsl_ll_entitlements( $LL_NOW, 'active', array( 'plus' => true, 'lazy_load' => true ), 10800000 ), new IWSL_Memory_Store() );
iwsl_assert_same( $LL_IMG, $ll->filter_the_content( $LL_IMG ), 'gate (stale heartbeat): unchanged despite flag' );

// ── 2. The pure transform: append-only, LCP-safe, author-respecting ───────────

// skip=1: first image left eager, the other two lazified (loading + decoding).
$html3 = '<img src="1.jpg"><img src="2.jpg"><img src="3.jpg">';
$r     = IWSL_Lazy_Load::add_lazy_attributes( $html3, false, 1 );
iwsl_assert_same( 2, substr_count( $r, 'loading="lazy"' ), 'skip=1: exactly 2 of 3 images lazified' );
iwsl_assert_same( 2, substr_count( $r, 'decoding="async"' ), 'skip=1: decoding added to the same 2' );
iwsl_assert( false !== strpos( $r, '<img src="1.jpg">' ), 'skip=1: first image byte-identical (LCP protected)' );

// skip=0: all three lazified.
$r0 = IWSL_Lazy_Load::add_lazy_attributes( $html3, false, 0 );
iwsl_assert_same( 3, substr_count( $r0, 'loading="lazy"' ), 'skip=0: all three images lazified' );

// an existing loading attr is respected — tag returned unchanged.
$existing = '<img src="x.jpg" loading="eager">';
iwsl_assert_same( $existing, IWSL_Lazy_Load::add_lazy_attributes( $existing, false, 0 ), 'existing loading attr respected (unchanged)' );

// existing decoding is not duplicated; original decoding kept; loading still added.
$dec = '<img src="y.jpg" decoding="sync">';
$rd  = IWSL_Lazy_Load::add_lazy_attributes( $dec, false, 0 );
iwsl_assert_same( 1, substr_count( $rd, 'loading="lazy"' ), 'decoding present: loading added once' );
iwsl_assert_same( 0, substr_count( $rd, 'decoding="async"' ), 'decoding present: async not duplicated' );
iwsl_assert( false !== strpos( $rd, 'decoding="sync"' ), 'decoding present: original decoding preserved' );

// self-closing form preserved.
$sc = '<img src="z.jpg" />';
$rs = IWSL_Lazy_Load::add_lazy_attributes( $sc, false, 0 );
iwsl_assert( false !== strpos( $rs, ' />' ), 'self-closing: /> preserved' );
iwsl_assert( false !== strpos( $rs, 'loading="lazy"' ), 'self-closing: loading added' );

// data-loading is NOT a loading attribute — the image is still lazified.
$dl = '<img src="q.jpg" data-loading="1">';
$rl = IWSL_Lazy_Load::add_lazy_attributes( $dl, false, 0 );
iwsl_assert( false !== strpos( $rl, 'loading="lazy"' ), 'data-loading is not loading=: image still lazified' );

// iframes only when enabled.
$ifr = '<iframe src="https://example.test/embed"></iframe>';
iwsl_assert( false === strpos( IWSL_Lazy_Load::add_lazy_attributes( $ifr, false, 0 ), 'loading' ), 'iframes off: iframe untouched' );
iwsl_assert( false !== strpos( IWSL_Lazy_Load::add_lazy_attributes( $ifr, true, 0 ), 'loading="lazy"' ), 'iframes on: iframe lazified' );
iwsl_assert( false === strpos( IWSL_Lazy_Load::add_lazy_attributes( $ifr, true, 0 ), 'decoding' ), 'iframes: no decoding attr (img-only)' );

// idempotent: a second pass adds nothing.
$once  = IWSL_Lazy_Load::add_lazy_attributes( '<img src="i.jpg">', false, 0 );
$twice = IWSL_Lazy_Load::add_lazy_attributes( $once, false, 0 );
iwsl_assert_same( $once, $twice, 'idempotent: re-running the pass changes nothing' );

// empty input is returned as-is.
iwsl_assert_same( '', IWSL_Lazy_Load::add_lazy_attributes( '', true, 0 ), 'empty input returns empty' );

// ── 3. filter_the_content integration when unlocked ───────────────────────────

// master toggle OFF → unchanged even though unlocked.
$store_off = new IWSL_Memory_Store();
$store_off->set( 'lazy_load', array( 'enabled' => false, 'lazy_iframes' => true, 'skip_images' => 0 ) );
$ll_off = new IWSL_Lazy_Load( iwsl_ll_unlocked_entitlements( $LL_NOW ), $store_off );
iwsl_assert_same( '<img src="d.jpg">', $ll_off->filter_the_content( '<img src="d.jpg">' ), 'unlocked + disabled: content unchanged' );

// master toggle ON → content img lazified.
$store_on = new IWSL_Memory_Store();
$store_on->set( 'lazy_load', array( 'enabled' => true, 'lazy_iframes' => true, 'skip_images' => 0 ) );
$ll_on = new IWSL_Lazy_Load( iwsl_ll_unlocked_entitlements( $LL_NOW ), $store_on );
$oon   = $ll_on->filter_the_content( '<img src="e.jpg">' );
iwsl_assert( false !== strpos( $oon, 'loading="lazy"' ), 'unlocked + enabled: content image lazified' );

// default settings (no stored value) → enabled, skip 1.
$ll_def = new IWSL_Lazy_Load( iwsl_ll_unlocked_entitlements( $LL_NOW ), new IWSL_Memory_Store() );
$def    = $ll_def->settings();
iwsl_assert_same( true, $def['enabled'], 'defaults: enabled true out of the box' );
iwsl_assert_same( 1, $def['skip_images'], 'defaults: skip_images is 1' );

// featured-image filter lazifies a below-core-annotation thumbnail.
$thumb = $ll_on->filter_post_thumbnail_html( '<img src="feat.jpg" class="wp-post-image">' );
iwsl_assert( false !== strpos( $thumb, 'loading="lazy"' ), 'thumbnail filter: featured image lazified' );

// ── 4. update_settings: gate + boundary validation ────────────────────────────

$store_u = new IWSL_Memory_Store();
$ll_u    = new IWSL_Lazy_Load( iwsl_ll_unlocked_entitlements( $LL_NOW ), $store_u );

$ru = $ll_u->update_settings( array( 'enabled' => '1', 'lazy_iframes' => '', 'skip_images' => '99' ) );
iwsl_assert_same( true, $ru['ok'], 'update_settings: ok when unlocked' );
iwsl_assert_same( 20, $ru['settings']['skip_images'], 'update_settings: skip clamped to MAX_SKIP (20)' );
iwsl_assert_same( true, $ru['settings']['enabled'], 'update_settings: enabled stored true' );
iwsl_assert_same( false, $ru['settings']['lazy_iframes'], 'update_settings: iframes stored false' );
iwsl_assert_same( 20, $ll_u->settings()['skip_images'], 'update_settings: persisted value read back' );

$rn = $ll_u->update_settings( array( 'enabled' => '1', 'skip_images' => '-5' ) );
iwsl_assert_same( 0, $rn['settings']['skip_images'], 'update_settings: negative skip clamped to 0' );

// locked update is refused and persists nothing.
$store_l = new IWSL_Memory_Store();
$ll_l    = new IWSL_Lazy_Load( iwsl_ll_entitlements( $LL_NOW, 'active', array( 'plus' => true ) ), $store_l );
$rl2     = $ll_l->update_settings( array( 'enabled' => '1', 'skip_images' => '3' ) );
iwsl_assert_same( false, $rl2['ok'], 'update_settings (locked): refused' );
iwsl_assert_same( 'entitlement-locked', $rl2['reason'], 'update_settings (locked): reason entitlement-locked' );
iwsl_assert_same( array(), $store_l->get( 'lazy_load', array() ), 'update_settings (locked): nothing persisted' );

// ── 5. purge(): teardown deletes the settings option key ──────────────────────

$store_p = new IWSL_Memory_Store();
$ll_p    = new IWSL_Lazy_Load( iwsl_ll_unlocked_entitlements( $LL_NOW ), $store_p );
$ll_p->update_settings( array( 'enabled' => '1', 'skip_images' => '5' ) );
iwsl_assert_same( 5, $ll_p->settings()['skip_images'], 'purge setup: setting persisted before purge' );

$pp = $ll_p->purge();
iwsl_assert_same( true, $pp['ok'], 'purge: ok' );
iwsl_assert_same( true, $pp['deleted'], 'purge: deleted true (a setting existed)' );
iwsl_assert_same( null, $store_p->get( 'lazy_load', null ), 'purge: option key truly absent' );
iwsl_assert_same( 1, $ll_p->settings()['skip_images'], 'purge: fresh settings() read falls back to defaults' );

// idempotent + cheap no-op when already clean.
$pp2 = $ll_p->purge();
iwsl_assert_same( true, $pp2['ok'], 'purge: second call still ok (idempotent)' );
iwsl_assert_same( false, $pp2['deleted'], 'purge: second call reports nothing deleted (cheap no-op)' );

// a fresh, never-configured engine: purge() is a clean no-op.
$ll_fresh = new IWSL_Lazy_Load( iwsl_ll_unlocked_entitlements( $LL_NOW ), new IWSL_Memory_Store() );
$pf       = $ll_fresh->purge();
iwsl_assert_same( true, $pf['ok'], 'purge (never configured): ok' );
iwsl_assert_same( false, $pf['deleted'], 'purge (never configured): nothing deleted' );

// ── 6. content-cache flush: a settings change invalidates the page cache ──────

if ( ! class_exists( 'IWSL_Teardown' ) ) {
	class IWSL_Teardown {
		/** @var int */
		public static $flush_calls = 0;
		public static function flush_page_cache(): void {
			self::$flush_calls++;
		}
	}
}

IWSL_Teardown::$flush_calls = 0;
$store_flush = new IWSL_Memory_Store();
$ll_flush    = new IWSL_Lazy_Load( iwsl_ll_unlocked_entitlements( $LL_NOW ), $store_flush );
$ll_flush->update_settings( array( 'enabled' => '1' ) );
iwsl_assert_same( 1, IWSL_Teardown::$flush_calls, 'update_settings: flush_page_cache() called once when IWSL_Teardown exists' );

// a locked update never reaches the flush.
IWSL_Teardown::$flush_calls = 0;
$store_locked_flush = new IWSL_Memory_Store();
$ll_locked_flush     = new IWSL_Lazy_Load( iwsl_ll_entitlements( $LL_NOW, 'active', array( 'plus' => true ) ), $store_locked_flush );
$ll_locked_flush->update_settings( array( 'enabled' => '1' ) );
iwsl_assert_same( 0, IWSL_Teardown::$flush_calls, 'update_settings (locked): flush_page_cache() NOT called' );
