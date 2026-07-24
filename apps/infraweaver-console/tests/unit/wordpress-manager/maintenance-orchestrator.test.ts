/** @jest-environment node */
// Maintenance ORCHESTRATOR — the mutual-exclusion contract. The heavy I/O leaves
// (signed op, provision, managed link) are stubbed so the module loads; the
// decision, merge and orchestration are exercised with injected fake deps so the
// "never let both 503 layers fight" invariant is proven executably.

jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed", () => ({ getManagedLink: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/provision", () => ({ getMaintenanceMode: jest.fn(), setMaintenanceMode: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({ setConnectorMaintenance: jest.fn(), siteHealthSnapshot: jest.fn() }));

import {
  decideMaintenanceRoute,
  resolveMaintenanceUnlocked,
  mergeMaintenanceParams,
  maintenanceStateFromSnapshot,
  applyMaintenance,
  readMaintenance,
  type MaintenanceDeps,
} from "@/addons/wordpress-manager/lib/maintenance-orchestrator";
import type { MaintenanceState, SiteHealthSnapshot } from "@/addons/wordpress-manager/lib/manage/site-health";

function snapshot(overrides: { switchOn?: boolean; maintenance?: Partial<MaintenanceState> } = {}): SiteHealthSnapshot {
  return {
    switches: { maintenance_mode: overrides.switchOn ?? true, redirect_manager: false, broken_link_scan: false, statistics: false },
    maintenance: { locked: false, enabled: false, headline: "Old headline", message: "Old message", allow_ips: [], ...overrides.maintenance },
    links: { locked: true, last_scan_summary: null },
    redirects: { locked: true, count: 0, log_enabled: false, auto_slug: false, top: [] },
    notfound: { locked: true, top: [] },
    suggestions: [],
    broken_images: [],
  };
}

function fakeDeps(over: Partial<MaintenanceDeps> = {}): MaintenanceDeps {
  return {
    getCommandable: jest.fn(async () => false),
    getSnapshot: jest.fn(async () => null),
    setConnector: jest.fn(async () => ({})),
    setMuPlugin: jest.fn(async (_s: string, enabled: boolean) => ({ enabled })),
    getMuStatus: jest.fn(async () => ({ enabled: false })),
    ...over,
  };
}

describe("decideMaintenanceRoute", () => {
  test("signed only when commandable AND unlocked", () => {
    expect(decideMaintenanceRoute({ commandable: true, maintenanceUnlocked: true })).toBe("connector");
    expect(decideMaintenanceRoute({ commandable: true, maintenanceUnlocked: false })).toBe("mu-plugin");
    expect(decideMaintenanceRoute({ commandable: false, maintenanceUnlocked: true })).toBe("mu-plugin");
    expect(decideMaintenanceRoute({ commandable: false, maintenanceUnlocked: false })).toBe("mu-plugin");
  });
});

describe("resolveMaintenanceUnlocked", () => {
  test("true only when the switch is on and the section is not locked", () => {
    expect(resolveMaintenanceUnlocked(null)).toBe(false);
    expect(resolveMaintenanceUnlocked(snapshot({ switchOn: true }))).toBe(true);
    expect(resolveMaintenanceUnlocked(snapshot({ switchOn: false }))).toBe(false);
    expect(resolveMaintenanceUnlocked(snapshot({ maintenance: { locked: true } }))).toBe(false);
  });
});

describe("mergeMaintenanceParams", () => {
  test("a bare enabled toggle preserves the existing headline/message/allow-list", () => {
    const current: MaintenanceState = { locked: false, enabled: false, headline: "Kept", message: "Also kept", allow_ips: ["9.9.9.9"] };
    const merged = mergeMaintenanceParams(current, { enabled: true });
    expect(merged).toEqual({ enabled: true, headline: "Kept", message: "Also kept", retry_after: false, until: 0, allow_ips: ["9.9.9.9"] });
  });
  test("provided fields override current", () => {
    const current: MaintenanceState = { locked: false, headline: "Old", message: "Old" };
    const merged = mergeMaintenanceParams(current, { enabled: true, headline: "New", until: 42, allow_ips: ["1.1.1.1"] });
    expect(merged.headline).toBe("New");
    expect(merged.until).toBe(42);
    expect(merged.allow_ips).toEqual(["1.1.1.1"]);
  });
});

describe("applyMaintenance — mutual exclusion", () => {
  test("signed path: drives the connector AND clears the mu-plugin (both never on)", async () => {
    const deps = fakeDeps({
      getCommandable: jest.fn(async () => true),
      getSnapshot: jest.fn(async () => snapshot({ switchOn: true })),
    });
    const out = await applyMaintenance("blog", { enabled: true }, deps);
    expect(out.source).toBe("connector");
    expect(out.enabled).toBe(true);
    // headline preserved from the snapshot via the merge
    expect(deps.setConnector).toHaveBeenCalledWith("blog", expect.objectContaining({ enabled: true, headline: "Old headline" }));
    // mutual exclusion — the fallback layer is forced OFF
    expect(deps.setMuPlugin).toHaveBeenCalledWith("blog", false);
  });

  test("fallback path (not commandable): drives ONLY the mu-plugin, never the connector", async () => {
    const deps = fakeDeps({ getCommandable: jest.fn(async () => false) });
    const out = await applyMaintenance("blog", { enabled: true }, deps);
    expect(out.source).toBe("mu-plugin");
    expect(out.enabled).toBe(true);
    expect(deps.setMuPlugin).toHaveBeenCalledWith("blog", true);
    expect(deps.setConnector).not.toHaveBeenCalled();
  });

  test("fallback path (commandable but locked/switch-off): mu-plugin, connector untouched", async () => {
    const deps = fakeDeps({
      getCommandable: jest.fn(async () => true),
      getSnapshot: jest.fn(async () => snapshot({ switchOn: false })),
    });
    const out = await applyMaintenance("blog", { enabled: false }, deps);
    expect(out.source).toBe("mu-plugin");
    expect(deps.setConnector).not.toHaveBeenCalled();
    expect(deps.setMuPlugin).toHaveBeenCalledWith("blog", false);
  });

  test("signed engine refuses mid-flight (locked) → falls back to the mu-plugin", async () => {
    const deps = fakeDeps({
      getCommandable: jest.fn(async () => true),
      getSnapshot: jest.fn(async () => snapshot({ switchOn: true })),
      setConnector: jest.fn(async () => ({ locked: true })),
    });
    const out = await applyMaintenance("blog", { enabled: true }, deps);
    expect(out.source).toBe("mu-plugin");
    expect(deps.setMuPlugin).toHaveBeenCalledWith("blog", true);
  });
});

describe("readMaintenance", () => {
  test("commandable + unlocked snapshot → connector state", async () => {
    const deps = fakeDeps({
      getCommandable: jest.fn(async () => true),
      getSnapshot: jest.fn(async () => snapshot({ maintenance: { locked: false, enabled: true } })),
    });
    const out = await readMaintenance("blog", deps);
    expect(out.source).toBe("connector");
    expect(out.enabled).toBe(true);
  });

  test("not commandable → mu-plugin status", async () => {
    const deps = fakeDeps({ getCommandable: jest.fn(async () => false), getMuStatus: jest.fn(async () => ({ enabled: true })) });
    const out = await readMaintenance("blog", deps);
    expect(out).toEqual({ source: "mu-plugin", enabled: true });
  });

  test("commandable but locked snapshot → mu-plugin status", async () => {
    const deps = fakeDeps({
      getCommandable: jest.fn(async () => true),
      getSnapshot: jest.fn(async () => snapshot({ maintenance: { locked: true } })),
      getMuStatus: jest.fn(async () => ({ enabled: false })),
    });
    const out = await readMaintenance("blog", deps);
    expect(out.source).toBe("mu-plugin");
  });
});

describe("maintenanceStateFromSnapshot", () => {
  test("projects the connector view into the read model", () => {
    const out = maintenanceStateFromSnapshot(snapshot({ maintenance: { locked: false, enabled: true, headline: "H", until: 7 } }));
    expect(out).toMatchObject({ source: "connector", enabled: true, headline: "H", until: 7 });
  });
});
