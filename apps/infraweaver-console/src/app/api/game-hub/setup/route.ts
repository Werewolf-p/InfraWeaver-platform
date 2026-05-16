import * as k8s from "@kubernetes/client-node";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadKubeConfig } from "@/lib/k8s";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

const GAME_HUB_NAMESPACE = "game-hub";
const GAME_HUB_ROLE_NAME = "infraweaver-console-game-hub";

function buildGameHubRole(): k8s.V1Role {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: {
      name: GAME_HUB_ROLE_NAME,
      namespace: GAME_HUB_NAMESPACE,
      labels: {
        app: "infraweaver-console",
      },
    },
    rules: [
      {
        apiGroups: [""],
        resources: ["pods", "services", "persistentvolumeclaims", "configmaps", "events", "pods/log", "pods/exec"],
        verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
      },
      {
        apiGroups: [""],
        resources: ["secrets"],
        verbs: ["get", "list", "create", "update", "patch", "delete"],
      },
      {
        apiGroups: ["apps"],
        resources: ["deployments", "statefulsets", "replicasets"],
        verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
      },
      {
        apiGroups: ["autoscaling"],
        resources: ["horizontalpodautoscalers"],
        verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
      },
      {
        apiGroups: ["batch"],
        resources: ["cronjobs", "jobs"],
        verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
      },
    ],
  };
}

function buildGameHubRoleBinding(): k8s.V1RoleBinding {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: {
      name: GAME_HUB_ROLE_NAME,
      namespace: GAME_HUB_NAMESPACE,
      labels: {
        app: "infraweaver-console",
      },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: GAME_HUB_ROLE_NAME,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: "infraweaver-console",
        namespace: "infraweaver-console",
      },
    ],
  };
}

function isAlreadyExistsError(error: unknown) {
  const candidate = error as { statusCode?: number; body?: { code?: number; reason?: string } } | undefined;
  return candidate?.statusCode === 409 || candidate?.body?.code === 409 || candidate?.body?.reason === "AlreadyExists";
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["cluster:read", "infra:read", "game-hub:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const apiExtApi = kc.makeApiClient(k8s.ApiextensionsV1Api);
    const storageApi = kc.makeApiClient(k8s.StorageV1Api);
    const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);

    let nsExists = false;
    try {
      await coreApi.readNamespace({ name: GAME_HUB_NAMESPACE });
      nsExists = true;
    } catch {}

    let crdExists = false;
    try {
      await apiExtApi.readCustomResourceDefinition({ name: "gameservers.infraweaver.rlservers.com" });
      crdExists = true;
    } catch {}

    let rbacExists = false;
    try {
      await rbacApi.readNamespacedRole({ name: GAME_HUB_ROLE_NAME, namespace: GAME_HUB_NAMESPACE });
      rbacExists = true;
    } catch {}

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

    const longhornAvailable = storageClasses.some((sc) => sc.name === "longhorn");

    return NextResponse.json({
      nsExists,
      crdExists,
      rbacExists,
      longhornAvailable,
      storageClasses,
      ready: nsExists && crdExists && rbacExists,
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
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const apiExtApi = kc.makeApiClient(k8s.ApiextensionsV1Api);
    let namespaceReady = false;

    try {
      await coreApi.readNamespace({ name: GAME_HUB_NAMESPACE });
      results.push({ resource: "game-hub namespace", status: "already exists" });
      namespaceReady = true;
    } catch {
      try {
        await coreApi.createNamespace({
          body: {
            apiVersion: "v1",
            kind: "Namespace",
            metadata: {
              name: GAME_HUB_NAMESPACE,
              labels: {
                "app.kubernetes.io/managed-by": "infraweaver-console",
                "app.kubernetes.io/part-of": "infraweaver",
              },
            },
          },
        });
        results.push({ resource: "game-hub namespace", status: "created" });
        namespaceReady = true;
      } catch (err) {
        if (isAlreadyExistsError(err)) {
          results.push({ resource: "game-hub namespace", status: "already exists" });
          namespaceReady = true;
        } else {
          results.push({ resource: "game-hub namespace", status: "error", error: safeError(err) });
        }
      }
    }

    if (namespaceReady) {
      try {
        await rbacApi.createNamespacedRole({ namespace: GAME_HUB_NAMESPACE, body: buildGameHubRole() });
        results.push({ resource: "game-hub Role", status: "created" });
      } catch (err) {
        if (isAlreadyExistsError(err)) {
          results.push({ resource: "game-hub Role", status: "already exists" });
        } else {
          results.push({ resource: "game-hub Role", status: "error", error: safeError(err) });
        }
      }

      try {
        await rbacApi.createNamespacedRoleBinding({ namespace: GAME_HUB_NAMESPACE, body: buildGameHubRoleBinding() });
        results.push({ resource: "game-hub RoleBinding", status: "created" });
      } catch (err) {
        if (isAlreadyExistsError(err)) {
          results.push({ resource: "game-hub RoleBinding", status: "already exists" });
        } else {
          results.push({ resource: "game-hub RoleBinding", status: "error", error: safeError(err) });
        }
      }
    }

    try {
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
