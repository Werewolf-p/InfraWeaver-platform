/**
 * Content / Branding / Config — the console-side wire validators are the "second
 * copy" of the connector's allow-lists. These tests pin PARITY with the connector
 * validators (`IWSL_White_Label::validate_wire_params`,
 * `IWSL_Config_Editor::validate_wire_params`, `IWSL_Duplicate_Post::validate_params`):
 * exact-key strictness, per-type shape, byte bounds — the same refusal cases the
 * plugin's verifier enforces. Plus the RPC registry wiring for the five methods.
 */

import {
  BRANDING_WIRE_MAX_BYTES,
  CONFIG_ALLOWLIST,
  brandingSetParamsSchema,
  configSetParamsSchema,
  contentDuplicateParamsSchema,
} from "@/addons/wordpress-manager/lib/manage/content-branding";
import { RPC_METHODS, RPC_REGISTRY } from "@/addons/wordpress-manager/lib/rpc/registry";

describe("brandingSetParamsSchema (mirrors IWSL_White_Label::validate_wire_params)", () => {
  test("accepts allow-listed string + bool fields", () => {
    // Arrange
    const params = { settings: { brand_name: "Acme", accent_color: "#2563eb", apply_to_email: true } };
    // Act / Assert
    expect(brandingSetParamsSchema.safeParse(params).success).toBe(true);
  });

  test("accepts an empty settings object (mirrors connector — nothing to write)", () => {
    expect(brandingSetParamsSchema.safeParse({ settings: {} }).success).toBe(true);
  });

  test("refuses a stray top-level key", () => {
    expect(brandingSetParamsSchema.safeParse({ settings: {}, extra: 1 }).success).toBe(false);
  });

  test("refuses a settings field outside the allow-list", () => {
    expect(brandingSetParamsSchema.safeParse({ settings: { not_a_field: "x" } }).success).toBe(false);
  });

  test("refuses a string field given a boolean (type mismatch)", () => {
    expect(brandingSetParamsSchema.safeParse({ settings: { brand_name: true } }).success).toBe(false);
  });

  test("refuses a bool field given a string (type mismatch)", () => {
    expect(brandingSetParamsSchema.safeParse({ settings: { apply_to_email: "yes" } }).success).toBe(false);
  });

  test("refuses when total string bytes exceed WIRE_MAX_BYTES", () => {
    // Arrange — a single oversized value pushes past the 8 KB ceiling.
    const big = "a".repeat(BRANDING_WIRE_MAX_BYTES + 1);
    // Act / Assert
    expect(brandingSetParamsSchema.safeParse({ settings: { login_message: big } }).success).toBe(false);
  });

  test("accepts a payload exactly at the byte ceiling", () => {
    const atLimit = "a".repeat(BRANDING_WIRE_MAX_BYTES);
    expect(brandingSetParamsSchema.safeParse({ settings: { login_message: atLimit } }).success).toBe(true);
  });
});

describe("configSetParamsSchema (mirrors IWSL_Config_Editor::validate_wire_params)", () => {
  test("accepts allow-listed keys with correctly-shaped values", () => {
    const params = { values: { WP_MEMORY_LIMIT: "256M", WP_DEBUG: true, EMPTY_TRASH_DAYS: 30 } };
    expect(configSetParamsSchema.safeParse(params).success).toBe(true);
  });

  test("refuses a stray top-level key", () => {
    expect(configSetParamsSchema.safeParse({ values: {}, extra: 1 }).success).toBe(false);
  });

  test("refuses a values key outside the allow-list", () => {
    expect(configSetParamsSchema.safeParse({ values: { DB_PASSWORD: "x" } }).success).toBe(false);
  });

  test("refuses a size value with a bad shape", () => {
    expect(configSetParamsSchema.safeParse({ values: { WP_MEMORY_LIMIT: "256X" } }).success).toBe(false);
  });

  test("accepts a size value as digits + K/M/G suffix", () => {
    expect(configSetParamsSchema.safeParse({ values: { upload_max_filesize: "512K" } }).success).toBe(true);
  });

  test("refuses a bool key given a string", () => {
    expect(configSetParamsSchema.safeParse({ values: { WP_DEBUG: "true" } }).success).toBe(false);
  });

  test("accepts int as a number and as its string form; refuses negative", () => {
    expect(configSetParamsSchema.safeParse({ values: { max_execution_time: 60 } }).success).toBe(true);
    expect(configSetParamsSchema.safeParse({ values: { max_execution_time: "60" } }).success).toBe(true);
    expect(configSetParamsSchema.safeParse({ values: { max_execution_time: -1 } }).success).toBe(false);
  });

  test("int_or_false accepts false, '', 'false', an int and its string form", () => {
    for (const v of [false, "", "false", 5, "5"]) {
      expect(configSetParamsSchema.safeParse({ values: { WP_POST_REVISIONS: v } }).success).toBe(true);
    }
  });

  test("int_or_false refuses a bad string", () => {
    expect(configSetParamsSchema.safeParse({ values: { WP_POST_REVISIONS: "maybe" } }).success).toBe(false);
  });

  test("the local allow-list mirror has exactly the 12 connector keys", () => {
    expect(Object.keys(CONFIG_ALLOWLIST)).toHaveLength(12);
  });
});

