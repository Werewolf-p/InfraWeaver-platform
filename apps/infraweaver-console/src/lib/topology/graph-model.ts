/**
 * Dependency-graph model — PURE (unit-testable, no k8s imports).
 *
 * The "graph" tab currently shows a flat grid of ArgoCD app cards with ZERO
 * edges. This assembles a real who-depends-on-whom graph from declared sources:
 * CiliumNetworkPolicy allow-rules, Service selectors, and Ingress backends.
 *
 * EDGE SEMANTICS: an edge `from → to` means "from depends on to" — if `to`
 * goes down, `from` breaks. That single convention powers blast-radius (reverse
 * reachability) and dependency (forward reachability) traversal.
 */

import type { CnpObject } from "@/lib/firewall/rules";

export type NodeKind = "app" | "service" | "external" | "fqdn" | "entity";
export type EdgeSource = "netpol-egress" | "netpol-ingress" | "service-selector" | "ingress-backend";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  namespace?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  source: EdgeSource;
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ServiceInput {
  namespace: string;
  name: string;
  /** The `app` label the service selector targets, if any. */
  selectorApp: string | null;
}

export interface RouteInput {
  host: string;
  targetNamespace: string;
  targetService: string;
}

export interface GraphInputs {
  policies: CnpObject[];
  services: ServiceInput[];
  routes: RouteInput[];
}

const NS_LABEL_KEYS = ["k8s:io.kubernetes.pod.namespace", "io.kubernetes.pod.namespace"];
const APP_LABEL_KEYS = ["k8s:app", "app", "k8s:app.kubernetes.io/name", "app.kubernetes.io/name"];

function pick(labels: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) if (labels[key]) return labels[key];
  return undefined;
}

/** App id `namespace/app` from a selector's matchLabels, defaulting the namespace. */
function appIdFromLabels(labels: Record<string, string> | undefined, defaultNamespace: string): { id: string; app: string; namespace: string } | null {
  if (!labels) return null;
  const app = pick(labels, APP_LABEL_KEYS);
  if (!app) return null;
  const namespace = pick(labels, NS_LABEL_KEYS) ?? defaultNamespace;
  return { id: `${namespace}/${app}`, app, namespace };
}

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Assemble the dependency graph from declared network sources. Cycle-safe by construction (dedup). */
export function buildDependencyGraph(inputs: GraphInputs): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];

  const addNode = (node: GraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (from: string, to: string, source: EdgeSource) => {
    if (from === to) return;
    const key = `${from}|${to}|${source}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, source });
  };
  const appNode = (id: string, app: string, namespace: string) => addNode({ id, kind: "app", name: app, namespace });

  for (const policy of inputs.policies) {
    const namespace = policy.metadata?.namespace ?? "default";
    const subject = appIdFromLabels(policy.spec?.endpointSelector?.matchLabels, namespace);
    if (!subject) continue;
    appNode(subject.id, subject.app, subject.namespace);

    // egress: subject depends on each declared peer (subject → peer).
    for (const rule of asArray<Record<string, unknown>>(policy.spec?.egress)) {
      for (const peer of asArray<{ matchLabels?: Record<string, string> }>(rule.toEndpoints)) {
        const target = appIdFromLabels(peer.matchLabels, namespace);
        if (!target) continue;
        appNode(target.id, target.app, target.namespace);
        addEdge(subject.id, target.id, "netpol-egress");
      }
      for (const fqdn of asArray<{ matchName?: string; matchPattern?: string }>(rule.toFQDNs)) {
        const name = fqdn.matchName || fqdn.matchPattern;
        if (!name) continue;
        const id = `fqdn:${name}`;
        addNode({ id, kind: "fqdn", name });
        addEdge(subject.id, id, "netpol-egress");
      }
      for (const entity of asArray<string>(rule.toEntities)) {
        const id = `entity:${entity}`;
        addNode({ id, kind: "entity", name: entity });
        addEdge(subject.id, id, "netpol-egress");
      }
    }

    // ingress: each declared peer depends on subject (peer → subject).
    for (const rule of asArray<Record<string, unknown>>(policy.spec?.ingress)) {
      for (const peer of asArray<{ matchLabels?: Record<string, string> }>(rule.fromEndpoints)) {
        const consumer = appIdFromLabels(peer.matchLabels, namespace);
        if (!consumer) continue;
        appNode(consumer.id, consumer.app, consumer.namespace);
        addEdge(consumer.id, subject.id, "netpol-ingress");
      }
    }
  }

  // Service → backing app: the service depends on its backing workload.
  for (const service of inputs.services) {
    const svcId = `svc:${service.namespace}/${service.name}`;
    addNode({ id: svcId, kind: "service", name: service.name, namespace: service.namespace });
    if (service.selectorApp) {
      const appId = `${service.namespace}/${service.selectorApp}`;
      appNode(appId, service.selectorApp, service.namespace);
      addEdge(svcId, appId, "service-selector");
    }
  }

  // External route → service: the public host depends on the backing service.
  for (const route of inputs.routes) {
    const extId = `external:${route.host}`;
    addNode({ id: extId, kind: "external", name: route.host });
    const svcId = `svc:${route.targetNamespace}/${route.targetService}`;
    addNode({ id: svcId, kind: "service", name: route.targetService, namespace: route.targetNamespace });
    addEdge(extId, svcId, "ingress-backend");
  }

  return { nodes: [...nodes.values()], edges };
}
