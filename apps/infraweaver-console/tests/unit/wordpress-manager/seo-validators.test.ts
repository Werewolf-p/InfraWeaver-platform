import {
  seoAltBackfillParamsSchema,
  seoAuditParamsSchema,
  seoFixParamsSchema,
} from "@/addons/wordpress-manager/lib/manage/seo";
import { RPC_METHODS, RPC_REGISTRY } from "@/addons/wordpress-manager/lib/rpc/registry";

describe("seoAuditParamsSchema (mirrors validate_audit_params)", () => {
  test("accepts empty and a bounded limit", () => {
    expect(seoAuditParamsSchema.safeParse({}).success).toBe(true);
    expect(seoAuditParamsSchema.safeParse({ limit: 200 }).success).toBe(true);
    expect(seoAuditParamsSchema.safeParse({ limit: 1 }).success).toBe(true);
  });
  test("rejects out-of-range limit and stray keys", () => {
    expect(seoAuditParamsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(seoAuditParamsSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(seoAuditParamsSchema.safeParse({ limit: 5, foo: 1 }).success).toBe(false);
  });
});

describe("seoAltBackfillParamsSchema (mirrors validate_backfill_params)", () => {
  test("accepts empty, limit and dry_run", () => {
    expect(seoAltBackfillParamsSchema.safeParse({}).success).toBe(true);
    expect(seoAltBackfillParamsSchema.safeParse({ limit: 50, dry_run: false }).success).toBe(true);
  });
  test("rejects bad types, out-of-range and stray keys", () => {
    expect(seoAltBackfillParamsSchema.safeParse({ dry_run: "yes" }).success).toBe(false);
    expect(seoAltBackfillParamsSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(seoAltBackfillParamsSchema.safeParse({ nope: true }).success).toBe(false);
  });
});

describe("seoFixParamsSchema (mirrors validate_fix_params — strict)", () => {
  test("accepts exactly { post_id>0, field:enum, value:string≤400 }", () => {
    expect(seoFixParamsSchema.safeParse({ post_id: 12, field: "title", value: "Hi" }).success).toBe(true);
    expect(seoFixParamsSchema.safeParse({ post_id: 1, field: "noindex", value: "1" }).success).toBe(true);
  });
  test("rejects unknown field, oversize value, non-positive id and stray keys", () => {
    expect(seoFixParamsSchema.safeParse({ post_id: 1, field: "slug", value: "x" }).success).toBe(false);
    expect(seoFixParamsSchema.safeParse({ post_id: 1, field: "title", value: "x".repeat(401) }).success).toBe(false);
    expect(seoFixParamsSchema.safeParse({ post_id: 0, field: "title", value: "x" }).success).toBe(false);
    expect(seoFixParamsSchema.safeParse({ post_id: 1, field: "title", value: "x", extra: 1 }).success).toBe(false);
    expect(seoFixParamsSchema.safeParse({ post_id: 1, field: "title" }).success).toBe(false);
  });
});

describe("RPC registry mirrors the four signed seo.* methods", () => {
  test("all four methods are registered in the allow-list", () => {
    for (const m of ["seo.status", "seo.audit.run", "seo.alt.backfill", "seo.fix.apply"] as const) {
      expect(RPC_METHODS).toContain(m);
      expect(RPC_REGISTRY[m]).toBeDefined();
    }
  });

  test("seo.status is a no-param safe read", () => {
    expect(RPC_REGISTRY["seo.status"].hasParams).toBe(false);
    expect(RPC_REGISTRY["seo.status"].validate({})).toBe(true);
    expect(RPC_REGISTRY["seo.status"].validate({ any: 1 })).toBe(false);
  });

  test("the gated methods validate through the mirrored zod schemas", () => {
    expect(RPC_REGISTRY["seo.audit.run"].validate({ limit: 10 })).toBe(true);
    expect(RPC_REGISTRY["seo.audit.run"].validate({ limit: 999 })).toBe(false);
    expect(RPC_REGISTRY["seo.fix.apply"].validate({ post_id: 3, field: "desc", value: "ok" })).toBe(true);
    expect(RPC_REGISTRY["seo.fix.apply"].validate({ post_id: 3, field: "bogus", value: "ok" })).toBe(false);
    expect(RPC_REGISTRY["seo.alt.backfill"].validate({ dry_run: true })).toBe(true);
    expect(RPC_REGISTRY["seo.alt.backfill"].validate({ dry_run: 1 })).toBe(false);
  });
});
