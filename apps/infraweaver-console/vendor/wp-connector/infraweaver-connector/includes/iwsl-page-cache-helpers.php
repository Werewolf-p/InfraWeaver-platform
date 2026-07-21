<?php
/**
 * Pure, dependency-free decision helpers for the gated full-page cache
 * (gate flag `page_cache`). Shared by TWO includers:
 *
 *   1. the serve-time drop-in (wp-content/advanced-cache.php), which WordPress
 *      core includes VERY EARLY — before ABSPATH is defined and long before the
 *      plugin/entitlements load; and
 *   2. the plugin (IWSL_Page_Cache) at normal request time, and the no-WP test
 *      harness.
 *
 * WHY NO `defined('ABSPATH')||exit;` GUARD (this file only). The drop-in that
 * requires this file runs before WordPress defines ABSPATH, so the usual
 * direct-access guard would abort the drop-in every request. Direct web access
 * to this file is harmless: it only DECLARES functions and executes nothing.
 * The direct-access line is deliberately replaced by the include-once sentinel
 * below.
 *
 * Every function is `function_exists`-guarded because this file is included
 * TWICE per cached request (drop-in first, plugin later) and the two includers
 * may resolve it by different path strings.
 *
 * PURITY. iwsl_pc_is_cacheable / iwsl_pc_cache_key / iwsl_pc_bypass_cookie /
 * iwsl_pc_response_storable read ONLY their arguments — no superglobals, no
 * filesystem, no clock — so they are exhaustively unit-testable in the harness.
 * The two effectful helpers (iwsl_pc_store_cb / iwsl_pc_atomic_store) delegate
 * every decision to those pure predicates.
 */

defined( 'IWSL_PC_HELPERS' ) || define( 'IWSL_PC_HELPERS', 1 );

if ( ! function_exists( 'iwsl_pc_bypass_cookie' ) ) {
	/**
	 * Whether a cookie NAME marks the request as personalized — a logged-in
	 * session, a password-protected post, a pending comment author, or a
	 * WooCommerce cart/session. Prefix and exact matches only; the cookie VALUE
	 * is never read. THE CRITICAL SECURITY GATE: caching a page produced for such
	 * a request and replaying it to a stranger would leak private data, so any
	 * hit forces a full bypass at both serve and store time.
	 */
	function iwsl_pc_bypass_cookie( string $name ): bool {
		$prefixes = array(
			'wordpress_logged_in_',
			'wp-postpass_',
			'comment_author_',
			'wp_woocommerce_session_',
		);
		foreach ( $prefixes as $prefix ) {
			if ( 0 === strncmp( $name, $prefix, strlen( $prefix ) ) ) {
				return true;
			}
		}
		$exact = array( 'woocommerce_items_in_cart', 'woocommerce_cart_hash' );
		return in_array( $name, $exact, true );
	}
}

