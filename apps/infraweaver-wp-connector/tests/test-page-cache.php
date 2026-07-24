<?php
/**
 * Page Cache (gate flag `page_cache`): the controller (IWSL_Page_Cache) + the
 * pure serve/store decision helpers (iwsl-page-cache-helpers.php).
 *
 * Runs under the zero-dependency harness: IWSL_Page_Cache takes an injected
 * content dir (a temp dir), an injected wp-config path (a temp file), a memory
 * store behind IWSL_Entitlements, and a fixed clock. The pure helpers are called
 * directly with injected $server / $cookies / header arrays. No WordPress fs or
 * url helpers are defined here, so the controller's LOCAL realpath containment,
 * signature and wp-config logic are authoritative — exactly as outside WP.
 */

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A memory store seeded unlocked (active + fresh heartbeat + page_cache). */
function iwsl_pc_unlocked_store( int $now ): IWSL_Memory_Store {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'page_cache' => true ) );
	return $store;
}

function iwsl_pc_ent( IWSL_Store $store, int $now ): IWSL_Entitlements {
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

function iwsl_pc_clock( int $now ): callable {
	return static function () use ( $now ): int {
		return $now;
	};
}

function iwsl_pc_tempdir(): string {
	$dir = sys_get_temp_dir() . '/iwsl-pc-' . bin2hex( random_bytes( 6 ) );
	mkdir( $dir, 0700, true );
	return $dir;
}

/** Write a realistic minimal wp-config.php and return its path. */
function iwsl_pc_write_config( string $content_dir ): string {
	$path = $content_dir . '/wp-config.php';
	$body = "<?php\n"
		. "\$table_prefix = 'wp_';\n"
		. "define( 'DB_NAME', 'wp' );\n"
		. "/* That's all, stop editing! Happy publishing. */\n"
		. "require_once ABSPATH . 'wp-settings.php';\n";
	file_put_contents( $path, $body );
	return $path;
}

/** A base $server array for a clean anonymous GET. */
function iwsl_pc_server( array $over = array() ): array {
	return array_merge(
		array(
			'REQUEST_METHOD' => 'GET',
			'REQUEST_URI'    => '/hello-world',
			'QUERY_STRING'   => '',
		),
		$over
	);
}

$PC_NOW = 30000000;

// ── 1. Gate: lower tier cannot enable; revoke tears the drop-in down ───────────

// (a) flag absent.
$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$store   = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $PC_NOW - 60000 );
$store->set( 'entitlements', array( 'plus' => true ) ); // page_cache ABSENT
$pc = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ) );
$r  = $pc->enable();
iwsl_assert_same( false, $r['ok'], 'gate (flag absent): enable ok=false' );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'gate (flag absent): entitlement-locked' );
iwsl_assert( ! is_file( $content . '/advanced-cache.php' ), 'gate (flag absent): NO drop-in written' );

// (b) state != active, even with the flag true.
$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$store   = new IWSL_Memory_Store();
$store->set( 'state', 'pending' );
$store->set( 'last_verified_at', $PC_NOW - 60000 );
$store->set( 'entitlements', array( 'page_cache' => true ) );
$pc = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ) );
$r  = $pc->enable();
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'gate (not active): entitlement-locked despite flag' );
iwsl_assert( ! is_file( $content . '/advanced-cache.php' ), 'gate (not active): NO drop-in written' );

// (c) stale heartbeat, even with the flag true.
$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$store   = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $PC_NOW - 10800000 ); // 3h — stale
$store->set( 'entitlements', array( 'page_cache' => true ) );
$pc = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ) );
$r  = $pc->enable();
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'gate (stale heartbeat): entitlement-locked despite flag' );
iwsl_assert( ! is_file( $content . '/advanced-cache.php' ), 'gate (stale heartbeat): NO drop-in written' );

// (d) all three granted → enable writes the drop-in + cache dir.
$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$store   = iwsl_pc_unlocked_store( $PC_NOW );
$pc      = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ) );
$r       = $pc->enable();
iwsl_assert_same( true, $r['ok'], 'gate (unlocked): enable ok=true' );
iwsl_assert( is_file( $content . '/advanced-cache.php' ), 'gate (unlocked): drop-in written' );
iwsl_assert( is_dir( $content . '/cache/iwsl' ), 'gate (unlocked): contained cache dir created' );
$head = (string) file_get_contents( $content . '/advanced-cache.php' );
iwsl_assert( false !== strpos( $head, 'signature: iwsl-page-cache' ), 'gate (unlocked): drop-in carries our signature' );

// (e) revoke → maybe_revoke() tears the drop-in down + purges.
mkdir( $content . '/cache/iwsl', 0755, true );
file_put_contents( $content . '/cache/iwsl/' . str_repeat( 'a', 40 ) . '.html', 'cached page' );
$store->set( 'entitlements', array( 'page_cache' => false ) ); // console revokes
$pc->maybe_revoke();
iwsl_assert( ! is_file( $content . '/advanced-cache.php' ), 'revoke: our drop-in torn down' );
$left = glob( $content . '/cache/iwsl/*.html' );
iwsl_assert_same( 0, is_array( $left ) ? count( $left ) : 0, 'revoke: cache dir purged' );

