<?php
/**
 * CDN URL Rewrite (gate flag `cdn_rewrite`): the same-origin static-asset host
 * swapper (IWSL_CDN_Rewrite).
 *
 * Runs under the zero-dependency harness: no WordPress url/output helpers are
 * defined, so the class's LOCAL parse_url-based rewrite is authoritative. The
 * gate is proved to BLOCK before any rewrite runs (the filter returns the URL
 * unchanged), and the pure rewrite is exercised directly with an injected origin
 * host.
 */

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Unlocked gate: active + fresh heartbeat + cdn_rewrite flag. */
function iwsl_cdn_unlocked_entitlements( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array( 'plus' => true, 'cdn_rewrite' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** A gate seeded with an explicit state + flag map (for the blocked cases). */
function iwsl_cdn_entitlements( int $now, string $state, array $flags, int $last_offset = 60000 ): IWSL_Entitlements {
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

/** A settings store pre-seeded with an enabled CDN host. */
function iwsl_cdn_store( string $host = 'cdn.example.com', bool $enabled = true ): IWSL_Memory_Store {
	$store = new IWSL_Memory_Store();
	$store->set( 'cdn_rewrite', array( 'enabled' => $enabled, 'host' => $host ) );
	return $store;
}

$CDN_NOW = 40000000;
$CDN_EXT = IWSL_CDN_Rewrite::ASSET_EXTENSIONS;

// ── 1. The pure rewrite: same-origin assets only ──────────────────────────────

iwsl_assert_same(
	'https://cdn.example.com/wp-content/uploads/a.jpg',
	IWSL_CDN_Rewrite::rewrite_url( 'https://example.com/wp-content/uploads/a.jpg', 'example.com', 'cdn.example.com', $CDN_EXT ),
	'rewrite: same-origin jpg host swapped to CDN'
);

// every allow-listed extension is rewritten.
foreach ( array( 'jpeg', 'png', 'gif', 'webp', 'svg', 'css', 'js', 'woff2', 'ico' ) as $ext ) {
	$src = 'https://example.com/assets/file.' . $ext;
	$exp = 'https://cdn.example.com/assets/file.' . $ext;
	iwsl_assert_same( $exp, IWSL_CDN_Rewrite::rewrite_url( $src, 'example.com', 'cdn.example.com', $CDN_EXT ), "rewrite: .{$ext} asset rewritten" );
}

// external host is NEVER rewritten.
iwsl_assert_same(
	'https://other.com/a.jpg',
	IWSL_CDN_Rewrite::rewrite_url( 'https://other.com/a.jpg', 'example.com', 'cdn.example.com', $CDN_EXT ),
	'rewrite: external host untouched'
);

// a look-alike host (origin as a prefix) is NOT rewritten.
iwsl_assert_same(
	'https://example.com.evil.com/a.jpg',
	IWSL_CDN_Rewrite::rewrite_url( 'https://example.com.evil.com/a.jpg', 'example.com', 'cdn.example.com', $CDN_EXT ),
	'rewrite: look-alike host (example.com.evil.com) untouched'
);

// dynamic / non-asset URLs are left on the origin.
iwsl_assert_same(
	'https://example.com/page.php',
	IWSL_CDN_Rewrite::rewrite_url( 'https://example.com/page.php', 'example.com', 'cdn.example.com', $CDN_EXT ),
	'rewrite: dynamic .php untouched'
);
iwsl_assert_same(
	'https://example.com/some/route',
	IWSL_CDN_Rewrite::rewrite_url( 'https://example.com/some/route', 'example.com', 'cdn.example.com', $CDN_EXT ),
	'rewrite: extensionless route untouched'
);

// admin assets are never rewritten, even with an asset extension.
iwsl_assert_same(
	'https://example.com/wp-admin/css/common.css',
	IWSL_CDN_Rewrite::rewrite_url( 'https://example.com/wp-admin/css/common.css', 'example.com', 'cdn.example.com', $CDN_EXT ),
	'rewrite: /wp-admin/ asset untouched'
);

// relative URL (no host) untouched.
iwsl_assert_same(
	'/wp-content/a.jpg',
	IWSL_CDN_Rewrite::rewrite_url( '/wp-content/a.jpg', 'example.com', 'cdn.example.com', $CDN_EXT ),
	'rewrite: relative URL untouched'
);

// ported / userinfo origin left alone (non-canonical).
iwsl_assert_same(
	'https://example.com:8443/a.jpg',
	IWSL_CDN_Rewrite::rewrite_url( 'https://example.com:8443/a.jpg', 'example.com', 'cdn.example.com', $CDN_EXT ),
	'rewrite: ported origin untouched'
);

// scheme + query + fragment preserved verbatim; host case-insensitive.
iwsl_assert_same(
	'http://cdn.example.com/wp-content/x.css?ver=1.2#top',
	IWSL_CDN_Rewrite::rewrite_url( 'http://Example.COM/wp-content/x.css?ver=1.2#top', 'example.com', 'cdn.example.com', $CDN_EXT ),
	'rewrite: scheme/query/fragment preserved, host case-insensitive'
);

// empty CDN host disables the rewrite.
iwsl_assert_same(
	'https://example.com/a.jpg',
	IWSL_CDN_Rewrite::rewrite_url( 'https://example.com/a.jpg', 'example.com', '', $CDN_EXT ),
	'rewrite: empty CDN host is a no-op'
);

// ── 2. Gate BLOCKS: filter_asset_url must never rewrite for a lower tier ───────

// (a) flag absent.
$locked = new IWSL_CDN_Rewrite( iwsl_cdn_entitlements( $CDN_NOW, 'active', array( 'plus' => true ) ), iwsl_cdn_store(), 'example.com' );
iwsl_assert_same( 'https://example.com/a.jpg', $locked->filter_asset_url( 'https://example.com/a.jpg' ), 'gate (flag absent): asset URL untouched' );

// (b) state != active.
$locked_b = new IWSL_CDN_Rewrite( iwsl_cdn_entitlements( $CDN_NOW, 'pending', array( 'plus' => true, 'cdn_rewrite' => true ) ), iwsl_cdn_store(), 'example.com' );
iwsl_assert_same( 'https://example.com/a.jpg', $locked_b->filter_asset_url( 'https://example.com/a.jpg' ), 'gate (not active): asset URL untouched despite flag' );

// (c) stale heartbeat.
$locked_c = new IWSL_CDN_Rewrite( iwsl_cdn_entitlements( $CDN_NOW, 'active', array( 'plus' => true, 'cdn_rewrite' => true ), 10800000 ), iwsl_cdn_store(), 'example.com' );
iwsl_assert_same( 'https://example.com/a.jpg', $locked_c->filter_asset_url( 'https://example.com/a.jpg' ), 'gate (stale heartbeat): asset URL untouched despite flag' );

// ── 3. Unlocked filters ───────────────────────────────────────────────────────

$un = new IWSL_CDN_Rewrite( iwsl_cdn_unlocked_entitlements( $CDN_NOW ), iwsl_cdn_store(), 'example.com' );
iwsl_assert_same( 'https://cdn.example.com/a.jpg', $un->filter_asset_url( 'https://example.com/a.jpg' ), 'unlocked: asset URL rewritten' );
iwsl_assert_same( 'https://example.com/index.php', $un->filter_asset_url( 'https://example.com/index.php' ), 'unlocked: dynamic URL still left on origin' );

// disabled setting → no rewrite even when unlocked.
$un_off = new IWSL_CDN_Rewrite( iwsl_cdn_unlocked_entitlements( $CDN_NOW ), iwsl_cdn_store( 'cdn.example.com', false ), 'example.com' );
iwsl_assert_same( 'https://example.com/a.jpg', $un_off->filter_asset_url( 'https://example.com/a.jpg' ), 'unlocked + disabled: asset URL untouched' );

// content rewrite flips multiple same-origin asset URLs, leaves php + external.
$html = '<img src="https://example.com/u/a.jpg" srcset="https://example.com/u/a-300.jpg 300w">'
	. '<link href="https://example.com/s.css">'
	. '<a href="https://example.com/page.php">link</a>'
	. '<img src="https://cdn2.other.com/ext.png">';
$rc = $un->rewrite_content( $html );
iwsl_assert( false !== strpos( $rc, 'https://cdn.example.com/u/a.jpg' ), 'content: full-size jpg rewritten' );
iwsl_assert( false !== strpos( $rc, 'https://cdn.example.com/u/a-300.jpg' ), 'content: srcset jpg rewritten' );
iwsl_assert( false !== strpos( $rc, 'https://cdn.example.com/s.css' ), 'content: css rewritten' );
iwsl_assert( false !== strpos( $rc, 'https://example.com/page.php' ), 'content: dynamic php left on origin' );
iwsl_assert( false !== strpos( $rc, 'https://cdn2.other.com/ext.png' ), 'content: external host untouched' );

// gate blocks content rewrite too.
$rc_locked = $locked->rewrite_content( $html );
iwsl_assert_same( $html, $rc_locked, 'gate (flag absent): content rewrite is a no-op' );

// ── 4. Host validation (is_valid_host + update_settings boundary) ─────────────

iwsl_assert_same( true, IWSL_CDN_Rewrite::is_valid_host( 'cdn.example.com' ), 'valid: bare FQDN' );
iwsl_assert_same( true, IWSL_CDN_Rewrite::is_valid_host( 'a.b.c.example.co.uk' ), 'valid: multi-label FQDN' );
iwsl_assert_same( false, IWSL_CDN_Rewrite::is_valid_host( 'https://cdn.example.com' ), 'invalid: has scheme' );
iwsl_assert_same( false, IWSL_CDN_Rewrite::is_valid_host( 'cdn.example.com/path' ), 'invalid: has path' );
iwsl_assert_same( false, IWSL_CDN_Rewrite::is_valid_host( 'cdn example com' ), 'invalid: has spaces' );
iwsl_assert_same( false, IWSL_CDN_Rewrite::is_valid_host( 'cdn.example.com:8080' ), 'invalid: has port' );
iwsl_assert_same( false, IWSL_CDN_Rewrite::is_valid_host( 'localhost' ), 'invalid: dotless host' );
iwsl_assert_same( false, IWSL_CDN_Rewrite::is_valid_host( '-cdn.example.com' ), 'invalid: leading hyphen' );
iwsl_assert_same( false, IWSL_CDN_Rewrite::is_valid_host( '' ), 'invalid: empty' );

$store_v = new IWSL_Memory_Store();
$cdn_v   = new IWSL_CDN_Rewrite( iwsl_cdn_unlocked_entitlements( $CDN_NOW ), $store_v, 'example.com' );

iwsl_assert_same( 'invalid-host', $cdn_v->update_settings( array( 'host' => 'https://cdn.example.com', 'enabled' => '1' ) )['reason'], 'update (scheme): refused invalid-host' );
iwsl_assert_same( 'invalid-host', $cdn_v->update_settings( array( 'host' => 'cdn.example.com/x', 'enabled' => '1' ) )['reason'], 'update (path): refused invalid-host' );
iwsl_assert_same( 'invalid-host', $cdn_v->update_settings( array( 'host' => 'cdn example', 'enabled' => '1' ) )['reason'], 'update (space): refused invalid-host' );
iwsl_assert_same( 'invalid-host', $cdn_v->update_settings( array( 'host' => 'localhost', 'enabled' => '1' ) )['reason'], 'update (dotless): refused invalid-host' );

$ok = $cdn_v->update_settings( array( 'host' => 'CDN.Example.com', 'enabled' => '1' ) );
iwsl_assert_same( true, $ok['ok'], 'update (valid): ok' );
iwsl_assert_same( 'cdn.example.com', $ok['settings']['host'], 'update (valid): host lowercased' );
iwsl_assert_same( true, $ok['settings']['enabled'], 'update (valid): enabled true when host set' );
iwsl_assert_same( 'cdn.example.com', $cdn_v->settings()['host'], 'update (valid): persisted value read back' );

// clearing the host forces enabled off.
$clr = $cdn_v->update_settings( array( 'host' => '', 'enabled' => '1' ) );
iwsl_assert_same( '', $clr['settings']['host'], 'update (clear): host cleared' );
iwsl_assert_same( false, $clr['settings']['enabled'], 'update (clear): enabled forced off when host empty' );

// locked update refused, nothing persisted.
$store_l = new IWSL_Memory_Store();
$cdn_l   = new IWSL_CDN_Rewrite( iwsl_cdn_entitlements( $CDN_NOW, 'active', array( 'plus' => true ) ), $store_l, 'example.com' );
$rl      = $cdn_l->update_settings( array( 'host' => 'cdn.example.com', 'enabled' => '1' ) );
iwsl_assert_same( false, $rl['ok'], 'update (locked): refused' );
iwsl_assert_same( 'entitlement-locked', $rl['reason'], 'update (locked): reason entitlement-locked' );
iwsl_assert_same( array(), $store_l->get( 'cdn_rewrite', array() ), 'update (locked): nothing persisted' );
