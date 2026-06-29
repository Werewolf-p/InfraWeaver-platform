import {
  flattenPolicyRules,
  removeRuleFromSpec,
  describePeer,
  describePorts,
  policySelectsApp,
  type CnpObject,
} from "@/lib/firewall/rules";

const policy: CnpObject = {
  metadata: {
    name: "mariadb-ingress-allowlist",
    namespace: "wordpress",
    labels: { "app.kubernetes.io/managed-by": "infraweaver-console" },
  },
  spec: {
    endpointSelector: { matchLabels: { app: "mariadb" } },
    ingress: [
      {
        fromEndpoints: [{ matchLabels: { "k8s:io.kubernetes.pod.namespace": "wordpress", "k8s:app": "wordpress" } }],
        toPorts: [{ ports: [{ port: "3306", protocol: "TCP" }] }],
      },
      { fromCIDR: ["10.0.0.0/24"] },
    ],
    egress: [{ toFQDNs: [{ matchName: "api.wordpress.org" }], toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }] }],
  },
};

describe("describePeer / describePorts", () => {
  test("ingress fromEndpoints renders pod namespace/app", () => {
    expect(describePeer(policy.spec!.ingress![0] as Record<string, unknown>, "ingress")).toBe("pod: wordpress/wordpress");
  });
  test("ingress fromCIDR renders cidr", () => {
    expect(describePeer(policy.spec!.ingress![1] as Record<string, unknown>, "ingress")).toBe("cidr: 10.0.0.0/24");
  });
  test("egress toFQDNs renders fqdn", () => {
    expect(describePeer(policy.spec!.egress![0] as Record<string, unknown>, "egress")).toBe("fqdn: api.wordpress.org");
  });
  test("ports render as port/PROTO, or 'all ports' when absent", () => {
    expect(describePorts(policy.spec!.ingress![0] as Record<string, unknown>)).toBe("3306/TCP");
    expect(describePorts(policy.spec!.ingress![1] as Record<string, unknown>)).toBe("all ports");
  });
});

describe("flattenPolicyRules", () => {
  test("flattens ingress + egress into addressable entries with stable indices", () => {
    const rules = flattenPolicyRules([policy]);
    expect(rules).toHaveLength(3);
    const ingress = rules.filter((r) => r.direction === "ingress");
    const egress = rules.filter((r) => r.direction === "egress");
    expect(ingress.map((r) => r.index)).toEqual([0, 1]);
    expect(egress[0].index).toBe(0);
    expect(rules.every((r) => r.managed)).toBe(true);
    expect(rules.every((r) => r.policyName === "mariadb-ingress-allowlist")).toBe(true);
  });

  test("marks unmanaged policies", () => {
    const unmanaged: CnpObject = { metadata: { name: "x", namespace: "y" }, spec: { egress: [{ toCIDR: ["1.1.1.1/32"] }] } };
    expect(flattenPolicyRules([unmanaged])[0].managed).toBe(false);
  });
});

describe("policySelectsApp", () => {
  test("matches app and k8s:app labels", () => {
    expect(policySelectsApp(policy, "mariadb")).toBe(true);
    expect(policySelectsApp(policy, "wordpress")).toBe(false);
    const k8sLabel: CnpObject = { spec: { endpointSelector: { matchLabels: { "k8s:app": "redis" } } } };
    expect(policySelectsApp(k8sLabel, "redis")).toBe(true);
  });
});

describe("removeRuleFromSpec", () => {
  test("removes a rule immutably and reindexes the remaining array", () => {
    const result = removeRuleFromSpec(policy, "ingress", 0);
    expect(result).not.toBeNull();
    expect(result!.spec.ingress).toHaveLength(1);
    expect((result!.spec.ingress![0] as Record<string, unknown>).fromCIDR).toEqual(["10.0.0.0/24"]);
    // original untouched
    expect(policy.spec!.ingress).toHaveLength(2);
    // egress still present -> not empty
    expect(result!.empty).toBe(false);
  });

  test("flags empty when the last rule across both directions is removed", () => {
    const single: CnpObject = { metadata: { name: "z" }, spec: { egress: [{ toCIDR: ["1.1.1.1/32"] }] } };
    const result = removeRuleFromSpec(single, "egress", 0);
    expect(result!.spec.egress).toEqual([]);
    expect(result!.empty).toBe(true);
  });

  test("returns null for out-of-range index", () => {
    expect(removeRuleFromSpec(policy, "ingress", 9)).toBeNull();
    expect(removeRuleFromSpec(policy, "egress", -1)).toBeNull();
  });
});
