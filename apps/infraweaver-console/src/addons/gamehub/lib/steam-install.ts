import { INSTALL_MOUNT } from "@/addons/gamehub/lib/install-wrapper";

/**
 * Verifying boot-install wrapper for SteamCMD game eggs.
 *
 * The problem it closes (see the game-hub audit): eggs like palworld/valheim/
 * ark/rust/cs2/satisfactory ship NO install script — their third-party runtime
 * image runs `steamcmd +app_update` into the PVC at boot. So PR#137's success
 * gate + `.installed` marker (which only run inside an installer init container
 * built from `egg.installScript`) never covered them. Two silent failure modes
 * slipped through: steamcmd HANGS mid-download (port never binds, but the pod's
 * child-process probe stayed green), or steamcmd EXITS 0 on a truncated/corrupt
 * tree (the game then binds its port and serves broken content — still green).
 *
 * The fix is to run the install ourselves in an init container and gate it on a
 * real verification of the result, not just steamcmd's exit code:
 *
 *   1. Run `steamcmd … +app_update <appId> validate +quit` (validate re-hashes
 *      and repairs a partial tree).
 *   2. VERIFY the Steam app manifest reports fully-installed (StateFlags == 4)
 *      AND the install dir is at least a floor size on disk.
 *   3. On mismatch, re-download/validate — up to `maxAttempts` times.
 *   4. If it never verifies, exit non-zero (fail-closed).
 *
 * Step 4 is what makes the `.installed` marker fail-closed: this script is meant
 * to be wrapped by `wrapInstallScript`, which writes the marker ONLY when the
 * wrapped script exits 0. So the script must NOT `exit 0` on success — it falls
 * through with a zero status and lets the wrapper write the marker; it only calls
 * `exit 1` when verification fails. A corrupt/partial install therefore fails the
 * init container, Kubernetes retries it, and the runtime never boots on a poisoned
 * PVC — mirroring the guarantee PR#137 gave the non-steam eggs.
 */

/** Steam appmanifest StateFlags value for "fully installed, no pending update". */
export const STEAM_STATE_FULLY_INSTALLED = 4;

/** Official SteamCMD image used for the installer init container. */
export const STEAM_INSTALL_IMAGE = "steamcmd/steamcmd:latest";

/** Default download/validate attempts before giving up fail-closed. */
export const STEAM_DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Default on-disk floor (50 MiB). A real dedicated-server install is multiple GB,
 * so this comfortably clears a healthy install while still catching a wiped or
 * aborted download (which leaves only KB–MB behind). The StateFlags check is the
 * primary guard; the size floor is a cheap secondary sanity check.
 */
export const STEAM_DEFAULT_MIN_BYTES = 50 * 1024 * 1024;

export interface SteamInstallSpec {
  /** Steam dedicated-server app id (e.g. Valheim = 896660). */
  appId: number;
  /** Install target. Defaults to the shared install mount (/mnt/server). */
  installDir?: string;
  /** Minimum on-disk size, in bytes, for the install to count as complete. */
  minBytes?: number;
  /** Download/validate attempts before failing closed. */
  maxAttempts?: number;
  /** Optional Steam beta branch (emits `-beta <branch>`). */
  betaBranch?: string;
}

/** Structural shape of an egg install script (matches GameEgg.installScript). */
export interface SteamInstallScript {
  script: string;
  container: string;
  entrypoint: string;
}

/**
 * Build the verifying steam install shell script. Pure string builder so the
 * verify/retry/fail-closed contract can be unit-tested in isolation and under a
 * real shell (the whole point, exactly like wrapInstallScript).
 */
export function buildSteamInstallScript(spec: SteamInstallSpec): string {
  const appId = spec.appId;
  const installDir = spec.installDir ?? INSTALL_MOUNT;
  const minBytes = spec.minBytes ?? STEAM_DEFAULT_MIN_BYTES;
  const maxAttempts = spec.maxAttempts ?? STEAM_DEFAULT_MAX_ATTEMPTS;
  const beta = spec.betaBranch ? ` -beta ${spec.betaBranch}` : "";

  return [
    "#!/bin/sh",
    // No `set -e`: steamcmd routinely exits non-zero on transient network blips
    // that a subsequent attempt recovers from — we decide success by verifying the
    // result, not by steamcmd's exit code. `set -u` guards our own typos.
    "set -u",
    `INSTALL_DIR="${installDir}"`,
    `MANIFEST="$INSTALL_DIR/steamapps/appmanifest_${appId}.acf"`,
    `MIN_BYTES=${minBytes}`,
    `MAX_ATTEMPTS=${maxAttempts}`,
    "",
    "# A verified install = the app manifest reports fully-installed (StateFlags",
    "# == 4, i.e. no pending update) AND the tree clears the on-disk size floor.",
    "verify_install() {",
    '  [ -f "$MANIFEST" ] || return 1',
    `  _flags=$(sed -n 's/.*"StateFlags"[^"]*"\\([0-9][0-9]*\\)".*/\\1/p' "$MANIFEST" 2>/dev/null | head -n1)`,
    `  [ "$_flags" = "${STEAM_STATE_FULLY_INSTALLED}" ] || return 1`,
    '  _bytes=$(du -sb "$INSTALL_DIR" 2>/dev/null | cut -f1)',
    '  [ -n "$_bytes" ] && [ "$_bytes" -ge "$MIN_BYTES" ] 2>/dev/null || return 1',
    "  return 0",
    "}",
    "",
    "ok=0",
    "attempt=1",
    'while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do',
    `  echo "[steam-install] app_update ${appId} (attempt $attempt/$MAX_ATTEMPTS)"`,
    `  steamcmd +force_install_dir "${installDir}" +login anonymous +app_update ${appId}${beta} validate +quit \\`,
    `    || echo "[steam-install] steamcmd exited non-zero on attempt $attempt (will verify anyway)" >&2`,
    "  if verify_install; then",
    '    ok=1',
    '    echo "[steam-install] verified: manifest fully-installed and size floor met"',
    "    break",
    "  fi",
    '  echo "[steam-install] verification failed on attempt $attempt — re-downloading/validating" >&2',
    "  attempt=$((attempt + 1))",
    "done",
    "",
    // Fall through with a zero status on success so the wrapping install script
    // writes the .installed marker; exit non-zero on failure so it never does.
    'if [ "$ok" = 1 ]; then',
    '  echo "[steam-install] install complete"',
    "else",
    `  echo "[steam-install] FAILED after $MAX_ATTEMPTS attempts — corrupt or partial install; not marking installed" >&2`,
    "  exit 1",
    "fi",
  ].join("\n");
}

