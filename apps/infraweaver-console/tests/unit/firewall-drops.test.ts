import {
  summarizeBlockedFlows,
  blockedFlowsQuery,
  buildAllowRule,
  isAllowable,
  type PromQueryResult,
  type BlockedDestination,
} from "@/lib/firewall/drops";

function sample(metric: Record<string, string>, rate: string): PromQueryResult["data"]["result"][number] {
  return { metric, value: [1719600000, rate] };
}

describe("summarizeBlockedFlows", () => {
  test("returns empty array for null/empty results", () => {
    expect(summarizeBlockedFlows(null)).toEqual([]);
    expect(summarizeBlockedFlows(undefined)).toEqual([]);
    expect(summarizeBlockedFlows({ status: "success", data: { resultType: "vector", result: [] } })).toEqual([]);
  });

  // Live label shape (Cilium 1.17): labelsContext supplies source_/destination_
  // namespace|pod|ip; the single `destination` context label carries the FQDN
  // (destinationContext=dns|ip). There is no destination_dns / destination_port
  // label on hubble_drop_total.
  test("groups dropped destinations by source pod and sorts by drop rate", () => {
    const result: PromQueryResult = {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          sample({ source_namespace: "wordpress", source_pod: "wp-0", destination: "api.wordpress.org", protocol: "TCP", reason: "POLICY_DENIED" }, "5"),
          sample({ source_namespace: "wordpress", source_pod: "wp-0", destination: "1.2.3.4", destination_ip: "1.2.3.4", protocol: "TCP" }, "2"),
          sample({ source_namespace: "tradesphere", source_pod: "ts-1", destination: "data.binance.com", protocol: "TCP" }, "9"),
        ],
      },
    };
    const out = summarizeBlockedFlows(result);
    expect(out).toHaveLength(2);
    // tradesphere is noisier overall -> first
    expect(out[0].pod).toBe("ts-1");
    expect(out[1].pod).toBe("wp-0");
    // within wp-0, fqdn (rate 5) before ip (rate 2)
    expect(out[1].destinations[0].target).toBe("api.wordpress.org");
    expect(out[1].destinations[0].kind).toBe("fqdn");
    expect(out[1].destinations[1].kind).toBe("ip");
    expect(out[1].destinations[1].target).toBe("1.2.3.4/32");
    expect(out[1].totalDropRate).toBeCloseTo(7);
  });

  test("dedupes identical destination+port+protocol and sums rate", () => {
    const result: PromQueryResult = {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          sample({ source_namespace: "n8n-prod", source_pod: "n8n-0", destination: "hooks.slack.com.", protocol: "TCP" }, "1"),
          sample({ source_namespace: "n8n-prod", source_pod: "n8n-0", destination: "hooks.slack.com.", protocol: "TCP" }, "3"),
        ],
      },
    };
    const out = summarizeBlockedFlows(result);
    expect(out[0].destinations).toHaveLength(1);
    // trailing dot stripped
    expect(out[0].destinations[0].target).toBe("hooks.slack.com");
    expect(out[0].destinations[0].dropRate).toBeCloseTo(4);
  });

  test("still honors legacy destination_dns/destination_port labels", () => {
    const result: PromQueryResult = {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          sample({ source_namespace: "wordpress", source_pod: "wp-0", destination_dns: "api.wordpress.org", destination_port: "443", protocol: "TCP" }, "5"),
        ],
      },
    };
    const out = summarizeBlockedFlows(result);
    expect(out[0].destinations[0]).toMatchObject({ kind: "fqdn", target: "api.wordpress.org", port: "443" });
  });

  test("an IP in the destination context label classifies as ip, never fqdn", () => {
    const result: PromQueryResult = {
      status: "success",
      data: {
        resultType: "vector",
        result: [sample({ source_namespace: "wordpress", source_pod: "wp-0", destination: "34.117.65.55", protocol: "TCP" }, "2")],
      },
    };
    const out = summarizeBlockedFlows(result);
    expect(out[0].destinations[0].kind).toBe("ip");
    expect(out[0].destinations[0].target).toBe("34.117.65.55/32");
  });

  test("in-cluster destination pod wins over the context label", () => {
    const result: PromQueryResult = {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          sample(
            { source_namespace: "wordpress", source_pod: "wp-0", destination: "10.244.1.187", destination_ip: "10.244.1.187", destination_namespace: "wordpress", destination_pod: "mariadb-0", protocol: "TCP" },
            "3",
          ),
        ],
      },
    };
    const out = summarizeBlockedFlows(result);
    expect(out[0].destinations[0]).toMatchObject({ kind: "pod", target: "mariadb-0", namespace: "wordpress" });
  });

  test("scrape-job labels (cilium agent's namespace/pod) are never used as the subject", () => {
    const result: PromQueryResult = {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          // What a real scraped series looks like: job labels namespace/pod point
          // at the cilium agent, NOT the flow's subject.
          sample({ namespace: "kube-system", pod: "cilium-h8sbd", source_namespace: "wordpress", source_pod: "wp-0", destination: "api.wordpress.org", protocol: "TCP" }, "1"),
        ],
      },
    };
    const out = summarizeBlockedFlows(result);
    expect(out[0].namespace).toBe("wordpress");
    expect(out[0].pod).toBe("wp-0");
  });

  test("ignores zero/negative drop rates", () => {
    const result: PromQueryResult = {
      status: "success",
      data: { resultType: "vector", result: [sample({ source_namespace: "x", source_pod: "p", destination: "a.b" }, "0")] },
    };
    expect(summarizeBlockedFlows(result)).toEqual([]);
  });

  test("tolerates missing labels without throwing", () => {
    const result: PromQueryResult = {
      status: "success",
      data: { resultType: "vector", result: [sample({}, "1")] },
    };
    const out = summarizeBlockedFlows(result);
    expect(out[0].namespace).toBe("unknown");
    expect(out[0].pod).toBe("unknown");
    expect(out[0].destinations[0].kind).toBe("unknown");
  });
});

