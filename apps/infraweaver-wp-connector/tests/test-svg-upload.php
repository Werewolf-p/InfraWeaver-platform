<?php
/**
 * SVG Uploads, sanitized (gate flag `svg_upload`): the upload filters
 * (IWSL_SVG_Upload) + the allow-list sanitizer core.
 *
 * Runs under the zero-dependency harness: the sanitizer is a pure static function
 * so it is exercised directly, and the toggle persistence takes an injected
 * IWSL_Memory_Store. No WordPress functions are stubbed — the feature's WP calls
 * are all function_exists-guarded, so the filters run in the no-WP harness.
 *
 * The gate assertions prove that a lower tier NEVER allows SVG and NEVER sanitizes
 * (the malicious bytes are left untouched precisely because the feature is off, so
 * WordPress keeps rejecting the upload). The sanitizer assertions prove a
 * `<script>` / `onload=` / `javascript:` / DOCTYPE-entity SVG is neutralized or
 * refused, and a clean SVG passes.
 */

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Unlocked entitlement gate: active + fresh heartbeat + svg_upload flag. */
function iwsl_svg_unlocked_entitlements( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'plus' => true, 'svg_upload' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** An enabled engine (unlocked gate + toggle ON) over a fresh memory store. */
function iwsl_svg_enabled_engine( int $now ): IWSL_SVG_Upload {
	$store = new IWSL_Memory_Store();
	$store->set( self_svg_enabled_key(), true );
	return new IWSL_SVG_Upload( iwsl_svg_unlocked_entitlements( $now ), $store );
}

/** The ENABLED_KEY const, resolved once (kept out of the fixture signature). */
function self_svg_enabled_key(): string {
	return IWSL_SVG_Upload::ENABLED_KEY;
}

/** Common SVG bodies. */
function iwsl_svg_clean(): string {
	return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#f00"/></svg>';
}
function iwsl_svg_script(): string {
	return '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="5" height="5"/></svg>';
}
function iwsl_svg_onload(): string {
	return '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle cx="5" cy="5" r="4"/></svg>';
}
function iwsl_svg_js_href(): string {
	return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="javascript:alert(1)" /></svg>';
}
function iwsl_svg_foreign(): string {
	return '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject></svg>';
}
function iwsl_svg_entity(): string {
	return '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe "PWNED">]><svg xmlns="http://www.w3.org/2000/svg"><desc>&xxe;</desc></svg>';
}
function iwsl_svg_tempdir(): string {
	$dir = sys_get_temp_dir() . '/iwsl-svg-' . bin2hex( random_bytes( 6 ) );
	mkdir( $dir, 0700, true );
	return $dir;
}

$SVG_NOW = 30000000;

// ── 1. Gate blocks a lower tier: SVG mime NOT allowed, prefilter does NOT run ──

// (a) svg_upload flag ABSENT (Basic shape has only `plus`), toggle irrelevant.
$store_a = new IWSL_Memory_Store();
$store_a->set( 'state', 'active' );
$store_a->set( 'last_verified_at', $SVG_NOW - 60000 );
$store_a->set( 'entitlements', array( 'plus' => true ) ); // svg_upload absent
$store_a->set( IWSL_SVG_Upload::ENABLED_KEY, true );       // toggle on, but gate locked
$ent_a    = new IWSL_Entitlements( $store_a, static function () use ( $SVG_NOW ): int {
	return $SVG_NOW; } );
$svg_a    = new IWSL_SVG_Upload( $ent_a, $store_a );
$mimes_a  = $svg_a->filter_upload_mimes( array( 'png' => 'image/png' ) );
iwsl_assert( ! isset( $mimes_a['svg'] ), 'gate blocks (absent flag): image/svg+xml NOT added to upload_mimes' );
iwsl_assert_same( false, $svg_a->is_active(), 'gate blocks (absent flag): is_active()=false' );

// The prefilter must leave a malicious file untouched (sanitization does NOT run).
$dir_a  = iwsl_svg_tempdir();
$file_a = $dir_a . '/evil.svg';
file_put_contents( $file_a, iwsl_svg_script() );
$res_a = $svg_a->prefilter_sanitize(
	array( 'name' => 'evil.svg', 'type' => IWSL_SVG_Upload::SVG_MIME, 'tmp_name' => $file_a, 'error' => 0, 'size' => filesize( $file_a ) )
);
iwsl_assert( empty( $res_a['error'] ), 'gate blocks (absent flag): prefilter sets no error (feature off)' );
iwsl_assert( false !== strpos( (string) file_get_contents( $file_a ), '<script' ), 'gate blocks (absent flag): file NOT sanitized (script still present)' );

// (b) state != active, even WITH the flag + toggle.
$store_b = new IWSL_Memory_Store();
$store_b->set( 'state', 'pending' );
$store_b->set( 'last_verified_at', $SVG_NOW - 60000 );
$store_b->set( 'entitlements', array( 'plus' => true, 'svg_upload' => true ) );
$store_b->set( IWSL_SVG_Upload::ENABLED_KEY, true );
$svg_b = new IWSL_SVG_Upload(
	new IWSL_Entitlements( $store_b, static function () use ( $SVG_NOW ): int {
		return $SVG_NOW; } ),
	$store_b
);
iwsl_assert( ! isset( $svg_b->filter_upload_mimes( array() )['svg'] ), 'gate blocks (not active): svg mime not added despite flag' );

// (c) stale heartbeat, even WITH the flag + toggle.
$store_c = new IWSL_Memory_Store();
$store_c->set( 'state', 'active' );
$store_c->set( 'last_verified_at', $SVG_NOW - 10800000 ); // 3h ago — stale
$store_c->set( 'entitlements', array( 'plus' => true, 'svg_upload' => true ) );
$store_c->set( IWSL_SVG_Upload::ENABLED_KEY, true );
$svg_c = new IWSL_SVG_Upload(
	new IWSL_Entitlements( $store_c, static function () use ( $SVG_NOW ): int {
		return $SVG_NOW; } ),
	$store_c
);
iwsl_assert( ! isset( $svg_c->filter_upload_mimes( array() )['svg'] ), 'gate blocks (stale heartbeat): svg mime not added despite flag' );

// ── 2. Unlocked but toggle OFF (default): still not allowed ────────────────────

$store_off = new IWSL_Memory_Store(); // ENABLED_KEY unset → default off
$svg_off   = new IWSL_SVG_Upload( iwsl_svg_unlocked_entitlements( $SVG_NOW ), $store_off );
iwsl_assert_same( false, $svg_off->is_enabled(), 'toggle: default off' );
iwsl_assert_same( false, $svg_off->is_active(), 'toggle off: is_active()=false even when unlocked' );
iwsl_assert( ! isset( $svg_off->filter_upload_mimes( array() )['svg'] ), 'toggle off: svg mime not added' );

// ── 3. Unlocked AND toggle ON: svg mime allowed + filetype fixed ──────────────

$svg_on   = iwsl_svg_enabled_engine( $SVG_NOW );
$mimes_on = $svg_on->filter_upload_mimes( array( 'png' => 'image/png' ) );
iwsl_assert_same( IWSL_SVG_Upload::SVG_MIME, $mimes_on['svg'] ?? '', 'active: image/svg+xml added to upload_mimes' );
iwsl_assert_same( true, $svg_on->is_active(), 'active: is_active()=true (unlocked + enabled)' );

// wp_check_filetype_and_ext corrects the ext/type for a real .svg file.
$dir3  = iwsl_svg_tempdir();
$ft    = $dir3 . '/logo.svg';
file_put_contents( $ft, iwsl_svg_clean() );
$fixed = $svg_on->filter_check_filetype_and_ext(
	array( 'ext' => false, 'type' => false, 'proper_filename' => false ),
	$ft,
	'logo.svg',
	array(),
	'image/svg+xml'
);
iwsl_assert_same( 'svg', $fixed['ext'] ?? '', 'filetype: .svg ext asserted for a real svg' );
iwsl_assert_same( IWSL_SVG_Upload::SVG_MIME, $fixed['type'] ?? '', 'filetype: image/svg+xml type asserted' );

// ── 4. Sanitizer neutralizes scripts / handlers / js-href / foreignObject ─────
//
// DOM-ENGINE-GUARDED (mirrors the media-optimizer roundtrip): the allow-list
// sanitizer needs ext-dom. WordPress always ships it; a bare CI PHP may not. With
// no DOM the sanitizer FAILS CLOSED (refuses with `no-dom`) — which we assert — so
// no un-sanitized SVG is ever accepted. The neutralization specifics run only when
// DOMDocument is present.

$svg_has_dom = class_exists( 'DOMDocument' );

if ( $svg_has_dom ) {
	$s_script = IWSL_SVG_Upload::sanitize_svg_string( iwsl_svg_script() );
	iwsl_assert_same( true, $s_script['ok'], 'sanitize <script>: ok=true (neutralized, not refused)' );
	iwsl_assert( false === stripos( $s_script['svg'], '<script' ), 'sanitize <script>: <script> element removed' );
	iwsl_assert( false === stripos( $s_script['svg'], 'alert' ), 'sanitize <script>: script body gone' );
	iwsl_assert( false !== stripos( $s_script['svg'], '<rect' ), 'sanitize <script>: safe <rect> preserved' );

	$s_onload = IWSL_SVG_Upload::sanitize_svg_string( iwsl_svg_onload() );
	iwsl_assert_same( true, $s_onload['ok'], 'sanitize onload: ok=true' );
	iwsl_assert( false === stripos( $s_onload['svg'], 'onload' ), 'sanitize onload: on* handler stripped' );
	iwsl_assert( false !== stripos( $s_onload['svg'], '<circle' ), 'sanitize onload: safe <circle> preserved' );

	$s_href = IWSL_SVG_Upload::sanitize_svg_string( iwsl_svg_js_href() );
	iwsl_assert_same( true, $s_href['ok'], 'sanitize javascript: href: ok=true' );
	iwsl_assert( false === stripos( $s_href['svg'], 'javascript' ), 'sanitize javascript: href: unsafe href stripped' );

	$s_foreign = IWSL_SVG_Upload::sanitize_svg_string( iwsl_svg_foreign() );
	iwsl_assert_same( true, $s_foreign['ok'], 'sanitize <foreignObject>: ok=true' );
	iwsl_assert( false === stripos( $s_foreign['svg'], 'foreignobject' ), 'sanitize <foreignObject>: element removed' );
	iwsl_assert( false === stripos( $s_foreign['svg'], '<script' ), 'sanitize <foreignObject>: nested script removed with it' );
} else {
	// Fail-closed: with no DOM engine, every SVG is refused (never stored raw).
	iwsl_assert_same( 'no-dom', IWSL_SVG_Upload::sanitize_svg_string( iwsl_svg_script() )['reason'], 'sanitize (no DOM): fail-closed with no-dom' );
	echo "  [skip] SVG neutralization specifics — no ext-dom in this PHP (WordPress always has it)\n";
}

// ── 5. Sanitizer REFUSES a DOCTYPE/ENTITY (XXE / billion-laughs) ──────────────

$s_entity = IWSL_SVG_Upload::sanitize_svg_string( iwsl_svg_entity() );
iwsl_assert_same( false, $s_entity['ok'], 'sanitize DOCTYPE/ENTITY: refused (ok=false)' );
iwsl_assert_same( 'doctype-or-entity', $s_entity['reason'], 'sanitize DOCTYPE/ENTITY: reason doctype-or-entity' );
iwsl_assert_same( '', $s_entity['svg'], 'sanitize DOCTYPE/ENTITY: no bytes returned' );

// Non-SVG and empty inputs are refused too.
iwsl_assert_same( 'not-svg', IWSL_SVG_Upload::sanitize_svg_string( 'plain text, not svg' )['reason'], 'sanitize: non-svg refused (not-svg)' );
iwsl_assert_same( 'empty', IWSL_SVG_Upload::sanitize_svg_string( '   ' )['reason'], 'sanitize: empty refused (empty)' );

// ── 6. A clean SVG passes and round-trips its safe geometry ───────────────────

if ( $svg_has_dom ) {
	$s_clean = IWSL_SVG_Upload::sanitize_svg_string( iwsl_svg_clean() );
	iwsl_assert_same( true, $s_clean['ok'], 'sanitize clean: ok=true' );
	iwsl_assert( false !== stripos( $s_clean['svg'], '<svg' ), 'sanitize clean: <svg> root preserved' );
	iwsl_assert( false !== stripos( $s_clean['svg'], '<rect' ), 'sanitize clean: <rect> preserved' );
	iwsl_assert( false !== strpos( $s_clean['svg'], 'viewBox' ), 'sanitize clean: viewBox attribute preserved' );
	iwsl_assert( false === stripos( $s_clean['svg'], '<script' ), 'sanitize clean: no script introduced' );
	iwsl_assert_same( 0, $s_clean['removed'], 'sanitize clean: nothing removed from an already-clean svg' );
} else {
	echo "  [skip] SVG clean round-trip — no ext-dom in this PHP\n";
}

// ── 7. Prefilter (active): sanitizes malicious in place, refuses entity ───────

// (a) malicious svg → with DOM, sanitized in place (no error, script gone); with
//     no DOM, fail-closed (upload refused, file never stored raw).
$dir7 = iwsl_svg_tempdir();
$mal  = $dir7 . '/mal.svg';
file_put_contents( $mal, iwsl_svg_script() );
$r7a = $svg_on->prefilter_sanitize(
	array( 'name' => 'mal.svg', 'type' => IWSL_SVG_Upload::SVG_MIME, 'tmp_name' => $mal, 'error' => 0, 'size' => filesize( $mal ) )
);
if ( $svg_has_dom ) {
	iwsl_assert( empty( $r7a['error'] ), 'prefilter: clean-after-sanitize sets no error' );
	iwsl_assert( false === strpos( (string) file_get_contents( $mal ), '<script' ), 'prefilter: file rewritten without <script>' );
} else {
	iwsl_assert( ! empty( $r7a['error'] ), 'prefilter (no DOM): malicious svg refused (fail-closed)' );
}

// (b) entity svg → REFUSED via $file[error]; upload blocked.
$ent_svg = $dir7 . '/xxe.svg';
file_put_contents( $ent_svg, iwsl_svg_entity() );
$r7b = $svg_on->prefilter_sanitize(
	array( 'name' => 'xxe.svg', 'type' => IWSL_SVG_Upload::SVG_MIME, 'tmp_name' => $ent_svg, 'error' => 0, 'size' => filesize( $ent_svg ) )
);
iwsl_assert( ! empty( $r7b['error'] ), 'prefilter: DOCTYPE/entity upload refused ($file[error] set)' );

// (c) a non-svg file passes through untouched.
$png = $dir7 . '/pic.png';
file_put_contents( $png, "\x89PNG\r\n\x1a\n" );
$r7c = $svg_on->prefilter_sanitize(
	array( 'name' => 'pic.png', 'type' => 'image/png', 'tmp_name' => $png, 'error' => 0, 'size' => filesize( $png ) )
);
iwsl_assert( empty( $r7c['error'] ), 'prefilter: a non-svg upload is left untouched' );

// ── 8. Toggle handler persists via the store (gate re-checked) ────────────────
// The admin-post handler needs no WP; drive the persistence directly through the
// same store the handler writes, proving default-off then enabled semantics.

$store8 = new IWSL_Memory_Store();
$svg8   = new IWSL_SVG_Upload( iwsl_svg_unlocked_entitlements( $SVG_NOW ), $store8 );
iwsl_assert_same( false, $svg8->is_enabled(), 'toggle store: starts disabled' );
$store8->set( IWSL_SVG_Upload::ENABLED_KEY, true );
iwsl_assert_same( true, $svg8->is_enabled(), 'toggle store: reads enabled once persisted' );
iwsl_assert_same( true, $svg8->is_active(), 'toggle store: active once unlocked + enabled' );

// ── 9. purge(): teardown clears the opt-in toggle (this engine's only state) ──

// (a) cheap no-op when nothing exists: a never-configured store.
$store9_clean = new IWSL_Memory_Store();
$svg9_clean   = new IWSL_SVG_Upload( iwsl_svg_unlocked_entitlements( $SVG_NOW ), $store9_clean );
$pg9_clean    = $svg9_clean->purge();
iwsl_assert_same( 0, $pg9_clean['options'], 'purge(clean): options=0 (toggle never set)' );
iwsl_assert_same( 0, $pg9_clean['meta'], 'purge(clean): meta=0 (this engine writes no postmeta)' );
iwsl_assert_same( false, $pg9_clean['cron'], 'purge(clean): cron=false (this engine schedules none)' );

// (b) seed a real footprint: the toggle enabled.
$store9 = new IWSL_Memory_Store();
$store9->set( IWSL_SVG_Upload::ENABLED_KEY, true );
$svg9 = new IWSL_SVG_Upload( iwsl_svg_unlocked_entitlements( $SVG_NOW ), $store9 );
iwsl_assert_same( true, $svg9->is_active(), 'purge: active before teardown' );

$pg9 = $svg9->purge();
iwsl_assert_same( 1, $pg9['options'], 'purge: the enabled toggle removed' );
iwsl_assert_same( false, $pg9['cron'], 'purge: cron=false (this engine schedules none)' );
iwsl_assert_same( null, $store9->get( IWSL_SVG_Upload::ENABLED_KEY ), 'purge: toggle key gone from the store' );
iwsl_assert_same( false, $svg9->is_enabled(), 'purge: is_enabled() false again (defaults off)' );
iwsl_assert_same( false, $svg9->is_active(), 'purge: is_active() false again even though the gate is still unlocked' );

// (c) idempotent: a second call finds nothing left, reports zero.
$pg9b = $svg9->purge();
iwsl_assert_same( 0, $pg9b['options'], 'purge(idempotent): second call removes nothing' );
