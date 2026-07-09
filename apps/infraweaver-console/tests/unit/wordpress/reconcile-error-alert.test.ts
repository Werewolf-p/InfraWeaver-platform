// A gate reconcile that races a concurrent write can lock-wait until the Authentik
// client's request AbortController fires, surfacing as `SsoUnavailableError`. That
// failure must be (1) VISIBLE as its own distinct alert — not folded into the generic
// "reconcile failed" line where it reads like a code fault — and (2) RETRIED, i.e. it
// must NOT settle the site, so the next poll re-runs the idempotent reconcile. These
// tests pin both: the alert branch of `reportReconcileError`, and the end-to-end
// invariant that a `SsoUnavailableError` reconcile leaves the site eligible to retry.
jest.mock("server-only", () => ({}), { virtual: true });

// `@kubernetes/client-node` is ESM-only (jest's CJS runtime can't parse it) and is
// pulled in transitively by provision.ts's module graph. Our path throws at the first
// await (readIntent → readSecret) long before any k8s client is built, so empty class
// stubs are enough to let the module load.
jest.mock("@kubernetes/client-node", () => ({
  CoreV1Api: class {},
  AppsV1Api: class {},
  CustomObjectsApi: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  KubeConfig: class {},
}));
jest.mock("@/lib/k8s", () => ({ loadKubeConfig: jest.fn(() => ({ makeApiClient: () => ({}) })) }));

// `readIntent` (the first await in `reconcileSite`) reads the vault via `./openbao`.
// Rejecting `readSecret` drives a real `triggerReconcile → reconcileSite` rejection
// without standing up the whole k8s/vault graph — nothing past readIntent is reached.
jest.mock("@/addons/wordpress-manager/lib/openbao", () => ({
  readSecret: jest.fn(),
  writeSecret: jest.fn(),
  deleteSecret: jest.fn(),
}));

// The alert emitter talks to the k8s Events API. Mock it here so these tests
// assert only that `reportReconcileError` ROUTES to it (the emit-side dedup /
// one-per-window invariant is proven in reconcile-alerts.test.ts).
jest.mock("@/addons/wordpress-manager/lib/reconcile-alerts", () => ({
  emitSsoUnavailableAlert: jest.fn(),
  clearSsoUnavailableAlert: jest.fn(),
}));

import { reportReconcileError, triggerReconcile } from "@/addons/wordpress-manager/lib/provision";
import { readSecret } from "@/addons/wordpress-manager/lib/openbao";
import { emitSsoUnavailableAlert, clearSsoUnavailableAlert } from "@/addons/wordpress-manager/lib/reconcile-alerts";
import { SsoUnavailableError } from "@/lib/sso/errors";
import { ServiceUnavailableError } from "@/addons/wordpress-manager/lib/errors";

const readSecretMock = readSecret as jest.MockedFunction<typeof readSecret>;
const emitAlertMock = emitSsoUnavailableAlert as jest.MockedFunction<typeof emitSsoUnavailableAlert>;
const clearAlertMock = clearSsoUnavailableAlert as jest.MockedFunction<typeof clearSsoUnavailableAlert>;

/** Let the fire-and-forget `void reconcileSite(...)` chain (.catch/.finally) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reportReconcileError", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    emitAlertMock.mockReset();
    clearAlertMock.mockReset();
  });
  afterEach(() => warn.mockRestore());

  test("fires a DISTINCT Authentik-unavailable alert for SsoUnavailableError", () => {
    reportReconcileError("hi2", new SsoUnavailableError("Authentik request timed out after 10000ms"));

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].join(" ");
    // Distinct from the generic branch: names the site, the Authentik-unavailable
    // cause, and that it will retry — so an operator reads "transient", not "bug".
    expect(line).toContain("hi2");
    expect(line).toMatch(/Authentik unavailable/i);
    expect(line).toMatch(/retry/i);
    expect(line).toContain("timed out after 10000ms");
    // NOT the generic wording — proves it took its own branch.
    expect(line).not.toMatch(/reconcile for hi2 failed/);
  });

  test("routes SsoUnavailableError to the deduped platform alert (bell, not just logs)", () => {
    reportReconcileError("hi2", new SsoUnavailableError("Authentik request timed out after 10000ms"));
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
    expect(emitAlertMock).toHaveBeenCalledWith("hi2", "Authentik request timed out after 10000ms");
  });

  test("stays SILENT for ServiceUnavailableError (pod not ready — normal, retried)", () => {
    reportReconcileError("hi2", new ServiceUnavailableError("WordPress pod is not running yet"));
    expect(warn).not.toHaveBeenCalled();
    expect(emitAlertMock).not.toHaveBeenCalled();
  });

  test("logs GENERICALLY for an unexpected fault and raises NO SSO alert", () => {
    reportReconcileError("hi2", new Error("boom"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(" ")).toMatch(/reconcile for hi2 failed/);
    expect(emitAlertMock).not.toHaveBeenCalled();
  });
});

describe("triggerReconcile — SsoUnavailableError is alerted AND retried (not swallowed)", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    readSecretMock.mockReset();
    emitAlertMock.mockReset();
    clearAlertMock.mockReset();
  });
  afterEach(() => warn.mockRestore());

  test("a timed-out gate reconcile leaves the site UNSETTLED so the next poll retries", async () => {
    const site = "alerttest";
    // Authentik unreachable mid-reconcile.
    readSecretMock.mockRejectedValue(new SsoUnavailableError("Authentik is unreachable"));

    triggerReconcile(site);
    await flush();

    // (1) The distinct alert fired — both the log line and the platform alert.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(" ")).toMatch(/Authentik unavailable/i);
    expect(emitAlertMock).toHaveBeenCalledWith(site, "Authentik is unreachable");
    // (2) The reconcile actually ran (readIntent → readSecret hit once).
    expect(readSecretMock).toHaveBeenCalledTimes(1);

    // (3) RETRY PROOF: the site was NOT settled, so a second trigger re-enters
    // reconcileSite (readSecret hit again). Had it settled, this would no-op.
    triggerReconcile(site);
    await flush();
    expect(readSecretMock).toHaveBeenCalledTimes(2);
  });

  test("a recovered reconcile clears the alert guard so a future outage re-arms", async () => {
    const site = "recovertest";
    // First pass succeeds end-to-end (readIntent finds nothing to apply → settles).
    readSecretMock.mockResolvedValue(null);

    triggerReconcile(site);
    await flush();

    // Recovery/settle clears the SSO alert guard.
    expect(clearAlertMock).toHaveBeenCalledWith(site);
    expect(emitAlertMock).not.toHaveBeenCalled();
  });
});
