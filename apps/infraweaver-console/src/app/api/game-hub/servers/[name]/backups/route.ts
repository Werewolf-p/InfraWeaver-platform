import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import {
  appendServerAudit,
  execShell,
  getPrimaryContainerName,
  getServerDeployment,
  getServerPod,
  gracefulStopServer,
  makeGameHubClients,
  readServerEgg,
  shellQuote,
} from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const backupPostBodySchema = z.object({
  action: z.enum(["create", "restore"]).optional(),
  filename: z.string().optional(),
  backupName: z.string().optional(),
});

const backupDeleteBodySchema = z.object({
  filename: z.string().min(1),
});

interface BackupEntry {
  filename: string;
  path: string;
  size: string;
  bytes: number;
  createdAt: string;
  checksum: string;
  status: "verified" | "warning";
}

function formatBackupSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function backupDirForMountPath(mountPath: string) {
  return `${mountPath.replace(/\/$/, "")}/.infraweaver-backups`;
}

function sanitizeBackupName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "");
}

function parseBackups(output: string): BackupEntry[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const parts = line.split("\t");
      if (parts.length < 5) return [];
      const bytes = Number.parseInt(parts[2] ?? "0", 10);
      const status: BackupEntry["status"] =
        bytes < 1_048_576 ? "warning" : "verified";
      return [
        {
          path: parts[0] ?? "",
          filename: parts[1] ?? "",
          size: formatBackupSize(bytes),
          bytes,
          createdAt: parts[3] ?? new Date().toISOString(),
          checksum: parts[4] ?? "",
          status,
        },
      ];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function listBackups(name: string) {
  const clients = makeGameHubClients();
  const deployment = await getServerDeployment(clients.appsApi, name);
  const egg = await readServerEgg(clients.coreApi, name, deployment);
  const pod = await getServerPod(clients.coreApi, name, true);
  if (!pod?.metadata?.name) throw new Error("No running pod found");
  const backupDir = backupDirForMountPath(egg.mountPath);
  const result = await execShell(
    clients.kc,
    pod.metadata.name,
    getPrimaryContainerName(pod, name),
    `backup_dir=${shellQuote(backupDir)}; mkdir -p "$backup_dir" && for file in "$backup_dir"/gameserver-backup-*.tar.gz; do [ -f "$file" ] || continue; checksum=$(sha256sum "$file" | awk '{print $1}'); bytes=$(stat -c '%s' "$file"); created=$(stat -c '%y' "$file" | awk '{print $1"T"$2}'); printf '%s\t%s\t%s\t%s\t%s\n' "$file" "\${file##*/}" "$bytes" "$created" "$checksum"; done`,
    10_000,
  );
  return parseBackups(result.stdout);
}

async function waitForServerPodsToStop(
  coreApi: ReturnType<typeof makeGameHubClients>["coreApi"],
  name: string,
  timeoutMs = 60_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pods = await coreApi.listNamespacedPod({
      namespace: "game-hub",
      labelSelector: `app=${name}`,
    });
    const activePods = pods.items.filter((pod) => {
      const phase = pod.status?.phase ?? "Unknown";
      return !pod.metadata?.deletionTimestamp && !["Succeeded", "Failed"].includes(phase);
    });
    if (activePods.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Timed out waiting for the server pod to stop");
}

async function waitForPodRunning(
  coreApi: ReturnType<typeof makeGameHubClients>["coreApi"],
  podName: string,
  timeoutMs = 60_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pod = await coreApi
      .readNamespacedPod({ name: podName, namespace: "game-hub" })
      .catch(() => null);
    if (pod?.status?.phase === "Running") return;
    if (pod?.status?.phase === "Failed") {
      throw new Error("Restore pod failed to start");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Timed out waiting for the restore pod");
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const access = await getGameHubAccessContext(session, 60);
  if (
    !hasGameHubPermission(
      access.groups,
      access.username,
      access.roleAssignments,
      "game-hub:read",
      name,
    )
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return NextResponse.json({ backups: await listBackups(name) });
  } catch (error) {
    console.error("list backups failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  if (!checkRateLimit(rateLimitKey("game-hub-backup-post", req), 5, 60_000)) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429 },
    );
  }

  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const nameErr2 = validateK8sName(name);
  if (nameErr2) return NextResponse.json(nameErr2.error, { status: nameErr2.status });
  const access = await getGameHubAccessContext(session, 60);
  if (
    !hasGameHubPermission(
      access.groups,
      access.username,
      access.roleAssignments,
      "game-hub:write",
      name,
    )
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = await req.json().catch(() => ({}));
  const parsedBody = backupPostBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Validation failed", details: parsedBody.error.flatten() }, { status: 400 });
  }
  const body = parsedBody.data;
  if (!["create", "restore"].includes(body.action ?? "create")) {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const egg = await readServerEgg(clients.coreApi, name, deployment);

    if ((body.action ?? "create") === "restore") {
      const backupName = sanitizeBackupName(body.backupName ?? body.filename ?? "");
      if (!backupName) {
        return NextResponse.json(
          { error: "backupName is required" },
          { status: 400 },
        );
      }

      const pvcName =
        deployment.spec?.template?.spec?.volumes?.find(
          (volume) => volume.persistentVolumeClaim?.claimName,
        )?.persistentVolumeClaim?.claimName ?? `${name}-data`;
      const backupDir = backupDirForMountPath(egg.mountPath);
      const desiredReplicas = Math.max(deployment.spec?.replicas ?? 1, 1);
      const restorePodName = `${name}-restore`.slice(0, 63);

      if ((deployment.spec?.replicas ?? 0) > 0) {
        await gracefulStopServer(clients, name, egg.stopCommand, 30_000);
      } else {
        await clients.appsApi.patchNamespacedDeployment({
          name,
          namespace: "game-hub",
          body: { spec: { replicas: 0 } },
          force: true,
          fieldManager: "infraweaver",
        });
      }

      await waitForServerPodsToStop(clients.coreApi, name);
      await clients.coreApi
        .deleteNamespacedPod({ name: restorePodName, namespace: "game-hub" })
        .catch(() => undefined);

      try {
        await clients.coreApi.createNamespacedPod({
          namespace: "game-hub",
          body: {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              name: restorePodName,
              namespace: "game-hub",
              labels: {
                "infraweaver/game": "true",
                "infraweaver/type": "backup-restore",
                "infraweaver.io/server": name,
              },
            },
            spec: {
              restartPolicy: "Never",
              securityContext: deployment.spec?.template?.spec?.securityContext,
              containers: [
                {
                  name: "restore",
                  image:
                    deployment.spec?.template?.spec?.containers?.[0]?.image ??
                    egg.dockerImage,
                  command: ["sh", "-c", "sleep 3600"],
                  volumeMounts: [{ name: "data", mountPath: egg.mountPath }],
                },
              ],
              volumes: [
                { name: "data", persistentVolumeClaim: { claimName: pvcName } },
              ],
            },
          },
        });
        await waitForPodRunning(clients.coreApi, restorePodName);
        await execShell(
          clients.kc,
          restorePodName,
          "restore",
          `backup_dir=${shellQuote(backupDir)}; mount_path=${shellQuote(egg.mountPath)}; backup_file="$backup_dir/${backupName}"; [ -f "$backup_file" ] && find "$mount_path" -mindepth 1 -maxdepth 1 ! -name '.infraweaver-backups' -exec rm -rf {} + && tar -xzf "$backup_file" -C "$mount_path"`,
          120_000,
        );
      } finally {
        await clients.coreApi
          .deleteNamespacedPod({ name: restorePodName, namespace: "game-hub" })
          .catch(() => undefined);
      }

      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: "game-hub",
        body: { spec: { replicas: desiredReplicas } },
        force: true,
        fieldManager: "infraweaver",
      });
      await auditLog(
        "game-hub:backup-restore",
        session.user?.email ?? "unknown",
        `restored backup ${backupName} for ${name}`,
      );
      await appendServerAudit(clients.coreApi, name, {
        timestamp: new Date().toISOString(),
        user: session.user?.email ?? "unknown",
        action: "backup:restore",
        details: backupName,
      });
      return NextResponse.json({ restored: true, backupName });
    }

    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) {
      return NextResponse.json(
        { error: "No running pod found" },
        { status: 404 },
      );
    }

    const retention =
      Number.parseInt(
        deployment.metadata?.annotations?.["infraweaver/backup-retention"] ?? "7",
        10,
      ) || 7;
    const backupDir = backupDirForMountPath(egg.mountPath);
    await execShell(
      clients.kc,
      pod.metadata.name,
      getPrimaryContainerName(pod, name),
      `backup_dir=${shellQuote(backupDir)}; mkdir -p "$backup_dir" && cd ${shellQuote(egg.mountPath)} && filename="$backup_dir/gameserver-backup-$(date +%Y%m%d-%H%M%S).tar.gz" && tar --exclude='.infraweaver-backups' -czf "$filename" . && ls -1t "$backup_dir"/gameserver-backup-*.tar.gz 2>/dev/null | tail -n +${retention + 1} | xargs -r rm -f`,
      30_000,
    );
    await auditLog(
      "game-hub:backup",
      session.user?.email ?? "unknown",
      `created backup for ${name}`,
    );
    await appendServerAudit(clients.coreApi, name, {
      timestamp: new Date().toISOString(),
      user: session.user?.email ?? "unknown",
      action: "backup:create",
      details: "Created manual backup",
    });
    return NextResponse.json({ backups: await listBackups(name) });
  } catch (error) {
    console.error("create backup failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  if (!checkRateLimit(rateLimitKey("game-hub-backup-delete", req), 10, 60_000)) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429 },
    );
  }

  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const nameErr3 = validateK8sName(name);
  if (nameErr3) return NextResponse.json(nameErr3.error, { status: nameErr3.status });
  const access = await getGameHubAccessContext(session, 60);
  if (
    !hasGameHubPermission(
      access.groups,
      access.username,
      access.roleAssignments,
      "game-hub:write",
      name,
    )
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawDeleteBody = await req.json().catch(() => null);
  const parsedDelete = backupDeleteBodySchema.safeParse(rawDeleteBody);
  if (!parsedDelete.success) {
    return NextResponse.json({ error: "Validation failed", details: parsedDelete.error.flatten() }, { status: 400 });
  }
  const backupName = sanitizeBackupName(parsedDelete.data.filename);

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const egg = await readServerEgg(clients.coreApi, name, deployment);
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) {
      return NextResponse.json(
        { error: "No running pod found" },
        { status: 404 },
      );
    }
    const backupDir = backupDirForMountPath(egg.mountPath);
    await execShell(
      clients.kc,
      pod.metadata.name,
      getPrimaryContainerName(pod, name),
      `rm -f ${shellQuote(`${backupDir}/${backupName}`)}`,
    );
    await appendServerAudit(clients.coreApi, name, {
      timestamp: new Date().toISOString(),
      user: session.user?.email ?? "unknown",
      action: "backup:delete",
      details: `Deleted ${backupName}`,
    });
    return NextResponse.json({ backups: await listBackups(name) });
  } catch (error) {
    console.error("delete backup failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
