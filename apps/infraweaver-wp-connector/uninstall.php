<?php
/**
 * Uninstall cleanup for the InfraWeaver Connector.
 *
 * Fires only on a real wp-admin "Delete plugin". Removes every local IWSL
 * option — all use the `iwsl_` prefix (IWSL_WP_Store::PREFIX), including the
 * per-nonce `iwsl_nonce.*` replay claims and per-kid `iwsl_wp_keys.*` /
 * `iwsl_iw_keys.*` material — so a MANUAL delete leaves no orphaned state.
 *
 * This mirrors the §8 kill switch (IWSL_Plugin::wipe) for the one path the
 * signed teardown can't cover: an operator deleting the plugin from wp-admin.
 * A stale `iwsl_*` set is exactly what blocks a later re-enroll, so clearing it
 * on uninstall keeps re-install → re-enroll clean.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

global $wpdb;

// One statement over the whole `iwsl_` family. `_` is a LIKE metacharacter, so
// the prefix is escaped via esc_like before the wildcard is appended.
$iwsl_like = $wpdb->esc_like( 'iwsl_' ) . '%';
$wpdb->query(
	$wpdb->prepare(
		"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s",
		$iwsl_like
	)
);

// ── Non-option residue ──────────────────────────────────────────────────────
// The option sweep above misses the plugin's out-of-options footprint: its own
// custom tables, the per-post meta rows it writes, and its scheduled cron events
// (which live in the shared `cron` option we must NOT touch). Clean each here.
// Uninstall runs in a minimal context, so this is direct SQL / core cron calls —
// no engines are instantiated — and every statement is scoped to artifacts this
// plugin created (its own table name, its own meta keys, its own cron hooks).
// Guarded so a partial WP environment can't fatal the uninstaller.

// 1. Custom tables. Statistics is the only engine with its own table
//    (`{$prefix}iwsl_stats_hits`); the activity log lives in an `iwsl_*` option,
//    already removed above. IF EXISTS makes this idempotent and cheap.
$iwsl_tables = array( $wpdb->prefix . 'iwsl_stats_hits' );
foreach ( $iwsl_tables as $iwsl_table ) {
	// Identifiers can't be bound; the name is a constant prefix + our own
	// hardcoded suffix, so there is no user input in the SQL.
	$wpdb->query( "DROP TABLE IF EXISTS `{$iwsl_table}`" );
}

// 2. Plugin-created post meta. Media protection / media optimizer markers and
//    the SEO Suite's per-post `_iwseo_*` overrides. Enumerated explicitly so we
//    never touch a core key (e.g. `_wp_attachment_image_alt`) or another
//    plugin's key. `%s` bind on the exact key; the postmeta table is trusted.
$iwsl_meta_keys = array(
	'_iwsl_protected',       // IWSL_Media_Protection::META_KEY
	'_iwsl_media_optimizer', // IWSL_Media_Optimizer::META_KEY
	// IWSL_SEO_Suite per-post override meta (the full `_iwseo_*` set).
	'_iwseo_title', '_iwseo_desc', '_iwseo_focuskw', '_iwseo_synonyms', '_iwseo_related',
	'_iwseo_canonical', '_iwseo_noindex', '_iwseo_nofollow', '_iwseo_robots_adv',
	'_iwseo_og_title', '_iwseo_og_desc', '_iwseo_og_image', '_iwseo_tw_title', '_iwseo_tw_desc',
	'_iwseo_tw_image', '_iwseo_cornerstone', '_iwseo_page_type', '_iwseo_article_type',
	'_iwseo_bctitle', '_iwseo_score', '_iwseo_read_score',
);
foreach ( $iwsl_meta_keys as $iwsl_meta_key ) {
	$wpdb->query(
		$wpdb->prepare(
			"DELETE FROM {$wpdb->postmeta} WHERE meta_key = %s",
			$iwsl_meta_key
		)
	);
}

// 3. Scheduled cron events. These are entries in the shared `cron` option, so
//    the option sweep above can't remove them without nuking core/other-plugin
//    schedules. Clear only the plugin's own hooks via core.
if ( function_exists( 'wp_clear_scheduled_hook' ) ) {
	$iwsl_cron_hooks = array(
		'iwsl_auto_convert_sweep',   // IWSL_Auto_Convert::CRON_HOOK
		'iwsl_scheduled_db_cleanup', // IWSL_Scheduled_DB_Cleanup::CRON_HOOK
	);
	foreach ( $iwsl_cron_hooks as $iwsl_cron_hook ) {
		wp_clear_scheduled_hook( $iwsl_cron_hook );
	}
}
