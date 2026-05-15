import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { makeKc } from "@/lib/kube-client";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import * as k8s from "@kubernetes/client-node";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["cluster:read", "config:read", "infra:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const policyApi = makeKc().makeApiClient(k8s.PolicyV1Api);
    const response = await policyApi.listPodDisruptionBudgetForAllNamespaces();
    const items = ((response as { items?: unknown[] }).items ?? []).map((entry: unknown) => {
      const pdb = entry as {
        metadata?: { name?: string; namespace?: string };
        spec?: {
          minAvailable?: string | number;
          maxUnavailable?: string | number;
          selector?: { matchLabels?: Record<string, string> };
        };
        status?: {
          currentHealthy?: number;
          desiredHealthy?: number;
          expectedPods?: number;
          disruptionsAllowed?: number;
        };
      };

      return {
        name: pdb.metadata?.name ?? "unknown",
        namespace: pdb.metadata?.namespace ?? "default",
        minAvailable: pdb.spec?.minAvailable ?? null,
        maxUnavailable: pdb.spec?.maxUnavailable ?? null,
        currentHealthy: pdb.status?.currentHealthy ?? 0,
        desiredHealthy: pdb.status?.desiredHealthy ?? 0,
        expectedPods: pdb.status?.expectedPods ?? 0,
        disruptionsAllowed: pdb.status?.disruptionsAllowed ?? 0,
        selector: pdb.spec?.selector?.matchLabels ?? {},
      };
    }).sort((left, right) => {
      if (left.disruptionsAllowed !== right.disruptionsAllowed) {
        return left.disruptionsAllowed - right.disruptionsAllowed;
      }
      return `${left.namespace}/${left.name}`.localeCompare(`${right.namespace}/${right.name}`);
    });

    return NextResponse.json({ pdbs: items, live: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      pdbs: [
        {
          name: "authentik-server-pdb",
          namespace: "authentik",
          minAvailable: 1,
          maxUnavailable: null,
          currentHealthy: 1,
          desiredHealthy: 1,
          expectedPods: 1,
          disruptionsAllowed: 0,
          selector: { "app.kubernetes.io/name": "authentik", "app.kubernetes.io/component": "server" },
        },
        {
          name: "infraweaver-console",
          namespace: "infraweaver-console",
          minAvailable: 1,
          maxUnavailable: null,
          currentHealthy: 2,
          desiredHealthy: 1,
          expectedPods: 2,
          disruptionsAllowed: 1,
          selector: { app: "infraweaver-console" },
        },
      ],
      live: false,
      error: safeError(error),
    }, { headers: { "Cache-Control": "no-store" } });
  }
}
