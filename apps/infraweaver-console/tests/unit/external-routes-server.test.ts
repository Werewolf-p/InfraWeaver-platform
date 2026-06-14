import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { rmSync } from "fs";
import { createExternalRoute, loadExternalRoutes } from "@/lib/external-routes-server";

const MANIFEST_DIR = path.join("kubernetes", "platform", "external-routes", "manifests");

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
}

function setupRepo(): { work: string; bare: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "iw-routes-"));
  const bare = path.join(root, "remote.git");
  const work = path.join(root, "work");
  mkdirSync(bare);
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" });
  execFileSync("git", ["clone", bare, work], { stdio: "pipe" });
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");

  const manifestPath = path.join(work, MANIFEST_DIR);
  mkdirSync(manifestPath, { recursive: true });
  // Seed an existing route file mirroring the real repo (06-routes-cluster.yaml).
  writeFileSync(
    path.join(manifestPath, "06-routes-cluster.yaml"),
    `---\napiVersion: traefik.io/v1alpha1\nkind: IngressRoute\nmetadata:\n  name: test-website-platform\n  namespace: traefik\n  labels:\n    infraweaver.io/access-tier: public\nspec:\n  entryPoints:\n    - websecure\n  routes:\n    - match: Host(\`test.example.com\`)\n      kind: Rule\n      services:\n        - name: test-website\n          port: 80\n`,
    "utf8",
  );
  writeFileSync(path.join(manifestPath, "04-backends-cluster.yaml"), "", "utf8");
  git(work, "add", "-A");
  git(work, "commit", "-m", "seed");
  git(work, "push", "origin", "main");
  return { work, bare };
}

describe("createExternalRoute — bitwarden repro", () => {
  it("adds bitwarden.rlservers.com -> 10.25.0.135:30032 (baremetal)", async () => {
    const { work } = setupRepo();

    const result = await createExternalRoute(
      {
        name: "bitwarden",
        host: "bitwarden.rlservers.com",
        accessTier: "public",
        targetType: "baremetal",
        targetPort: 30032,
        targetIP: "10.25.0.135",
        enableAuth: false,
        scheme: "http",
      },
      work,
    );

    // The new route should be discoverable
    const names = result.routes.map((r) => r.name);
    expect(names).toContain("bitwarden");

    // Manifest file for the public tier should exist on disk
    const publicFile = path.join(work, MANIFEST_DIR, "08-routes-external.yaml");
    expect(existsSync(publicFile)).toBe(true);
    const content = readFileSync(publicFile, "utf8");
    expect(content).toContain("bitwarden.rlservers.com");

    // Existing seeded route should still be visible
    const all = await loadExternalRoutes(work);
    expect(all.routes.map((r) => r.name)).toEqual(
      expect.arrayContaining(["bitwarden", "test-website-platform"]),
    );

    // Backend Service + Endpoints should target 10.25.0.135:30032
    const backends = readFileSync(path.join(work, MANIFEST_DIR, "05-backends-baremetal.yaml"), "utf8");
    expect(backends).toContain("10.25.0.135");
    expect(backends).toContain("30032");
    expect(backends).toContain("kind: Endpoints");

    const bitwarden = all.routes.find((r) => r.name === "bitwarden")!;
    expect(bitwarden.targetType).toBe("baremetal");
    expect(bitwarden.targetIP).toBe("10.25.0.135");
    expect(bitwarden.targetPort).toBe(30032);
    expect(bitwarden.hosts).toContain("bitwarden.rlservers.com");
  });

  it("gives a clear error (not an opaque 500) when repoDir is not a git repo", async () => {
    const { work } = setupRepo();
    rmSync(path.join(work, ".git"), { recursive: true, force: true });

    await expect(
      createExternalRoute(
        { name: "vault", host: "vault.rlservers.com", accessTier: "public", targetType: "baremetal", targetPort: 8200, targetIP: "10.25.0.140" },
        work,
      ),
    ).rejects.toThrow(/not a git repository/i);
  });
});