// ── 2. iwsl_pc_is_cacheable: the safe-by-default serve gauntlet ────────────────

iwsl_assert_same( true, iwsl_pc_is_cacheable( iwsl_pc_server(), array() ), 'cacheable: clean anonymous GET / → true' );

// Each of the SIX cookie patterns bypasses (the critical logged-in-leak gate).
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server(), array( 'wordpress_logged_in_abc123' => 'x' ) ), 'cacheable: wordpress_logged_in_* bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server(), array( 'wp-postpass_9a8b' => 'x' ) ), 'cacheable: wp-postpass_* bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server(), array( 'comment_author_deadbeef' => 'x' ) ), 'cacheable: comment_author_* bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server(), array( 'wp_woocommerce_session_1' => 'x' ) ), 'cacheable: wp_woocommerce_session_* bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server(), array( 'woocommerce_items_in_cart' => '1' ) ), 'cacheable: woocommerce_items_in_cart bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server(), array( 'woocommerce_cart_hash' => 'abc' ) ), 'cacheable: woocommerce_cart_hash bypasses' );
// An unrelated cookie does NOT bypass.
iwsl_assert_same( true, iwsl_pc_is_cacheable( iwsl_pc_server(), array( '_ga' => 'GA1.2' ) ), 'cacheable: an analytics cookie does NOT bypass' );

// Method / query / endpoint / traversal bypasses.
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_METHOD' => 'POST' ) ), array() ), 'cacheable: POST bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_METHOD' => 'HEAD' ) ), array() ), 'cacheable: HEAD bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/p?utm=x', 'QUERY_STRING' => 'utm=x' ) ), array() ), 'cacheable: query string bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/wp-admin/admin-ajax.php' ) ), array() ), 'cacheable: admin-ajax.php bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/wp-json/wp/v2/posts' ) ), array() ), 'cacheable: /wp-json bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/wp-login.php' ) ), array() ), 'cacheable: wp-login.php bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/xmlrpc.php' ) ), array() ), 'cacheable: xmlrpc.php bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/blog/feed' ) ), array() ), 'cacheable: feed bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/robots.txt' ) ), array() ), 'cacheable: robots.txt bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/sitemap.xml' ) ), array() ), 'cacheable: sitemap.xml bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/wp-sitemap_index.xml' ) ), array() ), 'cacheable: sitemap_index.xml bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/../etc/passwd' ) ), array() ), 'cacheable: traversal (..) bypasses' );
iwsl_assert_same( false, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/x%00y' ) ), array() ), 'cacheable: NUL byte in path bypasses' );
iwsl_assert_same( true, iwsl_pc_is_cacheable( iwsl_pc_server( array( 'REQUEST_URI' => '/feedback' ) ), array() ), 'cacheable: /feedback is NOT a feed (no false bypass)' );

// ── 3. iwsl_pc_cache_key: stable, contained, no raw path bytes ─────────────────

$k = iwsl_pc_cache_key( 'https', 'Example.com', '/Some/Path/' );
iwsl_assert_same( 1, preg_match( '/^[0-9a-f]{40}$/', $k ), 'cache_key: 40-hex sha1 shape' );
iwsl_assert( false === strpos( $k, 'Path' ) && false === strpos( $k, 'Some' ), 'cache_key: no raw path bytes in the value' );
iwsl_assert_same(
	iwsl_pc_cache_key( 'https', 'example.com', '/path' ),
	iwsl_pc_cache_key( 'https', 'example.com', '/path/' ),
	'cache_key: trailing-slash-insensitive'
);
iwsl_assert_same(
	iwsl_pc_cache_key( 'https', 'Example.com', '/p' ),
	iwsl_pc_cache_key( 'https', 'example.com', '/p' ),
	'cache_key: host case-insensitive'
);
iwsl_assert( iwsl_pc_cache_key( 'http', 'a.com', '/x' ) !== iwsl_pc_cache_key( 'https', 'a.com', '/x' ), 'cache_key: distinct per scheme' );
iwsl_assert( iwsl_pc_cache_key( 'https', 'a.com', '/x' ) !== iwsl_pc_cache_key( 'https', 'b.com', '/x' ), 'cache_key: distinct per host' );
iwsl_assert( iwsl_pc_cache_key( 'https', 'a.com', '/x' ) !== iwsl_pc_cache_key( 'https', 'a.com', '/y' ), 'cache_key: distinct per path' );
iwsl_assert_same( iwsl_pc_cache_key( 'https', 'a.com', '/' ), iwsl_pc_cache_key( 'https', 'a.com', '' ), 'cache_key: root path is deterministic' );

// ── 4. Drop-in signature: only OUR drop-in is ever removed ─────────────────────

// A foreign advanced-cache.php (no signature) survives enable / disable / revoke.
$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$foreign = "<?php\n/* WP Rocket / Super Cache — someone else's drop-in */\nreturn;\n";
file_put_contents( $content . '/advanced-cache.php', $foreign );
$store = iwsl_pc_unlocked_store( $PC_NOW );
$pc    = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ) );

