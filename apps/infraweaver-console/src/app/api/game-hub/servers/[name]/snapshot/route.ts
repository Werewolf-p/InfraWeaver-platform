import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, getKubernetesErrorStatus, makeGameHubClients } from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const snapshotBodySchema = z.object({
  snapshotClassName: z.string().optional(),
  label: z.string().optional(),
});

const LONGHORN_GROUP = "longhorn.io";
const LONGHORN_VERSION = "v1beta2";
const SNAPSHOT_PLURAL = "volumesnapshots";
const SNAPSHOT_GROUP = "snapshot.storage.k8s.io";
const SNAPSHOT_API_VERSION = "v1";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { customObjectsApi } = makeGameHubClients();
    const snapshots = await customObjectsApi.listNamespacedCustomObject({
      group: SNAPSHOT_GROUP,
      version: SNAPSHOT_API_VERSION,
      namespace: GAME_HUB_NAMESPACE,
      plural: SNAPSHOT_PLURAL,
      labelSelector: `app=${name}`,
    }) as unknown as { items?: unknown[] };

    return NextResponse.json({ snapshots: snapshots.items ?? [] });
  } catch (error) {
    if (getKubernetesErrorStatus(error) === 403) {
      console.warn("snapshot list forbidden", error);
      return NextResponse.json({ snapshots: [] }, { status: 200 });
    }
    console.error("snapshot list failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-snapshot", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const nameErr2 = validateK8sName(name);
  if (nameErr2) return NextResponse.json(nameErr2.error, { status: nameErr2.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const rawBody = await req.json().catch(() => ({}));
    const parsedBody = snapshotBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return NextResponse.json({ error: "Validation failed", details: parsedBody.error.flatten() }, { status: 400 });
    }
    const body = parsedBody.data;
    const clients = makeGameHubClients();

    const deployment = await clients.appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE });
    const pvcName = deployment.spec?.template?.spec?.volumes?.find((v) => v.persistentVolumeClaim?.claimName)?.persistentVolumeClaim?.claimName ?? `${name}-data`;

    const snapshotName = `${name}-snap-${Date.now()}`;
    const snapshotBody = {
      apiVersion: `${SNAPSHOT_GROUP}/${SNAPSHOT_API_VERSION}`,
      kind: "VolumeSnapshot",
      metadata: {
        name: snapshotName,
        namespace: GAME_HUB_NAMESPACE,
        labels: { app: name, "infraweaver/game": "true", "infraweaver/type": "snapshot" },
        annotations: body.label ? { "infraweaver.io/snapshot-label": body.label } : {},
      },
      spec: {
        volumeSnapshotClassName: body.snapshotClassName ?? "longhorn",
        source: { persistentVolumeClaimName: pvcName },
      },
    };

    await clients.customObjectsApi.createNamespacedCustomObject({
      group: SNAPSHOT_GROUP,
      version: SNAPSHOT_API_VERSION,
      namespace: GAME_HUB_NAMESPACE,
      plural: SNAPSHOT_PLURAL,
      body: snapshotBody,
    });

    await auditLog("game-hub:snapshot", session.user?.email ?? "unknown", `snapshot ${snapshotName} for ${name}`);
    await appendServerAudit(clients.coreApi, name, {
      timestamp: new Date().toISOString(),
      user: session.user?.email ?? "unknown",
      action: "snapshot",
      details: snapshotName,
    });

    return NextResponse.json({ created: true, snapshotName, pvcName }, { status: 201 });
  } catch (error) {
    console.error("snapshot create failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
