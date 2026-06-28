/**
 * `wp core install` glue. The official WordPress image leaves a fresh site at the
 * setup wizard; nothing usable (plugins, OIDC auto-login, an admin account) exists
 * until core is installed. The reconcile runs this once, idempotently, before it
 * configures plugins/SSO.
 */

/** POSIX single-quote a value for safe interpolation into a `sh -c` script. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Script that reports install state without ever failing the exec: prints
 * `INSTALLED` or `MISSING` on stdout and always exits 0, so the caller branches on
 * output rather than on a thrown non-zero (which it can't tell apart from a real
 * error like an unreachable DB).
 */
export function isInstalledScript(url: string): string {
  return `wp --allow-root --url=${shellQuote(url)} core is-installed >/dev/null 2>&1 && echo INSTALLED || echo MISSING`;
}

export interface CoreInstallOptions {
  url: string;
  title: string;
  adminUser: string;
  adminEmail: string;
}

/**
 * Script that installs WordPress core. The admin password is read from stdin (not
 * an argument) so it never lands in the k8s exec audit log; `--skip-email` keeps a
 * provision from sending outbound mail. SSO is the real login path, so this local
 * password is only ever a break-glass fallback held in the vault.
 */
export function coreInstallScript(opts: CoreInstallOptions): string {
  return [
    "set -e",
    // `read` returns non-zero at EOF when the piped secret has no trailing newline
    // (it still assigns what it read); `|| true` keeps `set -e` from aborting there.
    "read -r WP_ADMIN_PW || true",
    `wp --allow-root core install --url=${shellQuote(opts.url)} --title=${shellQuote(opts.title)} ` +
      `--admin_user=${shellQuote(opts.adminUser)} --admin_email=${shellQuote(opts.adminEmail)} ` +
      `--admin_password="$WP_ADMIN_PW" --skip-email`,
  ].join("\n");
}
