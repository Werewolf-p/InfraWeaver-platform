<?php
/**
 * Speed Pack (gate flag `speed_pack`, Pro): the generic engine IWSL_Speed_Pack.
 *
 * Runs under the zero-dependency harness: IWSL_Speed_Pack takes an in-memory
 * IWSL_Store behind IWSL_Entitlements, an injected home host, an injected
 * .htaccess path (a temp file — never the repo/ABSPATH .htaccess), and a fixed
 * clock. The pure transforms (minify_html / add_defer / delay_tag /
 * strip_version_qs / build_hints / build_htaccess_block) are called directly, and
 * the gated hook callbacks are called directly so their STATEMENT 1 gate is
 * authoritative — exactly as outside a full WordPress context.
 *
 * The one WordPress concession: this suite defines recording stubs for
 * remove_action / remove_filter so the emoji/embed DEQUEUE path is observable. No
 * other suite defines or depends on those, and this suite is ordered LAST in
 * run-tests.php, so the stubs never reach another suite. They are guarded with
 * function_exists and the recorder global is unset() at the end.
 */

// ── recording stubs for the dequeue path (guarded; suite ordered last) ─────────

$GLOBALS['iwsl_sp_removed'] = array();

if ( ! function_exists( 'remove_action' ) ) {
	function remove_action( $hook, $callback, $priority = 10 ) {
		$GLOBALS['iwsl_sp_removed'][] = array( 'action', (string) $hook, (string) $callback, (int) $priority );
		return true;
	}
}
if ( ! function_exists( 'remove_filter' ) ) {
	function remove_filter( $hook, $callback, $priority = 10 ) {
		$GLOBALS['iwsl_sp_removed'][] = array( 'filter', (string) $hook, (string) $callback, (int) $priority );
		return true;
	}
}

// ── toggleable is_admin() stub (front-end/admin context switch) ─────────────────
// The front-end callbacks early-return under is_admin(); this flag lets the suite
// exercise the admin-guard branches. Default false = front-end, so every existing
// assertion below is unaffected. Guarded + suite runs last (subprocess isolation).
$GLOBALS['iwsl_is_admin'] = false;

if ( ! function_exists( 'is_admin' ) ) {
	function is_admin(): bool {
		return ! empty( $GLOBALS['iwsl_is_admin'] );
	}
}

/** Whether the recorder captured a given (type, hook, callback) removal. */
function iwsl_sp_removed_has( string $type, string $hook, string $callback ): bool {
	foreach ( $GLOBALS['iwsl_sp_removed'] as $r ) {
		if ( $r[0] === $type && $r[1] === $hook && $r[2] === $callback ) {
			return true;
		}
	}
	return false;
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A memory store seeded unlocked (active + fresh heartbeat + speed_pack). */
function iwsl_sp_unlocked_store( int $now ): IWSL_Memory_Store {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'speed_pack' => true ) );
	return $store;
}

