import { UdmClient, UdmError } from "@/lib/udm/client";
import type { PortForwardRecord, UdmTransport } from "@/lib/udm/types";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Fake transport: every GET returns `existing`, writes echo the sent body back. */
function fakeTransport(existing: PortForwardRecord[]): { transport: UdmTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: UdmTransport = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET") return { status: 200, json: { data: existing } };
    return { status: 200, json: { data: [{ ...(body as object), _id: "written" }] } };
  };
  return { transport, calls };
}

function rec(over: Partial<PortForwardRecord>): PortForwardRecord {
  return {
    _id: over._id ?? "id",
    name: over.name ?? "rule",
    enabled: over.enabled ?? true,
    proto: over.proto ?? "udp",
    dst_port: over.dst_port ?? "8211",
    fwd: over.fwd ?? "10.10.0.91",
    fwd_port: over.fwd_port ?? "32255",
    src: "any",
  } as PortForwardRecord;
}

const NEW_RULE = {
  name: "palworld2",
  enabled: true,
  proto: "udp" as const,
  dst_port: "8211",
  fwd: "10.10.0.92",
  fwd_port: "32260",
};

describe("upsertPortForwardNoConflict", () => {
  it("uses the requested port when it is free", async () => {
    // Arrange
    const { transport, calls } = fakeTransport([rec({ name: "other", dst_port: "25565" })]);
    const client = new UdmClient(transport);

    // Act
    const alloc = await client.upsertPortForwardNoConflict(NEW_RULE);

    // Assert
    expect(alloc.assignedPort).toBe("8211");
    expect(alloc.bumped).toBe(false);
    const write = calls.find((c) => c.method === "POST");
    expect((write?.body as { dst_port: string }).dst_port).toBe("8211");
  });

  it("bumps the WAN port when an overlapping-proto rule already claims it", async () => {
    // Arrange: palworld udp:8211 already exists
    const { transport, calls } = fakeTransport([rec({ name: "palworld", proto: "udp", dst_port: "8211" })]);
    const client = new UdmClient(transport);

    // Act
    const alloc = await client.upsertPortForwardNoConflict(NEW_RULE);

    // Assert
    expect(alloc.requestedPort).toBe("8211");
    expect(alloc.assignedPort).toBe("8212");
    expect(alloc.bumped).toBe(true);
    const write = calls.find((c) => c.method === "POST");
    expect((write?.body as { dst_port: string }).dst_port).toBe("8212");
  });

  it("does not bump when the existing rule is a different protocol", async () => {
    // Arrange: a TCP rule on 8211 does not block a UDP request for 8211
    const { transport } = fakeTransport([rec({ name: "tcponly", proto: "tcp", dst_port: "8211" })]);
    const client = new UdmClient(transport);

    // Act
    const alloc = await client.upsertPortForwardNoConflict(NEW_RULE);

    // Assert
    expect(alloc.assignedPort).toBe("8211");
    expect(alloc.bumped).toBe(false);
  });

  it("keeps an existing same-name rule's port stable across re-reconcile", async () => {
    // Arrange: rule already assigned 8213 previously; caller re-requests 8211
    const { transport, calls } = fakeTransport([
      rec({ name: "palworld2", proto: "udp", dst_port: "8213", fwd: "10.10.0.92", fwd_port: "32260" }),
    ]);
    const client = new UdmClient(transport);

    // Act
    const alloc = await client.upsertPortForwardNoConflict(NEW_RULE);

    // Assert: it holds 8213, does not move to 8211
    expect(alloc.assignedPort).toBe("8213");
    expect(alloc.action).toBe("updated");
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
  });

  it("syncs the LAN fwd_port to the assigned WAN port when asked", async () => {
    // Arrange
    const { transport, calls } = fakeTransport([rec({ name: "palworld", proto: "udp", dst_port: "8211" })]);
    const client = new UdmClient(transport);

    // Act
    const alloc = await client.upsertPortForwardNoConflict(NEW_RULE, { keepFwdPortInSync: true });

    // Assert
    expect(alloc.assignedPort).toBe("8212");
    const write = calls.find((c) => c.method === "POST");
    expect((write?.body as { fwd_port: string }).fwd_port).toBe("8212");
  });

  it("rejects a second forward to the identical LAN endpoint", async () => {
    // Arrange: existing rule already delivers to 10.10.0.92:32260
    const { transport } = fakeTransport([
      rec({ name: "existing", proto: "udp", dst_port: "9000", fwd: "10.10.0.92", fwd_port: "32260" }),
    ]);
    const client = new UdmClient(transport);

    // Act + Assert
    await expect(client.upsertPortForwardNoConflict(NEW_RULE)).rejects.toThrow(UdmError);
  });

  it("throws 409 when no port is free in the probe window", async () => {
    // Arrange: fill the tiny window 8211-8212
    const { transport } = fakeTransport([
      rec({ name: "a", proto: "udp", dst_port: "8211" }),
      rec({ name: "b", proto: "udp", dst_port: "8212" }),
    ]);
    const client = new UdmClient(transport);

    // Act + Assert
    await expect(
      client.upsertPortForwardNoConflict(NEW_RULE, { min: 8211, max: 8212 }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("findDuplicatePorts", () => {
  it("surfaces overlapping-proto rules sharing a WAN port", async () => {
    // Arrange
    const { transport } = fakeTransport([
      rec({ name: "palworld", proto: "udp", dst_port: "8211" }),
      rec({ name: "dup", proto: "tcp_udp", dst_port: "8211" }),
    ]);
    const client = new UdmClient(transport);

    // Act
    const dups = await client.findDuplicatePorts();

    // Assert
    expect(dups).toEqual([{ port: 8211, names: ["dup", "palworld"] }]);
  });
});
