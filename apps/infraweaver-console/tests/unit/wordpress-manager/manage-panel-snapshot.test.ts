/** @jest-environment node */
// Durable per-panel snapshot store: the pure (de)serialization + the 16 KB
// per-entry bound. The ConfigMap I/O layer is mocked so these exercise only the
// shape validation and the bounding decision (oversized ⇒ NOT persisted, prior
// value kept) — never touching a real k8s client.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/addons/wordpress-manager/lib/manage/configmap-store", () => ({
  mutateConfigMap: jest.fn(),
  readConfigMapData: jest.fn(),
  RESERVED_UPDATED_AT_KEY: "updatedAt",
}));

import {
  serializePanelSnapshot,
  parsePanelSnapshot,
  writeSitePanelSnapshot,
  writeSitePanelSnapshots,
  readSitePanelSnapshot,
  readSitePanelSnapshots,
  MAX_PANEL_ENTRY_BYTES,
} from "@/addons/wordpress-manager/lib/manage/panel-snapshot";
import {
  mutateConfigMap,
  readConfigMapData,
} from "@/addons/wordpress-manager/lib/manage/configmap-store";

const mutateMock = mutateConfigMap as jest.MockedFunction<typeof mutateConfigMap>;
const readMock = readConfigMapData as jest.MockedFunction<typeof readConfigMapData>;

/** Run the mutator the store handed mutateConfigMap against an empty map and return it. */
function applyMutator(): Record<string, string> {
  const map: Record<string, string> = {};
  const mutator = mutateMock.mock.calls[0][1];
  mutator(map);
  return map;
}

describe("panel-snapshot (de)serialization", () => {
  test("round-trips a panel's data and capture time", () => {
    const data = { posts: 12, recent: [{ title: "hi" }] };
    const parsed = parsePanelSnapshot(serializePanelSnapshot("content", data, 1_700_000_000_000));
    expect(parsed).toEqual({ panel: "content", data, at: 1_700_000_000_000 });
  });

  test("degrades to null for every malformed/wrong-version/unknown-panel input", () => {
    expect(parsePanelSnapshot(undefined)).toBeNull();
    expect(parsePanelSnapshot("")).toBeNull();
    expect(parsePanelSnapshot("{not json")).toBeNull();
    expect(parsePanelSnapshot(serializePanelSnapshot("content", {}, 1).replace('"v":1', '"v":99'))).toBeNull();
    expect(parsePanelSnapshot(JSON.stringify({ v: 1, panel: "content", data: {} }))).toBeNull(); // no at
    expect(parsePanelSnapshot(JSON.stringify({ v: 1, at: 1, panel: "content" }))).toBeNull(); // no data
    expect(parsePanelSnapshot(JSON.stringify({ v: 1, at: 1, panel: "not-a-panel", data: {} }))).toBeNull();
  });
});

describe("panel-snapshot bounding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mutateMock.mockResolvedValue(undefined);
  });

  test("writes a normal panel entry under the bound", async () => {
    await writeSitePanelSnapshot("blog", "content", { posts: 3 }, 42);
    expect(mutateMock).toHaveBeenCalledTimes(1);
    const map = applyMutator();
    expect(parsePanelSnapshot(map.content)).toEqual({ panel: "content", data: { posts: 3 }, at: 42 });
  });

  test("skips (does not persist) an entry that exceeds the 16 KB bound", async () => {
    const huge = { rows: "x".repeat(MAX_PANEL_ENTRY_BYTES + 1000) };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeSitePanelSnapshot("blog", "content", huge, 42);
    expect(mutateMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("batch write persists only the in-bound entries in one mutate", async () => {
    const huge = { rows: "x".repeat(MAX_PANEL_ENTRY_BYTES + 1000) };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeSitePanelSnapshots("blog", [
      { panel: "content", data: { posts: 1 } },
      { panel: "media", data: huge },
    ]);
    expect(mutateMock).toHaveBeenCalledTimes(1);
    const map = applyMutator();
    expect(map.content).toBeDefined();
    expect(map.media).toBeUndefined();
    warn.mockRestore();
  });

  test("an empty batch is a no-op (no I/O)", async () => {
    await writeSitePanelSnapshots("blog", []);
    expect(mutateMock).not.toHaveBeenCalled();
  });
});

describe("panel-snapshot reads", () => {
  beforeEach(() => jest.clearAllMocks());

  test("reads one panel back, null for an unknown panel id", async () => {
    readMock.mockResolvedValue({ data: { content: serializePanelSnapshot("content", { posts: 9 }, 7) } });
    expect(await readSitePanelSnapshot("blog", "content")).toEqual({ panel: "content", data: { posts: 9 }, at: 7 });
    expect(await readSitePanelSnapshot("blog", "nope")).toBeNull();
  });

  test("reads all panels, skipping the reserved timestamp + corrupt entries", async () => {
    readMock.mockResolvedValue({
      data: {
        updatedAt: "2026-07-20T00:00:00Z",
        content: serializePanelSnapshot("content", { posts: 1 }, 1),
        media: "{corrupt",
      },
    });
    const all = await readSitePanelSnapshots("blog");
    expect([...all.keys()]).toEqual(["content"]);
  });
});