function iwsl_sp_ent( IWSL_Store $store, int $now ): IWSL_Entitlements {
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

function iwsl_sp_tempfile(): string {
	$dir = sys_get_temp_dir() . '/iwsl-sp-' . bin2hex( random_bytes( 6 ) );
	mkdir( $dir, 0700, true );
	return $dir . '/.htaccess';
}

/** Build an engine over $store with an injected home host + temp .htaccess path. */
function iwsl_sp_engine( IWSL_Store $store, int $now, string $home = 'example.com', ?string $htaccess = null ): IWSL_Speed_Pack {
	return new IWSL_Speed_Pack(
		iwsl_sp_ent( $store, $now ),
		$store,
		$home,
		null !== $htaccess ? $htaccess : iwsl_sp_tempfile(),
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** A full all-on settings map (used to prove the gate blocks even with toggles on). */
function iwsl_sp_all_on(): array {
	return array(
		'minify_html'          => true,
		'defer_js'             => true,
		'delay_js'             => false,
		'server_headers'       => true,
		'resource_hints'       => true,
		'remove_query_strings' => true,
		'disable_emojis'       => true,
		'disable_embeds'       => true,
		'instant_page'         => true,
		'heartbeat_control'    => true,
		'heartbeat_frequency'  => 90,
		'prefetch_hosts'       => array( 'fonts.gstatic.com' ),
		'defer_exclusions'     => array(),
	);
}

$SP_NOW = 40000000;

// ── 1. Gate BLOCKS every optimization when locked (toggles ON but gate locked) ─

/** Assert that a locked engine mutates nothing and writes no .htaccess. */
function iwsl_sp_assert_gate_blocks( IWSL_Memory_Store $store, int $now, string $label ): void {
	$store->set( 'speed_pack', iwsl_sp_all_on() ); // every toggle ON…
	$ht  = iwsl_sp_tempfile();
	$eng = iwsl_sp_engine( $store, $now, 'example.com', $ht );

	// …yet no transform mutates (STATEMENT 1 gate fires before the enabled check).
	iwsl_assert_same( '  <p>a   b</p>  ', $eng->filter_final_output( '  <p>a   b</p>  ' ), $label . ': minify blocked (HTML untouched)' );
	iwsl_assert_same( '<script src="/x.js"></script>', $eng->filter_script_loader_tag( '<script src="/x.js"></script>', 'x', '/x.js' ), $label . ': defer blocked (tag untouched)' );
	iwsl_assert_same( '/a.css?ver=1', $eng->filter_loader_src( '/a.css?ver=1' ), $label . ': query-string strip blocked' );
	iwsl_assert_same( array(), $eng->filter_resource_hints( array(), 'dns-prefetch' ), $label . ': resource hints blocked' );
	iwsl_assert_same( array( 'interval' => 15 ), $eng->filter_heartbeat_settings( array( 'interval' => 15 ) ), $label . ': heartbeat throttle blocked' );

	// Dequeue path blocked: apply_cleanup does nothing.
	$GLOBALS['iwsl_sp_removed'] = array();
	$eng->apply_cleanup();
	iwsl_assert_same( 0, count( $GLOBALS['iwsl_sp_removed'] ), $label . ': emoji/embed dequeue blocked (no removals)' );

	// save_settings refused; no .htaccess written.
	$r = $eng->save_settings( iwsl_sp_all_on() );
	iwsl_assert_same( 'entitlement-locked', $r['reason'], $label . ': save_settings entitlement-locked' );
	iwsl_assert( ! is_file( $ht ), $label . ': NO .htaccess block written while locked' );
}

// (a) flag absent.
$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $SP_NOW - 60000 );
$store->set( 'entitlements', array( 'plus' => true ) ); // speed_pack ABSENT
iwsl_sp_assert_gate_blocks( $store, $SP_NOW, 'gate (flag absent)' );

// (b) state != active, even with the flag true.
$store = new IWSL_Memory_Store();
$store->set( 'state', 'pending' );
$store->set( 'last_verified_at', $SP_NOW - 60000 );
$store->set( 'entitlements', array( 'speed_pack' => true ) );
iwsl_sp_assert_gate_blocks( $store, $SP_NOW, 'gate (not active)' );

// (c) stale heartbeat, even with the flag true.
$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $SP_NOW - 10800000 ); // 3h — stale
$store->set( 'entitlements', array( 'speed_pack' => true ) );
iwsl_sp_assert_gate_blocks( $store, $SP_NOW, 'gate (stale heartbeat)' );

// ── 2. Minify HTML: collapse whitespace, preserve protected regions ────────────

iwsl_assert_same( '<p>a b</p>', IWSL_Speed_Pack::minify_html( '  <p>a   b</p>  ' ), 'minify: collapses runs + trims to <p>a b</p>' );
iwsl_assert_same( '<pre>a   b</pre>', IWSL_Speed_Pack::minify_html( '<pre>a   b</pre>' ), 'minify: <pre> whitespace preserved byte-for-byte' );
$scripted = IWSL_Speed_Pack::minify_html( '<div>  x  </div><script>var a =   1;</script>' );
iwsl_assert( false !== strpos( $scripted, 'var a =   1;' ), 'minify: <script> body preserved byte-for-byte' );
iwsl_assert( false !== strpos( $scripted, '<div> x </div>' ), 'minify: surrounding markup still collapsed' );
iwsl_assert_same( 'XY', IWSL_Speed_Pack::minify_html( 'X<!-- a comment -->Y' ), 'minify: HTML comment stripped' );
$cond = IWSL_Speed_Pack::minify_html( 'A<!--[if IE]><b>x</b><![endif]-->B' );
iwsl_assert( false !== strpos( $cond, '<!--[if IE]>' ), 'minify: IE conditional comment preserved' );
// a `>` inside a quoted attribute on the opening tag must not truncate the
// protected region: the whole <code> block survives minify byte-for-byte.
$quoted = IWSL_Speed_Pack::minify_html( '<div>  a  </div><code data-x="a>b">keep   me</code>' );
iwsl_assert( false !== strpos( $quoted, '<code data-x="a>b">keep   me</code>' ), 'minify: <code> with >-bearing attr preserved intact' );
iwsl_assert( false !== strpos( $quoted, '<div> a </div>' ), 'minify: markup around the quoted-attr region still collapsed' );

// via the gated output-buffer callback when unlocked + toggle on.
$store = iwsl_sp_unlocked_store( $SP_NOW );
$store->set( 'speed_pack', array( 'minify_html' => true ) );
$eng = iwsl_sp_engine( $store, $SP_NOW );
iwsl_assert_same( '<p>a b</p>', $eng->filter_final_output( '  <p>a   b</p>  ' ), 'minify: filter_final_output collapses when unlocked' );

// ── 3. Defer JS: local scripts get defer; exclusions + third-party skipped ─────

iwsl_assert(
	false !== strpos( IWSL_Speed_Pack::add_defer( '<script src="/app.js"></script>', '/app.js', array(), 'example.com' ), '<script defer' ),
	'defer: root-relative local script gets defer'
);
iwsl_assert(
	false !== strpos( IWSL_Speed_Pack::add_defer( '<script src="https://example.com/a.js"></script>', 'https://example.com/a.js', array(), 'example.com' ), '<script defer' ),
	'defer: same-host absolute script gets defer'
);
iwsl_assert_same(
	'<script src="/jquery.js"></script>',
	IWSL_Speed_Pack::add_defer( '<script src="/jquery.js"></script>', '/jquery.js', array( 'jquery' ), 'example.com' ),
	'defer: excluded script untouched'
);
iwsl_assert_same(
	'<script src="https://cdn.other.com/a.js"></script>',
	IWSL_Speed_Pack::add_defer( '<script src="https://cdn.other.com/a.js"></script>', 'https://cdn.other.com/a.js', array(), 'example.com' ),
	'defer: third-party script untouched (local-only)'
);
iwsl_assert_same(
	'<script defer src="/a.js"></script>',
	IWSL_Speed_Pack::add_defer( '<script defer src="/a.js"></script>', '/a.js', array(), 'example.com' ),
	'defer: already-deferred tag untouched (no double defer)'
);

// via the gated callback when unlocked + defer toggle on.
$store = iwsl_sp_unlocked_store( $SP_NOW );
$store->set( 'speed_pack', array( 'defer_js' => true ) );
$eng = iwsl_sp_engine( $store, $SP_NOW );
iwsl_assert( false !== strpos( $eng->filter_script_loader_tag( '<script src="/app.js"></script>', 'app', '/app.js' ), ' defer' ), 'defer: filter_script_loader_tag adds defer when unlocked' );

// ── 4. Delay JS: local script parked under placeholder type; precedence ────────

$delayed = IWSL_Speed_Pack::delay_tag( '<script src="/a.js"></script>', '/a.js', array(), 'example.com' );
iwsl_assert( false !== strpos( $delayed, 'type="iwsl-delay"' ), 'delay: type injected on a local script' );
$reyped = IWSL_Speed_Pack::delay_tag( '<script type="text/javascript" src="/a.js"></script>', '/a.js', array(), 'example.com' );
iwsl_assert( false !== strpos( $reyped, 'type="iwsl-delay"' ) && false === strpos( $reyped, 'text/javascript' ), 'delay: existing type swapped to placeholder' );
iwsl_assert_same(
	'<script src="https://cdn.other.com/a.js"></script>',
	IWSL_Speed_Pack::delay_tag( '<script src="https://cdn.other.com/a.js"></script>', 'https://cdn.other.com/a.js', array(), 'example.com' ),
	'delay: third-party script untouched'
);
// precedence: with both delay + defer on, delay wins for a local script.
$store = iwsl_sp_unlocked_store( $SP_NOW );
$store->set( 'speed_pack', array( 'delay_js' => true, 'defer_js' => true ) );
$eng = iwsl_sp_engine( $store, $SP_NOW );
iwsl_assert( false !== strpos( $eng->filter_script_loader_tag( '<script src="/a.js"></script>', 'a', '/a.js' ), 'type="iwsl-delay"' ), 'delay: takes precedence over defer when both on' );

// ── 5. Remove query strings: strip only the ver cache-buster ───────────────────

iwsl_assert_same( '/a.css', IWSL_Speed_Pack::strip_version_qs( '/a.css?ver=6.4' ), 'qs: ?ver= removed entirely' );
iwsl_assert_same( '/a.js?foo=2', IWSL_Speed_Pack::strip_version_qs( '/a.js?ver=1&foo=2' ), 'qs: ver removed, other params kept' );
iwsl_assert_same( '/a.js?foo=2', IWSL_Speed_Pack::strip_version_qs( '/a.js?foo=2' ), 'qs: URL without ver unchanged' );
iwsl_assert_same( '/a.css#hash', IWSL_Speed_Pack::strip_version_qs( '/a.css?ver=1#hash' ), 'qs: fragment preserved after strip' );

$store = iwsl_sp_unlocked_store( $SP_NOW );
$store->set( 'speed_pack', array( 'remove_query_strings' => true ) );
$eng = iwsl_sp_engine( $store, $SP_NOW );
iwsl_assert_same( '/style.css', $eng->filter_loader_src( '/style.css?ver=1.0' ), 'qs: filter_loader_src strips ver when unlocked' );

// ── 6. Resource hints: dns-prefetch // + preconnect https://, no dup ───────────

iwsl_assert_same( array( '//fonts.gstatic.com' ), IWSL_Speed_Pack::build_hints( array(), 'dns-prefetch', array( 'fonts.gstatic.com' ) ), 'hints: dns-prefetch gets //host' );
iwsl_assert_same( array( 'https://fonts.gstatic.com' ), IWSL_Speed_Pack::build_hints( array(), 'preconnect', array( 'fonts.gstatic.com' ) ), 'hints: preconnect gets https://host' );
iwsl_assert_same( array( '//x' ), IWSL_Speed_Pack::build_hints( array( '//x' ), 'dns-prefetch', array( 'x' ) ), 'hints: no duplicate entry added' );
iwsl_assert_same( array(), IWSL_Speed_Pack::build_hints( array(), 'prefetch', array( 'x' ) ), 'hints: unrelated relation passes through untouched' );

$store = iwsl_sp_unlocked_store( $SP_NOW );
$store->set( 'speed_pack', array( 'resource_hints' => true, 'prefetch_hosts' => array( 'cdn.example.com' ) ) );
$eng = iwsl_sp_engine( $store, $SP_NOW );
iwsl_assert_same( array( '//cdn.example.com' ), $eng->filter_resource_hints( array(), 'dns-prefetch' ), 'hints: filter_resource_hints adds host when unlocked' );

// ── 7. Heartbeat throttle: interval clamped to the configured frequency ────────

$store = iwsl_sp_unlocked_store( $SP_NOW );
$store->set( 'speed_pack', array( 'heartbeat_control' => true, 'heartbeat_frequency' => 90 ) );
$eng = iwsl_sp_engine( $store, $SP_NOW );
$hb  = $eng->filter_heartbeat_settings( array( 'interval' => 15 ) );
iwsl_assert_same( 90, $hb['interval'], 'heartbeat: interval set to configured 90s when unlocked' );
iwsl_assert_same( 120, IWSL_Speed_Pack::clamp_heartbeat( 9999 ), 'heartbeat: clamp caps at 120' );
iwsl_assert_same( 15, IWSL_Speed_Pack::clamp_heartbeat( 1 ), 'heartbeat: clamp floors at 15' );

// ── 8. Emoji / embed dequeue: correct tables + gated invocation ────────────────

$emoji = IWSL_Speed_Pack::emoji_removals();
iwsl_assert( in_array( array( 'action', 'wp_head', 'print_emoji_detection_script', 7 ), $emoji, true ), 'emoji table: print_emoji_detection_script on wp_head @7' );
$embed = IWSL_Speed_Pack::embed_removals();
iwsl_assert( in_array( array( 'action', 'wp_head', 'wp_oembed_add_discovery_links', 10 ), $embed, true ), 'embed table: wp_oembed_add_discovery_links on wp_head @10' );

$store = iwsl_sp_unlocked_store( $SP_NOW );
$store->set( 'speed_pack', array( 'disable_emojis' => true, 'disable_embeds' => true ) );
$eng = iwsl_sp_engine( $store, $SP_NOW );
$GLOBALS['iwsl_sp_removed'] = array();
$eng->apply_cleanup();
iwsl_assert( iwsl_sp_removed_has( 'action', 'wp_head', 'print_emoji_detection_script' ), 'dequeue: emoji detection script removed from wp_head' );
iwsl_assert( iwsl_sp_removed_has( 'filter', 'the_content_feed', 'wp_staticize_emoji' ), 'dequeue: emoji staticize filter removed' );
iwsl_assert( iwsl_sp_removed_has( 'action', 'wp_head', 'wp_oembed_add_discovery_links' ), 'dequeue: oEmbed discovery links removed from wp_head' );

// ── 9. .htaccess block: IfModule-guarded compression + cache directives ────────

$block = IWSL_Speed_Pack::build_htaccess_block();
iwsl_assert( false !== strpos( $block, '# BEGIN InfraWeaver Speed Pack' ), 'htaccess: distinct BEGIN marker' );
iwsl_assert( false !== strpos( $block, '# END InfraWeaver Speed Pack' ), 'htaccess: distinct END marker' );
iwsl_assert( false !== strpos( $block, '<IfModule mod_deflate.c>' ), 'htaccess: mod_deflate IfModule guard' );
iwsl_assert( false !== strpos( $block, '<IfModule mod_brotli.c>' ), 'htaccess: mod_brotli IfModule guard' );
iwsl_assert( false !== strpos( $block, '<IfModule mod_expires.c>' ), 'htaccess: mod_expires IfModule guard' );
iwsl_assert( false !== strpos( $block, '<IfModule mod_headers.c>' ), 'htaccess: mod_headers IfModule guard' );
iwsl_assert( false !== strpos( $block, 'AddOutputFilterByType DEFLATE' ), 'htaccess: DEFLATE compression directive' );

// ── 10. Server config write on enable + presence teardown on revoke ────────────

$store = iwsl_sp_unlocked_store( $SP_NOW );
$ht    = iwsl_sp_tempfile();
$eng   = iwsl_sp_engine( $store, $SP_NOW, 'example.com', $ht );
$r     = $eng->save_settings( array( 'server_headers' => true ) );
iwsl_assert_same( true, $r['ok'], 'server: save ok' );
iwsl_assert_same( true, $r['server_config']['written'], 'server: .htaccess block written on enable' );
iwsl_assert( is_file( $ht ) && false !== strpos( (string) file_get_contents( $ht ), '# BEGIN InfraWeaver Speed Pack' ), 'server: block present in .htaccess' );
iwsl_assert_same( true, $store->get( 'speed_pack_htaccess_written' ), 'server: written flag set' );

// console revokes → maybe_revoke tears the block down.
$store->set( 'entitlements', array( 'speed_pack' => false ) );
$eng->maybe_revoke();
iwsl_assert( false === strpos( (string) file_get_contents( $ht ), '# BEGIN InfraWeaver Speed Pack' ), 'server: block torn down after revoke' );
iwsl_assert_same( false, $store->get( 'speed_pack_htaccess_written' ), 'server: written flag cleared after revoke' );

// existing content is preserved: our block is PREPENDED, original backed up.
$store2 = iwsl_sp_unlocked_store( $SP_NOW );
$ht2    = iwsl_sp_tempfile();
$original = "# BEGIN WordPress\nRewriteEngine On\n# END WordPress\n";
file_put_contents( $ht2, $original );
$eng2 = iwsl_sp_engine( $store2, $SP_NOW, 'example.com', $ht2 );
$eng2->save_settings( array( 'server_headers' => true ) );
$after = (string) file_get_contents( $ht2 );
iwsl_assert( 0 === strpos( $after, '# BEGIN InfraWeaver Speed Pack' ), 'server: our block prepended above WordPress markers' );
iwsl_assert( false !== strpos( $after, '# BEGIN WordPress' ), 'server: WordPress block preserved' );
iwsl_assert( is_file( $ht2 . '.iwsl.bak' ) && $original === (string) file_get_contents( $ht2 . '.iwsl.bak' ), 'server: original backed up to .iwsl.bak' );

// unwritable target → non-fatal, manual_step surfaced, ok stays true.
$store3 = iwsl_sp_unlocked_store( $SP_NOW );
$missing = sys_get_temp_dir() . '/iwsl-sp-nope-' . bin2hex( random_bytes( 4 ) ) . '/deeper/.htaccess';
$eng3 = iwsl_sp_engine( $store3, $SP_NOW, 'example.com', $missing );
$r3   = $eng3->save_settings( array( 'server_headers' => true ) );
iwsl_assert_same( true, $r3['ok'], 'server unwritable: save still ok (no fatal)' );
iwsl_assert_same( false, $r3['server_config']['written'], 'server unwritable: not written' );
iwsl_assert( isset( $r3['server_config']['manual_step'] ), 'server unwritable: manual_step surfaced' );
iwsl_assert( ! is_file( $missing ), 'server unwritable: no file created' );

// ── 11. Fail-safe: a throwing transform returns the original input ─────────────

iwsl_assert_same(
	'<b>keep me</b>',
	IWSL_Speed_Pack::guard( '<b>keep me</b>', static function ( string $s ): string {
		throw new RuntimeException( 'boom' );
	} ),
	'fail-safe: a throwing transform returns the original bytes'
);
iwsl_assert_same(
	'KEEP',
	IWSL_Speed_Pack::guard( 'KEEP', static function () {
		return 12345; // non-string result
	} ),
	'fail-safe: a non-string result returns the original bytes'
);

// ── 12. Settings persist + validate at the boundary ────────────────────────────

$store = iwsl_sp_unlocked_store( $SP_NOW );
$eng   = iwsl_sp_engine( $store, $SP_NOW );
$eng->save_settings(
	array(
		'minify_html'         => true,
		'heartbeat_frequency' => 5, // below min → clamped to 15
		'prefetch_hosts'      => "Fonts.GStatic.com\nbad host!\ncdn.example.com\nfonts.gstatic.com",
		'defer_exclusions'    => "jquery\njquery\n/wp-includes/",
	)
);
$saved = $eng->settings();
iwsl_assert_same( true, $saved['minify_html'], 'settings: minify_html persisted true' );
iwsl_assert_same( false, $saved['defer_js'], 'settings: omitted toggle defaults false' );
iwsl_assert_same( 15, $saved['heartbeat_frequency'], 'settings: heartbeat_frequency clamped up to 15' );
iwsl_assert_same( array( 'fonts.gstatic.com', 'cdn.example.com' ), $saved['prefetch_hosts'], 'settings: hosts lowercased, invalid dropped, deduped' );
iwsl_assert_same( array( 'jquery', '/wp-includes/' ), $saved['defer_exclusions'], 'settings: exclusions deduped + trimmed' );

// defence-in-depth: a DB-tampered option is re-validated on read.
$store->set( 'speed_pack', array( 'heartbeat_frequency' => 99999, 'prefetch_hosts' => array( 'ok.com', 'no good host' ) ) );
$reread = $eng->settings();
iwsl_assert_same( 120, $reread['heartbeat_frequency'], 'settings: tampered frequency re-clamped on read' );
iwsl_assert_same( array( 'ok.com' ), $reread['prefetch_hosts'], 'settings: tampered host list re-validated on read' );

// ── 13. Admin guard: front-end transforms never mangle wp-admin assets ─────────

$store = iwsl_sp_unlocked_store( $SP_NOW );
$store->set( 'speed_pack', array( 'delay_js' => true, 'defer_js' => true, 'remove_query_strings' => true ) );
$eng = iwsl_sp_engine( $store, $SP_NOW );

// (a) in wp-admin: script tag returned verbatim — no iwsl-delay type, no injected
//     defer — even with BOTH delay_js and defer_js enabled (else block-editor JS bricks).
$GLOBALS['iwsl_is_admin'] = true;
$admin_tag = '<script src="/wp-admin/x.js"></script>';
iwsl_assert_same(
	$admin_tag,
	$eng->filter_script_loader_tag( $admin_tag, 'x', '/wp-admin/x.js' ),
	'admin guard: filter_script_loader_tag returns tag verbatim in wp-admin (no delay/defer)'
);

// (b) in wp-admin: loader src keeps its ?ver= cache-buster (else stale admin assets).
iwsl_assert_same(
	'/wp-admin/a.css?ver=6.4',
	$eng->filter_loader_src( '/wp-admin/a.css?ver=6.4' ),
	'admin guard: filter_loader_src keeps ?ver= in wp-admin'
);

// (c) front-end (is_admin false): same engine + settings, transforms STILL apply.
$GLOBALS['iwsl_is_admin'] = false;
iwsl_assert(
	false !== strpos( $eng->filter_script_loader_tag( '<script src="/a.js"></script>', 'a', '/a.js' ), 'type="iwsl-delay"' ),
	'admin guard: front-end still delays local scripts when is_admin false'
);
iwsl_assert_same(
	'/style.css',
	$eng->filter_loader_src( '/style.css?ver=1.0' ),
	'admin guard: front-end still strips ?ver= when is_admin false'
);

// ── 14. purge(): full teardown — .htaccess block + BOTH option keys ───────────

// (a) fully configured: purge() strips the block and deletes both keys.
$store_p = iwsl_sp_unlocked_store( $SP_NOW );
$ht_p    = iwsl_sp_tempfile();
$eng_p   = iwsl_sp_engine( $store_p, $SP_NOW, 'example.com', $ht_p );
$eng_p->save_settings( array( 'minify_html' => true, 'server_headers' => true ) );
iwsl_assert( false !== strpos( (string) file_get_contents( $ht_p ), '# BEGIN InfraWeaver Speed Pack' ), 'purge setup: block present before purge' );

$pp = $eng_p->purge();
iwsl_assert_same( true, $pp['ok'], 'purge: ok' );
iwsl_assert_same( true, $pp['removed'], 'purge: htaccess block removed flag true' );
iwsl_assert_same( true, $pp['settings_deleted'], 'purge: settings_deleted true (a map existed)' );
iwsl_assert( false === strpos( (string) file_get_contents( $ht_p ), '# BEGIN InfraWeaver Speed Pack' ), 'purge: .htaccess block stripped' );
iwsl_assert_same( null, $store_p->get( 'speed_pack', null ), 'purge: settings option key truly absent' );
iwsl_assert_same( null, $store_p->get( 'speed_pack_htaccess_written', null ), 'purge: htaccess-written flag key deleted' );
iwsl_assert_same( array(), $eng_p->settings()['prefetch_hosts'], 'purge: a fresh settings() read falls back to defaults' );

// (b) idempotent + cheap no-op when already clean.
$pp2 = $eng_p->purge();
iwsl_assert_same( true, $pp2['ok'], 'purge: second call still ok (idempotent)' );
iwsl_assert_same( false, $pp2['removed'], 'purge: second call reports nothing removed' );
iwsl_assert_same( false, $pp2['settings_deleted'], 'purge: second call reports no settings to delete' );

// (c) a fresh, never-configured engine: purge() is a clean no-op.
$store_f = iwsl_sp_unlocked_store( $SP_NOW );
$eng_f   = iwsl_sp_engine( $store_f, $SP_NOW );
$pf      = $eng_f->purge();
iwsl_assert_same( true, $pf['ok'], 'purge (never configured): ok' );
iwsl_assert_same( false, $pf['removed'], 'purge (never configured): nothing removed' );
iwsl_assert_same( false, $pf['settings_deleted'], 'purge (never configured): no settings existed' );

// ── cleanup: unset the recorder global we installed ────────────────────────────

unset( $GLOBALS['iwsl_sp_removed'] );
unset( $GLOBALS['iwsl_is_admin'] );
