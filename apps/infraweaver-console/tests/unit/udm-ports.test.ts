import {
  expandPortTokens,
  protosOverlap,
  occupiedWanPorts,
  occupiedLanTargets,
  firstFreePort,
  findDuplicateWanPorts,
  findDuplicateNames,
} from "@/lib/udm/ports";
import type { PortForwardRecord } from "@/lib/udm/types";

function rec(over: Partial<PortForwardRecord>): PortForwardRecord {
  return {
    _id: over._id ?? "id",
    name: over.name ?? "rule",
    enabled: over.enabled ?? true,
    proto: over.proto ?? "tcp_udp",
    dst_port: over.dst_port ?? "8211",
    fwd: over.fwd ?? "10.10.0.91",
    fwd_port: over.fwd_port ?? "8211",
    src: over.src ?? "any",
  } as PortForwardRecord;
}

describe("expandPortTokens", () => {
  test("expands a single port", () => {
    expect(expandPortTokens("8211")).toEqual([8211]);
  });

  test("expands a comma list", () => {
    expect(expandPortTokens("80,443")).toEqual([80, 443]);
  });

  test("expands a range inclusive", () => {
    expect(expandPortTokens("2456-2457")).toEqual([2456, 2457]);
  });

  test("expands a mix of list and range", () => {
    expect(expandPortTokens("7777,7778,27015")).toEqual([7777, 7778, 27015]);
  });

  test("skips malformed and out-of-range tokens", () => {
    expect(expandPortTokens("abc, ,70000,-5,443")).toEqual([443]);
  });

  test("drops a reversed range", () => {
    expect(expandPortTokens("500-400")).toEqual([]);
  });
});

describe("protosOverlap", () => {
  test("tcp_udp overlaps every protocol", () => {
    expect(protosOverlap("tcp_udp", "tcp")).toBe(true);
    expect(protosOverlap("udp", "tcp_udp")).toBe(true);
  });

  test("tcp and udp do not overlap", () => {
    expect(protosOverlap("tcp", "udp")).toBe(false);
  });

  test("same protocol overlaps", () => {
    expect(protosOverlap("udp", "udp")).toBe(true);
  });
});

describe("occupiedWanPorts", () => {
  test("collects overlapping-proto WAN ports and excludes self", () => {
    const rules = [
      rec({ name: "a", proto: "udp", dst_port: "8211" }),
      rec({ name: "b", proto: "tcp", dst_port: "25565" }),
      rec({ name: "self", proto: "udp", dst_port: "9999" }),
    ];

    const occupied = occupiedWanPorts(rules, "udp", "self");

    expect(occupied.has(8211)).toBe(true);
    expect(occupied.has(25565)).toBe(false); // tcp does not overlap udp
    expect(occupied.has(9999)).toBe(false); // excluded self
  });

  test("ignores disabled rules", () => {
    const rules = [rec({ name: "off", enabled: false, dst_port: "8211" })];
    expect(occupiedWanPorts(rules, "udp").has(8211)).toBe(false);
  });
});

describe("occupiedLanTargets", () => {
  test("keys targets as ip:port for overlapping protos", () => {
    const rules = [rec({ name: "a", proto: "udp", fwd: "10.10.0.91", fwd_port: "32255" })];
    const lan = occupiedLanTargets(rules, "udp");
    expect(lan.has("10.10.0.91:32255")).toBe(true);
  });
});

describe("firstFreePort", () => {
  test("returns desired when free", () => {
    expect(firstFreePort(8211, new Set())).toBe(8211);
  });

  test("bumps upward past occupied ports", () => {
    expect(firstFreePort(8211, new Set([8211, 8212]))).toBe(8213);
  });

  test("respects min and clamps a below-min desired up to min", () => {
    expect(firstFreePort(10, new Set(), { min: 30000, max: 32767 })).toBe(30000);
  });

  test("wraps to min after passing max", () => {
    const occupied = new Set([32767]);
    expect(firstFreePort(32767, occupied, { min: 30000, max: 32767 })).toBe(30000);
  });

  test("returns null when the whole window is occupied", () => {
    const occupied = new Set([30000, 30001, 30002]);
    expect(firstFreePort(30000, occupied, { min: 30000, max: 30002 })).toBeNull();
  });
});

describe("findDuplicateWanPorts", () => {
  test("flags two overlapping-proto rules on the same port", () => {
    const rules = [
      rec({ name: "palworld", proto: "udp", dst_port: "8211" }),
      rec({ name: "dup", proto: "tcp_udp", dst_port: "8211" }),
    ];
    expect(findDuplicateWanPorts(rules)).toEqual([{ port: 8211, names: ["dup", "palworld"] }]);
  });

  test("does not flag tcp and udp sharing a port number", () => {
    const rules = [
      rec({ name: "web-tcp", proto: "tcp", dst_port: "443" }),
      rec({ name: "web-udp", proto: "udp", dst_port: "443" }),
    ];
    expect(findDuplicateWanPorts(rules)).toEqual([]);
  });

  test("returns empty when all ports are unique", () => {
    const rules = [
      rec({ name: "a", dst_port: "8211" }),
      rec({ name: "b", dst_port: "25565" }),
    ];
    expect(findDuplicateWanPorts(rules)).toEqual([]);
  });
});

describe("findDuplicateNames", () => {
  test("returns names appearing on more than one rule, sorted", () => {
    const rules = [rec({ name: "game-a" }), rec({ name: "game-b" }), rec({ name: "game-a" }), rec({ name: "z" }), rec({ name: "z" })];
    expect(findDuplicateNames(rules)).toEqual(["game-a", "z"]);
  });
  test("empty when all unique", () => {
    expect(findDuplicateNames([rec({ name: "a" }), rec({ name: "b" })])).toEqual([]);
  });
});
