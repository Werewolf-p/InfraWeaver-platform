// Saving a route that requires Authentik (internal tier, or public with the auth
// checkmark) must ALSO ensure the Authentik forward-auth gate exists — otherwise
// the Traefik forward-auth middleware points at a provider Authentik never created
// and login 404s. These tests pin: the gate is ensured on save for gated routes,
// skipped for un-gated routes and when Authentik isn't configured, and a gate
// failure degrades to a warning (never blocks the committed manifest save).
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import os from "os";
import path from "path";

const ensureSsoGate = jest.fn().mockResolvedValue({ gated: true });
jest.mock("@/lib/sso/sso-gate", () => ({ ensureSsoGate }));

import { createExternalRoute } from "@/lib/external-routes-server";
import { SsoUnavailableError } from "@/lib/sso/errors";

const MANIFEST_DIR = path.join("kubernetes", "platform", "external-routes", "manifests");

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
}

function setupRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "iw-routegate-"));
  const bare = path.join(root, "remote.git");
  const work = path.join(root, "work");
  mkdirSync(bare);
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" });
  execFileSync("git", ["clone", bare, work], { stdio: "pipe" });
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  mkdirSync(path.join(work, MANIFEST_DIR), { recursive: true });
  writeFileSync(path.join(work, MANIFEST_DIR, "04-backends-cluster.yaml"), "", "utf8");
  git(work, "add", "-A");
  git(work, "commit", "-m", "seed");
  git(work, "push", "origin", "main");
  return work;
}

const ORIGINAL_ENV = { url: process.env.AUTHENTIK_URL, token: process.env.AUTHENTIK_TOKEN };
function configureAuthentik() {
  process.env.AUTHENTIK_URL = "https://authentik.example.com";
  process.env.AUTHENTIK_TOKEN = "test-token";
}
function unconfigureAuthentik() {
  delete process.env.AUTHENTIK_URL;
  delete process.env.AUTHENTIK_TOKEN;
}

describe("createExternalRoute — ensures the Authentik gate on save", () => {
  beforeEach(() => ensureSsoGate.mockClear().mockResolvedValue({ gated: true }));
  afterEach(() => {
    process.env.AUTHENTIK_URL = ORIGINAL_ENV.url;
    process.env.AUTHENTIK_TOKEN = ORIGINAL_ENV.token;
  });

  test("internal route ensures a gate provider for the normalized internal host", async () => {
    configureAuthentik();
    const work = setupRepo();

    const result = await createExternalRoute(
      { name: "truenas", host: "truenas.rlservers.com", accessTier: "internal", targetType: "baremetal", targetPort: 443, targetIP: "10.25.0.50" },
      work,
    );

    expect(ensureSsoGate).toHaveBeenCalledTimes(1);
    const [gateInput] = ensureSsoGate.mock.calls[0];
    expect(gateInput).toMatchObject({ mode: "gate", appSlug: "route-truenas" });
    // Internal tier normalizes the host onto the internal wildcard domain; the gate
    // MUST target that exact host or forward-auth 404s.
    expect(gateInput.host).toBe("truenas.int.example.com");
    // The manifest was still committed.
    expect(result.routes.map((r) => r.name)).toContain("truenas");
    expect(result.gateWarning).toBeUndefined();
  });

  test("public route with the auth checkmark ensures a gate", async () => {
    configureAuthentik();
    const work = setupRepo();

    await createExternalRoute(
      { name: "vault", host: "vault.example.com", accessTier: "public", targetType: "baremetal", targetPort: 8200, targetIP: "10.25.0.60", enableAuth: true },
      work,
    );

    expect(ensureSsoGate).toHaveBeenCalledTimes(1);
    expect(ensureSsoGate.mock.calls[0][0]).toMatchObject({ mode: "gate", appSlug: "route-vault", host: "vault.example.com" });
  });

  test("public route WITHOUT auth does not touch Authentik", async () => {
    configureAuthentik();
    const work = setupRepo();

    await createExternalRoute(
      { name: "status", host: "status.example.com", accessTier: "public", targetType: "baremetal", targetPort: 80, targetIP: "10.25.0.70", enableAuth: false },
      work,
    );

    expect(ensureSsoGate).not.toHaveBeenCalled();
  });

  test("no Authentik configured → gate ensure is skipped (fork without SSO still saves routes)", async () => {
    unconfigureAuthentik();
    const work = setupRepo();

    const result = await createExternalRoute(
      { name: "truenas", host: "truenas.rlservers.com", accessTier: "internal", targetType: "baremetal", targetPort: 443, targetIP: "10.25.0.50" },
      work,
    );

    expect(ensureSsoGate).not.toHaveBeenCalled();
    expect(result.routes.map((r) => r.name)).toContain("truenas");
    expect(result.gateWarning).toBeUndefined();
  });

  test("a momentary Authentik outage degrades to a warning — the route still commits", async () => {
    configureAuthentik();
    ensureSsoGate.mockRejectedValueOnce(new SsoUnavailableError("Authentik is unreachable"));
    const work = setupRepo();

    const result = await createExternalRoute(
      { name: "truenas", host: "truenas.rlservers.com", accessTier: "internal", targetType: "baremetal", targetPort: 443, targetIP: "10.25.0.50" },
      work,
    );

    // Route committed to the manifest despite the gate failure.
    expect(result.routes.map((r) => r.name)).toContain("truenas");
    const internalFile = readFileSync(path.join(work, MANIFEST_DIR, "07-routes-internal.yaml"), "utf8");
    expect(internalFile).toContain("truenas.int.example.com");
    // ...and the operator is told to save again to retry the gate.
    expect(result.gateWarning).toMatch(/save again/i);
    expect(result.gateWarning).toContain("Authentik is unreachable");
  });
});
