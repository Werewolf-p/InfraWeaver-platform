import {
  MANAGE_PANELS,
  computePanelAvailability,
  getPanelDef,
  isManagePanelId,
  isPanelAvailable,
  resolveCapabilities,
} from "@/addons/wordpress-manager/lib/manage/capabilities";

const NO_CAPS = resolveCapabilities({ activePlugins: new Set<string>(), connectorActive: false });

describe("resolveCapabilities", () => {
  test("bare site has no optional capabilities", () => {
    expect(NO_CAPS.woocommerce).toBe(false);
    expect(NO_CAPS.forms).toBe(false);
    expect(NO_CAPS.connector).toBe(false);
  });

  test("WooCommerce lights the store capability", () => {
    const caps = resolveCapabilities({ activePlugins: new Set(["woocommerce"]), connectorActive: false });
    expect(caps.woocommerce).toBe(true);
  });

  test("any forms plugin satisfies the forms capability", () => {
    const caps = resolveCapabilities({ activePlugins: new Set(["wpforms-lite"]), connectorActive: false });
    expect(caps.forms).toBe(true);
  });

  test("an SEO plugin satisfies both seo and audience", () => {
    const caps = resolveCapabilities({ activePlugins: new Set(["wordpress-seo"]), connectorActive: false });
    expect(caps.seo).toBe(true);
    expect(caps.audience).toBe(true);
  });

  test("an analytics-only plugin satisfies audience but not seo", () => {
    const caps = resolveCapabilities({ activePlugins: new Set(["google-site-kit"]), connectorActive: false });
    expect(caps.audience).toBe(true);
    expect(caps.seo).toBe(false);
  });

  test("connector capability follows the managed-link flag", () => {
    const caps = resolveCapabilities({ activePlugins: new Set<string>(), connectorActive: true });
    expect(caps.connector).toBe(true);
  });
});

describe("panel availability", () => {
  test("all core (null-requirement) panels are always available", () => {
    const availability = computePanelAvailability(NO_CAPS);
    for (const panel of MANAGE_PANELS.filter((p) => p.requires === null)) {
      expect(availability.find((a) => a.id === panel.id)?.available).toBe(true);
    }
  });

  test("store is hidden without WooCommerce and shown with it", () => {
    const store = getPanelDef("store")!;
    expect(isPanelAvailable(store, NO_CAPS)).toBe(false);
    const withWoo = resolveCapabilities({ activePlugins: new Set(["woocommerce"]), connectorActive: false });
    expect(isPanelAvailable(store, withWoo)).toBe(true);
  });

  test("uptime + clients require the connector", () => {
    const withConn = resolveCapabilities({ activePlugins: new Set<string>(), connectorActive: true });
    expect(isPanelAvailable(getPanelDef("uptime")!, NO_CAPS)).toBe(false);
    expect(isPanelAvailable(getPanelDef("clients")!, NO_CAPS)).toBe(false);
    expect(isPanelAvailable(getPanelDef("uptime")!, withConn)).toBe(true);
    expect(isPanelAvailable(getPanelDef("clients")!, withConn)).toBe(true);
  });

  test("every panel id round-trips through the guard + registry", () => {
    for (const panel of MANAGE_PANELS) {
      expect(isManagePanelId(panel.id)).toBe(true);
      expect(getPanelDef(panel.id)?.id).toBe(panel.id);
    }
    expect(isManagePanelId("not-a-panel")).toBe(false);
  });

  test("there are 22 panels and 10 are gated", () => {
    expect(MANAGE_PANELS).toHaveLength(22);
    expect(MANAGE_PANELS.filter((p) => p.requires !== null)).toHaveLength(10);
  });

  test("the metrics panel is gated on the signed Connector channel", () => {
    const metrics = MANAGE_PANELS.find((p) => p.id === "metrics");
    expect(metrics?.requires?.capability).toBe("connector");
    expect(metrics?.requires?.connector).toBe(true);
  });
});
