/**
 * Stress test for the WAN-port bump path.
 *
 * The homelab design keeps WAN == NodePort and relies on NodePort uniqueness so a
 * bump "never" fires (see game-port-forward.ts). This test deliberately forces the
 * collision the design normally prevents — two game servers contrived onto the same
 * target port, plus a foreign manually-seeded rule squatting a port — and proves
 * `upsertPortForwardNoConflict` bumps the *newcomer* to the next free WAN port while
 * leaving every already-placed rule byte-for-byte untouched.
 *
 * Unlike the pure-logic test (udm-client-noconflict.test.ts, stateless echo
 * transport), this drives the ENTIRE stack — openGameServerPortForward -> real
 * UdmClient -> a stateful in-memory `rest/portforward` store — so "without touching
 * the first" is asserted against the store's actual final contents, not a mock.
 */

import { UdmClient } from "@/lib/udm/client";
import type { PortForwardRecord, TransportResponse, UdmTransport } from "@/lib/udm/types";
import { buildGamePortForwardRule, openGameServerPortForward } from "@/addons/gamehub/lib/game-port-forward";

const getUdmClientAsync = jest.fn();
jest.mock("@/lib/udm/config", () => ({
  getUdmClientAsync: () => getUdmClientAsync(),
}));

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * A stateful fake of the UDM `rest/portforward` endpoint: POST appends (assigns a
 * deterministic `_id`), PUT replaces by id, DELETE removes by id, GET lists. This
 * is what lets us re-read the store after N reconciles and prove earlier rules were
 * never mutated.
 */
class FakeUdm {
  readonly calls: Call[] = [];
  private store: PortForwardRecord[] = [];
  private seq = 0;

  /** Pre-seed a rule as if a human/other system created it directly on the router. */
  seed(rec: Partial<PortForwardRecord> & Pick<PortForwardRecord, "name" | "proto" | "dst_port" | "fwd" | "fwd_port">): void {
    this.store.push({ _id: `seed-${(this.seq += 1)}`, enabled: true, src: "any", ...rec } as PortForwardRecord);
  }

  snapshot(): PortForwardRecord[] {
    return this.store.map((r) => ({ ...r }));
  }

  byName(name: string): PortForwardRecord | undefined {
    return this.store.find((r) => r.name === name);
  }

  readonly transport: UdmTransport = async (method, path, body): Promise<TransportResponse> => {
    this.calls.push({ method, path, body });
    const idMatch = path.match(/\/rest\/portforward\/([^/]+)$/);

    if (method === "GET") return { status: 200, json: { data: this.snapshot() } };

    if (method === "POST") {
      const created = { _id: `w-${(this.seq += 1)}`, ...(body as object) } as PortForwardRecord;
      this.store.push(created);
      return { status: 200, json: { data: [created] } };
    }

    if (method === "PUT" && idMatch) {
      const id = idMatch[1];
      this.store = this.store.map((r) => (r._id === id ? ({ ...(body as object), _id: id } as PortForwardRecord) : r));
      return { status: 200, json: { data: [this.byId(id)] } };
    }

    if (method === "DELETE" && idMatch) {
      const id = idMatch[1];
      this.store = this.store.filter((r) => r._id !== id);
      return { status: 200, json: { data: [] } };
    }

    return { status: 400, json: { data: [] } };
  };

  private byId(id: string): PortForwardRecord | undefined {
    return this.store.find((r) => r._id === id);
  }
}

/** All writes (POST/PUT/DELETE) whose target rule carries this _id. */
function writesTouching(udm: FakeUdm, id: string): Call[] {
  return udm.calls.filter(
    (c) => c.method !== "GET" && (c.path.endsWith(`/${id}`) || (c.body as { _id?: string } | undefined)?._id === id),
  );
}

const NODE_IP = "10.10.0.91"; // single-node homelab: every NodePort lives on one node IP
const SHARED_PORT = 32000; // two servers contrived onto the same nodePort to force the collision

function wireClient(udm: FakeUdm): void {
  getUdmClientAsync.mockResolvedValue(new UdmClient(udm.transport));
}

beforeEach(() => {
  getUdmClientAsync.mockReset();
});