if ( ! function_exists( 'iwsl_pc_is_cacheable' ) ) {
	/**
	 * The safe-by-default serve gauntlet — a request may be served-from / stored-to
	 * the cache ONLY when EVERY rule below holds. Pure: it reads only the two
	 * injected arrays (a copy of $_SERVER and of $_COOKIE), never a superglobal.
	 *
	 *   - method is GET (never POST/HEAD/etc.);
	 *   - the query string is empty (strict empty-only rule for v1 — any `?...`
	 *     bypasses so per-visitor query variants never poison the cache);
	 *   - no personalization/session cookie is present (iwsl_pc_bypass_cookie);
	 *   - the path is a clean rooted path, not wp-admin / wp-login.php /
	 *     wp-cron.php / wp-json / admin-ajax.php / xmlrpc.php, and not a
	 *     feed / robots.txt / sitemap / xsl;
	 *   - the path carries no traversal (`..`), backslash or NUL bytes and is at
	 *     most 1024 bytes.
	 *
	 * @param array $server  Request server vars (REQUEST_METHOD, REQUEST_URI, QUERY_STRING).
	 * @param array $cookies Request cookies (name => value); only names are read.
	 */
	function iwsl_pc_is_cacheable( array $server, array $cookies ): bool {
		$method = isset( $server['REQUEST_METHOD'] ) ? (string) $server['REQUEST_METHOD'] : '';
		if ( 'GET' !== $method ) {
			return false;
		}

		$uri = isset( $server['REQUEST_URI'] ) ? (string) $server['REQUEST_URI'] : '';
		if ( '' === $uri ) {
			return false;
		}

		// Strict empty-only query rule (v1): any query string bypasses entirely.
		if ( false !== strpos( $uri, '?' ) || false !== strpos( $uri, '#' ) ) {
			return false;
		}
		$query = isset( $server['QUERY_STRING'] ) ? (string) $server['QUERY_STRING'] : '';
		if ( '' !== $query ) {
			return false;
		}

		// THE CRITICAL GATE: bypass on ANY auth/session/cart cookie.
		foreach ( array_keys( $cookies ) as $name ) {
			if ( is_string( $name ) && iwsl_pc_bypass_cookie( $name ) ) {
				return false;
			}
		}

		$path = parse_url( $uri, PHP_URL_PATH );
		if ( ! is_string( $path ) || '' === $path || '/' !== $path[0] ) {
			return false;
		}
		if ( strlen( $path ) > 1024 ) {
			return false;
		}

		// Poisoning / traversal bytes never reach the filesystem namespace anyway
		// (the key is a hash) but a request carrying them is not a real page.
		if ( false !== strpos( $path, '..' )
			|| false !== strpos( $path, '\\' )
			|| false !== strpos( $path, '%00' )
			|| false !== strpos( $path, "\0" ) ) {
			return false;
		}

		// Reserved / always-dynamic WordPress endpoints.
		if ( preg_match( '#^/(wp-admin|wp-login\.php|wp-cron\.php|wp-json)#', $path ) ) {
			return false;
		}
		if ( false !== strpos( $path, 'admin-ajax.php' ) || false !== strpos( $path, 'xmlrpc.php' ) ) {
			return false;
		}
		if ( preg_match( '#(/feed/?|/robots\.txt|sitemap(_index)?\.xml|\.xsl)$#', $path ) ) {
			return false;
		}

		return true;
	}
}

if ( ! function_exists( 'iwsl_pc_cache_key' ) ) {
	/**
	 * The cache key: sha1 of the lowercased scheme+host+normalized-path. The
	 * result is 40 hex chars, so NO raw request byte ever appears in a filename —
	 * the whole filesystem namespace is `[0-9a-f]{40}.html`. Trailing slashes are
	 * trimmed (root `/` preserved) so `/a` and `/a/` share one entry, mirroring
	 * IWSL_Redirects::normalize_path().
	 */
	function iwsl_pc_cache_key( string $scheme, string $host, string $path ): string {
		$norm_path = rtrim( $path, '/' );
		if ( '' === $norm_path ) {
			$norm_path = '/';
		}
		return sha1( strtolower( $scheme ) . '://' . strtolower( $host ) . $norm_path );
	}
}

if ( ! function_exists( 'iwsl_pc_response_storable' ) ) {
	/**
	 * The store-hygiene decision (pure). A response is storable ONLY when it is a
	 * non-empty HTTP 200 text/html body, DONOTCACHEPAGE is not set, and NONE of
	 * its response headers are Set-Cookie (a session was established mid-request —
	 * second-line defence for the logged-in-leak gate), Location (a redirect), or
	 * a private/no-cache/no-store Cache-Control.
	 *
	 * @param int      $status     http_response_code() at store time.
	 * @param string[] $headers    headers_list() at store time.
	 * @param int      $body_len   Length of the buffered body.
	 * @param bool     $donotcache Whether DONOTCACHEPAGE is defined-truthy.
	 */
	function iwsl_pc_response_storable( int $status, array $headers, int $body_len, bool $donotcache ): bool {
		if ( 200 !== $status ) {
			return false;
		}
		if ( $donotcache ) {
			return false;
		}
		if ( $body_len <= 0 ) {
			return false;
		}

		$has_html = false;
		foreach ( $headers as $header ) {
			if ( ! is_string( $header ) ) {
				continue;
			}
			$lc = strtolower( $header );
			if ( 0 === strpos( $lc, 'set-cookie:' ) ) {
				return false;
			}
			if ( 0 === strpos( $lc, 'location:' ) ) {
				return false;
			}
			if ( 0 === strpos( $lc, 'cache-control:' )
				&& ( false !== strpos( $lc, 'private' )
					|| false !== strpos( $lc, 'no-cache' )
					|| false !== strpos( $lc, 'no-store' ) ) ) {
				return false;
			}
			if ( 0 === strpos( $lc, 'content-type:' ) && false !== strpos( $lc, 'text/html' ) ) {
				$has_html = true;
			}
		}

		return $has_html;
	}
}