$r = $pc->enable();
iwsl_assert_same( 'dropin-conflict', $r['reason'], 'signature: enable refuses a foreign drop-in (never overwrites a competitor)' );
iwsl_assert_same( $foreign, (string) file_get_contents( $content . '/advanced-cache.php' ), 'signature: foreign drop-in bytes untouched by enable' );

$d = $pc->disable();
iwsl_assert_same( 'foreign-dropin', $d['reason'], 'signature: disable refuses a foreign drop-in' );
iwsl_assert_same( $foreign, (string) file_get_contents( $content . '/advanced-cache.php' ), 'signature: foreign drop-in bytes untouched by disable' );

$store->set( 'entitlements', array( 'page_cache' => false ) );
$pc->maybe_revoke();
iwsl_assert_same( $foreign, (string) file_get_contents( $content . '/advanced-cache.php' ), 'signature: foreign drop-in survives maybe_revoke byte-identical' );

// Our OWN drop-in is removed by disable().
$content2 = iwsl_pc_tempdir();
$config2  = iwsl_pc_write_config( $content2 );
$pc2      = new IWSL_Page_Cache( iwsl_pc_ent( iwsl_pc_unlocked_store( $PC_NOW ), $PC_NOW ), $content2, $config2, iwsl_pc_clock( $PC_NOW ) );
$pc2->enable();
iwsl_assert( is_file( $content2 . '/advanced-cache.php' ), 'signature: our drop-in present after enable' );
$d2 = $pc2->disable();
iwsl_assert_same( true, $d2['ok'], 'signature: disable ok on our drop-in' );
iwsl_assert_same( true, $d2['removed'], 'signature: our drop-in removed flag set' );
iwsl_assert( ! is_file( $content2 . '/advanced-cache.php' ), 'signature: our drop-in gone after disable' );

// ── 5. wp-config editor: idempotent, backed up, non-fatal, surgical removal ────

$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$orig    = (string) file_get_contents( $config );
$store   = iwsl_pc_unlocked_store( $PC_NOW );
$pc      = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ) );

$r1 = $pc->enable();
iwsl_assert_same( true, $r1['wp_config_written'], 'wp-config: WP_CACHE inserted on first enable' );
$after1 = (string) file_get_contents( $config );
iwsl_assert_same( 1, substr_count( $after1, "define( 'WP_CACHE', true )" ), 'wp-config: exactly one WP_CACHE define after first enable' );
iwsl_assert( is_file( $config . '.iwsl.bak' ), 'wp-config: .iwsl.bak backup created' );
iwsl_assert_same( $orig, (string) file_get_contents( $config . '.iwsl.bak' ), 'wp-config: backup holds the original bytes' );

// Second enable: drop-in is ours, define already present → no duplicate.
$r2 = $pc->enable();
iwsl_assert_same( true, $r2['ok'], 'wp-config: second enable still ok' );
iwsl_assert_same( false, $r2['wp_config_written'], 'wp-config: second enable does not rewrite (already defined)' );
$after2 = (string) file_get_contents( $config );
iwsl_assert_same( 1, substr_count( $after2, "define( 'WP_CACHE', true )" ), 'wp-config: still exactly one define (idempotent)' );

// Removal strips ONLY our marker line, leaves everything else intact.
$pc->disable();
$after3 = (string) file_get_contents( $config );
iwsl_assert( false === strpos( $after3, '// iwsl-page-cache' ), 'wp-config: disable strips our marker line' );
iwsl_assert( false !== strpos( $after3, "\$table_prefix = 'wp_';" ), 'wp-config: disable leaves table_prefix intact' );
iwsl_assert( false !== strpos( $after3, "stop editing" ), 'wp-config: disable leaves the stop-editing marker intact' );

// Not-writable / unreachable wp-config → enable still ok, manual_step surfaced, no fatal.
$content = iwsl_pc_tempdir();
$missing = $content . '/no-such-subdir/wp-config.php'; // parent dir absent → cannot write
$store   = iwsl_pc_unlocked_store( $PC_NOW );
$pc      = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $missing, iwsl_pc_clock( $PC_NOW ) );
$r       = $pc->enable();
iwsl_assert_same( true, $r['ok'], 'wp-config unwritable: enable still ok (no fatal)' );
iwsl_assert_same( false, $r['wp_config_written'], 'wp-config unwritable: not written' );
iwsl_assert( isset( $r['manual_step'] ) && false !== strpos( $r['manual_step'], 'WP_CACHE' ), 'wp-config unwritable: manual_step surfaced' );
iwsl_assert( is_file( $content . '/advanced-cache.php' ), 'wp-config unwritable: drop-in still written (stays inert until WP_CACHE set)' );