describe("contentDuplicateParamsSchema (mirrors IWSL_Duplicate_Post::validate_params)", () => {
  test("accepts a positive integer post_id", () => {
    expect(contentDuplicateParamsSchema.safeParse({ post_id: 42 }).success).toBe(true);
  });

  test("refuses a stray key", () => {
    expect(contentDuplicateParamsSchema.safeParse({ post_id: 42, force: true }).success).toBe(false);
  });

  test("refuses a non-positive or non-integer id", () => {
    expect(contentDuplicateParamsSchema.safeParse({ post_id: 0 }).success).toBe(false);
    expect(contentDuplicateParamsSchema.safeParse({ post_id: -3 }).success).toBe(false);
    expect(contentDuplicateParamsSchema.safeParse({ post_id: 1.5 }).success).toBe(false);
    expect(contentDuplicateParamsSchema.safeParse({ post_id: "42" }).success).toBe(false);
  });
});

describe("RPC registry wiring for the content-branding methods", () => {
  const methods = ["branding.get", "branding.set", "config.get", "config.set", "content.duplicate"] as const;

  test("all five wire strings are registered", () => {
    for (const m of methods) expect(RPC_METHODS).toContain(m);
  });

  test("read methods carry no params; write methods carry params", () => {
    expect(RPC_REGISTRY["branding.get"].hasParams).toBe(false);
    expect(RPC_REGISTRY["config.get"].hasParams).toBe(false);
    expect(RPC_REGISTRY["branding.set"].hasParams).toBe(true);
    expect(RPC_REGISTRY["config.set"].hasParams).toBe(true);
    expect(RPC_REGISTRY["content.duplicate"].hasParams).toBe(true);
  });

  test("read validators refuse any params (empty-only)", () => {
    expect(RPC_REGISTRY["branding.get"].validate({})).toBe(true);
    expect(RPC_REGISTRY["branding.get"].validate({ x: 1 })).toBe(false);
    expect(RPC_REGISTRY["config.get"].validate({})).toBe(true);
    expect(RPC_REGISTRY["config.get"].validate({ x: 1 })).toBe(false);
  });

  test("write validators delegate to the zod schemas (accept valid, refuse invalid)", () => {
    expect(RPC_REGISTRY["branding.set"].validate({ settings: { brand_name: "Acme" } })).toBe(true);
    expect(RPC_REGISTRY["branding.set"].validate({ settings: { bogus: 1 } })).toBe(false);
    expect(RPC_REGISTRY["config.set"].validate({ values: { WP_MEMORY_LIMIT: "256M" } })).toBe(true);
    expect(RPC_REGISTRY["config.set"].validate({ values: { WP_MEMORY_LIMIT: "nope" } })).toBe(false);
    expect(RPC_REGISTRY["content.duplicate"].validate({ post_id: 7 })).toBe(true);
    expect(RPC_REGISTRY["content.duplicate"].validate({ post_id: 0 })).toBe(false);
  });
});
