import { NextResponse } from "next/server";
import { listItems, makeCoreApi, makeCustomApi } from "@/lib/kube-client";
import type { CnpObject } from "@/lib/firewall/rules";
import { loadExternalRoutes } from "@/lib/external-routes-server";
import { errorMessage } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";
import { buildDependencyGraph, type RouteInput, type ServiceInput } from "@/lib/topology/graph-model";
import { findOrphans, findSinglePointsOfFailure } from "@/lib/topology/blast-radius";

const CNP_GROUP = "cilium.io";
const CNP_VERSION = "v2";
const CNP_PLURAL = "ciliumnetworkpolicies";
const APP_SELECTOR_KEYS = ["app", "k8s:app", "app.kubernetes.io/name", "k8s:app.kubernetes.io/name"];

function crdAbsent(msg: string): boolean {
  return /the server could not find the requested resource|no matches for kind/i.test(msg);
}

function selectorApp(selector: Record<string, string> | undefined): string | null {
  if (!selector) return null;
  for (const key of APP_SELECTOR_KEYS) if (selector[key]) return selector[key];
  return null;
}

/**
 * Assemble the real dependency graph from CiliumNetworkPolicy allow-rules,
 * Service selectors, and Ingress backends — replacing the flat, edgeless
 * ArgoCD grid. Degrades to available:false when the Cilium CRD is absent.
 */
export const GET = withAuth({ permission: "cluster:read" }, async () => {
  const custom = makeCustomApi();
  let policies: CnpObject[];
  try {
    const list = await custom.listClusterCustomObject({ group: CNP_GROUP, version: CNP_VERSION, plural: CNP_PLURAL });
    policies = listItems<CnpObject>(list);
  } catch (err) {
    const msg = errorMessage(err);
    if (crdAbsent(msg)) {
      return NextResponse.json({ available: false, reason: "dataplane_not_ready", nodes: [], edges: [] });
    }
    return NextResponse.json({ available: false, reason: "error", nodes: [], edges: [] }, { status: 200 });
  }

  // Services (best-effort).
  let services: ServiceInput[] = [];
  try {
    const svcResp = await makeCoreApi().listServiceForAllNamespaces();
    services = (svcResp.items ?? []).map((svc) => ({
      namespace: svc.metadata?.namespace ?? "",
      name: svc.metadata?.name ?? "",
      selectorApp: selectorApp(svc.spec?.selector as Record<string, string> | undefined),
    })).filter((s) => s.namespace && s.name);
  } catch {
    services = [];
  }

  // External routes → ingress backends (best-effort — reads the GitOps repo).
  let routes: RouteInput[] = [];
  try {
    const external = await loadExternalRoutes();
    routes = external.routes.flatMap((route) =>
      (route.hosts.length ? route.hosts : [route.name]).map((host) => ({
        host,
        targetNamespace: route.targetNamespace,
        targetService: route.targetService,
      })),
    ).filter((r) => r.host && r.targetService && r.targetNamespace);
  } catch {
    routes = [];
  }

  const graph = buildDependencyGraph({ policies, services, routes });
  const spof = findSinglePointsOfFailure(graph);
  const orphans = findOrphans(graph);

  return NextResponse.json({ available: true, ...graph, spof, orphans });
});
