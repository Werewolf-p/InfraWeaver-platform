<?php
/**
 * Tests for the shared UI helpers in includes/iwsl-ui-help.php:
 *  - iwsl_field_help()        — the "?" field-help badge markup.
 *  - iwsl_plus_redirect_base() — the post-save redirect target that keeps the
 *    operator on the SAME category sub-page instead of the Overview dashboard.
 *
 * Pure/near-pure: only wp_get_referer / admin_url / wp_parse_url are needed, and
 * they are stubbed here so the suite runs under the zero-WordPress harness.
 */

defined( 'ABSPATH' ) || define( 'ABSPATH', __DIR__ );

$GLOBALS['iwsl_test_referer'] = '';

if ( ! function_exists( 'wp_get_referer' ) ) {
	function wp_get_referer() {
		return $GLOBALS['iwsl_test_referer'];
	}
}
if ( ! function_exists( 'admin_url' ) ) {
	function admin_url( $path = '' ) {
		return 'https://site.test/wp-admin/' . ltrim( (string) $path, '/' );
	}
}
if ( ! function_exists( 'wp_parse_url' ) ) {
	function wp_parse_url( $url, $component = -1 ) {
		return parse_url( (string) $url, $component );
	}
}
if ( ! function_exists( 'esc_attr' ) ) {
	function esc_attr( $s ) {
		return htmlspecialchars( (string) $s, ENT_QUOTES );
	}
}
if ( ! function_exists( 'esc_html' ) ) {
	function esc_html( $s ) {
		return htmlspecialchars( (string) $s, ENT_QUOTES );
	}
}

require_once __DIR__ . '/../includes/iwsl-ui-help.php';

// ── iwsl_field_help ────────────────────────────────────────────────────────
iwsl_assert_same( '', iwsl_field_help( '' ), 'field_help: empty text renders nothing' );
$badge = iwsl_field_help( 'Plain explanation.' );
iwsl_assert( false !== strpos( $badge, 'iwsl-help' ), 'field_help: renders the help badge class' );
iwsl_assert( false !== strpos( $badge, 'Plain explanation.' ), 'field_help: carries the sentence' );

// ── iwsl_plus_redirect_base ────────────────────────────────────────────────
// Keeps the sub-page slug the form was submitted from, and DROPS stale result
// flags so they never accumulate across saves.
$GLOBALS['iwsl_test_referer'] = 'https://site.test/wp-admin/admin.php?page=infraweaver-plus-performance&iwsl_speed_locked=1';
iwsl_assert_same(
	'https://site.test/wp-admin/admin.php?page=infraweaver-plus-performance',
	iwsl_plus_redirect_base(),
	'redirect_base: keeps category sub-page, strips result flags'
);

// A media sub-page referer returns the media sub-page.
$GLOBALS['iwsl_test_referer'] = 'https://site.test/wp-admin/admin.php?page=infraweaver-plus-media';
iwsl_assert_same(
	'https://site.test/wp-admin/admin.php?page=infraweaver-plus-media',
	iwsl_plus_redirect_base(),
	'redirect_base: media sub-page preserved'
);

// The bare Dashboard page stays the Dashboard.
$GLOBALS['iwsl_test_referer'] = 'https://site.test/wp-admin/admin.php?page=infraweaver-plus';
iwsl_assert_same(
	'https://site.test/wp-admin/admin.php?page=infraweaver-plus',
	iwsl_plus_redirect_base(),
	'redirect_base: dashboard page preserved'
);

// No referer at all → safe fallback to the main page.
$GLOBALS['iwsl_test_referer'] = '';
iwsl_assert_same(
	'https://site.test/wp-admin/admin.php?page=infraweaver-plus',
	iwsl_plus_redirect_base(),
	'redirect_base: empty referer falls back to main page'
);

// A referer to some OTHER admin page (not ours) must NOT be honoured — never
// redirect off our own pages; fall back to the main page.
$GLOBALS['iwsl_test_referer'] = 'https://site.test/wp-admin/plugins.php?page=someone-else';
iwsl_assert_same(
	'https://site.test/wp-admin/admin.php?page=infraweaver-plus',
	iwsl_plus_redirect_base(),
	'redirect_base: foreign page ignored, falls back to main page'
);

// A page value carrying junk characters is hard-sanitised to [a-z0-9-].
$GLOBALS['iwsl_test_referer'] = 'https://site.test/wp-admin/admin.php?page=infraweaver-plus-seo%22%3E<script>';
iwsl_assert_same(
	'https://site.test/wp-admin/admin.php?page=infraweaver-plus-seoscript',
	iwsl_plus_redirect_base(),
	'redirect_base: sanitises the slug to safe characters'
);
