import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { makeCoreApi, makeCustomApi } from "@/lib/kube-client";
import { appLabelFromPod, type FlowDirection } from "@/lib/firewall/drops";
import { flattenPolicyRules, policySelectsApp, policySelectsPod, removeRuleFromSpec, type CnpObject } from "@/lib/firewall/rules";

const CNP_GROUP = "cilium.io";
const CNP_VERSION = "v2";
const CNP_PLURAL = "ciliumnetworkpolicies";

function crdAbsent(msg: string): boolean {
  return /the server could not find the requested resource|no matches for kind/i.test(msg);
}

// GET: the rules currently allowed for a pod, split into ingress + egress. Pass
// ?namespace=&app= (or &pod= to derive the app label). Degrades to empty when the
// Cilium CRD isn't present yet.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const namespace = req.nextUrl.searchParams.get("namespace")?.trim();
  const pod = req.nextUrl.searchParams.get("pod")?.trim();
  const appParam = req.nextUrl.searchParams.get("app")?.trim();
  const app = appParam || (pod ? appLabelFromPod(pod) : undefined);
  if (!namespace || !app) {
    return NextResponse.json({ error: "namespace and app (or pod) are required" }, { status: 400 });
  }

  // Prefer the pod's real labels for selector matching (policySelectsPod) — the
  // app-string guess (policySelectsApp) only catches CNPs keyed on `app`/`k8s:app`
  // and misses component-based selectors like wordpress-zero-trust. Falls back to
  // the string guess when there's no `pod` param or the pod lookup fails.
  let podLabels: Record<string, string> | undefined;
  if (pod) {
    try {
      const podObj = await makeCoreApi().readNamespacedPod({ name: pod, namespace });
      podLabels = podObj.metadata?.labels ?? undefined;
    } catch {
      podLabels = undefined;
    }
  }

  const custom = makeCustomApi();
  try {
    const list = (await custom.listNamespacedCustomObject({
      group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL,
    })) as { items?: CnpObject[] };
    const matching = (list.items ?? []).filter((p) =>
      podLabels ? policySelectsPod(p, podLabels) : policySelectsApp(p, app),
    );
    const rules = flattenPolicyRules(matching);
    return NextResponse.json({
      available: true,
      namespace,
      app,
      ingress: rules.filter((r) => r.direction === "ingress"),
      egress: rules.filter((r) => r.direction === "egress"),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (crdAbsent(msg)) {
      return NextResponse.json({ available: false, reason: "dataplane_not_ready", ingress: [], egress: [] });
    }
    return NextResponse.json({ error: `Failed to list rules: ${msg}` }, { status: 500 });
  }
}

interface DeleteBody {
  namespace: string;
  policyName: string;
  direction: FlowDirection;
  index: number;
}

// DELETE: remove a single allow rule from a policy. Removing the last rule deletes
// the now-empty policy rather than leaving a bare endpointSelector (which Cilium
// treats as a default-deny for that endpoint).
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { namespace, policyName } = body ?? {};
  const direction: FlowDirection = body?.direction === "ingress" ? "ingress" : "egress";
  if (!namespace || !policyName || !Number.isInteger(body?.index) || body.index < 0) {
    return NextResponse.json({ error: "namespace, policyName and a non-negative index are required" }, { status: 400 });
  }

  const custom = makeCustomApi();
  try {
    const policy = (await custom.getNamespacedCustomObject({
      group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL, name: policyName,
    })) as CnpObject;

    const result = removeRuleFromSpec(policy, direction, body.index);
    if (!result) {
      return NextResponse.json({ error: "Rule index out of range — it may have already been removed" }, { status: 404 });
    }

    if (result.empty) {
      await custom.deleteNamespacedCustomObject({
        group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL, name: policyName,
      });
      return NextResponse.json({ ok: true, policy: policyName, deletedPolicy: true });
    }

    await custom.patchNamespacedCustomObject({
      group: CNP_GROUP, version: CNP_VERSION, namespace, plural: CNP_PLURAL, name: policyName,
      body: { spec: { [direction]: result.spec[direction] } },
    });
    return NextResponse.json({ ok: true, policy: policyName, deletedPolicy: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|404/i.test(msg)) {
      return NextResponse.json({ error: "Policy not found — it may have already been removed" }, { status: 404 });
    }
    if (crdAbsent(msg)) {
      return NextResponse.json(
        { error: "Cilium dataplane is not live yet — no rules to remove." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: `Failed to remove rule: ${msg}` }, { status: 500 });
  }
}