// ── 6. Purge: contained files only; sibling untouched; symlink not followed ────

$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$dir     = $content . '/cache/iwsl';
mkdir( $dir, 0755, true );
$k1 = str_repeat( 'a', 40 );
$k2 = str_repeat( 'b', 40 );
file_put_contents( $dir . '/' . $k1 . '.html', 'one' );
file_put_contents( $dir . '/' . $k2 . '.html', 'two' );
file_put_contents( $dir . '/' . $k1 . '.12345.iwsltmp', 'orphan-temp' );
$sibling = $content . '/keep-me.html'; // OUTSIDE the contained cache dir
file_put_contents( $sibling, 'safe' );

$pc  = new IWSL_Page_Cache( iwsl_pc_ent( iwsl_pc_unlocked_store( $PC_NOW ), $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ) );
$res = $pc->purge_all();
iwsl_assert_same( true, $res['ok'], 'purge: ok' );
iwsl_assert_same( 3, $res['purged'], 'purge: exactly three contained files removed (2 html + 1 temp)' );
iwsl_assert( ! is_file( $dir . '/' . $k1 . '.html' ), 'purge: html entry 1 removed' );
iwsl_assert( ! is_file( $dir . '/' . $k2 . '.html' ), 'purge: html entry 2 removed' );
iwsl_assert( ! is_file( $dir . '/' . $k1 . '.12345.iwsltmp' ), 'purge: orphan temp removed' );
iwsl_assert( is_file( $sibling ), 'purge: sibling OUTSIDE the contained dir untouched' );

// Symlinked entry inside the cache dir is not followed; its target survives.
$secret = $content . '/secret.html';
file_put_contents( $secret, 'do not delete' );
$linkname = $dir . '/' . str_repeat( 'c', 40 ) . '.html';
symlink( $secret, $linkname );
$pc->purge_all();
iwsl_assert( is_file( $secret ), 'purge: symlink target NOT deleted (symlink never followed)' );

// ── 7. iwsl_pc_response_storable: store hygiene (pure) ─────────────────────────

$html = array( 'Content-Type: text/html; charset=UTF-8' );
iwsl_assert_same( true, iwsl_pc_response_storable( 200, $html, 100, false ), 'storable: 200 text/html non-empty → yes' );
iwsl_assert_same( false, iwsl_pc_response_storable( 302, $html, 100, false ), 'storable: non-200 → no' );
iwsl_assert_same( false, iwsl_pc_response_storable( 200, $html, 100, true ), 'storable: DONOTCACHEPAGE → no' );
iwsl_assert_same( false, iwsl_pc_response_storable( 200, $html, 0, false ), 'storable: empty body → no' );
iwsl_assert_same( false, iwsl_pc_response_storable( 200, array( 'Content-Type: application/json' ), 100, false ), 'storable: non-html content-type → no' );
iwsl_assert_same( false, iwsl_pc_response_storable( 200, array( 'Content-Type: text/html', 'Set-Cookie: sid=1' ), 100, false ), 'storable: Set-Cookie present → no (session-leak guard)' );
iwsl_assert_same( false, iwsl_pc_response_storable( 200, array( 'Content-Type: text/html', 'Cache-Control: private' ), 100, false ), 'storable: Cache-Control private → no' );
iwsl_assert_same( false, iwsl_pc_response_storable( 200, array( 'Content-Type: text/html', 'Cache-Control: no-store' ), 100, false ), 'storable: Cache-Control no-store → no' );
iwsl_assert_same( false, iwsl_pc_response_storable( 200, array( 'Content-Type: text/html', 'Location: /elsewhere' ), 100, false ), 'storable: Location header → no' );

// ── 8. purge(): full teardown — drop-in + wp-config marker + cache dir ────────

// (a) fully enabled site: purge() removes everything and reports counts.
$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$store   = iwsl_pc_unlocked_store( $PC_NOW );
$pc      = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ) );
$pc->enable(); // creates the contained cache/iwsl dir.
file_put_contents( $content . '/cache/iwsl/' . str_repeat( 'd', 40 ) . '.html', 'cached' );
iwsl_assert( is_file( $content . '/advanced-cache.php' ), 'purge setup: drop-in present before purge' );

$p = $pc->purge();
iwsl_assert_same( true, $p['ok'], 'purge: ok' );
iwsl_assert_same( true, $p['removed'], 'purge: drop-in removed flag true' );
iwsl_assert( $p['purged'] >= 1, 'purge: at least one cached file reported purged' );
iwsl_assert( ! is_file( $content . '/advanced-cache.php' ), 'purge: drop-in file gone' );
iwsl_assert( false === strpos( (string) file_get_contents( $config ), '// iwsl-page-cache' ), 'purge: wp-config marker line gone' );
$left = glob( $content . '/cache/iwsl/*.html' );
iwsl_assert_same( 0, is_array( $left ) ? count( $left ) : 0, 'purge: cache dir emptied' );

