import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildContainerRealpathGuard,
  PATH_ESCAPE_MARKER,
  type ContainerPathTarget,
} from "@/lib/validate";

// Mirror of game-hub-server's shellQuote — importing the real one drags in the
// ESM-only @kubernetes/client-node, which jest cannot transform.
function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Runs the generated guard under a real `sh` against a real filesystem — the
// same way it executes inside a game container — so symlink resolution is
// tested for real, not simulated.
function runGuard(root: string, targets: ContainerPathTarget[]): { escaped: boolean; status: number } {
  const script = buildContainerRealpathGuard(root, targets, shellQuote);
  try {
    const stdout = execFileSync("sh", ["-c", `${script}\necho GUARD_PASSED`], { encoding: "utf8" });
    return { escaped: stdout.includes(PATH_ESCAPE_MARKER), status: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; status?: number };
    return { escaped: (failed.stdout ?? "").includes(PATH_ESCAPE_MARKER), status: failed.status ?? 1 };
  }
}

describe("buildContainerRealpathGuard", () => {
  let dataRoot: string;
  let outside: string;

  beforeEach(() => {
    // Arrange: /tmp/.../data is the "PVC", /tmp/.../outside is the host fs.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "iw-guard-"));
    dataRoot = path.join(base, "data");
    outside = path.join(base, "outside");
    fs.mkdirSync(path.join(dataRoot, "world"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "server.properties"), "motd=hi\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "token\n");
    // The H1 primitives: a dir symlink and a file symlink escaping the root.
    fs.symlinkSync(outside, path.join(dataRoot, "escape-dir"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dataRoot, "escape-file"));
    // A benign in-root symlink.
    fs.symlinkSync(path.join(dataRoot, "world"), path.join(dataRoot, "world-link"));
  });

  it("allows a real directory inside the root", () => {
    const result = runGuard(dataRoot, [{ path: path.join(dataRoot, "world"), kind: "existing-dir" }]);
    expect(result.escaped).toBe(false);
    expect(result.status).toBe(0);
  });

  it("rejects listing through a symlinked directory that escapes the root", () => {
    const result = runGuard(dataRoot, [{ path: path.join(dataRoot, "escape-dir"), kind: "existing-dir" }]);
    expect(result.escaped).toBe(true);
  });

  it("rejects a path that tunnels through an escaping symlink mid-path", () => {
    const result = runGuard(dataRoot, [
      { path: path.join(dataRoot, "escape-dir", "secret.txt"), kind: "existing-file" },
    ]);
    expect(result.escaped).toBe(true);
  });

  it("rejects reading a symlink file even when its parent is in-root", () => {
    const result = runGuard(dataRoot, [{ path: path.join(dataRoot, "escape-file"), kind: "existing-file" }]);
    expect(result.escaped).toBe(true);
  });

  it("allows reading a regular file inside the root", () => {
    const result = runGuard(dataRoot, [{ path: path.join(dataRoot, "server.properties"), kind: "existing-file" }]);
    expect(result.escaped).toBe(false);
  });

  it("rejects a destination whose existing ancestor resolves outside the root", () => {
    const result = runGuard(dataRoot, [
      { path: path.join(dataRoot, "escape-dir", "new", "file.txt"), kind: "destination" },
    ]);
    expect(result.escaped).toBe(true);
  });

  it("rejects writing onto an existing symlink destination", () => {
    const result = runGuard(dataRoot, [{ path: path.join(dataRoot, "escape-file"), kind: "destination" }]);
    expect(result.escaped).toBe(true);
  });

  it("allows a destination with not-yet-existing nested components", () => {
    const result = runGuard(dataRoot, [
      { path: path.join(dataRoot, "world", "region", "r.0.0.mca"), kind: "destination" },
    ]);
    expect(result.escaped).toBe(false);
  });

  it("allows deleting a symlink itself (entry kind resolves only the parent)", () => {
    const result = runGuard(dataRoot, [{ path: path.join(dataRoot, "escape-file"), kind: "entry" }]);
    expect(result.escaped).toBe(false);
  });

  it("rejects an entry whose parent directory escapes the root", () => {
    const result = runGuard(dataRoot, [
      { path: path.join(dataRoot, "escape-dir", "secret.txt"), kind: "entry" },
    ]);
    expect(result.escaped).toBe(true);
  });

  it("allows a benign in-root symlinked directory", () => {
    const result = runGuard(dataRoot, [{ path: path.join(dataRoot, "world-link"), kind: "existing-dir" }]);
    expect(result.escaped).toBe(false);
  });

  it("rejects a nonexistent root", () => {
    const result = runGuard(path.join(dataRoot, "missing-root"), [
      { path: path.join(dataRoot, "missing-root", "x"), kind: "destination" },
    ]);
    expect(result.escaped).toBe(true);
  });

  it("permits everything under a '/' root", () => {
    const result = runGuard("/", [{ path: dataRoot, kind: "existing-dir" }]);
    expect(result.escaped).toBe(false);
  });

  it("throws on a target that fails lexical validation", () => {
    expect(() =>
      buildContainerRealpathGuard(dataRoot, [{ path: "../etc/passwd", kind: "existing-file" }], shellQuote),
    ).toThrow("Invalid container target path");
  });

  it("throws on a shell-unsafe root", () => {
    expect(() => buildContainerRealpathGuard("/data'$(id)", [], shellQuote)).toThrow("Invalid container root path");
  });
});
