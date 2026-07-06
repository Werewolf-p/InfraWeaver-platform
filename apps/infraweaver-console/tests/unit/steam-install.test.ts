import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTALL_MOUNT, wrapInstallScript } from "@/addons/gamehub/lib/install-wrapper";
import {
  STEAM_INSTALL_EGGS,
  STEAM_INSTALL_IMAGE,
  buildSteamInstallScript,
  steamInstallScriptForEgg,
} from "@/addons/gamehub/lib/steam-install";

// SteamCMD game eggs (palworld/valheim/ark/rust/cs2/satisfactory) install at boot
// via a third-party image entrypoint, so PR#137's marker/success-gate never ran
// for them. A steamcmd that HANGS mid-download or EXITS 0 on a truncated/corrupt
// install left a partial tree the runtime then served (or crashlooped on) while
// the pod reported healthy. This builder closes that gap: it re-runs the install
// ourselves in an init container, VERIFIES the Steam app manifest + on-disk size,
// re-downloads (validate) on mismatch, and — composed with wrapInstallScript —
// writes the .installed marker fail-closed (only when verification passes).

describe("buildSteamInstallScript — structure", () => {
  const script = buildSteamInstallScript({ appId: 896660 });

  it("runs steamcmd +app_update <appId> with validate against the install dir", () => {
    expect(script).toContain("+force_install_dir");
    expect(script).toContain("+login anonymous");
    expect(script).toContain("+app_update 896660");
    // validate makes steamcmd re-hash and repair a partial/corrupt tree
    expect(script).toContain("validate");
    expect(script).toContain("+quit");
  });

  it("verifies the app manifest StateFlags is fully-installed (4)", () => {
    expect(script).toContain(`appmanifest_896660.acf`);
    expect(script).toContain("StateFlags");
    // 4 == StateFlagFullyInstalled with no pending update
    expect(script).toMatch(/StateFlags[\s\S]*?\b4\b/);
  });

  it("verifies the installed tree meets a minimum on-disk size floor", () => {
    expect(script).toMatch(/du\s+-sb/);
    // default floor is present as a concrete byte count
    expect(script).toMatch(/-ge\s+"?\$?\{?MIN_BYTES/);
  });

  it("retries the download/validate before giving up", () => {
    expect(script).toContain("MAX_ATTEMPTS");
    expect(script).toMatch(/attempt/i);
    const dflt = buildSteamInstallScript({ appId: 1 });
    expect(dflt).toMatch(/MAX_ATTEMPTS=3\b/);
  });

  it("fails closed: exits non-zero when verification never passes", () => {
    // wrapInstallScript only writes the marker when this script exits 0, so a
    // fail-closed exit is what keeps a corrupt install from being marked done.
    expect(script).toContain("exit 1");
    expect(script).toMatch(/not marking installed|FAILED/i);
  });

  it("does NOT call `exit 0` on the success path (would bypass the marker write)", () => {
    // wrapInstallScript runs this script as the condition of an `if`; an explicit
    // success-path `exit 0` would terminate the shell before the marker touch.
    // Success must fall through with a 0 status instead.
    expect(script).not.toMatch(/(^|\n)\s*exit 0\b/);
  });

  it("honors an explicit install dir, floor, attempts, and beta branch", () => {
    const custom = buildSteamInstallScript({
      appId: 258550,
      installDir: "/data/rust",
      minBytes: 1234,
      maxAttempts: 5,
      betaBranch: "prerelease",
    });
    expect(custom).toContain(`+force_install_dir "/data/rust"`);
    expect(custom).toContain("appmanifest_258550.acf");
    expect(custom).toMatch(/MIN_BYTES=1234\b/);
    expect(custom).toMatch(/MAX_ATTEMPTS=5\b/);
    expect(custom).toContain("-beta prerelease");
  });

  it("defaults the install dir to the shared install mount", () => {
    expect(buildSteamInstallScript({ appId: 5 })).toContain(`+force_install_dir "${INSTALL_MOUNT}"`);
  });

  it("hands the verified tree to the runtime user (chown 1000:1000) so it can write saves", () => {
    // hermsi/ark-server (and the other steam images) gosu-drop to uid/gid 1000 and
    // must create Saved/ + Mods/ under the install tree, which steamcmd installs as
    // root. Without this chown the runtime crashes with EACCES on those mkdirs.
    expect(script).toMatch(/chown\s+-R\s+1000:1000\s+"\$INSTALL_DIR"/);
    // must be non-fatal so a non-root installer still falls through 0 -> marker write
    expect(script).toMatch(/chown[\s\S]*?\|\|\s*echo/);
  });

  it("honors an explicit runtime owner uid/gid for the chown", () => {
    const custom = buildSteamInstallScript({ appId: 1, ownerUid: 999, ownerGid: 998 });
    expect(custom).toMatch(/chown\s+-R\s+999:998\s+"\$INSTALL_DIR"/);
  });

  it("emits a POSIX-sh-parseable script (sh -n clean)", () => {
    // Guards against an unbalanced if/while/fi that would corrupt the init.
    expect(() => execFileSync("sh", ["-n", "-c", script], { stdio: "pipe" })).not.toThrow();
  });
});

describe("steamInstallScriptForEgg / STEAM_INSTALL_EGGS", () => {
  it("covers exactly the steam eggs whose image reads binaries from the PVC", () => {
    // valheim/cs2 are deliberately excluded — their images keep binaries in the
    // image or ignore the marker (see STEAM_INSTALL_EGGS doc + PR #139 checklist).
    // ark is included: hermsi/ark-server reads /app/server, which the egg mounts at
    // the PVC root, so the pre-install to /mnt/server is authoritative.
    expect(Object.keys(STEAM_INSTALL_EGGS).sort()).toEqual(
      ["ark", "palworld", "rust", "satisfactory"].sort(),
    );
  });

  it("targets the wolveix subpath for satisfactory, not the volume root", () => {
    const spec = steamInstallScriptForEgg("satisfactory");
    expect(spec?.script).toContain('+force_install_dir "/mnt/server/gamefiles"');
    expect(spec?.script).toContain('INSTALL_DIR="/mnt/server/gamefiles"');
    expect(spec?.script).toContain("appmanifest_1690800.acf");
  });

  it.each(["valheim", "cs2", "csgo"])(
    "does NOT pre-install the excluded steam egg %s",
    (eggId) => {
      expect(steamInstallScriptForEgg(eggId)).toBeNull();
    },
  );

  it("pre-installs ark to the volume ROOT so the /app/server mount reads it", () => {
    const spec = steamInstallScriptForEgg("ark");
    expect(spec).not.toBeNull();
    expect(spec?.container).toBe(STEAM_INSTALL_IMAGE);
    // ARK appId 376030, default installDir = the shared mount root (/mnt/server).
    expect(spec?.script).toContain("+app_update 376030");
    expect(spec?.script).toContain('+force_install_dir "/mnt/server"');
    expect(spec?.script).toContain("appmanifest_376030.acf");
  });

  it("returns a runnable install-script spec for a steam egg", () => {
    const spec = steamInstallScriptForEgg("palworld");
    expect(spec).not.toBeNull();
    expect(spec?.container).toBe(STEAM_INSTALL_IMAGE);
    expect(spec?.entrypoint).toBe("/bin/sh");
    expect(spec?.script).toContain("+app_update 2394010");
  });

  it("returns null for a non-steam / unknown egg", () => {
    expect(steamInstallScriptForEgg("minecraft-java")).toBeNull();
    expect(steamInstallScriptForEgg("nope")).toBeNull();
  });
});

// End-to-end behavior: run the wrapped steam script under a real shell with a
// FAKE steamcmd on PATH that fabricates a Steam appmanifest, so we can prove the
// verify/retry/fail-closed marker gate the way the wrapper test does for eggs.
describe("buildSteamInstallScript — behavior under a real shell", () => {
  let mount: string;
  let bin: string;
  const APP_ID = 896660;

  beforeEach(() => {
    mount = mkdtempSync(join(tmpdir(), "iw-steam-"));
    bin = mkdtempSync(join(tmpdir(), "iw-bin-"));
  });
  afterEach(() => {
    rmSync(mount, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const marker = () => join(mount, ".installed");
  const countFile = () => join(bin, "count");

  /**
   * Install a fake `steamcmd` that parses +force_install_dir / +app_update, then
   * writes a fabricated appmanifest + payload into <dir>/steamapps.
   *  - flagsFor(n): StateFlags to write on the n-th (1-based) invocation
   *  - bytes: size of the payload file it drops (drives the size floor check)
   */
  const installFakeSteamcmd = (opts: { flagsFor: (n: number) => number; bytes: number }) => {
    writeFileSync(countFile(), "0");
    const fake = [
      "#!/bin/sh",
      'dir=""; app=""',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      '    +force_install_dir) dir="$2"; shift 2 ;;',
      '    +app_update) app="$2"; shift 2 ;;',
      "    *) shift ;;",
      "  esac",
      "done",
      `n=$(cat "${countFile()}"); n=$((n + 1)); echo "$n" > "${countFile()}"`,
      `flags=$(awk -v n="$n" 'BEGIN{ ${Array.from({ length: 8 }, (_, i) => `if(n==${i + 1}) print ${opts.flagsFor(i + 1)};`).join(" ")} }')`,
      '[ -z "$flags" ] && flags=4',
      'mkdir -p "$dir/steamapps"',
      `head -c ${opts.bytes} /dev/zero > "$dir/payload.bin"`,
      'printf \'"AppState"\\n{\\n\\t"appid"\\t\\t"%s"\\n\\t"StateFlags"\\t\\t"%s"\\n}\\n\' "$app" "$flags" > "$dir/steamapps/appmanifest_$app.acf"',
      "exit 0",
    ].join("\n");
    const p = join(bin, "steamcmd");
    writeFileSync(p, fake);
    chmodSync(p, 0o755);
  };

  const runWrapped = (spec: Parameters<typeof buildSteamInstallScript>[0]): { code: number } => {
    const script = wrapInstallScript(buildSteamInstallScript({ installDir: mount, ...spec }), true, mount);
    try {
      execFileSync("sh", ["-c", script], { stdio: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      return { code: 0 };
    } catch (err) {
      return { code: (err as { status?: number }).status ?? 1 };
    }
  };

  const attempts = () => Number.parseInt(readFileSync(countFile(), "utf8").trim(), 10);

  it("writes the marker when steamcmd installs a fully-installed, big-enough tree", () => {
    installFakeSteamcmd({ flagsFor: () => 4, bytes: 4096 });
    const { code } = runWrapped({ appId: APP_ID, minBytes: 1024 });
    expect(code).toBe(0);
    expect(existsSync(marker())).toBe(true);
    expect(attempts()).toBe(1); // verified first try, no needless re-download
  });

  it("fails closed: StateFlags never reaches 4 -> non-zero, no marker, exhausts retries", () => {
    installFakeSteamcmd({ flagsFor: () => 1027 /* update-required bits, not fully installed */, bytes: 4096 });
    const { code } = runWrapped({ appId: APP_ID, minBytes: 1024, maxAttempts: 3 });
    expect(code).not.toBe(0);
    expect(existsSync(marker())).toBe(false);
    expect(attempts()).toBe(3);
  });

  it("fails closed on a truncated install: StateFlags=4 but under the size floor", () => {
    installFakeSteamcmd({ flagsFor: () => 4, bytes: 64 });
    const { code } = runWrapped({ appId: APP_ID, minBytes: 10 * 1024 * 1024, maxAttempts: 2 });
    expect(code).not.toBe(0);
    expect(existsSync(marker())).toBe(false);
    expect(attempts()).toBe(2);
  });

  it("self-heals: re-downloads and marks installed once a later attempt verifies", () => {
    // corrupt on attempt 1, clean on attempt 2
    installFakeSteamcmd({ flagsFor: (n) => (n >= 2 ? 4 : 6 /* update started */), bytes: 4096 });
    const { code } = runWrapped({ appId: APP_ID, minBytes: 1024, maxAttempts: 3 });
    expect(code).toBe(0);
    expect(existsSync(marker())).toBe(true);
    expect(attempts()).toBe(2);
  });

  it("skips steamcmd entirely once the marker exists (idempotent fast restart)", () => {
    installFakeSteamcmd({ flagsFor: () => 4, bytes: 4096 });
    writeFileSync(marker(), "");
    const { code } = runWrapped({ appId: APP_ID, minBytes: 1024 });
    expect(code).toBe(0);
    expect(attempts()).toBe(0); // guard fired -> steamcmd never invoked
  });
});