if ( ! function_exists( 'iwsl_pc_atomic_store' ) ) {
	/**
	 * Atomically store a body under the contained cache dir as `<key>.html`. The
	 * key MUST be a 40-hex digest (defence-in-depth against a poisoned key reaching
	 * the filesystem). Enforces the max-entries cap by refusing further stores on
	 * breach (never scan-and-delete on the hot path). Temp sibling + rename() so a
	 * reader never sees a half-written file.
	 */
	function iwsl_pc_atomic_store( string $dir, string $key, string $body, int $max_entries ): bool {
		if ( '' === $dir || ! is_dir( $dir ) ) {
			return false;
		}
		if ( ! preg_match( '/^[0-9a-f]{40}$/', $key ) ) {
			return false;
		}

		$existing = glob( $dir . '/*.html' );
		if ( is_array( $existing ) && count( $existing ) >= $max_entries ) {
			$final = $dir . '/' . $key . '.html';
			if ( ! is_file( $final ) ) {
				return false; // at cap and this is a NEW entry — skip.
			}
		}

		$final = $dir . '/' . $key . '.html';
		$tmp   = $dir . '/' . $key . '.' . getmypid() . '.iwsltmp';

		$fp = @fopen( $tmp, 'wb' );
		if ( false === $fp ) {
			return false;
		}
		$written = @fwrite( $fp, $body );
		@fclose( $fp );
		if ( false === $written ) {
			@unlink( $tmp );
			return false;
		}
		if ( ! @rename( $tmp, $final ) ) {
			@unlink( $tmp );
			return false;
		}
		return true;
	}
}

if ( ! function_exists( 'iwsl_pc_store_cb' ) ) {
	/**
	 * The ob_start() shutdown callback the drop-in registers on a MISS. Reads the
	 * per-request config baked into the drop-in (cache dir, key, cap) from a global,
	 * asks the pure iwsl_pc_response_storable() predicate whether the buffered
	 * response may be cached, and stores it atomically if so. It NEVER modifies the
	 * body — it always returns $buffer unchanged.
	 *
	 * @param string $buffer The buffered response body.
	 * @param int    $phase  ob phase flags (unused; PHP passes it).
	 */
	function iwsl_pc_store_cb( string $buffer, int $phase = 0 ): string {
		unset( $phase );
		$ctx = isset( $GLOBALS['iwsl_pc_ctx'] ) && is_array( $GLOBALS['iwsl_pc_ctx'] ) ? $GLOBALS['iwsl_pc_ctx'] : array();
		$dir = isset( $ctx['dir'] ) ? (string) $ctx['dir'] : '';
		$key = isset( $ctx['key'] ) ? (string) $ctx['key'] : '';
		$max = isset( $ctx['max_entries'] ) ? (int) $ctx['max_entries'] : 2000;
		if ( '' === $dir || '' === $key ) {
			return $buffer;
		}

		$status     = function_exists( 'http_response_code' ) ? (int) http_response_code() : 200;
		$headers    = function_exists( 'headers_list' ) ? headers_list() : array();
		$donotcache = defined( 'DONOTCACHEPAGE' ) && DONOTCACHEPAGE;

		if ( iwsl_pc_response_storable( $status, is_array( $headers ) ? $headers : array(), strlen( $buffer ), $donotcache ) ) {
			iwsl_pc_atomic_store( $dir, $key, $buffer, $max );
		}
		return $buffer;
	}
}