describe("bump path — two game servers colliding on one WAN port", () => {
  test("second server bumps to the next free port; the first is left untouched", async () => {
    // Arrange: server-a already reconciled and holds the shared port (this IS the
    // "pre-seeded rule on one server's nodePort").
    const udm = new FakeUdm();
    wireClient(udm);

    const first = await openGameServerPortForward({ serverName: "server-a", protocol: "UDP", nodeIp: NODE_IP, nodePort: SHARED_PORT });
    expect(first).toMatchObject({ assignedPort: "32000", bumped: false, action: "created" });

    const firstId = udm.byName("game-server-a")!._id;
    const callsBefore = udm.calls.length;

    // Act: server-b, contrived onto the SAME nodePort, reconciles second.
    const second = await openGameServerPortForward({ serverName: "server-b", protocol: "UDP", nodeIp: NODE_IP, nodePort: SHARED_PORT });

    // Assert: the newcomer bumped WAN 32000 -> 32001...
    expect(second).toMatchObject({ requestedPort: "32000", assignedPort: "32001", bumped: true, action: "created", ruleName: "game-server-b" });

    // ...the LAN side tracked it (keepFwdPortInSync), so no LAN-target collision either.
    const b = udm.byName("game-server-b")!;
    expect(b.dst_port).toBe("32001");
    expect(b.fwd_port).toBe("32001");
    expect(b.fwd).toBe(NODE_IP);

    // ...and the first rule was NEVER written to during the second reconcile.
    const a = udm.byName("game-server-a")!;
    expect(a._id).toBe(firstId);
    expect(a.dst_port).toBe("32000");
    expect(a.fwd_port).toBe("32000");
    expect(writesTouching(udm, firstId)).toHaveLength(0); // never PUT/DELETE'd — the create POST carried no _id yet
    expect(udm.calls.slice(callsBefore).filter((c) => c.method !== "GET")).toEqual([
      expect.objectContaining({ method: "POST" }), // exactly one write — the newcomer — nothing else
    ]);
  });

  test("re-reconciling the bumped server is idempotent — it keeps 32001, never drifts back onto 32000", async () => {
    // Arrange: reach the post-bump state.
    const udm = new FakeUdm();
    wireClient(udm);
    await openGameServerPortForward({ serverName: "server-a", protocol: "UDP", nodeIp: NODE_IP, nodePort: SHARED_PORT });
    await openGameServerPortForward({ serverName: "server-b", protocol: "UDP", nodeIp: NODE_IP, nodePort: SHARED_PORT });

    // Act: reconcile server-b again (still requesting its NodePort 32000).
    const again = await openGameServerPortForward({ serverName: "server-b", protocol: "UDP", nodeIp: NODE_IP, nodePort: SHARED_PORT });

    // Assert: holds 32001 via an in-place update, does not collide back onto server-a.
    expect(again).toMatchObject({ assignedPort: "32001", action: "updated" });
    expect(udm.byName("game-server-b")!.dst_port).toBe("32001");
    expect(udm.byName("game-server-a")!.dst_port).toBe("32000");
    expect(udm.snapshot()).toHaveLength(2); // no duplicate rule was spawned
  });

  test("bump climbs past a run of taken ports (three servers stacked on one port)", async () => {
    const udm = new FakeUdm();
    wireClient(udm);

    const ports: string[] = [];
    for (const name of ["srv1", "srv2", "srv3"]) {
      const r = await openGameServerPortForward({ serverName: name, protocol: "UDP", nodeIp: NODE_IP, nodePort: SHARED_PORT });
      ports.push(r.assignedPort!);
    }

    // Each newcomer steps to the next free port; no two share a WAN port.
    expect(ports).toEqual(["32000", "32001", "32002"]);
    expect(new Set(udm.snapshot().map((r) => r.dst_port)).size).toBe(3);
    expect(await new UdmClient(udm.transport).findDuplicatePorts()).toEqual([]);
  });
});

describe("bump path — foreign manually-seeded rule squats the port", () => {
  test("a game server bumps around a hand-created rule and never rewrites it", async () => {
    // Arrange: an operator manually forwarded 32000/udp to some other host.
    const udm = new FakeUdm();
    udm.seed({ name: "manual-legacy", proto: "udp", dst_port: "32000", fwd: "10.9.9.9", fwd_port: "32000" });
    wireClient(udm);
    const seedId = udm.byName("manual-legacy")!._id;

    // Act: a game server whose NodePort is 32000 reconciles.
    const res = await openGameServerPortForward({ serverName: "arkserver", protocol: "UDP", nodeIp: NODE_IP, nodePort: SHARED_PORT });

    // Assert: game rule bumped to 32001; the manual rule is byte-for-byte intact.
    expect(res).toMatchObject({ requestedPort: "32000", assignedPort: "32001", bumped: true });
    expect(writesTouching(udm, seedId)).toHaveLength(0);
    expect(udm.byName("manual-legacy")).toEqual(
      expect.objectContaining({ _id: seedId, dst_port: "32000", fwd: "10.9.9.9", fwd_port: "32000" }),
    );
  });

  test("a different-protocol squatter does NOT trigger a bump (tcp rule vs udp game server)", async () => {
    // Arrange: manual TCP rule on 32000 — different wire, no real conflict.
    const udm = new FakeUdm();
    udm.seed({ name: "manual-tcp", proto: "tcp", dst_port: "32000", fwd: "10.9.9.9", fwd_port: "32000" });
    wireClient(udm);

    // Act
    const res = await openGameServerPortForward({ serverName: "udpserver", protocol: "UDP", nodeIp: NODE_IP, nodePort: SHARED_PORT });

    // Assert: keeps 32000, no bump.
    expect(res).toMatchObject({ assignedPort: "32000", bumped: false });
  });
});

