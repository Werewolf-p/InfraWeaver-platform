// The groups routes pull in `route-utils` (-> auth/NextAuth, ESM) and
// `access-store` (a `server-only` module + the Kubernetes client), none of which
// Jest can transform. Replace them with light fakes so we exercise the real
// permission-deny logic (from @/lib/rbac, which stays unmocked) end-to-end
// through the route handlers.
jest.mock("server-only", () => ({}), { virtual: true });

// The route guards do `session instanceof Response`; the jsdom test env has no
// `Response` global and our requireRoutePermissions mock never returns one, so a
// minimal stand-in keeps that `instanceof` from throwing.
if (typeof (globalThis as { Response?: unknown }).Response === "undefined") {
  (globalThis as { Response?: unknown }).Response = class {};
}

const createGroup = jest.fn(async (input: Record<string, unknown>) => ({
  id: "g1",
  createdAt: "2026-06-10T00:00:00.000Z",
  createdBy: "admin@example.com",
  ...input,
}));
const updateGroup = jest.fn(async (id: string, patch: Record<string, unknown>) => ({
  id,
  name: "existing",
  description: "",
  permissions: [],
  members: [],
  createdAt: "2026-06-10T00:00:00.000Z",
  createdBy: "admin@example.com",
  ...patch,
}));

jest.mock("@/lib/access-store", () => ({
  createGroup,
  updateGroup,
  loadAccessState: jest.fn(),
  deleteGroup: jest.fn(),
}));

// Fake route envelope: capture status + payload as a plain object instead of a
// NextResponse so assertions stay simple. requireRoutePermissions returns a
// session (never a Response), so the routes proceed straight to the handler.
jest.mock("@/lib/route-utils", () => ({
  requireRoutePermissions: jest.fn(async () => ({ user: { email: "admin@example.com" } })),
  apiError: (error: string, options: { status?: number } = {}) => ({ kind: "error", error, status: options.status ?? 500 }),
  apiSuccess: (data: unknown, options: { status?: number } = {}) => ({ kind: "success", data, status: options.status ?? 200 }),
  routeErrorResponse: (error: unknown) => ({ kind: "error", error: String(error), status: 500 }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/groups/route";
import { PATCH } from "@/app/api/groups/[id]/route";
import {
  ALL_PERMISSIONS,
  GROUP_DENIED_PERMISSIONS,
  type Permission,
} from "@/lib/rbac";

interface RouteResult {
  kind: "error" | "success";
  status: number;
  error?: string;
  data?: { group?: { permissions?: Permission[] } };
}

function postRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function patchRequest(body: unknown): { req: NextRequest; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: { json: async () => body } as unknown as NextRequest,
    ctx: { params: Promise.resolve({ id: "g1" }) },
  };
}

beforeEach(() => {
  createGroup.mockClear();
  updateGroup.mockClear();
});

describe("custom group permission deny-list — POST /api/groups", () => {
  it.each<Permission>(["users:write", "*", "rbac:admin", "cluster:admin", "platform:update", "security:write", "users:invite"])(
    "rejects creating a group containing %s with 400",
    async (permission) => {
      const res = (await POST(postRequest({ name: "evil", permissions: [permission] }))) as unknown as RouteResult;
      expect(res.status).toBe(400);
      expect(res.error).toBe(`Permission ${permission} cannot be granted via custom groups`);
      expect(createGroup).not.toHaveBeenCalled();
    },
  );

  it("rejects when a disallowed permission is mixed in with allowed ones", async () => {
    const res = (await POST(postRequest({ name: "mixed", permissions: ["apps:read", "users:write"] }))) as unknown as RouteResult;
    expect(res.status).toBe(400);
    expect(res.error).toContain("users:write");
    expect(createGroup).not.toHaveBeenCalled();
  });

  it("creates a group with an allowed resource-level permission set (201)", async () => {
    const permissions: Permission[] = ["apps:read", "config:read", "game-hub:read", "game-hub:players", "wiki:read"];
    const res = (await POST(postRequest({ name: "viewers", permissions }))) as unknown as RouteResult;
    expect(res.status).toBe(201);
    expect(res.kind).toBe("success");
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(res.data?.group?.permissions).toEqual(permissions);
  });

  it("creates a group with an empty permission set (201)", async () => {
    const res = (await POST(postRequest({ name: "empty", permissions: [] }))) as unknown as RouteResult;
    expect(res.status).toBe(201);
    expect(createGroup).toHaveBeenCalledTimes(1);
  });
});

describe("custom group permission deny-list — PATCH /api/groups/[id]", () => {
  it.each<Permission>(["users:write", "*"])(
    "rejects patching a group to contain %s with 400",
    async (permission) => {
      const { req, ctx } = patchRequest({ permissions: [permission] });
      const res = (await PATCH(req, ctx)) as unknown as RouteResult;
      expect(res.status).toBe(400);
      expect(res.error).toBe(`Permission ${permission} cannot be granted via custom groups`);
      expect(updateGroup).not.toHaveBeenCalled();
    },
  );

  it("patches a group with an allowed permission set (200)", async () => {
    const permissions: Permission[] = ["apps:read", "cluster:read"];
    const { req, ctx } = patchRequest({ permissions });
    const res = (await PATCH(req, ctx)) as unknown as RouteResult;
    expect(res.status).toBe(200);
    expect(updateGroup).toHaveBeenCalledTimes(1);
    expect(res.data?.group?.permissions).toEqual(permissions);
  });

  it("allows a patch that omits permissions entirely (200)", async () => {
    const { req, ctx } = patchRequest({ description: "rename only" });
    const res = (await PATCH(req, ctx)) as unknown as RouteResult;
    expect(res.status).toBe(200);
    expect(updateGroup).toHaveBeenCalledTimes(1);
  });
});

describe("GROUP_DENIED_PERMISSIONS integrity", () => {
  it("is a subset of the Permission union and includes the escalation tier", () => {
    const all = new Set<Permission>(ALL_PERMISSIONS);
    for (const denied of GROUP_DENIED_PERMISSIONS) {
      expect(all.has(denied)).toBe(true);
    }
    expect(GROUP_DENIED_PERMISSIONS).toContain("*");
    expect(GROUP_DENIED_PERMISSIONS).toContain("users:write");
  });
});
