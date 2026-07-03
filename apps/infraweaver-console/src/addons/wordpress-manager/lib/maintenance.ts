/**
 * Maintenance mode — put a WordPress site behind a "temporarily unavailable" page
 * for anonymous/non-admin visitors, on demand and indefinitely.
 *
 * We deliberately do NOT use WordPress's built-in `.maintenance` drop-in: core
 * ignores it after 10 minutes (`wp_is_maintenance_mode()` bails once
 * `time() - $upgrading >= 10 * MINUTE_IN_SECONDS`), so it can't express an
 * operator-held maintenance window. Instead we drop a tiny must-use plugin that
 * unconditionally serves a 503 while the `infraweaver_maintenance` option is set —
 * admins and wp-cli always pass through so the site stays manageable.
 *
 * Pure helpers here (command strings + status parser) so they're unit-testable
 * without a cluster; the pod-exec lives in provision.ts.
 */

/** Path (relative to the WordPress root) of the maintenance must-use plugin. */
export const MAINTENANCE_MU_PLUGIN_PATH = "wp-content/mu-plugins/infraweaver-maintenance.php";

/** WordPress option toggled to enable/disable the maintenance page. */
export const MAINTENANCE_OPTION = "infraweaver_maintenance";

export interface MaintenanceStatus {
  enabled: boolean;
}

/**
 * The must-use plugin source. mu-plugins auto-load on every request, so once this
 * file exists the site honours the `infraweaver_maintenance` option with no
 * activation step. Gated on `template_redirect` (front-end, after auth is
 * available) so logged-in admins and wp-cli are never locked out.
 */
export function maintenancePluginContents(): string {
  return `<?php
/**
 * InfraWeaver Maintenance Mode (must-use plugin).
 * Serves a 503 "under maintenance" page to anonymous / non-admin visitors while
 * the "${MAINTENANCE_OPTION}" option is truthy. Managed by the InfraWeaver
 * console — do not edit by hand.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }
add_action( 'template_redirect', function () {
    if ( ! get_option( '${MAINTENANCE_OPTION}' ) ) { return; }
    if ( defined( 'WP_CLI' ) && WP_CLI ) { return; }
    if ( is_user_logged_in() && current_user_can( 'manage_options' ) ) { return; }
    wp_die(
        '<h1>Under maintenance</h1><p>This site is temporarily unavailable while we perform scheduled maintenance. Please check back soon.</p>',
        'Under maintenance',
        array( 'response' => 503, 'exit' => true )
    );
}, 0 );
`;
}

/**
 * Idempotently write the must-use plugin. The contents are streamed over stdin
 * (never as an argument) so the PHP — quotes, \`$\`, and all — reaches the file
 * verbatim without any shell interpretation. \`mkdir -p\` makes this safe on sites
 * that have never had an mu-plugin before.
 */
export function installMaintenancePluginCommand(): string {
  return `set -e; mkdir -p wp-content/mu-plugins && cat > ${MAINTENANCE_MU_PLUGIN_PATH}`;
}

/** Turn the maintenance page on (option = 1) or off (delete the option). */
export function setMaintenanceCommand(enabled: boolean): string {
  return enabled
    ? `wp --allow-root option update ${MAINTENANCE_OPTION} 1 --autoload=yes`
    : `wp --allow-root option delete ${MAINTENANCE_OPTION}`;
}

/** Read the current maintenance flag. Emits "1" when on, empty/error when off. */
export function maintenanceStatusCommand(): string {
  return `wp --allow-root option get ${MAINTENANCE_OPTION} 2>/dev/null`;
}

/** Parse the status command output. Only an explicit truthy value counts as on. */
export function parseMaintenanceStatus(stdout: string): MaintenanceStatus {
  const value = stdout.trim();
  return { enabled: value === "1" || value.toLowerCase() === "true" };
}
