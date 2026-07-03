import {
  type BlockedDestination,
  type PodDenies,
  flowId,
  isFlowAllowable,
  notAllowableReason,
  podDeniesForPods,
  podFlowCount,
  podKey,
} from "@/app/(dashboard)/network/firewall/types";

const dest = (over: Partial<BlockedDestination>): BlockedDestination => ({
  kind: "ip",
  target: "10.0.0.1/32",
  dropRate: 1,
  ...over,
});

describe("firewall UI helpers", () => {
  describe("isFlowAllowable", () => {
    it("allows fqdn/ip/pod on egress", () => {
      expect(isFlowAllowable("egress", dest({ kind: "fqdn", target: "registry-1.docker.io" }))).toBe(true);
      expect(isFlowAllowable("egress", dest({ kind: "ip" }))).toBe(true);
      expect(isFlowAllowable("egress", dest({ kind: "pod", target: "mariadb" }))).toBe(true);
    });

    it("rejects unknown peers in both directions", () => {
      expect(isFlowAllowable("egress", dest({ kind: "unknown", target: "unknown" }))).toBe(false);
      expect(isFlowAllowable("ingress", dest({ kind: "unknown", target: "unknown" }))).toBe(false);
    });

    it("rejects fqdn sources on ingress (no fromFQDNs in Cilium)", () => {
      expect(isFlowAllowable("ingress", dest({ kind: "fqdn", target: "example.com" }))).toBe(false);
    });

    it("allows ip/pod sources on ingress", () => {
      expect(isFlowAllowable("ingress", dest({ kind: "ip" }))).toBe(true);
      expect(isFlowAllowable("ingress", dest({ kind: "pod", target: "wordpress" }))).toBe(true);
    });
  });

  it("notAllowableReason explains the fqdn-on-ingress case specifically", () => {
    expect(notAllowableReason("ingress", dest({ kind: "fqdn", target: "x" }))).toMatch(/way in/i);
    expect(notAllowableReason("egress", dest({ kind: "unknown", target: "x" }))).toMatch(/resolved/i);
  });

  it("flowId is stable and distinguishes direction, target and port", () => {
    const pod = { namespace: "wordpress", pod: "wp-abc" };
    const peer = dest({ target: "1.1.1.1/32", port: "443" });
    expect(flowId(pod, "egress", peer)).toBe("wordpress/wp-abc|egress|1.1.1.1/32|443");
    expect(flowId(pod, "egress", peer)).not.toBe(flowId(pod, "ingress", peer));
    expect(flowId(pod, "egress", peer)).not.toBe(flowId(pod, "egress", dest({ target: "1.1.1.1/32", port: "80" })));
  });

  it("podKey and podFlowCount summarise a pod", () => {
    const pod: PodDenies = {
      namespace: "wordpress",
      pod: "wp-abc",
      ingress: [dest({ kind: "pod", target: "traefik" })],
      egress: [dest({ kind: "fqdn", target: "a" }), dest({ kind: "fqdn", target: "b" })],
      totalDropRate: 3,
    };
    expect(podKey(pod)).toBe("wordpress/wp-abc");
    expect(podFlowCount(pod)).toBe(3);
  });

  it("podDeniesForPods returns the app slice, synthesizing sealed pods", () => {
    const fleet: PodDenies[] = [
      { namespace: "wordpress", pod: "blog-1", ingress: [], egress: [dest({ target: "evil.example" })], totalDropRate: 1 },
      { namespace: "other", pod: "blog-1", ingress: [dest({ target: "10.0.0.1" })], egress: [], totalDropRate: 2 },
    ];

    const slice = podDeniesForPods(fleet, "wordpress", ["blog-1", "blog-db-1"]);

    // The namespace must match — the identically-named pod in "other" is ignored.
    expect(slice[0]).toBe(fleet[0]);
    // Pods with no reported denials still appear, sealed, in input order.
    expect(slice[1]).toEqual({ namespace: "wordpress", pod: "blog-db-1", ingress: [], egress: [], totalDropRate: 0 });
    expect(slice.map((p) => p.pod)).toEqual(["blog-1", "blog-db-1"]);
  });
});
