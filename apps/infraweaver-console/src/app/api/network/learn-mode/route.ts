import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { makeCoreApi, makeCustomApi } from "@/lib/kube-client";
import { appLabelFromPod, type PromQueryResult } from "@/lib/firewall/drops";
import { MANAGED_BY, workloadSelectorFromPodLabels } from "@/lib/firewall/rules";
import {
  buildLearnPolicy,
  buildLearnedAllowRules,
  learnPolicyName,
  learnedQueriesQuery,
  parseLearnedQueries,
} from "@/lib/firewall/learn";

const PROMETHEUS_URL =
  process.env.PROMETHEUS_URL ?? "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090";

const CNP_GROUP = "cilium.io";
const CNP_VERSION = "v2";
const CNP_PLURAL = "ciliumnetworkpolicies";
// Learned queries are read over the whole learn session, capped so a
// forgotten toggle doesn't scan unbounded history.
const MAX_LEARN_WINDOW_MINUTES = 24 * 60;

async function promQuery(query: string): Promise<PromQueryResult | undefined> {
  try {
    const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return undefined;
    return (await res.json()) as PromQueryResult;
  } catch {
    return undefined;
  }
}

interface LearnPolicyObject {
  metadata?: { creationTimestamp?: string };
}

async function getLearnPolicy(namespace: string, name: string): Promise<LearnPolicyObject | undefined> {
  try {
    return (await makeCustomApi().getNamespacedCustomObject({
      group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL, name,
    })) as LearnPolicyObject;
  } catch {
    return undefined;
  }
}

function learnWindowMinutes(policy: LearnPolicyObject): number {
  const created = Date.parse(policy.metadata?.creationTimestamp ?? "");
  if (!Number.isFinite(created)) return 60;
  const minutes = Math.ceil((Date.now() - created) / 60_000) + 1;
  return Math.min(Math.max(minutes, 1), MAX_LEARN_WINDOW_MINUTES);
}

// GET ?namespace=&pods=a,b — learn-mode status + the learned FQDN list.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const namespace = req.nextUrl.searchParams.get("namespace");
  const pods = (req.nextUrl.searchParams.get("pods") ?? "").split(",").filter(Boolean);
  if (!namespace || pods.length === 0) {
    return NextResponse.json({ error: "namespace and pods are required" }, { status: 400 });
  }

  const appLabel = appLabelFromPod(pods[0]);
  const policy = await getLearnPolicy(namespace, learnPolicyName(appLabel));
  if (!policy) return NextResponse.json({ active: false, learned: [] });

  const result = await promQuery(learnedQueriesQuery(namespace, learnWindowMinutes(policy)));
  return NextResponse.json({
    active: true,
    since: policy.metadata?.creationTimestamp ?? null,
    learned: parseLearnedQueries(result, pods),
  });
}

interface LearnBody {
  namespace: string;
  pods: string[];
  action: "enable" | "disable" | "commit";
}

// POST — enable/disable learn mode, or commit ("Allow learned"): write every
// learned FQDN into <app>-egress-allowlist, then drop the temp-allow policy.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: LearnBody;
  try {
    body = (await req.json()) as LearnBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { namespace, pods, action } = body ?? {};
  if (!namespace || !pods?.length || !["enable", "disable", "commit"].includes(action)) {
    return NextResponse.json({ error: "namespace, pods and a valid action are required" }, { status: 400 });
  }

  const appLabel = appLabelFromPod(pods[0]);
  const policyName = learnPolicyName(appLabel);
  const custom = makeCustomApi();

  try {
    if (action === "enable") {
      let podLabels: Record<string, string> | undefined;
      try {
        const podObj = await makeCoreApi().readNamespacedPod({ name: pods[0], namespace });
        podLabels = podObj.metadata?.labels ?? undefined;
      } catch {
        podLabels = undefined;
      }
      const selector = workloadSelectorFromPodLabels(podLabels) ?? { app: appLabel };
      if (await getLearnPolicy(namespace, policyName)) {
        return NextResponse.json({ ok: true, active: true, skipped: true });
      }
      await custom.createNamespacedCustomObject({
        group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL,
        body: buildLearnPolicy(policyName, namespace, selector, MANAGED_BY),
      });
      return NextResponse.json({ ok: true, active: true });
    }

    let committed = 0;
    if (action === "commit") {
      const policy = await getLearnPolicy(namespace, policyName);
      if (!policy) return NextResponse.json({ error: "Learn mode is not active" }, { status: 409 });
      const result = await promQuery(learnedQueriesQuery(namespace, learnWindowMinutes(policy)));
      const learned = parseLearnedQueries(result, pods);
      const rules = buildLearnedAllowRules(learned);
      if (rules.length > 0) {
        const allowlistName = `${appLabel}-egress-allowlist`;
        const existing = (await getLearnPolicy(namespace, allowlistName)) as
          | { spec?: Record<string, unknown> }
          | undefined;
        if (existing) {
          const current = (existing.spec?.egress as unknown[] | undefined) ?? [];
          const have = new Set(current.map((r) => JSON.stringify(r)));
          const merged = [...current, ...rules.filter((r) => !have.has(JSON.stringify(r)))];
          await custom.patchNamespacedCustomObject({
            group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL, name: allowlistName,
            body: [{ op: "add", path: "/spec/egress", value: merged }],
          });
          committed = merged.length - current.length;
        } else {
          let podLabels: Record<string, string> | undefined;
          try {
            const podObj = await makeCoreApi().readNamespacedPod({ name: pods[0], namespace });
            podLabels = podObj.metadata?.labels ?? undefined;
          } catch {
            podLabels = undefined;
          }
          await custom.createNamespacedCustomObject({
            group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL,
            body: {
              apiVersion: "cilium.io/v2",
              kind: "CiliumNetworkPolicy",
              metadata: { name: allowlistName, namespace, labels: { "app.kubernetes.io/managed-by": MANAGED_BY } },
              spec: {
                endpointSelector: { matchLabels: workloadSelectorFromPodLabels(podLabels) ?? { app: appLabel } },
                egress: rules,
              },
            },
          });
          committed = rules.length;
        }
      }
    }

    // disable + commit both end with the temp-allow policy removed.
    try {
      await custom.deleteNamespacedCustomObject({
        group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL, name: policyName,
      });
    } catch {
      // already gone — fine for disable; commit checked existence above.
    }
    return NextResponse.json({ ok: true, active: false, committed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Learn mode ${action} failed: ${msg}` }, { status: 500 });
  }
}
