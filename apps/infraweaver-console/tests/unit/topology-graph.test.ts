import { describe, expect, it } from "@jest/globals";
import { buildDependencyGraph, type GraphInputs } from "@/lib/topology/graph-model";
import {
  computeBlastRadius,
  computeDependencies,
  findOrphans,
  findSinglePointsOfFailure,
} from "@/lib/topology/blast-radius";
import type { CnpObject } from "@/lib/firewall/rules";

function cnp(namespace: string, app: string, spec: NonNullable<CnpObject["spec"]>): CnpObject {
  return { metadata: { namespace, name: `${app}-policy` }, spec: { endpointSelector: { matchLabels: { app } }, ...spec } };
}

// web → api → postgres, all in ns "prod". Built from egress allow-rules.
const inputs: GraphInputs = {
  policies: [
    cnp("prod", "web", { egress: [{ toEndpoints: [{ matchLabels: { app: "api" } }] }] }),
    cnp("prod", "api", { egress: [{ toEndpoints: [{ matchLabels: { app: "postgres" } }] }] }),
  ],
  services: [{ namespace: "prod", name: "postgres", selectorApp: "postgres" }],
  routes: [{ host: "app.example.com", targetNamespace: "prod", targetService: "web" }],
};

describe("buildDependencyGraph", () => {
  it("derives edges from CNP egress (from depends on to)", () => {
    const graph = buildDependencyGraph(inputs);
    expect(graph.edges).toContainEqual({ from: "prod/web", to: "prod/api", source: "netpol-egress" });
    expect(graph.edges).toContainEqual({ from: "prod/api", to: "prod/postgres", source: "netpol-egress" });
  });

  it("adds service→app and external→service edges", () => {
    const graph = buildDependencyGraph(inputs);
    expect(graph.edges).toContainEqual({ from: "svc:prod/postgres", to: "prod/postgres", source: "service-selector" });
    expect(graph.edges).toContainEqual({ from: "external:app.example.com", to: "svc:prod/web", source: "ingress-backend" });
  });

  it("dedups repeated edges", () => {
    const dup = buildDependencyGraph({ ...inputs, policies: [...inputs.policies, ...inputs.policies] });
    const webApi = dup.edges.filter((e) => e.from === "prod/web" && e.to === "prod/api");
    expect(webApi).toHaveLength(1);
  });
});

describe("blast radius / dependencies", () => {
  const graph = buildDependencyGraph(inputs);

  it("computes who breaks when postgres dies (transitive dependents)", () => {
    const blast = computeBlastRadius(graph, "prod/postgres");
    const all = [...blast.direct, ...blast.transitive];
    expect(all).toEqual(expect.arrayContaining(["prod/api", "prod/web", "svc:prod/postgres"]));
  });

  it("computes what web needs (forward reachability)", () => {
    const deps = computeDependencies(graph, "prod/web");
    const all = [...deps.direct, ...deps.transitive];
    expect(all).toEqual(expect.arrayContaining(["prod/api", "prod/postgres"]));
  });

  it("is cycle-safe", () => {
    const cyclic = buildDependencyGraph({
      policies: [
        cnp("x", "a", { egress: [{ toEndpoints: [{ matchLabels: { app: "b" } }] }] }),
        cnp("x", "b", { egress: [{ toEndpoints: [{ matchLabels: { app: "a" } }] }] }),
      ],
      services: [],
      routes: [],
    });
    expect(() => computeBlastRadius(cyclic, "x/a")).not.toThrow();
    const blast = computeBlastRadius(cyclic, "x/a");
    expect([...blast.direct, ...blast.transitive]).toContain("x/b");
  });
});

describe("findSinglePointsOfFailure", () => {
  it("flags a high-fan-in dependency", () => {
    const spof = findSinglePointsOfFailure(buildDependencyGraph(inputs), 2);
    const postgres = spof.find((s) => s.nodeId === "prod/postgres");
    expect(postgres).toBeDefined();
    expect(postgres!.dependentCount).toBeGreaterThanOrEqual(2);
  });
});

describe("findOrphans", () => {
  it("flags a service with no consumers", () => {
    const graph = buildDependencyGraph({
      policies: [],
      services: [{ namespace: "z", name: "lonely", selectorApp: "lonely" }],
      routes: [],
    });
    const orphans = findOrphans(graph);
    expect(orphans).toContainEqual({ nodeId: "svc:z/lonely", reason: "no-consumers" });
  });
});
