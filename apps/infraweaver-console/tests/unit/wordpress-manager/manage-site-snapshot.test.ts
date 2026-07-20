/** @jest-environment node */
// Durable Manage-snapshot store: the pure (de)serialization half. Round-trips an
// overview through the stored envelope and asserts every malformed/oversized/
// wrong-version input degrades to null (never throws), so one corrupt ConfigMap
// entry can never sink a page read of the whole map.
jest.mock("server-only", () => ({}), { virtual: true });
// The store imports kube-client for its I/O half; stub it so importing the pure
// serialize/parse functions never touches a real k8s client.
jest.mock("@/lib/kube-client", () => ({ makeCoreApi: jest.fn() }));

import {
  serializeSnapshot,
  parseSnapshot,
} from "@/addons/wordpress-manager/lib/manage/site-snapshot";
import type { ManageOverview } from "@/addons/wordpress-manager/lib/manage/types";

function overview(overrides: Partial<ManageOverview> = {}): ManageOverview {
  return {
    site: "blog",
    wpVersion: "6.5",
    phpVersion: "8.3.6",
    coreUpdate: false,
    pendingUpdates: 2,
    pluginUpdates: 1,
    themeUpdates: 1,
    activePlugins: 7,
    totalPlugins: 9,
    dbSizeMb: 42,
    uploadsMb: 128,
    cachePlugin: "w3-total-cache",
    health: 88,
    connector: { active: true, lastRoundtripMs: 2663, lastCheckIso: "2026-07-20T00:00:00Z", connectorVersion: "0.4.2" },
    capabilities: {} as ManageOverview["capabilities"],
    panels: [{ id: "updates", available: true }],
    ...overrides,
  };
}

describe("site-snapshot (de)serialization", () => {
  test("round-trips an overview and its capture time", () => {
    const ov = overview();
    const parsed = parseSnapshot(serializeSnapshot(ov, 1_700_000_000_000));
    expect(parsed).not.toBeNull();
    expect(parsed?.at).toBe(1_700_000_000_000);
    expect(parsed?.overview).toEqual(ov);
  });

  test("returns null for undefined/empty input", () => {
    expect(parseSnapshot(undefined)).toBeNull();
    expect(parseSnapshot("")).toBeNull();
  });

  test("returns null for unparseable JSON", () => {
    expect(parseSnapshot("{not json")).toBeNull();
  });

  test("returns null when the envelope version does not match", () => {
    const raw = serializeSnapshot(overview(), 1).replace('"v":1', '"v":99');
    expect(parseSnapshot(raw)).toBeNull();
  });

  test("returns null when the capture time is missing or non-numeric", () => {
    expect(parseSnapshot(JSON.stringify({ v: 1, overview: overview() }))).toBeNull();
    expect(parseSnapshot(JSON.stringify({ v: 1, at: "soon", overview: overview() }))).toBeNull();
  });

  test("returns null when the overview shape is structurally invalid", () => {
    // missing site
    expect(parseSnapshot(JSON.stringify({ v: 1, at: 1, overview: { panels: [] } }))).toBeNull();
    // panels not an array
    expect(parseSnapshot(JSON.stringify({ v: 1, at: 1, overview: { site: "x", panels: {} } }))).toBeNull();
    // overview not an object
    expect(parseSnapshot(JSON.stringify({ v: 1, at: 1, overview: 5 }))).toBeNull();
  });
});
