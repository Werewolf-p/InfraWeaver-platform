import {
  summarizeBlockedIngress,
  blockedIngressQuery,
  buildIngressAllowRule,
  isIngressAllowable,
  isBidirectionalCandidate,
  appLabelFromPod,
  type PromQueryResult,
  type BlockedDestination,
} from "@/lib/firewall/drops";

function sample(metric: Record<string, string>, rate: string): PromQueryResult["data"]["result"][number] {
  return { metric, value: [1719600000, rate] };
}

describe("summarizeBlockedIngress", () => {
  test("groups by destination pod and reports the blocked source as the peer", () => {
    const result: PromQueryResult = {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          // someone in tradesphere tried to reach mariadb in wordpress and was denied
          sample(
            {
              source_namespace: "tradesphere",
              source_pod: "ts-api-7",
              destination_namespace: "wordpress",
              destination_pod: "mariadb-0",
              destination_port: "3306",
              protocol: "TCP",
              reason: "Policy denied",
            },
            "4",
          ),
          // an external IP hit the same pod on 3306 — live shape: the `source`
          // context label (sourceContext=dns|ip) carries the IP alongside source_ip
          sample(
            {
              source: "10.0.0.9",
              source_ip: "10.0.0.9",
              destination_namespace: "wordpress",
              destination_pod: "mariadb-0",
              destination_port: "3306",
              protocol: "TCP",
            },
            "1",
          ),
        ],
      },
    };
    const out = summarizeBlockedIngress(result);
    expect(out).toHaveLength(1);
    expect(out[0].namespace).toBe("wordpress");
    expect(out[0].pod).toBe("mariadb-0");
    // noisiest source first
    expect(out[0].destinations[0].kind).toBe("pod");
    expect(out[0].destinations[0].target).toBe("ts-api-7");
    expect(out[0].destinations[0].port).toBe("3306");
    expect(out[0].destinations[1].kind).toBe("ip");
    expect(out[0].destinations[1].target).toBe("10.0.0.9/32");
  });

  test("returns empty for null/empty", () => {
    expect(summarizeBlockedIngress(null)).toEqual([]);
    expect(summarizeBlockedIngress({ status: "success", data: { resultType: "vector", result: [] } })).toEqual([]);
  });
});

describe("blockedIngressQuery", () => {
  test("builds an ingress topk PromQL with the given window", () => {
    const q = blockedIngressQuery(7);
    // Hubble's labelsContext emits `traffic_direction` (lowercase values) — there
    // is no `direction` label on hubble_drop_total.
    expect(q).toContain('hubble_drop_total{traffic_direction="ingress"}[7m]');
    expect(q).toContain("topk(");
    expect(q).toContain("source_pod");
    expect(q).toContain("destination_pod");
  });
  test("clamps invalid windows to >= 1m", () => {
    expect(blockedIngressQuery(0)).toContain("[1m]");
  });
});

describe("buildIngressAllowRule / isIngressAllowable", () => {
  const ip: BlockedDestination = { kind: "ip", target: "10.0.0.9/32", port: "3306", protocol: "tcp", dropRate: 1 };
  const pod: BlockedDestination = { kind: "pod", target: "ts-api", namespace: "tradesphere", port: "3306", protocol: "TCP", dropRate: 1 };
  const fqdn: BlockedDestination = { kind: "fqdn", target: "api.example.com", dropRate: 1 };
  const unknown: BlockedDestination = { kind: "unknown", target: "unknown", dropRate: 1 };

  test("ip -> fromCIDR with uppercased port protocol", () => {
    const r = buildIngressAllowRule(ip);
    expect(r.fromCIDR).toEqual(["10.0.0.9/32"]);
    expect(r.toPorts?.[0].ports[0]).toEqual({ port: "3306", protocol: "TCP" });
  });
  test("pod -> fromEndpoints with namespace + app labels", () => {
    const r = buildIngressAllowRule(pod);
    expect(r.fromEndpoints?.[0].matchLabels["k8s:io.kubernetes.pod.namespace"]).toBe("tradesphere");
    expect(r.fromEndpoints?.[0].matchLabels["k8s:app"]).toBe("ts-api");
  });
  test("fqdn and unknown are not ingress-allowable", () => {
    expect(isIngressAllowable(ip)).toBe(true);
    expect(isIngressAllowable(pod)).toBe(true);
    expect(isIngressAllowable(fqdn)).toBe(false);
    expect(isIngressAllowable(unknown)).toBe(false);
    expect(buildIngressAllowRule(fqdn)).toEqual({});
    expect(buildIngressAllowRule(unknown)).toEqual({});
  });
});

describe("bidirectional helpers", () => {
  test("only in-cluster pods are bidirectional candidates", () => {
    expect(isBidirectionalCandidate({ kind: "pod", target: "mariadb", dropRate: 1 })).toBe(true);
    expect(isBidirectionalCandidate({ kind: "ip", target: "1.2.3.4/32", dropRate: 1 })).toBe(false);
    expect(isBidirectionalCandidate({ kind: "fqdn", target: "a.b", dropRate: 1 })).toBe(false);
    expect(isBidirectionalCandidate({ kind: "pod", target: "unknown", dropRate: 1 })).toBe(false);
  });

  test("appLabelFromPod strips replicaset/pod hash suffixes", () => {
    expect(appLabelFromPod("mariadb-77c9b5d6f9-x4k2p")).toBe("mariadb");
    expect(appLabelFromPod("wordpress-0")).toBe("wordpress");
    expect(appLabelFromPod("mariadb")).toBe("mariadb");
  });
});
