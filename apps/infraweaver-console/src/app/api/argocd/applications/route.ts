import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

interface ArgoApplication {
  metadata?: { name?: string; namespace?: string };
  spec?: { destination?: { namespace?: string } };
  status?: {
    health?: { status?: string };
    operationState?: {
      finishedAt?: string;
      phase?: string;
      startedAt?: string;
      syncResult?: { revision?: string };
    };
    reconciledAt?: string;
    summary?: { images?: string[] };
    sync?: { revision?: string; status?: string };
  };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // Fetch applications from Kubernetes API using the built-in cluster
    const kubeConfig = process.env.KUBECONFIG || "/.kube/config";
    const { KubeConfig } = await import("@kubernetes/client-node");
    const kc = new KubeConfig();
    kc.loadFromFile(kubeConfig);
    kc.loadFromDefault();

    const { CustomObjectsApi } = await import("@kubernetes/client-node");
    const customApi = kc.makeApiClient(CustomObjectsApi);

    const response = await customApi.listNamespacedCustomObject({
      group: "argoproj.io",
      version: "v1alpha1",
      namespace: "argocd",
      plural: "applications",
    }) as { items?: ArgoApplication[] };

    const items = Array.isArray(response.items) ? response.items : [];
    return NextResponse.json({ items });
  } catch (error) {
    console.error("Failed to fetch applications from Kubernetes API:", error);
    return NextResponse.json(
      { error: "Failed to fetch applications", details: String(error) },
      { status: 500 }
    );
  }
}
