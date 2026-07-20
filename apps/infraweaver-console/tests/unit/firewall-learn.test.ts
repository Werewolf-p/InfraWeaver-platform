import {
  allowedFqdnsFromPolicy,
  allowlistPolicyName,
  buildLearnPolicy,
  buildLearnedAllowRules,
  filterAlreadyAllowed,
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

describe("allowlistPolicyName", () => {
  test("is <app>-egress-allowlist", () => {
    expect(allowlistPolicyName("zonnevaarwater-nl")).toBe("zonnevaarwater-nl-egress-allowlist");
  });
});

describe("allowedFqdnsFromPolicy", () => {
  test("extracts matchName + matchPattern, normalizing case and trailing dots", () => {
    const policy = {
      spec: {
        egress: [
          { toFQDNs: [{ matchName: "SERVMASK.com." }, { matchName: "api.wordpress.org" }] },
          { toEndpoints: [{ matchLabels: { "k8s-app": "kube-dns" } }] }, // non-FQDN rule ignored
          { toFQDNs: [{ matchPattern: "*.GoogleAPIs.com." }] },
        ],
      },
    };
    const allowed = allowedFqdnsFromPolicy(policy);
    expect([...allowed.names].sort()).toEqual(["api.wordpress.org", "servmask.com"]);
    expect(allowed.patterns).toEqual(["*.googleapis.com"]);
  });

  test("absent / malformed policy yields an empty set", () => {
    expect(allowedFqdnsFromPolicy(undefined)).toEqual({ names: new Set(), patterns: [] });
    expect(allowedFqdnsFromPolicy(null)).toEqual({ names: new Set(), patterns: [] });
    expect(allowedFqdnsFromPolicy({ spec: {} })).toEqual({ names: new Set(), patterns: [] });
    expect(allowedFqdnsFromPolicy({ spec: { egress: "nope" } })).toEqual({ names: new Set(), patterns: [] });
  });
});

describe("filterAlreadyAllowed", () => {
  const learned = [
    { fqdn: "servmask.com", count: 15 },
    { fqdn: "api.wordpress.org", count: 5 },
    { fqdn: "storage.googleapis.com", count: 3 },
  ];

  test("removes FQDNs already covered by exact matchName rules", () => {
    const allowed = allowedFqdnsFromPolicy({
      spec: { egress: [{ toFQDNs: [{ matchName: "servmask.com" }] }] },
    });
    expect(filterAlreadyAllowed(learned, allowed)).toEqual([
      { fqdn: "api.wordpress.org", count: 5 },
      { fqdn: "storage.googleapis.com", count: 3 },
    ]);
  });

  test("wildcard matchPattern coverage excludes matching subdomains but not the bare apex or siblings", () => {
    const allowed = allowedFqdnsFromPolicy({
      spec: { egress: [{ toFQDNs: [{ matchPattern: "*.googleapis.com" }] }] },
    });
    const queries = [
      { fqdn: "storage.googleapis.com", count: 3 }, // covered -> dropped
      { fqdn: "a.b.googleapis.com", count: 2 }, // covered (matches across dots) -> dropped
      { fqdn: "googleapis.com", count: 1 }, // bare apex NOT covered by *. -> kept
      { fqdn: "api.wordpress.org", count: 5 }, // unrelated -> kept
    ];
    expect(filterAlreadyAllowed(queries, allowed)).toEqual([
      { fqdn: "googleapis.com", count: 1 },
      { fqdn: "api.wordpress.org", count: 5 },
    ]);
  });

  test("a session where everything was already allowed yields an empty learned list", () => {
    const allowed = allowedFqdnsFromPolicy({
      spec: {
        egress: [
          { toFQDNs: [{ matchName: "servmask.com" }, { matchName: "api.wordpress.org" }] },
          { toFQDNs: [{ matchPattern: "*.googleapis.com" }] },
        ],
      },
    });
    expect(filterAlreadyAllowed(learned, allowed)).toEqual([]);
  });

  test("empty allowlist keeps every learned entry (no I/O, order preserved)", () => {
    expect(filterAlreadyAllowed(learned, allowedFqdnsFromPolicy(undefined))).toEqual(learned);
  });

  test("re-enable scenario: after committing, the same DNS traffic surfaces no new domains", () => {
    // Prometheus still reports the domains the app resolves (they are now allowed),
    // but the allowlist written by the prior "Allow learned" filters them all out.
    const result: PromQueryResult = {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          sample({ source_pod: "wp-0", query: "servmask.com." }, "20"),
          sample({ source_pod: "wp-0", query: "api.wordpress.org" }, "8"),
        ],
      },
    };
    const committed = allowedFqdnsFromPolicy({
      spec: {
        egress: [{ toFQDNs: [{ matchName: "servmask.com" }, { matchName: "api.wordpress.org" }] }],
      },
    });
    expect(filterAlreadyAllowed(parseLearnedQueries(result, ["wp-0"]), committed)).toEqual([]);
  });
});