// (b) idempotent + cheap no-op when already clean: a second call changes nothing and errors nothing.
$p2 = $pc->purge();
iwsl_assert_same( true, $p2['ok'], 'purge: second call still ok (idempotent)' );
iwsl_assert_same( false, $p2['removed'], 'purge: second call reports nothing removed' );
iwsl_assert_same( 0, $p2['purged'], 'purge: second call purges nothing (cheap no-op)' );

// (c) a fresh, never-enabled site: purge() is a clean no-op.
$content3 = iwsl_pc_tempdir();
$config3  = iwsl_pc_write_config( $content3 );
$pc3      = new IWSL_Page_Cache( iwsl_pc_ent( iwsl_pc_unlocked_store( $PC_NOW ), $PC_NOW ), $content3, $config3, iwsl_pc_clock( $PC_NOW ) );
$p3       = $pc3->purge();
iwsl_assert_same( true, $p3['ok'], 'purge (never enabled): ok' );
iwsl_assert_same( false, $p3['removed'], 'purge (never enabled): nothing removed' );
iwsl_assert_same( 0, $p3['purged'], 'purge (never enabled): nothing purged' );

// (d) a foreign drop-in is NEVER touched by purge().
$content4 = iwsl_pc_tempdir();
$config4  = iwsl_pc_write_config( $content4 );
$foreign4 = "<?php\n/* a competing cache plugin */\nreturn;\n";
file_put_contents( $content4 . '/advanced-cache.php', $foreign4 );
$pc4 = new IWSL_Page_Cache( iwsl_pc_ent( iwsl_pc_unlocked_store( $PC_NOW ), $PC_NOW ), $content4, $config4, iwsl_pc_clock( $PC_NOW ) );
$p4  = $pc4->purge();
iwsl_assert_same( false, $p4['ok'], 'purge (foreign drop-in): refused' );
iwsl_assert_same( 'foreign-dropin', $p4['reason'], 'purge (foreign drop-in): reason foreign-dropin' );
iwsl_assert_same( $foreign4, (string) file_get_contents( $content4 . '/advanced-cache.php' ), 'purge (foreign drop-in): bytes untouched' );

// ── 9. Counters + exclusion helpers (pure, drop-in-safe, lock-free) ────────────

$stats_dir = iwsl_pc_tempdir();
$T0        = 30000; // unix seconds
iwsl_pc_bump( $stats_dir, 'hit', $T0 );
iwsl_pc_bump( $stats_dir, 'hit', $T0 );
iwsl_pc_bump( $stats_dir, 'miss', $T0 );
iwsl_assert_same( 2, iwsl_pc_count( $stats_dir, 'hit', 1, $T0 ), 'counters: two HITs counted today (filesize == count)' );
iwsl_assert_same( 1, iwsl_pc_count( $stats_dir, 'miss', 1, $T0 ), 'counters: one MISS counted today' );
iwsl_assert_same( 0, iwsl_pc_count( $stats_dir, 'hit', 1, $T0 + 86400 ), 'counters: next day starts at zero (per-day file)' );
iwsl_assert_same( 2, iwsl_pc_count( $stats_dir, 'hit', 7, $T0 + 86400 ), 'counters: 7-day window still sees the prior day' );
iwsl_pc_bump( $stats_dir, 'bogus', $T0 );
iwsl_assert_same( 0, iwsl_pc_count( $stats_dir, 'bogus', 1, $T0 ), 'counters: an invalid type is never counted (fail-open)' );
$today = gmdate( 'Ymd', $T0 );
iwsl_assert( is_file( $stats_dir . '/stats-hit-' . $today . '.cnt' ), 'counters: file named stats-hit-YYYYMMDD.cnt' );
iwsl_pc_bump( $stats_dir, 'hit', $T0 - ( 10 * 86400 ) ); // 10 days ago
$pruned = iwsl_pc_prune_stats( $stats_dir, 7, $T0 );
iwsl_assert( $pruned >= 1, 'counters: prune removes files older than keep-days' );
iwsl_assert( is_file( $stats_dir . '/stats-hit-' . $today . '.cnt' ), 'counters: prune keeps the current-day file' );

iwsl_assert_same( true, iwsl_pc_excluded( '/checkout', array( '/checkout' ) ), 'excluded: exact match' );
iwsl_assert_same( true, iwsl_pc_excluded( '/checkout/', array( '/checkout' ) ), 'excluded: exact match is trailing-slash-insensitive' );
iwsl_assert_same( false, iwsl_pc_excluded( '/checkout-thanks', array( '/checkout' ) ), 'excluded: exact does NOT match a longer path (no accidental prefix)' );
iwsl_assert_same( true, iwsl_pc_excluded( '/members/area', array( '/members/*' ) ), 'excluded: trailing-* prefix match' );
iwsl_assert_same( false, iwsl_pc_excluded( '/public', array( '/members/*' ) ), 'excluded: a non-matching path is not excluded' );
iwsl_assert_same( false, iwsl_pc_excluded( '/x', array() ), 'excluded: an empty rule list never excludes' );

