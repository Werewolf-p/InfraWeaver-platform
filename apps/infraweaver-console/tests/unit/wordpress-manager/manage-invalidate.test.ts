/** @jest-environment node */
// Post-mutation cache invalidation: a Manage write must drop BOTH the in-memory SWR
// cache AND the durable cross-replica ConfigMap snapshots (per-panel + overview),
// otherwise the next non-forced read is served the pre-mutation snapshot durable-first
// and the change looks like it "did nothing". The three underlying stores are mocked
// so this asserts only the fan-out + best-effort error handling.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/addons/wordpress-manager/lib/manage/snapshot-cache", () => ({ invalidateManageCache: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/panel-snapshot", () => ({ clearSitePanelSnapshots: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/site-snapshot", () => ({ clearSiteSnapshot: jest.fn() }));

import { invalidateManageReadsAfterMutation } from "@/addons/wordpress-manager/lib/manage/invalidate";
import { invalidateManageCache } from "@/addons/wordpress-manager/lib/manage/snapshot-cache";
import { clearSitePanelSnapshots } from "@/addons/wordpress-manager/lib/manage/panel-snapshot";
import { clearSiteSnapshot } from "@/addons/wordpress-manager/lib/manage/site-snapshot";

const memMock = invalidateManageCache as jest.MockedFunction<typeof invalidateManageCache>;
const panelMock = clearSitePanelSnapshots as jest.MockedFunction<typeof clearSitePanelSnapshots>;
const overviewMock = clearSiteSnapshot as jest.MockedFunction<typeof clearSiteSnapshot>;

describe("invalidateManageReadsAfterMutation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    panelMock.mockResolvedValue(undefined);
    overviewMock.mockResolvedValue(undefined);
  });

  test("clears the in-memory SWR cache AND both durable snapshot stores for the site", async () => {
    await invalidateManageReadsAfterMutation("blog");
    expect(memMock).toHaveBeenCalledWith("blog");
    expect(panelMock).toHaveBeenCalledWith("blog");
    expect(overviewMock).toHaveBeenCalledWith("blog");
  });

  test("a durable panel-store failure is swallowed and the overview clear still runs", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    panelMock.mockRejectedValue(new Error("configmap conflict"));
    await expect(invalidateManageReadsAfterMutation("blog")).resolves.toBeUndefined();
    expect(memMock).toHaveBeenCalledWith("blog");
    expect(overviewMock).toHaveBeenCalledWith("blog");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("a durable overview-store failure is swallowed too (mutation already succeeded)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    overviewMock.mockRejectedValue(new Error("apiserver blip"));
    await expect(invalidateManageReadsAfterMutation("blog")).resolves.toBeUndefined();
    expect(panelMock).toHaveBeenCalledWith("blog");
    warn.mockRestore();
  });
});
