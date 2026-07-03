import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { makeCustomApi } from "@/lib/kube-client";
import {
  summarizeBlockedFlows,
  summarizeBlockedIngress,
  blockedFlowsQuery,
  blockedIngressQuery,
  buildAllowRule,
  buildIngressAllowRule,
  isAllowable,
  isIngressAllowable,
  isBidirectionalCandidate,
  appLabelFromPod,
  type PromQueryResult,
  type BlockedDestination,
  type FlowDirection,
} from "@/lib/firewall/drops";
import { MANAGED_BY, policySelectsPod, workloadSelectorFromPodLabels, type CnpObject } from "@/lib/firewall/rules";
import { makeCoreApi } from "@/lib/kube-client";

const PROMETHEUS_URL =
  process.env.PROMETHEUS_URL ?? "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090";

const CNP_GROUP = "cilium.io";
const CNP_VERSION = "v2";
const CNP_PLURAL = "ciliumnetworkpolicies";

interface PodDenies {
  namespace: string;
  pod: string;
  egress: BlockedDestination[]; // peer = what the pod tried to reach
  ingress: BlockedDestination[]; // peer = who tried to reach the pod
  totalDropRate: number;
}

async function promQuery(query: string): Promise<{ ok: boolean; json?: PromQueryResult }> {
  try {
    const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false };
    return { ok: true, json: (await res.json()) as PromQueryResult };
  } catch {
    return { ok: false };
  }
}

// GET: recently blocked flows per pod, split into ingress + egress. Empty (not an
// error) when Cilium/Hubble isn't live yet — the metric simply doesn't exist.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const raw = Number(req.nextUrl.searchParams.get("window") ?? "10");
  const windowMinutes = Number.isFinite(raw) ? raw : 10;

  const [eg, ing, presence] = await Promise.all([
    promQuery(blockedFlowsQuery(windowMinutes)),
    promQuery(blockedIngressQuery(windowMinutes)),
    // Presence probe: the dataplane is live as soon as the metric exists, even
    // when nothing was dropped inside the window — zero denies must render as
    // "sealed", not "dataplane not reporting".
    promQuery("count(hubble_drop_total)"),
  ]);

  if (!eg.ok && !ing.ok) {
    // Prometheus unreachable (or Cilium not installed): degrade to empty, never throw.
    return NextResponse.json({ available: false, reason: "dataplane_not_ready", pods: [] }, { status: 200 });
  }

  const egress = summarizeBlockedFlows(eg.json);
  const ingress = summarizeBlockedIngress(ing.json);
  const byPod = new Map<string, PodDenies>();
  const ensure = (namespace: string, pod: string): PodDenies => {
    const key = `${namespace}/${pod}`;
    let p = byPod.get(key);
    if (!p) {
      p = { namespace, pod, egress: [], ingress: [], totalDropRate: 0 };
      byPod.set(key, p);
    }
    return p;
  };
  for (const s of egress) {
    const p = ensure(s.namespace, s.pod);
    p.egress = s.destinations;
    p.totalDropRate += s.totalDropRate;
  }
  for (const s of ingress) {
    const p = ensure(s.namespace, s.pod);
    p.ingress = s.destinations;
    p.totalDropRate += s.totalDropRate;
  }
  const pods = [...byPod.values()].sort((a, b) => b.totalDropRate - a.totalDropRate);
  const metricPresent = (presence.json?.data?.result?.length ?? 0) > 0;
  const dataplaneLive = metricPresent || egress.length > 0 || ingress.length > 0;

  return NextResponse.json({
    available: true,
    dataplaneLive,
    windowMinutes,
    pods,
    note: dataplaneLive ? undefined : "Cilium/Hubble not detected yet — no blocked-flow metrics.",
  });
}

