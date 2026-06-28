import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { makeCustomApi } from "@/lib/kube-client";
import {
  summarizeBlockedFlows,
  blockedFlowsQuery,
  buildAllowRule,
  isAllowable,
  type PromQueryResult,
  type BlockedDestination,
} from "@/lib/firewall/drops";

const PROMETHEUS_URL =
  process.env.PROMETHEUS_URL ?? "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090";

const CNP_GROUP = "cilium.io";
const CNP_VERSION = "v2";
const CNP_PLURAL = "ciliumnetworkpolicies";

// GET: recently blocked egress flows, grouped per pod. Empty (not an error) when
// Cilium/Hubble isn't live yet — the metric simply doesn't exist.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const windowMinutes = Number(req.nextUrl.searchParams.get("window") ?? "10");
  const query = blockedFlowsQuery(Number.isFinite(windowMinutes) ? windowMinutes : 10);

  try {
    const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { available: false, reason: "metrics_unavailable", pods: [] },
        { status: 200 },
      );
    }
    const json = (await res.json()) as PromQueryResult;
    const hasMetric = (json?.data?.result?.length ?? 0) > 0 || json?.status === "success";
    return NextResponse.json({
      available: true,
      // dataplaneLive is true only once the hubble_drop_total series exists.
      dataplaneLive: (json?.data?.result?.length ?? 0) > 0,
      windowMinutes,
      pods: summarizeBlockedFlows(json),
      note: hasMetric ? undefined : "Cilium/Hubble not detected yet — no blocked-flow metrics.",
    });
  } catch {
    // Prometheus unreachable (or Cilium not installed): degrade to empty, never throw.
    return NextResponse.json(
      { available: false, reason: "dataplane_not_ready", pods: [] },
      { status: 200 },
    );
  }
}

interface AllowBody {
  namespace: string;
  pod: string;
  appLabel?: string; // label value selecting the source pods (defaults to pod's app)
  destination: BlockedDestination;
}

// POST: "Allow next time" — append an egress allow rule to the source app's
// CiliumNetworkPolicy. 503 (honest) until the Cilium CRD exists.
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
  if (!body?.namespace || !body?.pod || !body?.destination) {
    return NextResponse.json({ error: "namespace, pod and destination are required" }, { status: 400 });
  }
  if (!isAllowable(body.destination)) {
    return NextResponse.json({ error: "This destination cannot be auto-allowed (unknown target)" }, { status: 422 });
  }

  const appLabel = body.appLabel || body.pod.replace(/-[a-z0-9]+(-[a-z0-9]+)?$/, "");
  const policyName = `${appLabel}-egress-allowlist`;
  const newRule = buildAllowRule(body.destination);
  const custom = makeCustomApi();

  try {
    // Read-modify-write: append to an existing allowlist policy, or create one.
    let existing: { spec?: { egress?: unknown[] } } | undefined;
    try {
      existing = (await custom.getNamespacedCustomObject({
        group: CNP_GROUP, version: CNP_VERSION, namespace: body.namespace, plural: CNP_PLURAL, name: policyName,
      })) as { spec?: { egress?: unknown[] } };
    } catch {
      existing = undefined;
    }

    if (existing) {
      const egress = [...(existing.spec?.egress ?? []), newRule];
      await custom.patchNamespacedCustomObject({
        group: CNP_GROUP, version: CNP_VERSION, namespace: body.namespace, plural: CNP_PLURAL, name: policyName,
        body: { spec: { egress } },
      });
    } else {
      await custom.createNamespacedCustomObject({
        group: CNP_GROUP, version: CNP_VERSION, namespace: body.namespace, plural: CNP_PLURAL,
        body: {
          apiVersion: "cilium.io/v2",
          kind: "CiliumNetworkPolicy",
          metadata: { name: policyName, namespace: body.namespace, labels: { "app.kubernetes.io/managed-by": "infraweaver-console" } },
          spec: { endpointSelector: { matchLabels: { app: appLabel } }, egress: [newRule] },
        },
      });
    }
    return NextResponse.json({ ok: true, policy: policyName, namespace: body.namespace, rule: newRule });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // CRD absent => Cilium not installed yet.
    if (/the server could not find the requested resource|not found|404|no matches for kind/i.test(msg)) {
      return NextResponse.json(
        { error: "Cilium dataplane is not live yet — cannot apply allow rules until migration completes." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: `Failed to apply allow rule: ${msg}` }, { status: 500 });
  }
}
