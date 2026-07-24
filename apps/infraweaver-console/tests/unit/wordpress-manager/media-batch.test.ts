import {
  chunkIds,
  collectMatchingIds,
  isOffloadable,
  isOptimizable,
  mergeIds,
  offloadChip,
  optimizationChip,
  planOptimizeBatches,
  type MatchIdsPage,
} from "@/addons/wordpress-manager/lib/manage/media-batch";
import { OPTIMIZE_BATCH, type MediaOffload, type MediaOptimization } from "@/addons/wordpress-manager/lib/manage/media";
import { runItems, summarize } from "@/addons/wordpress-manager/lib/manage/run-ledger";

describe("chunkIds / planOptimizeBatches", () => {
  test("splits into consecutive batches of at most size, order preserved", () => {
    // Arrange
    const ids = [1, 2, 3, 4, 5, 6, 7];
    // Act
    const batches = chunkIds(ids, 3);
    // Assert
    expect(batches).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  test("empty selection yields no batches", () => {
    expect(chunkIds([], 10)).toEqual([]);
    expect(planOptimizeBatches([])).toEqual([]);
  });

  test("planOptimizeBatches chunks at the connector's OPTIMIZE_BATCH size", () => {
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    const batches = planOptimizeBatches(ids);
    expect(OPTIMIZE_BATCH).toBe(10);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
    // Every id appears exactly once across the plan.
    expect(batches.flat()).toEqual(ids);
  });
});

describe("mergeIds", () => {
  test("dedupes, preserves first-seen order, drops non-positives", () => {
    expect(mergeIds([3, 1, 3], [1, 4, 0, -2, 5])).toEqual([3, 1, 4, 5]);
  });
});

describe("select-all-matching → batched optimize loop", () => {
  test("uncapped: one include_ids call returns the whole matching set", async () => {
    // Arrange — 25 non-lossless assets, all returned in one include_ids call.
    const matchIds = Array.from({ length: 25 }, (_, i) => i + 1);
    const deps = {
      fetchMatchIds: jest.fn(async (): Promise<MatchIdsPage> => ({ ids: matchIds, capped: false, total: 25, perPage: 60 })),
      fetchPageIds: jest.fn(async () => []),
    };

    // Act — resolve the selection, then run the batched optimize plan.
    const selection = await collectMatchingIds(deps);
    const batches = planOptimizeBatches(selection.ids);
    const optimized = new Set<number>();
    const final = await runItems(
      batches.map((_, i) => String(i)),
      async (batchKey) => {
        for (const id of batches[Number(batchKey)]) optimized.add(id);
        return { ok: true };
      },
      () => undefined,
      3,
    );

    // Assert — full set selected, chunked into 3 signed calls, every asset covered.
    expect(selection).toEqual({ ids: matchIds, capped: false, total: 25 });
    expect(deps.fetchPageIds).not.toHaveBeenCalled();
    expect(batches.length).toBe(3);
    expect(summarize(final)).toEqual({ total: 3, ok: 3, failed: 0, done: true });
    expect([...optimized].sort((a, b) => a - b)).toEqual(matchIds);
  });

  test("capped: loops the filtered pages to gather the overflow beyond one call", async () => {
    // Arrange — 5 total match, but the single include_ids call capped at 3.
    const firstThree = [1, 2, 3];
    const pages: Record<number, number[]> = { 1: [1, 2], 2: [3, 4], 3: [5] };
    const deps = {
      fetchMatchIds: jest.fn(async (): Promise<MatchIdsPage> => ({ ids: firstThree, capped: true, total: 5, perPage: 2 })),
      fetchPageIds: jest.fn(async (page: number) => pages[page] ?? []),
    };

    // Act
    const selection = await collectMatchingIds(deps);

    // Assert — overflow pages walked, ids merged + deduped, full set recovered.
    expect(deps.fetchPageIds).toHaveBeenCalledTimes(3); // ceil(5/2)
    expect(selection.ids).toEqual([1, 2, 3, 4, 5]);
    expect(selection.capped).toBe(false);
    expect(selection.total).toBe(5);
  });

  test("capped: honours the maxIds safety ceiling and reports still-capped", async () => {
    const deps = {
      fetchMatchIds: jest.fn(async (): Promise<MatchIdsPage> => ({ ids: [1, 2], capped: true, total: 100, perPage: 2 })),
      fetchPageIds: jest.fn(async (page: number) => [page * 10, page * 10 + 1]),
      maxIds: 4,
    };
    const selection = await collectMatchingIds(deps);
    expect(selection.ids.length).toBeLessThanOrEqual(4);
    expect(selection.capped).toBe(true);
  });
});

describe("row status → pill mapping (filter columns)", () => {
  const opt = (over: Partial<MediaOptimization>): MediaOptimization => ({
    status: "optimized",
    converter: "webp_lossless",
    bytes_in: 1000,
    bytes_out: 400,
    saved_pct: 60,
    restorable: true,
    ...over,
  });

  test("optimizationChip maps each status to a distinct pill", () => {
    expect(optimizationChip(null)).toEqual({ label: "—", tone: "neutral", active: false });
    expect(optimizationChip(opt({ status: "optimized", saved_pct: 60 }))).toEqual({
      label: "Lossless · −60%",
      tone: "good",
      active: true,
    });
    expect(optimizationChip(opt({ status: "optimized", saved_pct: null }))).toEqual({
      label: "Lossless",
      tone: "good",
      active: true,
    });
    expect(optimizationChip(opt({ status: "original", saved_pct: null }))).toEqual({
      label: "Not lossless",
      tone: "warn",
      active: false,
    });
    expect(optimizationChip(opt({ status: "ineligible" }))).toEqual({
      label: "Not eligible",
      tone: "neutral",
      active: false,
    });
  });

  test("offloadChip maps offloaded/local/off to the CDN pill", () => {
    const off = (s: MediaOffload["status"]): MediaOffload => ({ status: s, variant: null, url: null });
    expect(offloadChip(null)).toEqual({ label: "—", tone: "neutral", active: false });
    expect(offloadChip(off("offloaded"))).toEqual({ label: "On CDN", tone: "good", active: true });
    expect(offloadChip(off("local"))).toEqual({ label: "Local", tone: "neutral", active: false });
  });

  test("isOptimizable / isOffloadable identify the bulk targets", () => {
    expect(isOptimizable(opt({ status: "original" }))).toBe(true);
    expect(isOptimizable(opt({ status: "optimized" }))).toBe(false);
    expect(isOptimizable(null)).toBe(false);
    expect(isOffloadable({ status: "local", variant: null, url: null })).toBe(true);
    expect(isOffloadable({ status: "offloaded", variant: "derivative", url: "x" })).toBe(false);
  });
});
