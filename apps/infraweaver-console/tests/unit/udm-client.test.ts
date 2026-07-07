import { UdmClient, UdmError } from "@/lib/udm/client";
import type { TransportResponse, UdmTransport } from "@/lib/udm/types";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** A programmable fake transport that records calls and returns queued responses. */
function fakeTransport(handler: (call: Call) => TransportResponse): { transport: UdmTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: UdmTransport = async (method, path, body) => {
    const call = { method, path, body };
    calls.push(call);
    return handler(call);
  };
  return { transport, calls };
}

function ok(data: unknown): TransportResponse {
  return { status: 200, json: { data } };
}

const RULE = {
  name: "palworld",
  enabled: true,
  proto: "udp" as const,
  dst_port: "8211",
  fwd: "10.10.0.91",
  fwd_port: "32255",
};

describe("UdmClient port-forward reconciliation", () => {
  it("lists rules from the default site path", async () => {
    // Arrange
    const { transport, calls } = fakeTransport(() => ok([{ ...RULE, _id: "a1" }]));
    const client = new UdmClient(transport);

    // Act
    const rules = await client.listPortForwards();

    // Assert
    expect(rules).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "GET", path: "/proxy/network/api/s/default/rest/portforward", body: undefined });
  });

  it("creates a rule with POST when the name is absent", async () => {
    // Arrange
    const { transport, calls } = fakeTransport((call) => {
      if (call.method === "GET") return ok([]);
      return ok([{ ...RULE, _id: "new-id" }]);
    });
    const client = new UdmClient(transport);

    // Act
    const result = await client.upsertPortForward(RULE);

    // Assert
    expect(result).toEqual({ action: "created", id: "new-id" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1].path).toBe("/proxy/network/api/s/default/rest/portforward");
  });

  it("updates in place with PUT to the existing _id and never duplicates", async () => {
    // Arrange
    const existing = { ...RULE, _id: "existing-id", dst_port: "8211" };
    const { transport, calls } = fakeTransport((call) => {
      if (call.method === "GET") return ok([existing]);
      return ok([existing]);
    });
    const client = new UdmClient(transport);

    // Act
    const result = await client.upsertPortForward({ ...RULE, dst_port: "8212" });

    // Assert
    expect(result).toEqual({ action: "updated", id: "existing-id" });
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].path).toBe("/proxy/network/api/s/default/rest/portforward/existing-id");
    // Merges onto the existing document, overriding the changed field.
    expect(calls[1].body).toMatchObject({ _id: "existing-id", dst_port: "8212" });
  });

  it("reports absent when deleting a name that does not exist", async () => {
    // Arrange
    const { transport, calls } = fakeTransport(() => ok([]));
    const client = new UdmClient(transport);

    // Act
    const result = await client.deletePortForward("missing");

    // Assert
    expect(result).toEqual({ action: "absent", id: null });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("deletes an existing rule by its _id", async () => {
    // Arrange
    const { transport, calls } = fakeTransport((call) =>
      call.method === "GET" ? ok([{ ...RULE, _id: "del-id" }]) : ok([]),
    );
    const client = new UdmClient(transport);

    // Act
    const result = await client.deletePortForward("palworld");

    // Assert
    expect(result).toEqual({ action: "deleted", id: "del-id" });
    expect(calls[1]).toMatchObject({ method: "DELETE", path: "/proxy/network/api/s/default/rest/portforward/del-id" });
  });

  it("flags duplicate rule names", async () => {
    // Arrange
    const { transport } = fakeTransport(() =>
      ok([
        { ...RULE, _id: "1", name: "dup" },
        { ...RULE, _id: "2", name: "dup" },
        { ...RULE, _id: "3", name: "unique" },
      ]),
    );
    const client = new UdmClient(transport);

    // Act
    const dups = await client.findDuplicateNames();

    // Assert
    expect(dups).toEqual(["dup"]);
  });

  it("honors a non-default site slug in the request path", async () => {
    // Arrange
    const { transport, calls } = fakeTransport(() => ok([]));
    const client = new UdmClient(transport, "lab");

    // Act
    await client.listPortForwards();

    // Assert
    expect(calls[0].path).toBe("/proxy/network/api/s/lab/rest/portforward");
  });

  it("throws UdmError with the HTTP status on a non-2xx response", async () => {
    // Arrange
    const { transport } = fakeTransport(() => ({ status: 401, json: {} }));
    const client = new UdmClient(transport);

    // Act / Assert
    await expect(client.listPortForwards()).rejects.toMatchObject({ name: "UdmError", status: 401 });
    await expect(client.listPortForwards()).rejects.toBeInstanceOf(UdmError);
  });
});

describe("UdmClient WAN status", () => {
  it("returns the public IP and marks a normal address as not CGNAT", async () => {
    // Arrange
    const { transport } = fakeTransport(() =>
      ok([{ subsystem: "wan", status: "ok", wan_ip: "84.82.69.110" }]),
    );
    const client = new UdmClient(transport);

    // Act
    const wan = await client.getWanStatus();

    // Assert
    expect(wan).toEqual({ wanIp: "84.82.69.110", up: true, isCgnat: false });
  });

  it("detects CGNAT when the WAN IP is in 100.64.0.0/10", async () => {
    // Arrange
    const { transport } = fakeTransport(() =>
      ok([{ subsystem: "www", status: "ok", wan_ip: "100.72.13.4" }]),
    );
    const client = new UdmClient(transport);

    // Act
    const wan = await client.getWanStatus();

    // Assert
    expect(wan.isCgnat).toBe(true);
  });
});
