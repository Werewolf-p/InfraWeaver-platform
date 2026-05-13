import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["cluster:read", "infra:read", "game-hub:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const apiExtApi = kc.makeApiClient(k8s.ApiextensionsV1Api);
    const storageApi = kc.makeApiClient(k8s.StorageV1Api);

    // Check namespace
    let nsExists = false;
    try {
      await coreApi.readNamespace({ name: "game-hub" });
      nsExists = true;
    } catch {}

    // Check CRD
    let crdExists = false;
    try {
      await apiExtApi.readCustomResourceDefinition({ name: "gameservers.infraweaver.rlservers.com" });
      crdExists = true;
    } catch {}

    // List available storage classes
    const storageClasses: Array<{ name: string; provisioner: string; isDefault: boolean }> = [];
    try {
      const scs = await storageApi.listStorageClass();
      for (const sc of scs.items ?? []) {
        const name = sc.metadata?.name ?? "";
        if (!name) continue;
        const isDefault = sc.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true";
        storageClasses.push({ name, provisioner: sc.provisioner ?? "", isDefault });
      }
    } catch {}

    const longhornAvailable = storageClasses.some(sc => sc.name === "longhorn");

    return NextResponse.json({
      nsExists,
      crdExists,
      longhornAvailable,
      storageClasses,
      ready: nsExists && crdExists,
    });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
}

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const results: Array<{ resource: string; status: string; error?: string }> = [];

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    // Create game-hub namespace if it doesn't exist
    try {
      await coreApi.readNamespace({ name: "game-hub" });
      results.push({ resource: "game-hub namespace", status: "already exists" });
    } catch {
      try {
        await coreApi.createNamespace({
          body: {
            metadata: {
              name: "game-hub",
              labels: { "app.kubernetes.io/managed-by": "infraweaver-console" },
            },
          },
        });
        results.push({ resource: "game-hub namespace", status: "created" });
      } catch (err) {
        results.push({ resource: "game-hub namespace", status: "error", error: safeError(err) });
      }
    }

    // CRD is deployed via ArgoCD — just verify it exists
    try {
      const apiExtApi = kc.makeApiClient(k8s.ApiextensionsV1Api);
      await apiExtApi.readCustomResourceDefinition({ name: "gameservers.infraweaver.rlservers.com" });
      results.push({ resource: "GameServer CRD", status: "already exists" });
    } catch {
      results.push({ resource: "GameServer CRD", status: "not found — deployed automatically via ArgoCD" });
    }
  } catch (err) {
    results.push({ resource: "setup", status: "error", error: safeError(err) });
  }

  return NextResponse.json({ results });
}
