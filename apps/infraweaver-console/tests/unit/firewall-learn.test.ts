import {
  buildLearnPolicy,
  buildLearnedAllowRules,
  learnPolicyName,
  learnedQueriesQuery,
  parseLearnedQueries,
} from "@/lib/firewall/learn";
import type { PromQueryResult } from "@/lib/firewall/drops";

function sample(metric: Record<string, string>, value: string): PromQueryResult["data"]["result"][number] {
  return { metric, value: [1719600000, value] };
}

describe("buildLearnPolicy", () => {
  test("selects the workload, allows all both ways, and proxies DNS", () => {
    const p = buildLearnPolicy("zonnevaarwater-nl-learn-mode", "wordpress", { "infraweaver.io/site": "zonnevaarwater-nl" }, "infraweaver-console");
    const spec = p.spec as Record<string, unknown>;
    expect((spec.endpointSelector as { matchLabels: object }).matchLabels).toEqual({ "infraweaver.io/site": "zonnevaarwater-nl" });
    const egress = spec.egress as Array<Record<string, unknown>>;
    expect(egress.some((r) => JSON.stringify(r).includes('"matchPattern":"*"'))).toBe(true);
    expect(egress.some((r) => JSON.stringify(r.toEntities) === '["all"]')).toBe(true);
    expect(JSON.stringify((spec.ingress as unknown[])[0])).toContain('"all"');
    expect((p.metadata as { labels: Record<string, string> }).labels["infraweaver.io/learn-mode"]).toBe("true");
  });

  test("learnPolicyName is <app>-learn-mode", () => {
    expect(learnPolicyName("zonnevaarwater-nl")).toBe("zonnevaarwater-nl-learn-mode");
  });
});

describe("learnedQueriesQuery", () => {
  test("scopes to namespace and clamps window", () => {
    const q = learnedQueriesQuery("wordpress", 0);
    expect(q).toContain('source_namespace="wordpress"');
    expect(q).toContain("[1m]");
    expect(q).toContain("query");
  });
});

describe("parseLearnedQueries", () => {
  const result: PromQueryResult = {
    status: "success",
    data: {
      resultType: "vector",
      result: [
        sample({ source_pod: "wp-0", query: "servmask.com." }, "12"),
        sample({ source_pod: "wp-0", query: "SERVMASK.com" }, "3"),
        sample({ source_pod: "wp-0", query: "mariadb.wordpress.svc.cluster.local." }, "50"),
        sample({ source_pod: "wp-0", query: "4.3.2.1.in-addr.arpa." }, "9"),
        sample({ source_pod: "other-pod", query: "evil.example.com" }, "99"),
        sample({ source_pod: "wp-0", query: "api.wordpress.org" }, "5"),
      ],
    },
  };

  test("filters to app pods, drops cluster noise, merges case/dot dupes, sorts by count", () => {
    const out = parseLearnedQueries(result, ["wp-0"]);
    expect(out).toEqual([
      { fqdn: "servmask.com", count: 15 },
      { fqdn: "api.wordpress.org", count: 5 },
    ]);
  });

  test("empty/null input yields empty list", () => {
    expect(parseLearnedQueries(null, ["wp-0"])).toEqual([]);
  });
});

describe("buildLearnedAllowRules", () => {
  test("one toFQDNs rule per unique fqdn", () => {
    const rules = buildLearnedAllowRules([
      { fqdn: "servmask.com", count: 15 },
      { fqdn: "servmask.com", count: 1 },
      { fqdn: "api.wordpress.org", count: 5 },
    ]);
    expect(rules).toEqual([
      { toFQDNs: [{ matchName: "servmask.com" }] },
      { toFQDNs: [{ matchName: "api.wordpress.org" }] },
    ]);
  });
});
