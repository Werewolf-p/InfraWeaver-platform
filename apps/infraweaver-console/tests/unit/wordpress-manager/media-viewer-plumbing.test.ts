/**
 * Media viewer (Agent A) — console plumbing. Pins the six new signed methods end to
 * end at the contract level: the isomorphic zod validators (parity with the
 * connector's IWSL_Media_Detail / _Editor / _Protection), the RPC registry entries,
 * the single panel registry (gating + zoom math), and the console adapter's
 * verb → route → op contract (the seam Agents B/C reuse).
 */

import {
  mediaDeleteParamsSchema,
  mediaEditParamsSchema,
  mediaGetParamsSchema,
  mediaProtectParamsSchema,
  mediaUpdateMetaParamsSchema,
  mediaUsageParamsSchema,
  MEDIA_READ_VERBS,
  MEDIA_WRITE_VERBS,
} from "@/addons/wordpress-manager/lib/manage/media";
import { RPC_REGISTRY } from "@/addons/wordpress-manager/lib/rpc/registry";
import {
  VIEWER_PANELS,
  isPanelUnlocked,
  nextZoom,
  ZOOM_MIN,
  ZOOM_MAX,
  type PanelSpec,
} from "@/addons/wordpress-manager/components/manage/media/viewer/panel-registry";
import { createConsoleAdapter } from "@/addons/wordpress-manager/components/manage/media/viewer/viewer-adapter";

describe("media viewer param validators (parity with the connector)", () => {
  test("media.get accepts { id } and rejects strays / bad ids", () => {
    expect(mediaGetParamsSchema.safeParse({ id: 7 }).success).toBe(true);
    expect(mediaGetParamsSchema.safeParse({ id: 0 }).success).toBe(false);
    expect(mediaGetParamsSchema.safeParse({ id: 7, foo: 1 }).success).toBe(false);
  });

  test("media.updateMeta requires expect_modified AND at least one editable field", () => {
    expect(mediaUpdateMetaParamsSchema.safeParse({ id: 7, expect_modified: "t", alt: "x" }).success).toBe(true);
    expect(mediaUpdateMetaParamsSchema.safeParse({ id: 7, expect_modified: "t" }).success).toBe(false); // no field
    expect(mediaUpdateMetaParamsSchema.safeParse({ id: 7, alt: "x" }).success).toBe(false); // no token
    expect(mediaUpdateMetaParamsSchema.safeParse({ id: 7, expect_modified: "t", alt: "a".repeat(501) }).success).toBe(false);
  });

  test("media.edit op union: only non-zero multiples of 90 rotate; crop needs positive size", () => {
    expect(mediaEditParamsSchema.safeParse({ id: 7, ops: [{ type: "rotate", angle: 90 }] }).success).toBe(true);
    expect(mediaEditParamsSchema.safeParse({ id: 7, ops: [{ type: "rotate", angle: 45 }] }).success).toBe(false);
    expect(mediaEditParamsSchema.safeParse({ id: 7, ops: [{ type: "rotate", angle: 0 }] }).success).toBe(false);
    expect(mediaEditParamsSchema.safeParse({ id: 7, ops: [{ type: "flip", axis: "horizontal" }] }).success).toBe(true);
    expect(mediaEditParamsSchema.safeParse({ id: 7, ops: [{ type: "crop", x: 0, y: 0, width: 0, height: 1 }] }).success).toBe(false);
    expect(mediaEditParamsSchema.safeParse({ id: 7, ops: [] }).success).toBe(false);
    expect(mediaEditParamsSchema.safeParse({ id: 7, ops: Array(11).fill({ type: "rotate", angle: 90 }) }).success).toBe(false);
  });

  test("media.protect + media.usage shapes", () => {
    expect(mediaProtectParamsSchema.safeParse({ ids: [1, 2], protected: true }).success).toBe(true);
    expect(mediaProtectParamsSchema.safeParse({ ids: [], protected: true }).success).toBe(false);
    expect(mediaUsageParamsSchema.safeParse({ id: 7, page: 2 }).success).toBe(true);
    expect(mediaUsageParamsSchema.safeParse({ id: 7, page: 0 }).success).toBe(false);
  });

  test("media.delete fences on the LITERAL confirm:true (a truthy 1 is refused)", () => {
    expect(mediaDeleteParamsSchema.safeParse({ id: 7, confirm: true }).success).toBe(true);
    expect(mediaDeleteParamsSchema.safeParse({ id: 7, confirm: false }).success).toBe(false);
    expect(mediaDeleteParamsSchema.safeParse({ id: 7, confirm: 1 }).success).toBe(false);
    expect(mediaDeleteParamsSchema.safeParse({ id: 7 }).success).toBe(false);
  });
});

