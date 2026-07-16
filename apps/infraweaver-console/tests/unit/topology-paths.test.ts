import { describe, expect, it } from "@jest/globals";
import { buildDependencyGraph, type GraphInputs } from "@/lib/topology/graph-model";
import { findAllPaths, findShortestPath, pathEdgeKeys } from "@/lib/topology/paths";
import type { CnpObject } from "@/lib/firewall/rules";

function cnp(app: string, egressApps: string[]): CnpObject {
  return {
    metadata: { namespace: "prod", name: `${app}-policy` },
    spec: { endpointSelector: { matchLabels: { app } }, egress: egressApps.map((a) => ({ toEndpoints: [{ matchLabels: { app: a } }] })) },
  };
}

// web → api → db, and web → api → cache → db (two paths to db).
const inputs: GraphInputs = {
  policies: [cnp("web", ["api"]), cnp("api", ["db", "cache"]), cnp("cache", ["db"])],
  services: [],
  routes: [],
};
const graph = buildDependencyGraph(inputs);

describe("findShortestPath", () => {
  it("returns the shortest dependency chain including both endpoints", () => {
    expect(findShortestPath(graph, "prod/web", "prod/db")).toEqual(["prod/web", "prod/api", "prod/db"]);
  });
  it("returns null when unreachable", () => {
    expect(findShortestPath(graph, "prod/db", "prod/web")).toBeNull();
  });
  it("returns the single node for from === to", () => {
    expect(findShortestPath(graph, "prod/web", "prod/web")).toEqual(["prod/web"]);
  });
});

describe("findAllPaths", () => {
  it("enumerates every acyclic path, shortest first", () => {
    const paths = findAllPaths(graph, "prod/web", "prod/db");
    expect(paths).toContainEqual(["prod/web", "prod/api", "prod/db"]);
    expect(paths).toContainEqual(["prod/web", "prod/api", "prod/cache", "prod/db"]);
    expect(paths[0].length).toBeLessThanOrEqual(paths[1].length);
  });
  it("is cycle-safe", () => {
    const cyclic = buildDependencyGraph({ policies: [cnp("a", ["b"]), cnp("b", ["a"])], services: [], routes: [] });
    expect(() => findAllPaths(cyclic, "prod/a", "prod/b")).not.toThrow();
  });
});

describe("pathEdgeKeys", () => {
  it("produces from|to keys for each hop", () => {
    expect(pathEdgeKeys(["a", "b", "c"])).toEqual(new Set(["a|b", "b|c"]));
  });
});
