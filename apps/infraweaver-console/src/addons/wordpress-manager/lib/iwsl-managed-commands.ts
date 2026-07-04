/**
 * Shell scripts for managed IWSL enrollment (§5.1), run inside a site's
 * WordPress container via `execInWpPod`. Every script is a FIXED string —
 * payloads (plugin zip, enrollment bundle) arrive over stdin so nothing
 * user-controlled is ever interpolated into a command line, and secrets never
 * appear in the k8s exec audit log. Pure module, unit-tested.
 */

const ZIP_TMP = "/tmp/.iw-connector.zip";
const BUNDLE_TMP = "/tmp/.iw-enroll.iwenroll";

export const CONNECTOR_PLUGIN_SLUG = "infraweaver-connector";

/** stdin: the connector zip, base64-encoded. `--force` upgrades in place. */
export function installConnectorScript(): string {
  return [
    "set -e",
    `trap 'rm -f ${ZIP_TMP}' EXIT`,
    `base64 -d > ${ZIP_TMP}`,
    `wp --allow-root plugin install ${ZIP_TMP} --force --activate`,
  ].join("\n");
}

/**
 * Clear any previous link state (`iwsl_` options) so a re-enroll starts from
 * a clean TOFU slate instead of the plugin rejecting a second bundle.
 */
export function resetConnectorStateScript(): string {
  return "wp --allow-root option list --search='iwsl_%' --field=option_name | xargs -r -n1 wp --allow-root option delete";
}

/** stdin: the `.iwenroll` bundle content. The plugin shreds the file itself. */
export function enrollBundleScript(): string {
  return [
    "set -e",
    `trap 'rm -f ${BUNDLE_TMP}' EXIT`,
    `cat > ${BUNDLE_TMP}`,
    `wp --allow-root infraweaver enroll --file=${BUNDLE_TMP}`,
  ].join("\n");
}

/**
 * Print the passive enroll-proof (§5 step 2) as JSON — byte-identical to what
 * the REST endpoint serves, but fetched over exec so managed enrollment never
 * depends on the site's public URL being reachable from the console.
 */
export function readEnrollProofScript(): string {
  return `wp --allow-root eval 'echo wp_json_encode( iwsl_plugin()->enrollment()->build_proof() );'`;
}

/** Best-effort teardown on unlink — tolerate a plugin that's already gone. */
export function uninstallConnectorScript(): string {
  return [
    `wp --allow-root plugin deactivate ${CONNECTOR_PLUGIN_SLUG} || true`,
    `wp --allow-root plugin delete ${CONNECTOR_PLUGIN_SLUG} || true`,
    resetConnectorStateScript() + " || true",
  ].join("\n");
}

/**
 * Pull the proof JSON out of wp-cli stdout, which may carry PHP notices ahead
 * of it. `null` means the plugin has no pending enrollment (state mismatch).
 */
export function extractProofJson(stdout: string): string {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("IWSL: plugin returned no pending enrollment proof");
  }
  return stdout.slice(start, end + 1);
}
