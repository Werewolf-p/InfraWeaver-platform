// A stuck SSO gate re-fails on EVERY dashboard poll, so `emitSsoUnavailableAlert`
// is called once per poll for as long as Authentik is down. These tests pin the
// core invariant: exactly ONE platform Event is published per outage window (not
// one per poll), the guard re-arms after the site recovers, and a publish failure
// never rejects into the reconcile loop.
jest.mock("server-only", () => ({}), { virtual: true });

const createNamespacedEvent = jest.fn().mockResolvedValue({});
jest.mock("@/lib/kube-client", () => ({
  makeCoreApi: () => ({ createNamespacedEvent }),
}));

import {
  emitSsoUnavailableAlert,
  clearSsoUnavailableAlert,
  __resetSsoAlertsForTest,
} from "@/addons/wordpress-manager/lib/reconcile-alerts";

/** Let the fire-and-forget `void publishGateStuckEvent(...)` chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("emitSsoUnavailableAlert — one alert per outage window, not per poll", () => {
  beforeEach(() => {
    createNamespacedEvent.mockClear().mockResolvedValue({});
    __resetSsoAlertsForTest();
  });

  test("publishes exactly ONE Event across many failing polls in one outage window", async () => {
    // Simulate 5 dashboard polls, each re-hitting the same stuck gate.
    for (let poll = 0; poll < 5; poll++) {
      emitSsoUnavailableAlert("truenas", "Authentik request timed out after 10000ms");
      await flush();
    }
    expect(createNamespacedEvent).toHaveBeenCalledTimes(1);
  });

  test("re-arms after recovery: a fresh outage publishes a second Event", async () => {
    emitSsoUnavailableAlert("truenas", "Authentik is unreachable");
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(1);

    // Site recovered (successful reconcile clears the guard).
    clearSsoUnavailableAlert("truenas");

    // Later, a NEW outage — must alert again, not be deduped away.
    emitSsoUnavailableAlert("truenas", "Authentik is unreachable");
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(2);
  });

  test("dedups PER SITE — two stuck sites each get their own alert", async () => {
    emitSsoUnavailableAlert("truenas", "boom");
    emitSsoUnavailableAlert("synology", "boom");
    emitSsoUnavailableAlert("truenas", "boom"); // dup — no new Event
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(2);
  });

  test("publishes a Warning Event on the site's Deployment that names the cause", async () => {
    emitSsoUnavailableAlert("truenas", "Authentik request timed out after 10000ms");
    await flush();

    const arg = createNamespacedEvent.mock.calls[0][0];
    expect(arg.namespace).toBe("wordpress");
    expect(arg.body.type).toBe("Warning");
    expect(arg.body.involvedObject).toMatchObject({ kind: "Deployment", name: "truenas" });
    expect(arg.body.reason).toBe("SsoGateUnavailable");
    expect(arg.body.message).toContain("truenas");
    expect(arg.body.message).toContain("timed out after 10000ms");
  });

  test("a failed publish re-arms so the next poll retries (never swallows the outage)", async () => {
    createNamespacedEvent.mockRejectedValueOnce(new Error("Forbidden"));

    emitSsoUnavailableAlert("truenas", "boom");
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(1); // attempted, failed

    emitSsoUnavailableAlert("truenas", "boom");
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(2); // retried, succeeded
  });

  test("never rejects — a publish failure must not wedge the reconcile loop", async () => {
    createNamespacedEvent.mockRejectedValue(new Error("API down"));
    expect(() => emitSsoUnavailableAlert("truenas", "boom")).not.toThrow();
    await flush();
  });
});

describe("emitSsoUnavailableAlert — re-publishes so a long outage survives Event GC", () => {
  // Kubernetes GCs the Warning Event at the apiserver Event TTL (~1h). A plain
  // publish-once guard would leave a >1h outage with no live Event on the bell.
  // These pin the refresh: deduped WITHIN the window, re-published AFTER it.
  const REPUBLISH_MS = 30 * 60 * 1000;
  const t0 = 1_000_000_000_000; // fixed base so `now` is fully deterministic

  beforeEach(() => {
    createNamespacedEvent.mockClear().mockResolvedValue({});
    __resetSsoAlertsForTest();
  });

  test("re-publishes a fresh Event once the refresh window elapses in one outage", async () => {
    emitSsoUnavailableAlert("truenas", "boom", t0);
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(1);

    // Still inside the window — deduped, no new Event.
    emitSsoUnavailableAlert("truenas", "boom", t0 + REPUBLISH_MS - 1);
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(1);

    // Window elapsed, gate still stuck — refresh so the bell keeps a live Event.
    emitSsoUnavailableAlert("truenas", "boom", t0 + REPUBLISH_MS);
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(2);

    // Back inside the fresh window — deduped again.
    emitSsoUnavailableAlert("truenas", "boom", t0 + REPUBLISH_MS + 1);
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(2);
  });

  test("recovery resets the window so the next outage re-publishes immediately", async () => {
    emitSsoUnavailableAlert("truenas", "boom", t0);
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(1);

    clearSsoUnavailableAlert("truenas"); // successful reconcile

    // New outage moments later — must alert now, not wait out the refresh window.
    emitSsoUnavailableAlert("truenas", "boom", t0 + 1000);
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(2);
  });

  test("a failed refresh re-arms so the next poll retries immediately", async () => {
    emitSsoUnavailableAlert("truenas", "boom", t0);
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(1);

    // Refresh attempt fails (e.g. transient API error) — guard must drop.
    createNamespacedEvent.mockRejectedValueOnce(new Error("Forbidden"));
    emitSsoUnavailableAlert("truenas", "boom", t0 + REPUBLISH_MS);
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(2); // attempted, failed

    // Next poll (no need to wait another window) lands the alert.
    emitSsoUnavailableAlert("truenas", "boom", t0 + REPUBLISH_MS + 1000);
    await flush();
    expect(createNamespacedEvent).toHaveBeenCalledTimes(3); // retried, succeeded
  });
});