/**
 * SteamCMD dedicated-server app ids for the built-in eggs whose runtime image
 * installs at boot (so they have no install script of their own). Keyed by the
 * canonical egg id (post-alias).
 *
 * The verifying pre-install is only correct when the runtime image actually reads
 * the game binaries from a path on the PVC that our installDir writes to. Validated
 * against each image on the live cluster (PR #139 checklist). `installDir` defaults
 * to the shared mount root (/mnt/server); an image that installs to a volume SUBPATH
 * gets that subpath here.
 *
 *   - palworld (jammsen)   installs to the VOLUME ROOT /palworld and SKIPS its own
 *                          install when PalServer.sh already exists → our verified
 *                          pre-install to the mount root is authoritative. FITS.
 *   - rust (didstopia)     installs RustDedicated to the VOLUME ROOT /steamcmd/rust;
 *                          our pre-install lands there. It re-validates on boot
 *                          (RUST_START_MODE=0 default) — idempotent and safe. FITS.
 *   - satisfactory (wolveix) installs to the SUBPATH /config/gamefiles, not the
 *                          volume root, and self-heals only if gamefiles are missing.
 *                          Target the same subpath so the runtime reads our verified
 *                          tree. FITS via installDir subpath.
 *   - ark (hermsi/ark-server) reads the ARK dedicated server (appId 376030) from
 *                          /app/server. The egg now mounts the PVC there and launches
 *                          ShooterGameServer DIRECTLY (bypassing the image's arkmanager
 *                          updater), so our pre-install to the mount ROOT (default
 *                          installDir /mnt/server, which the runtime sees at /app/server)
 *                          is authoritative — same shape as palworld. FITS once the egg
 *                          is rewired (image ref + mountPath + startupCommand, done in
 *                          the same change). NOTE: image-pull + path mapping are verified;
 *                          the direct ShooterGameServer launch off the PVC still wants an
 *                          on-cluster smoke (steam runtime libs) before it is called
 *                          "validated" like the three above.
 *
 * EXCLUDED (validated on-cluster — a pre-install to the PVC would be ignored or junk):
 *   - valheim (lloesche)   keeps server binaries INSIDE the image at /opt/valheim and
 *                          uses the /config mount for saves/config ONLY (no VOLUME
 *                          declared). Pre-installing to /config is never read and just
 *                          pollutes the saves dir. The updater re-downloads every boot.
 *   - cs2 (cm2network/csgo) re-runs +app_update every boot and launches srcds with
 *                          -autoupdate, so it ignores the .installed marker (no durable
 *                          fail-closed guarantee). Worse, appId 740 is the LEGACY CS:GO
 *                          dedicated server; the CS2 server is a different image
 *                          (cm2network/cs2, appId 730). The egg needs an image/appId fix
 *                          before a pre-install is meaningful.
 *
 * Optional follow-up (not applied — keeps this change surgical): setting
 * RUST_START_MODE=2 (rust) / SKIPUPDATE=true (satisfactory) as egg env defaults makes
 * each image trust the pre-installed tree instead of re-downloading on every boot.
 */
export const STEAM_INSTALL_EGGS: Record<string, SteamInstallSpec> = {
  palworld: { appId: 2394010 },
  rust: { appId: 258550 },
  satisfactory: { appId: 1690800, installDir: `${INSTALL_MOUNT}/gamefiles` },
  // ARK reads /app/server (the egg's mountPath); that mount IS the PVC root, so the
  // default installDir (/mnt/server) lands the game exactly where the runtime reads.
  ark: { appId: 376030 },
};

/**
 * Build the installer init-container spec for a steam egg, or null when the egg
 * isn't one of the entrypoint-install steam eggs. Consumed by getEggForGameType,
 * which surfaces it as `egg.installScript` so route.ts builds the installer init
 * container and wrapInstallScript gates the `.installed` marker fail-closed.
 */
export function steamInstallScriptForEgg(eggId: string): SteamInstallScript | null {
  const spec = STEAM_INSTALL_EGGS[eggId];
  if (!spec) return null;
  return {
    script: buildSteamInstallScript(spec),
    container: STEAM_INSTALL_IMAGE,
    entrypoint: "/bin/sh",
  };
}
