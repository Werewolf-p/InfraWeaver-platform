/**
 * Wrapper for a Pelican/parkervcp egg install script, run once in an init
 * container before the game server's first boot. It adds two things around the
 * egg's own (arbitrary, upstream-authored) install script:
 *
 *   1. An idempotency guard: if the .installed marker already exists on the PVC,
 *      skip the whole thing and exit 0 (fast restarts don't re-download).
 *   2. A success gate: the .installed marker — and the non-root chown hand-off —
 *      are written ONLY when the egg script exits 0.
 *
 * Why the success gate matters (the bug it fixes): the egg script is injected raw
 * with no `set -e`, so before this gate `touch .installed` ran UNCONDITIONALLY,
 * right after the egg script, regardless of its exit code. A download that failed
 * without an explicit non-zero exit (the common case — an unchecked `curl`, a
 * partial SteamCMD) left a broken artifact on the PVC (e.g. a 0-byte server.jar)
 * AND set the marker. Every subsequent restart then hit the idempotency guard,
 * exited 0, and skipped reinstall — so the runtime container crashlooped forever
 * on the corrupt artifact ("Invalid or corrupt jarfile"), un-self-healing. The
 * wrapper is generic, so this trapped ALL eggs, not just Minecraft.
 *
 * Gating the marker on success means a failed install exits the init container
 * non-zero: Kubernetes retries the init cleanly (no poisoned marker) instead of
 * handing a corrupt PVC to a crashlooping runtime.
 *
 * `set -e` is deliberately NOT used to detect failure: parkervcp egg scripts
 * routinely run commands that exit non-zero benignly, so `set -e` would break
 * many working eggs. Instead the whole normalized script is used as the condition
 * of an `if`, so the branch is chosen by the script's FINAL exit status. An
 * explicit `exit` inside the egg script still terminates the shell exactly as it
 * did before wrapping — a success-path `exit 0` simply skips the marker (the
 * server reinstalls next boot) rather than false-passing, i.e. no behavior change
 * for eggs that exit on their own.
 */

/** Pelican install scripts hardcode /mnt/server as their write target. */
export const INSTALL_MOUNT = "/mnt/server";

/** uid/gid non-root runtime containers run as (see the pod securityContext). */
export const RUNTIME_UID = 1000;

/**
 * Build the wrapped installer shell script. Pure string builder so it can be
 * unit-tested in isolation (the marker/chown gating is the whole point).
 *
 * @param normalizedScript the egg's install script, already CRLF→LF normalized
 * @param isRoot           true when the runtime container also runs as root
 *                         (root already owns the installed files → skip chown)
 * @param installMount     PVC mount path the install script writes to
 * @param runtimeUid       uid/gid to hand non-root eggs' files to
 */
export function wrapInstallScript(
  normalizedScript: string,
  isRoot: boolean,
  installMount: string = INSTALL_MOUNT,
  runtimeUid: number = RUNTIME_UID,
): string {
  const marker = `${installMount}/.installed`;
  return [
    "#!/bin/sh",
    `if [ -f "${marker}" ]; then`,
    '  echo "[install] Already installed — skipping"',
    "  exit 0",
    "fi",
    // Use the whole egg script as the `if` condition: the then-branch (marker +
    // chown) runs only on a zero final exit status. A multi-line list is a valid
    // `if` condition in POSIX sh/ash/bash; a bare newline terminates it before
    // `then`. See the file header for why this is an `if` and not `set -e`.
    "if",
    normalizedScript,
    "then",
    // Hand root-installed files to the runtime user for non-root eggs (a root
    // runtime already owns them, so the chown is skipped there).
    ...(isRoot ? [] : [`  chown -R ${runtimeUid}:${runtimeUid} "${installMount}"`]),
    `  touch "${marker}"`,
    '  echo "[install] Installation complete"',
    "else",
    '  echo "[install] FAILED — install script exited non-zero; not marking installed" >&2',
    "  exit 1",
    "fi",
  ].join("\n");
}