// ── 10. status(): counters, hit-rate, exclusions, template version, staleness ──

$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$store   = iwsl_pc_unlocked_store( $PC_NOW );
$pc      = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ), array( 'exclusions' => array( '/checkout', '/members/*' ) ), $store );
$pc->enable();
$dir = $content . '/cache/iwsl';
iwsl_pc_bump( $dir, 'hit', 30000 ); // now_s for $PC_NOW (30000000 ms) == 30000
iwsl_pc_bump( $dir, 'hit', 30000 );
iwsl_pc_bump( $dir, 'hit', 30000 );
iwsl_pc_bump( $dir, 'miss', 30000 );
$st = $pc->status();
iwsl_assert_same( 3, $st['hits_today'], 'status: hits_today reflects the counters' );
iwsl_assert_same( 1, $st['misses_today'], 'status: misses_today reflects the counters' );
iwsl_assert_same( 75, $st['hit_rate'], 'status: hit_rate = hits/(hits+misses) as a percentage' );
iwsl_assert_same( array( '/checkout', '/members/*' ), $st['exclusions'], 'status: exclusions echoed' );
iwsl_assert_same( 2, $st['template_version'], 'status: template_version reported' );
iwsl_assert_same( false, $st['dropin_stale'], 'status: a freshly-rendered drop-in is not stale' );

$body = (string) file_get_contents( $content . '/advanced-cache.php' );
iwsl_assert( false !== strpos( $body, 'iwsl-pc-tpl: 2' ), 'drop-in: baked template-version marker present' );
iwsl_assert( false !== strpos( $body, 'members' ), 'drop-in: exclusion pattern baked into the drop-in' );

$content_s = iwsl_pc_tempdir();
$config_s  = iwsl_pc_write_config( $content_s );
file_put_contents( $content_s . '/advanced-cache.php', "<?php\n/* signature: iwsl-page-cache */\nreturn;\n" );
$pc_s = new IWSL_Page_Cache( iwsl_pc_ent( iwsl_pc_unlocked_store( $PC_NOW ), $PC_NOW ), $content_s, $config_s, iwsl_pc_clock( $PC_NOW ) );
iwsl_assert_same( true, $pc_s->status()['dropin_stale'], 'status: a v1 drop-in with no tpl marker reads as stale (re-render due)' );

// ── 11. purge_paths(): per-URL purge, both schemes, host from the baked home ───

$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$store   = iwsl_pc_unlocked_store( $PC_NOW );
$pc      = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ) );
$pc->enable();
$dir     = $content . '/cache/iwsl';
$k_http  = iwsl_pc_cache_key( 'http', 'fixture-site.test', '/hello' );
$k_https = iwsl_pc_cache_key( 'https', 'fixture-site.test', '/hello' );
$k_other = iwsl_pc_cache_key( 'https', 'fixture-site.test', '/keep' );
file_put_contents( $dir . '/' . $k_http . '.html', 'h' );
file_put_contents( $dir . '/' . $k_https . '.html', 'h' );
file_put_contents( $dir . '/' . $k_other . '.html', 'k' );
$r = $pc->purge_paths( array( '/hello' ) );
iwsl_assert_same( true, $r['ok'], 'purge_paths: ok' );
iwsl_assert_same( 2, $r['purged'], 'purge_paths: both scheme variants of /hello purged (host is the baked home, not the caller)' );
iwsl_assert( ! is_file( $dir . '/' . $k_http . '.html' ), 'purge_paths: http variant removed' );
iwsl_assert( ! is_file( $dir . '/' . $k_https . '.html' ), 'purge_paths: https variant removed' );
iwsl_assert( is_file( $dir . '/' . $k_other . '.html' ), 'purge_paths: an unrelated URL survives' );
$r2 = $pc->purge_paths( array( '/hello/' ) );
iwsl_assert_same( 0, $r2['purged'], 'purge_paths: unknown/already-purged path purges 0 (idempotent)' );
iwsl_assert_same( true, $r2['ok'], 'purge_paths: idempotent success' );
$r3 = $pc->purge_paths( array( 'no-slash', '/ok/../etc', '/with?query', '//evil.example.com' ) );
iwsl_assert_same( 0, $r3['purged'], 'purge_paths: malformed / off-host-looking paths purge nothing' );

// ── 12. configure(): ttl + exclusions persist + re-render; toggle; gates ───────

