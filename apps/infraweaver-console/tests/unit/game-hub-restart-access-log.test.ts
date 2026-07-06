/**
 * The game-hub `servers/[name]` PATCH restart action deletes pods, so — like the
 * generic /api/pods DELETE/PATCH routes — it must emit a raw `type:access` line
 * that pins the caller + referer. This was the one mutating game-hub path with
 * no access trail, so a restart that churned an installing pod during a console
 * rolling update was unattributable.
 *
 * The route pulls in `next/server`, NextAuth, the Kubernetes client and other
 * ESM/`server-only` modules Jest can't transform, so we replace every dependency
 * with a light fake and keep ONLY `@/lib/access-log` real, then spy on
 * `console.log` to assert the real `logMutatingAccess` fired.
 */
jest.mock("server-only", () => ({}), { virtual: true });

// next/server is ESM-only under Jest; stub NextResponse.json to a plain object.
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
  NextRequest: class {},
}));

jest.mock("@/lib/auth", () => ({
  auth: jest.fn(async () => ({ user: { email: "remon@example.com" } })),
}));

jest.mock("@/lib/game-hub", () => ({
  GAME_HUB_NAMESPACE: "game-hub",
  getGameHubAccessContext: jest.fn(async () => ({ groups: [], username: "remon", roleAssignments: [] })),
  hasGameHubPermission: jest.fn(() => true),
}));

const restartServerPods = jest.fn(async () => ({ deleted: [], skippedInstalling: true }));
const patchNamespacedDeployment = jest.fn(async () => ({}));

jest.mock("@/lib/game-hub-server", () => ({
  GAME_HUB_NS: "game-hub",
  makeGameHubClients: jest.fn(() => ({
    appsApi: { patchNamespacedDeployment, readNamespacedDeployment: jest.fn(async () => ({ metadata: { annotations: {} } })) },
    coreApi: {},
    autoscalingApi: { deleteNamespacedHorizontalPodAutoscaler: jest.fn(async () => ({})) },
    batchApi: {},
  })),
  getServerDeployment: jest.fn(async () => ({ metadata: { annotations: {} }, spec: {}, status: {} })),
  readServerEgg: jest.fn(async () => ({})),
  parseDiscordWebhookConfig: jest.fn(() => null),
  sendDiscordWebhook: jest.fn(async () => undefined),
  appendServerAudit: jest.fn(async () => undefined),
  restartServerPods,
  // Unused-on-this-path exports referenced at import time.
  forceStopServer: jest.fn(),
  gracefulStopServer: jest.fn(),
  getServerPod: jest.fn(),
  getNodeIp: jest.fn(),
  checkPortReachable: jest.fn(),
  derivePowerStatus: jest.fn(),
  createCronJob: jest.fn(),
  deleteCronJob: jest.fn(),
  getDeploymentGameType: jest.fn(),
  parseImageVersion: jest.fn(() => ({ version: "latest", pinned: false })),
  parsePlayerHistory: jest.fn(() => []),
  parsePowerSchedule: jest.fn(() => null),
  buildPowerScheduleCron: jest.fn(),
  readSavedCommands: jest.fn(async () => []),
  writeSavedCommands: jest.fn(async () => undefined),
  validateServerToken: jest.fn(),
  isKubernetesNotFoundError: jest.fn(() => false),
}));

jest.mock("@/lib/game-eggs", () => ({ buildEggConfigMap: jest.fn() }));
jest.mock("@/lib/game-hub-manifest", () => ({
  deleteServerManifest: jest.fn(),
  getGitHubConfig: jest.fn(() => ({ token: "" })),
  writeServerManifest: jest.fn(async () => undefined),
}));
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn(async () => undefined) }));
jest.mock("@/lib/api-security", () => ({ validateK8sName: jest.fn(() => null) }));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: jest.fn(() => true), rateLimitKey: jest.fn(() => "k") }));
jest.mock("@/lib/rbac", () => ({ getEffectivePermissions: jest.fn(() => new Set()) }));
jest.mock("@/lib/utils", () => ({ safeError: jest.fn((e: unknown) => String(e)) }));

// Loaded AFTER the mocks so the route binds the fakes; access-log stays real.
import { PATCH } from "@/app/api/game-hub/servers/[name]/route";

function makeReq(action: string): Request {
  const headers: Record<string, string> = {
    referer: "https://console.int/game-hub",
    "user-agent": "jest",
    "x-forwarded-for": "10.0.0.9",
  };
  return {
    method: "PATCH",
    url: "https://console.int/api/game-hub/servers/ark-0",
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => ({ action }),
  } as unknown as Request;
}

function accessLines(spy: jest.SpyInstance): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('"type":"access"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("game-hub servers PATCH restart access logging", () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    restartServerPods.mockResolvedValue({ deleted: [], skippedInstalling: true });
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("emits a type:access line pinning actor, method and path on restart", async () => {
    // Arrange
    const req = makeReq("restart");

    // Act
    const res = (await PATCH(req as never, { params: Promise.resolve({ name: "ark-0" }) } as never)) as {
      body: Record<string, unknown>;
    };

    // Assert
    expect(restartServerPods).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ action: "restart", name: "ark-0", skippedInstalling: true });

    const lines = accessLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: "access",
      method: "PATCH",
      path: "/api/game-hub/servers/ark-0",
      actor: "remon@example.com",
      referer: "https://console.int/game-hub",
      ip: "10.0.0.9",
    });
  });

  test("does not emit an access line for a non-restart action", async () => {
    // Arrange
    const req = makeReq("set-notes");

    // Act
    await PATCH(req as never, { params: Promise.resolve({ name: "ark-0" }) } as never);

    // Assert
    expect(restartServerPods).not.toHaveBeenCalled();
    expect(accessLines(logSpy)).toHaveLength(0);
  });
});