describe("blockedFlowsQuery", () => {
  test("builds an egress topk PromQL with the given window", () => {
    const q = blockedFlowsQuery(15);
    // Hubble's labelsContext emits `traffic_direction` (lowercase values) — there
    // is no `direction` label on hubble_drop_total.
    expect(q).toContain('hubble_drop_total{traffic_direction="egress"}[15m]');
    expect(q).toContain("topk(");
    expect(q).toContain("source_pod");
    expect(q).toContain("destination,");
  });
  test("clamps invalid windows to >= 1m", () => {
    expect(blockedFlowsQuery(0)).toContain("[1m]");
  });
});

describe("buildAllowRule / isAllowable", () => {
  const fqdn: BlockedDestination = { kind: "fqdn", target: "api.wordpress.org", port: "443", protocol: "tcp", dropRate: 1 };
  const ip: BlockedDestination = { kind: "ip", target: "1.2.3.4/32", port: "443", protocol: "TCP", dropRate: 1 };
  const pod: BlockedDestination = { kind: "pod", target: "mariadb", namespace: "wordpress", port: "3306", protocol: "TCP", dropRate: 1 };
  const unknown: BlockedDestination = { kind: "unknown", target: "unknown", dropRate: 1 };

  test("fqdn -> toFQDNs with uppercased protocol port", () => {
    const r = buildAllowRule(fqdn);
    expect(r.toFQDNs).toEqual([{ matchName: "api.wordpress.org" }]);
    expect(r.toPorts?.[0].ports[0]).toEqual({ port: "443", protocol: "TCP" });
  });
  test("ip -> toCIDR", () => {
    expect(buildAllowRule(ip).toCIDR).toEqual(["1.2.3.4/32"]);
  });
  test("pod -> toEndpoints with namespace + app labels", () => {
    const r = buildAllowRule(pod);
    expect(r.toEndpoints?.[0].matchLabels["k8s:io.kubernetes.pod.namespace"]).toBe("wordpress");
    expect(r.toEndpoints?.[0].matchLabels["k8s:app"]).toBe("mariadb");
  });
  test("isAllowable rejects unknown destinations", () => {
    expect(isAllowable(fqdn)).toBe(true);
    expect(isAllowable(ip)).toBe(true);
    expect(isAllowable(pod)).toBe(true);
    expect(isAllowable(unknown)).toBe(false);
    expect(buildAllowRule(unknown)).toEqual({});
  });
});
