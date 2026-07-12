import { NextResponse } from "next/server";
import { z } from "zod";
import { GAME_HUB_NAMESPACE } from "@/lib/game-hub";
import { auditServerAction, getKubernetesErrorStatus, makeGameHubClients, withGameHubAuth } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

const snapshotBodySchema = z.object({
  snapshotClassName: z.string().optional(),
  label: z.string().optional(),
});

const SNAPSHOT_PLURAL = "volumesnapshots";
const SNAPSHOT_GROUP = "snapshot.storage.k8s.io";
const SNAPSHOT_API_VERSION = "v1";

export const GET = withGameHubAuth({ permission: "game-hub:read" }, async ({ name }) => {
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
});

export const POST = withGameHubAuth(
  { permission: "game-hub:admin", rateLimit: { name: "game-hub-snapshot", limit: 5, windowMs: 60_000 } },
  async ({ req, session, name }) => {
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

      await auditServerAction(clients.coreApi, name, session, "snapshot", snapshotName);

      return NextResponse.json({ created: true, snapshotName, pvcName }, { status: 201 });
    } catch (error) {
      console.error("snapshot create failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
