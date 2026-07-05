import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTALL_MOUNT, RUNTIME_UID, wrapInstallScript } from "@/addons/gamehub/lib/install-wrapper";

// The wrapper's whole job is to write the .installed marker ONLY when the egg
// install script succeeds. Before the success gate, `touch .installed` ran
// unconditionally, so a failed download (0-byte server.jar) still set the marker
// and every restart skipped reinstall -> the runtime crashlooped forever on the
// corrupt artifact. These tests pin the gate behaviorally (run the script under a
// real shell) and structurally (string shape).

describe("wrapInstallScript — structure", () => {
  it("keeps the idempotency guard: skips and exits 0 when the marker exists", () => {
    const wrapped = wrapInstallScript("echo hi", true);
    expect(wrapped).toContain(`if [ -f "${INSTALL_MOUNT}/.installed" ]`);
    expect(wrapped).toContain("Already installed");
  });

  it("gates the marker behind the egg script's exit status (touch is inside then)", () => {
    const wrapped = wrapInstallScript("echo hi", true);
    const thenIdx = wrapped.indexOf("\nthen\n");
    const elseIdx = wrapped.indexOf("\nelse\n");
    const touchIdx = wrapped.indexOf(`touch "${INSTALL_MOUNT}/.installed"`);
    // marker write must live in the success branch, never unconditionally
    expect(thenIdx).toBeGreaterThan(-1);
    expect(elseIdx).toBeGreaterThan(thenIdx);
    expect(touchIdx).toBeGreaterThan(thenIdx);
    expect(touchIdx).toBeLessThan(elseIdx);
  });

  it("fails closed: else branch marks nothing and exits non-zero", () => {
    const wrapped = wrapInstallScript("echo hi", true);
    const elseBlock = wrapped.slice(wrapped.indexOf("\nelse\n"));
    expect(elseBlock).not.toContain("touch");
    expect(elseBlock).toContain("exit 1");
    expect(elseBlock).toContain("not marking installed");
  });

  it("chowns to the runtime uid for non-root eggs, inside the success branch", () => {
    const wrapped = wrapInstallScript("echo hi", false);
    const chown = `chown -R ${RUNTIME_UID}:${RUNTIME_UID} "${INSTALL_MOUNT}"`;
    expect(wrapped).toContain(chown);
    const thenIdx = wrapped.indexOf("\nthen\n");
    const elseIdx = wrapped.indexOf("\nelse\n");
    const chownIdx = wrapped.indexOf(chown);
    expect(chownIdx).toBeGreaterThan(thenIdx);
    expect(chownIdx).toBeLessThan(elseIdx);
  });

  it("omits the chown for root eggs (root already owns the files)", () => {
    expect(wrapInstallScript("echo hi", true)).not.toContain("chown");
  });

  it("does not inject `set -e` (parkervcp scripts fail non-zero benignly)", () => {
    expect(wrapInstallScript("echo hi", false)).not.toContain("set -e");
  });
});

describe("wrapInstallScript — behavior under a real shell", () => {
  let mount: string;

  beforeEach(() => {
    mount = mkdtempSync(join(tmpdir(), "iw-install-"));
  });
  afterEach(() => {
    rmSync(mount, { recursive: true, force: true });
  });

  const marker = () => join(mount, ".installed");
  // isRoot=true so the success path skips chown — the test process is non-root and
  // cannot chown to uid 1000. Marker gating is identical regardless of chown.
  const run = (script: string): { code: number } => {
    try {
      execFileSync("sh", ["-c", wrapInstallScript(script, true, mount)], { stdio: "pipe" });
      return { code: 0 };
    } catch (err) {
      return { code: (err as { status?: number }).status ?? 1 };
    }
  };

  it("writes the marker when the egg script succeeds", () => {
    const { code } = run("echo installing > /dev/null");
    expect(code).toBe(0);
    expect(existsSync(marker())).toBe(true);
  });

  it("does NOT write the marker when the egg script's final command fails", () => {
    // mirrors the bug: an install whose last step exits non-zero (failed curl)
    const { code } = run("false");
    expect(code).toBe(1);
    expect(existsSync(marker())).toBe(false);
  });

  it("does NOT write the marker when an early command fails but the shell would otherwise continue", () => {
    const { code } = run("exit 3");
    // explicit non-zero exit terminates the shell before the then/else split
    expect(code).not.toBe(0);
    expect(existsSync(marker())).toBe(false);
  });

  it("skips the egg script entirely once the marker exists", () => {
    execFileSync("sh", ["-c", `touch ${marker()}`]);
    const sentinel = join(mount, "ran");
    const { code } = run(`touch ${sentinel}`);
    expect(code).toBe(0);
    // guard fired -> egg script never ran -> sentinel absent
    expect(existsSync(sentinel)).toBe(false);
  });

  it("does not false-pass an egg that exits 0 mid-script (marker stays unset, no regression)", () => {
    // a success-path `exit 0` terminates the shell before the marker write; the
    // server simply reinstalls next boot rather than being wrongly marked done
    const { code } = run("echo done\nexit 0\necho unreached");
    expect(code).toBe(0);
    expect(existsSync(marker())).toBe(false);
  });
});
