<?php
/*
 * IWSL-PAGE-CACHE — managed by InfraWeaver Connector. Do not edit.
 * signature: iwsl-page-cache
 * iwsl-pc-tpl: %%IWSL_PC_TPL%%
 */

/*
 * Serve-time full-page cache drop-in. WordPress core includes this file VERY
 * EARLY — before plugins load — whenever WP_CACHE is true. It therefore CANNOT
 * call the plugin's entitlement gate per request; the gate is enforced by
 * PRESENCE (the plugin writes this file ONLY while entitled and removes it the
 * moment the flag is revoked). Every step below fails OPEN: any anomaly returns
 * control to WordPress, which then serves the page uncached. It never fails
 * closed to a broken site.
 *
 * The controller (IWSL_Page_Cache::render_template) substitutes the five baked
 * values below at write time. The signature comment above is how the plugin
 * recognises — and only ever removes — its OWN drop-in, never a competitor's.
 */

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	return;
}
if ( defined( 'DOING_CRON' ) && DOING_CRON ) {
	return;
}

$iwsl_pc_helpers = '%%IWSL_PC_HELPERS_PATH%%';
$iwsl_pc_dir     = '%%IWSL_PC_CACHE_DIR%%';
$iwsl_pc_host    = '%%IWSL_PC_HOST%%';
$iwsl_pc_ttl     = (int) '%%IWSL_PC_TTL%%';
$iwsl_pc_max     = (int) '%%IWSL_PC_MAX_ENTRIES%%';
$iwsl_pc_excl    = json_decode( '%%IWSL_PC_EXCLUSIONS%%', true );
if ( ! is_array( $iwsl_pc_excl ) ) {
	$iwsl_pc_excl = array();
}

if ( '' === $iwsl_pc_helpers || ! is_file( $iwsl_pc_helpers ) ) {
	return;
}
require_once $iwsl_pc_helpers;

if ( ! function_exists( 'iwsl_pc_is_cacheable' )
	|| ! function_exists( 'iwsl_pc_cache_key' )
	|| ! function_exists( 'iwsl_pc_store_cb' ) ) {
	return;
}

// Host pinning — refuse any request whose Host header is not the baked home
// host. Kills Host-header cache poisoning and unbounded key growth.
$iwsl_pc_req_host = isset( $_SERVER['HTTP_HOST'] ) ? strtolower( (string) $_SERVER['HTTP_HOST'] ) : '';
if ( '' !== $iwsl_pc_host && $iwsl_pc_req_host !== strtolower( $iwsl_pc_host ) ) {
	return;
}

// The full safe-by-default serve gauntlet (method / query / cookies / path).
if ( ! iwsl_pc_is_cacheable( $_SERVER, $_COOKIE ) ) {
	return;
}
if ( ! is_dir( $iwsl_pc_dir ) ) {
	return;
}

$iwsl_pc_scheme = 'http';
if ( ( isset( $_SERVER['HTTPS'] ) && '' !== $_SERVER['HTTPS'] && 'off' !== strtolower( (string) $_SERVER['HTTPS'] ) )
	|| ( isset( $_SERVER['SERVER_PORT'] ) && '443' === (string) $_SERVER['SERVER_PORT'] ) ) {
	$iwsl_pc_scheme = 'https';
}

$iwsl_pc_path = parse_url( (string) $_SERVER['REQUEST_URI'], PHP_URL_PATH );
if ( ! is_string( $iwsl_pc_path ) || '' === $iwsl_pc_path ) {
	return;
}

// Operator exclusion rules (baked prefix / trailing-* patterns) — an excluded
// path is never served-from or stored-to the cache. Skew-guarded: an old drop-in
// paired with new helpers, or vice versa, simply skips exclusion matching.
if ( is_array( $iwsl_pc_excl ) && array() !== $iwsl_pc_excl
	&& function_exists( 'iwsl_pc_excluded' ) && iwsl_pc_excluded( $iwsl_pc_path, $iwsl_pc_excl ) ) {
	return;
}

$iwsl_pc_key_host = '' !== $iwsl_pc_host ? $iwsl_pc_host : $iwsl_pc_req_host;
$iwsl_pc_key      = iwsl_pc_cache_key( $iwsl_pc_scheme, $iwsl_pc_key_host, $iwsl_pc_path );
$iwsl_pc_file     = $iwsl_pc_dir . '/' . $iwsl_pc_key . '.html';

// HIT — a fresh stored copy exists: emit it and exit BEFORE WordPress boots.
if ( is_file( $iwsl_pc_file ) ) {
	$iwsl_pc_mtime = @filemtime( $iwsl_pc_file );
	if ( false !== $iwsl_pc_mtime && ( $iwsl_pc_mtime + $iwsl_pc_ttl ) > time() ) {
		if ( ! headers_sent() ) {
			header( 'X-IWSL-Cache: HIT' );
			header( 'Content-Type: text/html; charset=UTF-8' );
		}
		// Lock-free HIT counter (append-one-byte). Skew-guarded.
		if ( function_exists( 'iwsl_pc_bump' ) ) {
			iwsl_pc_bump( $iwsl_pc_dir, 'hit' );
		}
		readfile( $iwsl_pc_file );
		exit;
	}
}

// MISS — buffer the response and store it on shutdown via the pure store
// callback. The X-IWSL-Cache: MISS header is the only thing added; the body is
// never modified.
if ( ! headers_sent() ) {
	header( 'X-IWSL-Cache: MISS' );
}
// Lock-free MISS counter (append-one-byte). Skew-guarded.
if ( function_exists( 'iwsl_pc_bump' ) ) {
	iwsl_pc_bump( $iwsl_pc_dir, 'miss' );
}
$GLOBALS['iwsl_pc_ctx'] = array(
	'dir'         => $iwsl_pc_dir,
	'key'         => $iwsl_pc_key,
	'max_entries' => $iwsl_pc_max,
);
ob_start( 'iwsl_pc_store_cb' );