describe("RPC registry + verb lists", () => {
  test("the six viewer methods are registered with param validators", () => {
    for (const m of ["media.get", "media.updateMeta", "media.edit", "media.protect", "media.delete", "media.usage"] as const) {
      expect(RPC_REGISTRY[m]).toBeDefined();
      expect(RPC_REGISTRY[m].hasParams).toBe(true);
    }
    expect(RPC_REGISTRY["media.get"].validate({ id: 7 })).toBe(true);
    expect(RPC_REGISTRY["media.delete"].validate({ id: 7 })).toBe(false); // confirm fence at the registry too
    expect(RPC_REGISTRY["media.delete"].validate({ id: 7, confirm: true })).toBe(true);
  });

  test("read/write verb lists carry the new verbs", () => {
    expect(MEDIA_READ_VERBS).toContain("get");
    expect(MEDIA_READ_VERBS).toContain("usage");
    for (const v of ["updateMeta", "edit", "protect", "delete"]) expect(MEDIA_WRITE_VERBS).toContain(v);
  });
});

describe("panel registry (single source, gating, zoom)", () => {
  test("the locked spec is present in order and gated correctly", () => {
    const ids = VIEWER_PANELS.map((p) => p.id);
    expect(ids).toEqual([
      "edit", "details", "alt", "title", "caption", "description", "fileurl",
      "optimization", "offload", "protect", "folder", "tags", "usage", "actions",
    ]);
  });

  test("isPanelUnlocked: a gated panel is locked without its flag, shown otherwise", () => {
    const protect = VIEWER_PANELS.find((p) => p.id === "protect") as PanelSpec;
    expect(isPanelUnlocked(protect, { media_folders: true, image_optimization: true, media_protection: false })).toBe(false);
    expect(isPanelUnlocked(protect, { media_folders: true, image_optimization: true, media_protection: true })).toBe(true);
    const details = VIEWER_PANELS.find((p) => p.id === "details") as PanelSpec;
    expect(isPanelUnlocked(details, { media_folders: false, image_optimization: false })).toBe(true); // ungated
  });

  test("zoom math is clamped and reversible", () => {
    expect(nextZoom(1, "zoomIn")).toBeGreaterThan(1);
    expect(nextZoom(ZOOM_MAX, "zoomIn")).toBe(ZOOM_MAX);
    expect(nextZoom(1, "zoomOut")).toBe(ZOOM_MIN);
    expect(nextZoom(4, "zoomReset")).toBe(ZOOM_MIN);
    expect(nextZoom(1, "toggle")).toBe(2);
    expect(nextZoom(2, "toggle")).toBe(ZOOM_MIN);
  });
});

describe("console adapter — verb → route → op contract", () => {
  const site = "mysite";
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    calls = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => ({ ok: true, asset: { id: 7 } }) } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  test("getAsset issues GET ?read=get with the id in the JSON p param", async () => {
    const adapter = createConsoleAdapter(site);
    await adapter.getAsset(7);
    expect(calls[0].url).toContain("/api/wordpress/sites/mysite/media?read=get");
    expect(decodeURIComponent(calls[0].url)).toContain('{"id":7}');
  });

  test("usage issues GET ?read=usage with id+page", async () => {
    await createConsoleAdapter(site).usage(7, 2);
    expect(calls[0].url).toContain("read=usage");
    expect(decodeURIComponent(calls[0].url)).toContain('"page":2');
  });

  test("updateMeta POSTs { verb:'updateMeta', params:{ id, expect_modified, ...fields } }", async () => {
    await createConsoleAdapter(site).updateMeta(7, { caption: "hi" }, "TOK");
    const body = JSON.parse(String(calls[0].init!.body));
    expect(calls[0].init!.method).toBe("POST");
    expect(body).toEqual({ verb: "updateMeta", params: { id: 7, expect_modified: "TOK", caption: "hi" } });
  });

  test("edit POSTs the ops with defaults target=all, regenerate=true", async () => {
    await createConsoleAdapter(site).edit(7, [{ type: "rotate", angle: 90 }]);
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body).toEqual({ verb: "edit", params: { id: 7, ops: [{ type: "rotate", angle: 90 }], target: "all", regenerate: true } });
  });

  test("protect POSTs the ids + boolean; del hard-sends confirm:true", async () => {
    const adapter = createConsoleAdapter(site);
    await adapter.protect([7], true);
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ verb: "protect", params: { ids: [7], protected: true } });
    await adapter.del(7);
    expect(JSON.parse(String(calls[1].init!.body))).toEqual({ verb: "delete", params: { id: 7, confirm: true } });
  });

  test("optimize/offload/restore scope to the single id", async () => {
    const adapter = createConsoleAdapter(site);
    await adapter.optimize(7);
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ verb: "optimize", params: { ids: [7] } });
    await adapter.offload(7, "offload");
    expect(JSON.parse(String(calls[1].init!.body))).toEqual({ verb: "offload", params: { op: "offload", ids: [7] } });
    await adapter.restore(7);
    expect(JSON.parse(String(calls[2].init!.body))).toEqual({ verb: "restore", params: { ids: [7] } });
  });
});