$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$store   = iwsl_pc_unlocked_store( $PC_NOW );
$pc      = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ), null, $store );
$c       = $pc->configure( array( 'enabled' => true, 'ttl' => 1800, 'exclusions' => array( '/checkout', 'bad-no-slash', '/members/*' ) ) );
iwsl_assert_same( true, $c['ok'], 'configure: enable ok' );
iwsl_assert_same( 1800, $c['settings']['ttl'], 'configure: ttl applied' );
iwsl_assert_same( array( '/checkout', '/members/*' ), $c['settings']['exclusions'], 'configure: exclusions sanitized (no-slash pattern dropped)' );
iwsl_assert( is_file( $content . '/advanced-cache.php' ), 'configure: drop-in written' );
$body = (string) file_get_contents( $content . '/advanced-cache.php' );
iwsl_assert( false !== strpos( $body, "(int) '1800'" ), 'configure: new ttl baked into the drop-in' );
$persisted = $store->get( 'page_cache_settings' );
iwsl_assert_same( 1800, $persisted['ttl'], 'configure: ttl persisted to the store' );
$pc_reload = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ), null, $store );
iwsl_assert_same( 1800, $pc_reload->settings()['ttl'], 'configure: persisted ttl survives a fresh engine (one settings source)' );
iwsl_assert_same( array( '/checkout', '/members/*' ), $pc_reload->settings()['exclusions'], 'configure: persisted exclusions survive a reload' );
iwsl_assert_same( 'invalid-ttl', $pc->configure( array( 'ttl' => 59 ) )['reason'], 'configure: ttl below min refused' );
iwsl_assert_same( 'invalid-ttl', $pc->configure( array( 'ttl' => 999999 ) )['reason'], 'configure: ttl above max refused' );
iwsl_assert_same( 'invalid-exclusions', $pc->configure( array( 'exclusions' => 'not-an-array' ) )['reason'], 'configure: non-array exclusions refused' );
$d = $pc->configure( array( 'enabled' => false ) );
iwsl_assert_same( true, $d['ok'], 'configure: disable ok' );
iwsl_assert( ! is_file( $content . '/advanced-cache.php' ), 'configure: drop-in removed on disable' );

$locked_store = new IWSL_Memory_Store();
$locked_store->set( 'state', 'active' );
$locked_store->set( 'last_verified_at', $PC_NOW - 60000 );
$locked_store->set( 'entitlements', array( 'plus' => true ) ); // page_cache ABSENT
$pc_locked = new IWSL_Page_Cache( iwsl_pc_ent( $locked_store, $PC_NOW ), iwsl_pc_tempdir(), null, iwsl_pc_clock( $PC_NOW ), null, $locked_store );
$cl        = $pc_locked->configure( array( 'enabled' => true, 'ttl' => 1200 ) );
iwsl_assert_same( false, $cl['ok'], 'configure: a locked (Basic) site is refused by enable()' );
iwsl_assert_same( 'entitlement-locked', $cl['reason'], 'configure: entitlement-locked reason surfaced' );

// ── 13. warm(): SSRF-safe loopback (URL built from OWN home), caps, stub HTTP ───

$content   = iwsl_pc_tempdir();
$config    = iwsl_pc_write_config( $content );
$store     = iwsl_pc_unlocked_store( $PC_NOW );
$warm_urls = array();
$http_stub = static function ( string $url, int $timeout ) use ( &$warm_urls ): int {
	$warm_urls[] = $url;
	return 200;
};
$pc = new IWSL_Page_Cache(
	iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ),
	array( 'home_url' => 'https://fixture-site.test', 'http' => $http_stub ), $store
);
$w = $pc->warm( array( '/', '/blog', '/shop' ), 25 );
iwsl_assert_same( 3, $w['warmed'], 'warm: three pages warmed (stub returns 200)' );
iwsl_assert_same( 0, $w['failed'], 'warm: none failed' );
iwsl_assert_same( 'https://fixture-site.test/blog', $warm_urls[1], 'warm: URL built from the OWN home host + validated path' );
$warm_urls = array();
$w2 = $pc->warm( array( 'https://evil.example.com/x', '//evil.example.com', '/legit' ), 25 );
iwsl_assert_same( 1, $w2['warmed'], 'warm: only the one legit on-host path fetched (SSRF-safe by construction)' );
iwsl_assert_same( 2, $w2['skipped'], 'warm: off-host / protocol-relative targets skipped' );
iwsl_assert_same( 'https://fixture-site.test/legit', $warm_urls[0], 'warm: fetched URL is on the baked home host only' );
$warm_urls = array();
$w3 = $pc->warm( array( '/a', '/b', '/c', '/d' ), 2 );
iwsl_assert_same( 2, $w3['warmed'], 'warm: limit caps the number of fetches' );
iwsl_assert_same( 2, count( $warm_urls ), 'warm: only two HTTP calls made under the limit' );

$locked = new IWSL_Memory_Store();
$locked->set( 'state', 'active' );
$locked->set( 'last_verified_at', $PC_NOW - 60000 );
$locked->set( 'entitlements', array( 'plus' => true ) );
$pc_l = new IWSL_Page_Cache( iwsl_pc_ent( $locked, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ), array( 'home_url' => 'https://fixture-site.test', 'http' => $http_stub ) );
$wl   = $pc_l->warm( array( '/' ), 25 );
iwsl_assert_same( 'entitlement-locked', $wl['reason'], 'warm: a locked site is refused (page_cache-gated)' );

