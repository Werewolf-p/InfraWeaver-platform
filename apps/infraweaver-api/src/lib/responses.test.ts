import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Context } from "hono";
import type { AppBindings } from "../types/index.js";
import { forbidden, badRequest, invalidBody, notFound, upstream } from "./responses.js";

// Stub context: helpers only call c.json(body, status), so record both.
type Call = { body: unknown; status: number };
function stubCtx(): { c: Context<AppBindings>; last: () => Call } {
  let call: Call | undefined;
  const c = {
    json: (body: unknown, status: number) => {
      call = { body, status };
      return call;
    },
  } as unknown as Context<AppBindings>;
  return { c, last: () => call as Call };
}

describe("api response helpers", () => {
  it("forbidden defaults to the bare Forbidden/403 RBAC shape", () => {
    const { c, last } = stubCtx();
    forbidden(c);
    assert.deepEqual(last(), { body: { error: "Forbidden" }, status: 403 });
  });

  it("forbidden passes a custom message through at 403", () => {
    const { c, last } = stubCtx();
    forbidden(c, "Refusing to delete a reserved namespace");
    assert.deepEqual(last(), { body: { error: "Refusing to delete a reserved namespace" }, status: 403 });
  });

  it("badRequest maps to 400 with the message", () => {
    const { c, last } = stubCtx();
    badRequest(c, "Invalid slug");
    assert.deepEqual(last(), { body: { error: "Invalid slug" }, status: 400 });
  });

  it("invalidBody returns the flattened zod error at 400", () => {
    const { c, last } = stubCtx();
    const parsed = z.object({ name: z.string() }).safeParse({});
    assert.equal(parsed.success, false);
    if (parsed.success) return;
    invalidBody(c, parsed.error);
    const { status, body } = last();
    assert.equal(status, 400);
    assert.deepEqual(body, { error: parsed.error.flatten() });
  });

  it("notFound maps to 404", () => {
    const { c, last } = stubCtx();
    notFound(c, "Community app not found");
    assert.deepEqual(last(), { body: { error: "Community app not found" }, status: 404 });
  });

  it("upstream maps to 502", () => {
    const { c, last } = stubCtx();
    upstream(c, "Failed to fetch pods");
    assert.deepEqual(last(), { body: { error: "Failed to fetch pods" }, status: 502 });
  });
});
