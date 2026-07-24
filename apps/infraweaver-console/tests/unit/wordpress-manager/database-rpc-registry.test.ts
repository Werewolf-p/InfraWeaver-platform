/**
 * The `db.*` methods must be registered in the console RPC allow-list in lockstep
 * with the plugin's IWSL_Plugin::command_handlers(). These tests assert the three
 * methods exist, that db.analyze is paramless, and that the write validators
 * mirror the plugin's (dry_run a real boolean; frequency clamped) — the same
 * allow-list check the plugin enforces, so the two sides can never drift.
 */

import { RPC_METHODS, RPC_REGISTRY } from "@/addons/wordpress-manager/lib/rpc/registry";

describe("db.* RPC registry entries", () => {
  test("all three methods are registered", () => {
    expect(RPC_METHODS).toEqual(expect.arrayContaining(["db.analyze", "db.cleanup", "db.schedule"]));
  });

  test("db.analyze is paramless", () => {
    expect(RPC_REGISTRY["db.analyze"].hasParams).toBe(false);
    expect(RPC_REGISTRY["db.analyze"].validate({})).toBe(true);
    expect(RPC_REGISTRY["db.analyze"].validate({ anything: 1 })).toBe(false);
  });

  test("db.cleanup validator mirrors the plugin (dry_run must be a real boolean)", () => {
    const v = RPC_REGISTRY["db.cleanup"].validate;
    expect(RPC_REGISTRY["db.cleanup"].hasParams).toBe(true);
    expect(v({ categories: ["post_revisions"], dry_run: false })).toBe(true);
    expect(v({ categories: ["post_revisions"], dry_run: true, max_rows: 100 })).toBe(true);
    // Missing / non-boolean dry_run is rejected before it can reach the wire.
    expect(v({ categories: ["post_revisions"] })).toBe(false);
    expect(v({ categories: ["post_revisions"], dry_run: "false" })).toBe(false);
    // A category id can only ever be a registry-shaped token.
    expect(v({ categories: ["DROP TABLE wp_users"], dry_run: true })).toBe(false);
  });

  test("db.schedule validator mirrors the plugin (frequency clamped to the allow-list)", () => {
    const v = RPC_REGISTRY["db.schedule"].validate;
    expect(RPC_REGISTRY["db.schedule"].hasParams).toBe(true);
    expect(v({ enabled: true, frequency: "daily" })).toBe(true);
    expect(v({ enabled: false, frequency: "weekly", categories: ["auto_drafts"] })).toBe(true);
    expect(v({ enabled: true, frequency: "hourly" })).toBe(false);
    expect(v({ enabled: true })).toBe(false);
  });
});