// ── 14. Counters survive purge_all but are removed by disable()/purge() ────────

$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$store   = iwsl_pc_unlocked_store( $PC_NOW );
$pc      = new IWSL_Page_Cache( iwsl_pc_ent( $store, $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ), null, $store );
$pc->enable();
$dir = $content . '/cache/iwsl';
file_put_contents( $dir . '/' . str_repeat( 'a', 40 ) . '.html', 'page' );
iwsl_pc_bump( $dir, 'hit', 30000 );
$pc->purge_all();
iwsl_assert_same( 1, iwsl_pc_count( $dir, 'hit', 1, 30000 ), 'counters: survive purge_all (page purge != forgetting history)' );
iwsl_assert( ! is_file( $dir . '/' . str_repeat( 'a', 40 ) . '.html' ), 'counters: purge_all still cleared the cached page' );
iwsl_assert_same( 0, $pc->status()['entries'], 'counters: .cnt files are excluded from the entry count/cap' );
$pc->disable();
iwsl_assert_same( 0, iwsl_pc_count( $dir, 'hit', 1, 30000 ), 'counters: disable() teardown removes hit/miss history' );

// ── 15. Host-pin FAIL-CLOSED: the rendered drop-in never trusts the caller Host ─
// The drop-in is pre-WP procedural code, so we assert on the rendered ARTIFACT
// (the template's structural PHP is copied verbatim — only %%…%% placeholders are
// substituted). A revert to the fail-OPEN pattern would trip these regressions.
$content = iwsl_pc_tempdir();
$config  = iwsl_pc_write_config( $content );
$pc      = new IWSL_Page_Cache( iwsl_pc_ent( iwsl_pc_unlocked_store( $PC_NOW ), $PC_NOW ), $content, $config, iwsl_pc_clock( $PC_NOW ) );
$pc->enable();
$dropin = (string) file_get_contents( $content . '/advanced-cache.php' );
iwsl_assert( false !== strpos( $dropin, "'' === \$iwsl_pc_host" ), 'host-pin: rendered drop-in bakes the fail-closed empty-host bypass guard' );
iwsl_assert( false !== strpos( $dropin, '$iwsl_pc_key_host = $iwsl_pc_host;' ), 'host-pin: cache key host is ALWAYS the baked home host' );
iwsl_assert( false === strpos( $dropin, '? $iwsl_pc_host : $iwsl_pc_req_host' ), 'host-pin: cache key never falls back to the caller HTTP_HOST (no fail-open ternary)' );

// ── 16. default_http_get: TLS verify only skipped for a literal loopback host ───
// warm()'s DEFAULT client (no injected http) MUST verify TLS for any non-loopback
// host so an on-path actor can't feed the warmer poisoned HTML. Stub WP's HTTP so
// we can read back the exact wp_remote_get args. (These stubs live only in THIS
// isolated suite process.)
$GLOBALS['iwsl_pc_wp_get_args'] = array();
if ( ! function_exists( 'wp_remote_get' ) ) {
	function wp_remote_get( string $url, array $args = array() ) {
		$GLOBALS['iwsl_pc_wp_get_args'][] = array( 'url' => $url, 'args' => $args );
		return array( 'code' => 200 );
	}
}
if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ): bool {
		return false;
	}
}
if ( ! function_exists( 'wp_remote_retrieve_response_code' ) ) {
	function wp_remote_retrieve_response_code( $resp ): int {
		return is_array( $resp ) && isset( $resp['code'] ) ? (int) $resp['code'] : 0;
	}
}
$iwsl_pc_http = new ReflectionMethod( 'IWSL_Page_Cache', 'default_http_get' );
$iwsl_pc_http->setAccessible( true );
$iwsl_pc_ssl = static function ( string $url ) use ( $iwsl_pc_http ): array {
	$GLOBALS['iwsl_pc_wp_get_args'] = array();
	$iwsl_pc_http->invoke( null, $url, 5 );
	return $GLOBALS['iwsl_pc_wp_get_args'][0]['args'];
};
iwsl_assert_same( false, $iwsl_pc_ssl( 'http://127.0.0.1/' )['sslverify'], 'warm http: sslverify OFF for 127.0.0.1 loopback' );
iwsl_assert_same( false, $iwsl_pc_ssl( 'https://[::1]:8080/' )['sslverify'], 'warm http: sslverify OFF for [::1] loopback' );
iwsl_assert_same( false, $iwsl_pc_ssl( 'http://localhost/' )['sslverify'], 'warm http: sslverify OFF for localhost' );
$iwsl_pc_remote = $iwsl_pc_ssl( 'https://fixture-site.test/blog' );
iwsl_assert_same( true, $iwsl_pc_remote['sslverify'], 'warm http: sslverify ON for a non-loopback host (MITM-safe)' );
iwsl_assert_same( 0, $iwsl_pc_remote['redirection'], 'warm http: redirection stays pinned to 0' );