/**
 * A deliberately tiny WAN window to exercise `firstFreePort`'s wrap arm. The
 * game-hub wrapper (`openGameServerPortForward`) always allocates over the full
 * [1,65535] range, so it can never expose the wrap edge — these tests call the
 * real `UdmClient.upsertPortForwardNoConflict` directly (still against the
 * stateful FakeUdm store) with an explicit `{min,max}` so the requested port can
 * be pinned to the very TOP of the window. The rule itself is still built by the
 * game layer's `buildGamePortForwardRule`, so this is the same WAN==NodePort,
 * keepFwdPortInSync shape as the full-stack cases above.
 */
const WINDOW_MIN = 32000;
const WINDOW_MAX = 32002; // tight 3-port window: [min, mid, top] = [32000, 32001, 32002]
const WINDOW = { keepFwdPortInSync: true, min: WINDOW_MIN, max: WINDOW_MAX } as const;

describe("bump path — requested port at the top of a tight [min,max] window", () => {
  test("probe wraps past max to min and lands on the free low port", async () => {
    // Arrange: the top and middle of the window are taken; only the low port
    // (== min) is free. There is no port ABOVE the requested one, so the only
    // way to a free slot is to wrap around to min.
    const udm = new FakeUdm();
    udm.seed({ name: "game-server-a", proto: "udp", dst_port: "32002", fwd: NODE_IP, fwd_port: "32002" }); // window top
    udm.seed({ name: "game-filler", proto: "udp", dst_port: "32001", fwd: NODE_IP, fwd_port: "32001" }); // window mid
    const client = new UdmClient(udm.transport);

    // Act: server-b, contrived onto the SAME nodePort as server-a (32002 — the
    // window top), reconciles into the tight window.
    const rule = buildGamePortForwardRule({ serverName: "server-b", protocol: "UDP", nodeIp: NODE_IP, nodePort: WINDOW_MAX });
    const alloc = await client.upsertPortForwardNoConflict(rule, WINDOW);

    // Assert: desired 32002 is taken AND is the ceiling, so the probe wrapped to
    // min and settled on the free low port 32000 — not off the top of the window.
    expect(alloc).toMatchObject({ requestedPort: "32002", assignedPort: "32000", bumped: true, action: "created" });

    const b = udm.byName("game-server-b")!;
    expect(b.dst_port).toBe("32000");
    expect(b.fwd_port).toBe("32000"); // keepFwdPortInSync tracked the wrapped-down port
    expect(b.fwd).toBe(NODE_IP);

    // The two pre-placed rules are byte-for-byte where they were.
    expect(udm.byName("game-server-a")!.dst_port).toBe("32002");
    expect(udm.byName("game-filler")!.dst_port).toBe("32001");
    // Every WAN port distinct — the wrap did not silently double-book min.
    expect(await new UdmClient(udm.transport).findDuplicatePorts()).toEqual([]);
  });

  test("whole window full → clean 409, nothing written to the store", async () => {
    // Arrange: every port in the tight window is occupied by an overlapping udp
    // rule — there is no free slot to wrap onto.
    const udm = new FakeUdm();
    udm.seed({ name: "game-lo", proto: "udp", dst_port: "32000", fwd: NODE_IP, fwd_port: "32000" });
    udm.seed({ name: "game-mid", proto: "udp", dst_port: "32001", fwd: NODE_IP, fwd_port: "32001" });
    udm.seed({ name: "game-hi", proto: "udp", dst_port: "32002", fwd: NODE_IP, fwd_port: "32002" });
    const client = new UdmClient(udm.transport);

    const rule = buildGamePortForwardRule({ serverName: "newcomer", protocol: "UDP", nodeIp: NODE_IP, nodePort: WINDOW_MAX });
    const writesBefore = udm.calls.filter((c) => c.method !== "GET").length; // seeds bypass the transport → 0

    // Act + assert: allocation fails with a 409 raised BEFORE any write is issued.
    await expect(client.upsertPortForwardNoConflict(rule, WINDOW)).rejects.toMatchObject({
      name: "UdmError",
      status: 409,
    });

    // No POST/PUT/DELETE reached the store — the failed reconcile left it pristine
    // (no half-created "game-newcomer" rule squatting a slot it never secured).
    expect(udm.calls.filter((c) => c.method !== "GET")).toHaveLength(writesBefore);
    expect(udm.byName("game-newcomer")).toBeUndefined();
    expect(udm.snapshot()).toHaveLength(3); // exactly the three seeds, untouched
  });
});
