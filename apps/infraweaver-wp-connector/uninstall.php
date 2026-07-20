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
