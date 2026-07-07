import {
  buildGamePortForwardRule,
  gamePortForwardName,
  getLanNodeIp,
  openGameServerPortForward,
  removeGameServerPortForward,
} from "@/addons/gamehub/lib/game-port-forward";

const upsertPortForwardNoConflict = jest.fn();
const deletePortForward = jest.fn();
const getUdmClientAsync = jest.fn();

jest.mock("@/lib/udm/config", () => ({
  getUdmClientAsync: () => getUdmClientAsync(),
}));

beforeEach(() => {
  upsertPortForwardNoConflict.mockReset();
  deletePortForward.mockReset();
  getUdmClientAsync.mockReset();
});

describe("gamePortForwardName", () => {
  test("prefixes the server name with game-", () => {
    expect(gamePortForwardName("palworld")).toBe("game-palworld");
  });
});

describe("buildGamePortForwardRule", () => {
  test("WAN port equals the NodePort and proto lowercases (UDP)", () => {
    const rule = buildGamePortForwardRule({ serverName: "palworld", protocol: "UDP", nodeIp: "10.10.0.91", nodePort: 32255 });
    expect(rule).toEqual({
      name: "game-palworld",
      enabled: true,
      proto: "udp",
      dst_port: "32255",
      fwd: "10.10.0.91",
      fwd_port: "32255",
      src: "any",
      log: false,
    });
  });

  test("defaults to tcp for a TCP port", () => {
    const rule = buildGamePortForwardRule({ serverName: "valheim", protocol: "TCP", nodeIp: "10.10.0.92", nodePort: 30567 });
    expect(rule.proto).toBe("tcp");
    expect(rule.dst_port).toBe("30567");
    expect(rule.fwd_port).toBe("30567");
  });
});

describe("getLanNodeIp", () => {
  test("returns the first Ready node's InternalIP", async () => {
    const coreApi = {
      listNode: async () => ({
        items: [
          { status: { conditions: [{ type: "Ready", status: "False" }], addresses: [{ type: "InternalIP", address: "10.10.0.90" }] } },
          { status: { conditions: [{ type: "Ready", status: "True" }], addresses: [{ type: "InternalIP", address: "10.10.0.91" }] } },
        ],
      }),
    } as never;
    expect(await getLanNodeIp(coreApi)).toBe("10.10.0.91");
  });

  test("returns null when no Ready node exists", async () => {
    const coreApi = { listNode: async () => ({ items: [{ status: { conditions: [{ type: "Ready", status: "False" }] } }] }) } as never;
    expect(await getLanNodeIp(coreApi)).toBeNull();
  });
});

describe("openGameServerPortForward", () => {
  test("returns { configured: false } when the connector is not configured", async () => {
    getUdmClientAsync.mockResolvedValue(null);
    const result = await openGameServerPortForward({ serverName: "palworld", protocol: "UDP", nodeIp: "10.10.0.91", nodePort: 32255 });
    expect(result).toEqual({ configured: false });
  });

  test("upserts with keepFwdPortInSync and returns the assigned port", async () => {
    upsertPortForwardNoConflict.mockResolvedValue({ action: "created", id: "abc", requestedPort: "32255", assignedPort: "32255", bumped: false });
    getUdmClientAsync.mockResolvedValue({ upsertPortForwardNoConflict });
    const result = await openGameServerPortForward({ serverName: "palworld", protocol: "UDP", nodeIp: "10.10.0.91", nodePort: 32255 });

    expect(upsertPortForwardNoConflict).toHaveBeenCalledWith(
      expect.objectContaining({ name: "game-palworld", proto: "udp", dst_port: "32255", fwd_port: "32255", fwd: "10.10.0.91" }),
      { keepFwdPortInSync: true },
    );
    expect(result).toEqual({ configured: true, assignedPort: "32255", requestedPort: "32255", bumped: false, action: "created", ruleName: "game-palworld" });
  });
});

describe("removeGameServerPortForward", () => {
  test("returns false when the connector is not configured", async () => {
    getUdmClientAsync.mockResolvedValue(null);
    expect(await removeGameServerPortForward("palworld")).toBe(false);
    expect(deletePortForward).not.toHaveBeenCalled();
  });

  test("deletes the rule by its game- name", async () => {
    deletePortForward.mockResolvedValue({ action: "deleted", id: "abc" });
    getUdmClientAsync.mockResolvedValue({ deletePortForward });
    expect(await removeGameServerPortForward("palworld")).toBe(true);
    expect(deletePortForward).toHaveBeenCalledWith("game-palworld");
  });
});