interface AllowBody {
  namespace: string;
  pod: string;
  appLabel?: string; // label value selecting the subject pods (defaults to pod's app)
  direction?: FlowDirection; // "egress" (default) or "ingress"
  destination?: BlockedDestination; // egress peer (back-compat name)
  peer?: BlockedDestination; // generic peer (preferred)
  bidirectional?: boolean; // also allow the mirror side when the peer is an in-cluster pod
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

interface ApplyResult {
  policy: string;
  namespace: string;
  direction: FlowDirection;
  skipped?: boolean;
}

// Read-modify-write a `<app>-<direction>-allowlist` CiliumNetworkPolicy, appending
// the rule. Idempotent: an identical rule already present is left untouched.
// `subjectPodLabels` (when available) drives the endpointSelector — the old
// `{app: <name>}` guess selects nothing on pods without an `app` label (all
// WordPress sites), leaving the policy inert while the UI reports "allowed".
async function applyAllow(
  custom: ReturnType<typeof makeCustomApi>,
  namespace: string,
  appLabel: string,
  direction: FlowDirection,
  peer: BlockedDestination,
  subjectPodLabels?: Record<string, string>,
): Promise<ApplyResult> {
  const rule = direction === "egress" ? buildAllowRule(peer) : buildIngressAllowRule(peer);
  if (Object.keys(rule).length === 0) {
    throw new Error(`Peer cannot be expressed as an ${direction} allow rule`);
  }
  const policyName = `${appLabel}-${direction}-allowlist`;
  const selector = workloadSelectorFromPodLabels(subjectPodLabels) ?? { app: appLabel };

  let existing: (CnpObject & { spec?: Record<string, unknown> }) | undefined;
  try {
    existing = (await custom.getNamespacedCustomObject({
      group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL, name: policyName,
    })) as CnpObject & { spec?: Record<string, unknown> };
  } catch {
    existing = undefined;
  }

  if (existing) {
    const current = (existing.spec?.[direction] as unknown[] | undefined) ?? [];
    const ruleKey = stableStringify(rule);
    // Heal a policy whose selector no longer (or never) selected the subject pod
    // — e.g. one created with the old app-label guess.
    const needsSelectorFix = !!subjectPodLabels && !policySelectsPod(existing, subjectPodLabels);
    const hasRule = current.some((r) => stableStringify(r) === ruleKey);
    if (!needsSelectorFix && hasRule) {
      return { policy: policyName, namespace, direction, skipped: true };
    }
    if (needsSelectorFix) {
      // Full replace (PUT), not a merge patch: merge-patching matchLabels keeps
      // the stale keys (e.g. the old `app:` guess) and the selector still
      // matches nothing.
      const replaced = {
        ...existing,
        spec: {
          ...(existing.spec ?? {}),
          endpointSelector: { matchLabels: selector },
          [direction]: hasRule ? current : [...current, rule],
        },
      };
      await custom.replaceNamespacedCustomObject({
        group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL, name: policyName,
        body: replaced,
      });
    } else {
      await custom.patchNamespacedCustomObject({
        group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL, name: policyName,
        body: { spec: { [direction]: [...current, rule] } },
      });
    }
  } else {
    await custom.createNamespacedCustomObject({
      group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL,
      body: {
        apiVersion: "cilium.io/v2",
        kind: "CiliumNetworkPolicy",
        metadata: { name: policyName, namespace, labels: { "app.kubernetes.io/managed-by": MANAGED_BY } },
        spec: { endpointSelector: { matchLabels: selector }, [direction]: [rule] },
      },
    });
  }
  return { policy: policyName, namespace, direction };
}

// POST: "Allow" a denied flow. Appends the matching allow rule to the subject
// app's policy. When the peer is an in-cluster pod and `bidirectional` is set,
// also adds the mirror rule on the peer's policy so both sides are covered in one
// click. 503 (honest) until the Cilium CRD exists.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: AllowBody;
  try {
    body = (await req.json()) as AllowBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const peerInput = body?.peer ?? body?.destination;
  if (!body?.namespace || !body?.pod || !peerInput) {
    return NextResponse.json({ error: "namespace, pod and peer are required" }, { status: 400 });
  }
  const direction: FlowDirection = body.direction === "ingress" ? "ingress" : "egress";
  const allowable = direction === "egress" ? isAllowable(peerInput) : isIngressAllowable(peerInput);
  if (!allowable) {
    return NextResponse.json(
      { error: `This peer cannot be auto-allowed on ${direction} (unsupported target)` },
      { status: 422 },
    );
  }

  // Normalise an in-cluster pod peer to its app label so the selector matches the
  // workload, not one ephemeral pod instance.
  const peer: BlockedDestination =
    peerInput.kind === "pod" ? { ...peerInput, target: appLabelFromPod(peerInput.target) } : peerInput;
  const subjectApp = body.appLabel || appLabelFromPod(body.pod);

  // The subject pod's real labels drive the policy's endpointSelector; the
  // app-label guess is only a fallback when the pod can't be read.
  let subjectPodLabels: Record<string, string> | undefined;
  try {
    const podObj = await makeCoreApi().readNamespacedPod({ name: body.pod, namespace: body.namespace });
    subjectPodLabels = podObj.metadata?.labels ?? undefined;
  } catch {
    subjectPodLabels = undefined;
  }

  const custom = makeCustomApi();
  const applied: ApplyResult[] = [];

  try {
    applied.push(await applyAllow(custom, body.namespace, subjectApp, direction, peer, subjectPodLabels));

    if (body.bidirectional && isBidirectionalCandidate(peer)) {
      const mirrorDir: FlowDirection = direction === "egress" ? "ingress" : "egress";
      const subjectAsPeer: BlockedDestination = {
        kind: "pod",
        target: subjectApp,
        namespace: body.namespace,
        port: peer.port,
        protocol: peer.protocol,
        dropRate: 0,
      };
      applied.push(await applyAllow(custom, peer.namespace || "default", peer.target, mirrorDir, subjectAsPeer));
    }

    return NextResponse.json({ ok: true, applied, bothSides: applied.length > 1 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/the server could not find the requested resource|not found|404|no matches for kind/i.test(msg)) {
      return NextResponse.json(
        { error: "Cilium dataplane is not live yet — cannot apply allow rules until migration completes." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: `Failed to apply allow rule: ${msg}` }, { status: 500 });
  }
}
