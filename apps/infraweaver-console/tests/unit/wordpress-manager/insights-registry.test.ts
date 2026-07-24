/** @jest-environment node */
// The RPC registry must know the three insight methods and validate their params
// exactly as the connector does (a request the console accepts is one the plugin
// accepts), and `callRpc` must funnel only allow-listed methods.

import {
  RPC_METHODS,
  RPC_REGISTRY,
  callRpc,
  type RpcMethod,
  type RpcTransport,
} from "@/addons/wordpress-manager/lib/rpc/registry";

const INSIGHT_METHODS: RpcMethod[] = ["stats.summary", "stats.timeseries", "activity.log"];

describe("rpc registry — insight methods", () => {
  test("all three are registered and carry params", () => {
    for (const m of INSIGHT_METHODS) {
      expect(RPC_METHODS).toContain(m);
      expect(RPC_REGISTRY[m]).toBeDefined();
      expect(RPC_REGISTRY[m].hasParams).toBe(true);
    }
  });

  test("stats.summary validator: empty or 1|7|30, nothing else", () => {
    const v = RPC_REGISTRY["stats.summary"].validate;
    expect(v({})).toBe(true);
    expect(v({ range_days: 7 })).toBe(true);
    expect(v({ range_days: 3 })).toBe(false);
    expect(v({ range_days: 7, extra: 1 })).toBe(false);
  });

  test("stats.timeseries validator: empty or 1..30", () => {
    const v = RPC_REGISTRY["stats.timeseries"].validate;
    expect(v({})).toBe(true);
    expect(v({ days: 30 })).toBe(true);
    expect(v({ days: 0 })).toBe(false);
    expect(v({ days: 31 })).toBe(false);
  });

  test("activity.log validator: empty or 1..100", () => {
    const v = RPC_REGISTRY["activity.log"].validate;
    expect(v({})).toBe(true);
    expect(v({ limit: 100 })).toBe(true);
    expect(v({ limit: 0 })).toBe(false);
    expect(v({ limit: 101 })).toBe(false);
  });
});

describe("callRpc funnel", () => {
  const reply = { ok: true, kid: 1, result: { locked: false }, roundtripMs: 1 };

  test("forwards a registered insight method + params unchanged", async () => {
    const transport = jest.fn(async () => reply) as unknown as RpcTransport;
    await callRpc(transport, "stats.summary", { range_days: 7 });
    expect(transport).toHaveBeenCalledWith("stats.summary", { range_days: 7 }, undefined);
  });

  test("rejects a method that is not allow-listed", async () => {
    const transport = jest.fn(async () => reply) as unknown as RpcTransport;
    await expect(callRpc(transport, "stats.bogus" as RpcMethod, {} as never)).rejects.toThrow(/not an allow-listed/);
    expect(transport).not.toHaveBeenCalled();
  });
});
