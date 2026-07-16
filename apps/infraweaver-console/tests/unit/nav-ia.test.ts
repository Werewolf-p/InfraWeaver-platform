import { NAV_GROUPS, ALL_NAV_ITEMS } from "@/lib/nav-config";
import { filterNavGroupsByAddons, buildAddonList } from "@/lib/addons";
import { ADDON_MANIFESTS } from "@/generated/addon-registry";

describe("IA restructure — navigation groups", () => {
  it("collapses into the 7 target groups + a conditional Addons group", () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual([
      "overview",
      "workloads",
      "networking",
      "storage",
      "observability",
      "security",
      "platform",
      "addons",
    ]);
  });

  it("preserves every relocated capability (no route dropped from nav)", () => {
    const hrefs = new Set(ALL_NAV_ITEMS.map((i) => i.href));
    // A sampling spanning each new group home — these moved but must still exist.
    for (const href of [
      "/cluster", "/changelog", // overview
      "/workloads", "/all-services", "/namespace-cleanup", "/pod-shell", // workloads (hub)
      "/network", "/gameservers", "/network/firewall", // networking (hub)
      "/registry", "/config", "/secrets", "/storage", // storage & config hubs
      "/monitoring", "/alert-silence", "/tests", "/events", // observability (diagnostics hub)
      "/identity", "/audit", // security & access (Identity hub + audit log)
      "/gitops-diff", "/settings/addons", // platform
    ]) {
      expect(hrefs.has(href)).toBe(true);
    }
  });

  it("folds merged pages into hubs (no longer standalone nav items)", () => {
    const hrefs = new Set(ALL_NAV_ITEMS.map((i) => i.href));
    for (const merged of [
      "/config-maps", "/config-drift", // → /config tabs
      "/secret-expiry", "/certificates", // → /secrets tabs
      "/storage-timeline", "/pv-browser", "/backups", // → /storage tabs
      "/self-test", "/health-tester", "/webhook-tester", // → /tests tabs
      "/network-policies", "/ingress", // → /network tabs
      "/status", "/health", "/uptime", // → /monitoring tabs
      "/dns", // → /routes tabs (routing)
      "/users", "/access", "/rbac", // → /identity tabs
      "/apps", "/app-graph", // → /workloads tabs
    ]) {
      expect(hrefs.has(merged)).toBe(false);
    }
  });

  it("derives the Addons group from manifests, not hardcoded links", () => {
    const addonsGroup = NAV_GROUPS.find((g) => g.id === "addons");
    const manifestHrefs = ADDON_MANIFESTS.flatMap((m) =>
      (m.navItems ?? []).filter((n) => n.group === "addons").map((n) => n.href),
    );
    expect(addonsGroup?.items.map((i) => i.href).sort()).toEqual([...manifestHrefs].sort());
  });

  it("hides the Addons group entirely when no addon is enabled", () => {
    const filtered = filterNavGroupsByAddons(NAV_GROUPS, buildAddonList([]));
    expect(filtered.find((g) => g.id === "addons")).toBeUndefined();
  });

  it("shows only enabled addons' nav items", () => {
    const filtered = filterNavGroupsByAddons(NAV_GROUPS, buildAddonList(["game-hub"]));
    const addonsGroup = filtered.find((g) => g.id === "addons");
    expect(addonsGroup?.items.map((i) => i.href)).toContain("/game-hub");
    expect(addonsGroup?.items.map((i) => i.href)).not.toContain("/wordpress");
  });
});
