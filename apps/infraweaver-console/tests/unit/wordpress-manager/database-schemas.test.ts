/**
 * Parity tests for the console-side `db.*` request validators. These MIRROR the
 * plugin's validators in IWSL_Plugin::command_handlers() — the load-bearing
 * invariant being that `dry_run` is a REQUIRED real boolean so deletion fires
 * only on a literal `false` (preview-by-default), and that a category id can only
 * ever be a registry-shaped token (never a table name).
 */

import {
  MAX_CLEANERS_PER_RUN,
  MAX_ROWS,
  dbCleanupParamsSchema,
  dbScheduleParamsSchema,
} from "@/addons/wordpress-manager/lib/manage/database";

describe("dbCleanupParamsSchema", () => {
  test("accepts a valid preview request", () => {
    expect(dbCleanupParamsSchema.safeParse({ categories: ["post_revisions"], dry_run: true }).success).toBe(true);
  });

  test("accepts a valid delete request with a lowered cap", () => {
    const parsed = dbCleanupParamsSchema.safeParse({ categories: ["expired_transients"], dry_run: false, max_rows: 200 });
    expect(parsed.success).toBe(true);
  });

  test("REJECTS a missing dry_run — preview-by-default depends on the flag being explicit", () => {
    expect(dbCleanupParamsSchema.safeParse({ categories: ["post_revisions"] }).success).toBe(false);
  });

  test("REJECTS a non-boolean dry_run (string 'false')", () => {
    expect(dbCleanupParamsSchema.safeParse({ categories: ["post_revisions"], dry_run: "false" }).success).toBe(false);
  });

  test("REJECTS a truthy-but-not-boolean dry_run (1)", () => {
    expect(dbCleanupParamsSchema.safeParse({ categories: ["post_revisions"], dry_run: 1 }).success).toBe(false);
  });

  test("REJECTS a category id that is not registry-shaped (uppercase / punctuation)", () => {
    expect(dbCleanupParamsSchema.safeParse({ categories: ["DROP TABLE"], dry_run: true }).success).toBe(false);
    expect(dbCleanupParamsSchema.safeParse({ categories: ["wp_options; --"], dry_run: true }).success).toBe(false);
  });

  test("REJECTS more than MAX_CLEANERS_PER_RUN categories", () => {
    const many = Array.from({ length: MAX_CLEANERS_PER_RUN + 1 }, (_, i) => `cleaner_${i}`);
    expect(dbCleanupParamsSchema.safeParse({ categories: many, dry_run: true }).success).toBe(false);
  });

  test("REJECTS a non-integer max_rows", () => {
    expect(dbCleanupParamsSchema.safeParse({ categories: ["post_revisions"], dry_run: false, max_rows: 3.5 }).success).toBe(false);
    expect(dbCleanupParamsSchema.safeParse({ categories: ["post_revisions"], dry_run: false, max_rows: "5" }).success).toBe(false);
  });

  test("REJECTS unknown keys (strict)", () => {
    expect(dbCleanupParamsSchema.safeParse({ categories: ["post_revisions"], dry_run: true, drop: true }).success).toBe(false);
  });
});

describe("dbScheduleParamsSchema", () => {
  test("accepts a valid daily schedule", () => {
    expect(dbScheduleParamsSchema.safeParse({ enabled: true, frequency: "daily" }).success).toBe(true);
  });

  test("accepts a weekly schedule with a category subset", () => {
    expect(
      dbScheduleParamsSchema.safeParse({ enabled: true, frequency: "weekly", categories: ["spam_comments"] }).success,
    ).toBe(true);
  });

  test("REJECTS an off-allow-list frequency", () => {
    expect(dbScheduleParamsSchema.safeParse({ enabled: true, frequency: "monthly" }).success).toBe(false);
  });

  test("REJECTS a missing enabled boolean", () => {
    expect(dbScheduleParamsSchema.safeParse({ frequency: "daily" }).success).toBe(false);
  });

  test("REJECTS unknown keys (strict)", () => {
    expect(dbScheduleParamsSchema.safeParse({ enabled: true, frequency: "daily", extra: 1 }).success).toBe(false);
  });
});

describe("engine caps mirror the plugin constants", () => {
  test("MAX_ROWS is 1000 and MAX_CLEANERS_PER_RUN is 32", () => {
    expect(MAX_ROWS).toBe(1000);
    expect(MAX_CLEANERS_PER_RUN).toBe(32);
  });
});
