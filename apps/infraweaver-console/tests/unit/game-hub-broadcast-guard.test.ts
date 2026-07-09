/**
 * @jest-environment node
 *
 * H2 (SECURITY-SCAN-2026-07-08): the /game-hub/servers/broadcast route fanned a
 * command out to many servers but — unlike /exec, /command, /rcon — never ran
 * assertCommandAllowed, so the per-server deployment blocklist and the egg's
 * per-role command ACL were skipped on the broadcast path. This test pins the
 * fix: broadcast must enforce assertCommandAllowed per server, and a denial must
 * surface as that server's error without running the command.
 *
 * The route pulls in auth/NextAuth (ESM) and the Kubernetes client, which Jest
 * can't transform — replace them with light fakes so we exercise the real guard
 * wiring end-to-end through the handler.
 */
jest.mock("server-only", () => ({}), { virtual: true });

if (typeof (globalThis as { Response?: unknown }).Response === "undefined") {
  (globalThis as { Response?: unknown }).Response = class {};
}

const runServerCommand = jest.fn(async () => ({ stdout: "ok", stderr: "", method: "rcon" }));
const assertCommandAllowed = jest.fn(async (_clients: unknown, name: string) =>
  name === "blocked-server"
    ? { allowed: false, reason: "acl", message: "Command not allowed for your role" }
    : { allowed: true },
);
const hasGameHubPermission = jest.fn(() => true);

jest.mock("@/lib/auth", () => ({ auth: jest.fn(async () => ({ user: { email: "op@example.com" } })) }));
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn(async () => {}), auditUnauthorizedAccess: jest.fn(async () => {}) }));
jest.mock("@/lib/game-hub", () => ({
  getGameHubAccessContext: jest.fn(async () => ({ groups: [], username: "op", roleAssignments: [] })),
  hasGameHubPermission: (...a: unknown[]) => hasGameHubPermission(...(a as [])),
}));
jest.mock("@/lib/game-hub-server", () => ({
  makeGameHubClients: jest.fn(() => ({})),
  runServerCommand: (...a: unknown[]) => runServerCommand(...(a as [])),
  assertCommandAllowed: (...a: unknown[]) => assertCommandAllowed(...(a as [])),
}));
jest.mock("@/lib/api-helpers", () => ({ sanitizeConsoleCommand: (c: string) => ({ ok: true, value: c }) }));
jest.mock("@/lib/api-security", () => ({ validateK8sName: () => null }));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => true, rateLimitKey: () => "k" }));
jest.mock("@/lib/utils", () => ({ safeError: (e: unknown) => String(e) }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/game-hub/servers/broadcast/route";

function makeReq(body: unknown): NextRequest {
  return { json: async () => body, headers: new Headers() } as unknown as NextRequest;
}

beforeEach(() => {
  runServerCommand.mockClear();
  assertCommandAllowed.mockClear();
  hasGameHubPermission.mockClear();
});

test("runs assertCommandAllowed for every targeted server", async () => {
  const res = await POST(makeReq({ servers: ["s1", "s2"], command: "say hi" }));
  await res.json();
  expect(assertCommandAllowed).toHaveBeenCalledTimes(2);
  expect(assertCommandAllowed.mock.calls.map((c) => c[1]).sort()).toEqual(["s1", "s2"]);
});

test("a server whose ACL denies the command is not executed and reports the denial", async () => {
  const res = await POST(makeReq({ servers: ["s1", "blocked-server"], command: "op forbidden" }));
  const body = (await res.json()) as { results: { server: string; error?: string }[] };

  const blocked = body.results.find((r) => r.server === "blocked-server");
  expect(blocked?.error).toBe("Command not allowed for your role");

  // The command ran only against the allowed server, never the denied one.
  expect(runServerCommand).toHaveBeenCalledTimes(1);
  expect(runServerCommand.mock.calls[0][1]).toBe("s1");
});

test("a server the caller lacks game-hub:console on is forbidden before ACL check", async () => {
  hasGameHubPermission.mockImplementation((_g, _u, _r, _p, server) => server !== "no-access");
  const res = await POST(makeReq({ servers: ["s1", "no-access"], command: "say hi" }));
  const body = (await res.json()) as { results: { server: string; error?: string }[] };

  expect(body.results.find((r) => r.server === "no-access")?.error).toBe("Forbidden");
  expect(assertCommandAllowed).not.toHaveBeenCalledWith(expect.anything(), "no-access", expect.anything(), expect.anything());
});
