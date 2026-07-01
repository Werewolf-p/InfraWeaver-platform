import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { getSaveCommands } from "@/lib/game-eggs";
import {
  appendServerAudit,
  execShell,
  getPrimaryContainerName,
  getServerDeployment,
  getServerPod,
  gracefulStopServer,
  isKubernetesNotFoundError,
  makeGameHubClients,
  readServerEgg,
  runServerCommand,
  shellQuote,
} from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const backupPostBodySchema = z.object({
  action: z.enum(["create", "restore", "prune"]).optional(),
  filename: z.string().optional(),
  backupName: z.string().optional(),
  keepCount: z.number().optional(),
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
  // "unverified": archive exists and its sha256 was computed, but integrity has
  // not been proven by re-extraction. "warning": suspiciously small (likely
  // incomplete). We never claim "verified" without a real integrity check.
  status: "unverified" | "warning";
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
        bytes < 1_048_576 ? "warning" : "unverified";
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
    if (isKubernetesNotFoundError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
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
  if (!["create", "restore", "prune"].includes(body.action ?? "create")) {
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
      const desiredReplicas = deployment.spec?.replicas ?? 1;
      const restorePodName = `${name}-restore`.slice(0, 63);

      if ((deployment.spec?.replicas ?? 0) > 0) {
        await gracefulStopServer(clients, name, egg.stopCommand, 30_000);
      } else {
        await clients.appsApi.patchNamespacedDeployment({
          name,
          namespace: "game-hub",
          body: { spec: { replicas: 0 } },

          fieldManager: "infraweaver",
        });
      }

      await waitForServerPodsToStop(clients.coreApi, name);
      await clients.coreApi
        .deleteNamespacedPod({ name: restorePodName, namespace: "game-hub" })
        .catch(() => undefined);

      // Classify the outcome without relying on exec error-message text: the
      // check exec exits 0 and prints a token; extraction failures throw.
      let restoreStatus: "ok" | "missing" | "corrupt" | "failed" = "failed";
      let restoreError: unknown = null;
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

        // Pre-flight: prove the archive exists and is a readable gzip tar BEFORE
        // we touch the live world. Emits a token on stdout for reliable
        // classification (stderr/exit-code text is not carried by k8s exec).
        const check = await execShell(
          clients.kc,
          restorePodName,
          "restore",
          `backup_file=${shellQuote(`${backupDir}/${backupName}`)}; if [ ! -f "$backup_file" ]; then echo IW_MISSING; elif ! tar -tzf "$backup_file" >/dev/null 2>&1; then echo IW_CORRUPT; else echo IW_OK; fi`,
          30_000,
        );
        if (check.stdout.includes("IW_MISSING")) {
          restoreStatus = "missing";
        } else if (check.stdout.includes("IW_CORRUPT")) {
          restoreStatus = "corrupt";
        } else if (check.stdout.includes("IW_OK")) {
          // Atomic extraction: unpack into a sibling temp dir on the same volume,
          // and only wipe+swap the live world once the archive is fully
          // extracted. If tar fails the live world is left untouched.
          await execShell(
            clients.kc,
            restorePodName,
            "restore",
            `set -e; mount_path=${shellQuote(egg.mountPath)}; backup_file=${shellQuote(`${backupDir}/${backupName}`)}; if [ ! -f "$backup_file" ]; then echo MISSING >&2; exit 3; fi; rm -rf "$mount_path/.restore-tmp"; mkdir -p "$mount_path/.restore-tmp" && tar -xzf "$backup_file" -C "$mount_path/.restore-tmp" && find "$mount_path" -mindepth 1 -maxdepth 1 ! -name '.restore-tmp' ! -name '.infraweaver-backups' -exec rm -rf {} + && mv "$mount_path/.restore-tmp"/* "$mount_path"/ 2>/dev/null; mv "$mount_path/.restore-tmp"/.[!.]* "$mount_path"/ 2>/dev/null; rmdir "$mount_path/.restore-tmp"`,
            // Large-world extraction can legitimately take minutes; the exec now
            // rejects on timeout, so give it ample headroom (10 min).
            600_000,
          );
          restoreStatus = "ok";
        }
      } catch (error) {
        restoreStatus = "failed";
        restoreError = error;
      } finally {
        await clients.coreApi
          .deleteNamespacedPod({ name: restorePodName, namespace: "game-hub" })
          .catch(() => undefined);
      }

      // Always bring the server back to its desired replica count — a failed or
      // aborted restore must never leave the workload stopped.
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: "game-hub",
        body: { spec: { replicas: desiredReplicas } },

        fieldManager: "infraweaver",
      });

      if (restoreStatus !== "ok") {
        await appendServerAudit(clients.coreApi, name, {
          timestamp: new Date().toISOString(),
          user: session.user?.email ?? "unknown",
          action: "backup:restore-failed",
          details: `${backupName} (${restoreStatus})`,
        });
        if (restoreStatus === "missing") {
          return NextResponse.json(
            { error: `Backup ${backupName} not found` },
            { status: 404 },
          );
        }
        if (restoreStatus === "corrupt") {
          return NextResponse.json(
            { error: `Backup ${backupName} is not a readable archive` },
            { status: 409 },
          );
        }
        return NextResponse.json(
          { error: `Restore failed: ${safeError(restoreError)}` },
          { status: 500 },
        );
      }

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

    if ((body.action ?? "create") === "prune") {
      const keepCount = typeof body.keepCount === "number"
        ? Math.max(1, Math.min(20, Math.trunc(body.keepCount)))
        : 5;
      const backups = await listBackups(name);
      const toDelete = backups.slice(keepCount);
      if (toDelete.length === 0) {
        return NextResponse.json({ backups, deleted: [], keepCount });
      }

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
        toDelete.map((backup) => `rm -f ${shellQuote(`${backupDir}/${backup.filename}`)}`).join(" && "),
        10_000,
      );
      await auditLog(
        "game-hub:backup-prune",
        session.user?.email ?? "unknown",
        `pruned backups for ${name} to keep ${keepCount}`,
      );
      await appendServerAudit(clients.coreApi, name, {
        timestamp: new Date().toISOString(),
        user: session.user?.email ?? "unknown",
        action: "backup:prune",
        details: `Kept ${keepCount}, deleted ${toDelete.length}`,
      });
      return NextResponse.json({
        backups: await listBackups(name),
        deleted: toDelete.map((backup) => backup.filename),
        keepCount,
      });
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

    // Quiesce the world before archiving so the tar captures a consistent
    // snapshot: pause autosaves (off), flush to disk (flush), take the backup,
    // then always resume autosaves (on). Every RCON call is best-effort — a
    // game that lacks the command must not fail the backup.
    const saves = getSaveCommands(egg);
    const quiesce = async (command: string | undefined) => {
      if (!command) return;
      try {
        await runServerCommand(clients, name, command);
      } catch (rconError) {
        console.error(`backup quiesce command failed (${command})`, rconError);
      }
    };

    await quiesce(saves.off);
    await quiesce(saves.flush);
    try {
      await execShell(
        clients.kc,
        pod.metadata.name,
        getPrimaryContainerName(pod, name),
        `backup_dir=${shellQuote(backupDir)}; mkdir -p "$backup_dir" && cd ${shellQuote(egg.mountPath)} && filename="$backup_dir/gameserver-backup-$(date +%Y%m%d-%H%M%S).tar.gz" && tar --exclude='.infraweaver-backups' -czf "$filename" . && ls -1t "$backup_dir"/gameserver-backup-*.tar.gz 2>/dev/null | tail -n +${retention + 1} | xargs -r rm -f`,
        // Archiving a large world can take minutes; the exec rejects on timeout
        // (a truncated archive must never be stored as a good backup), so allow 5 min.
        300_000,
      );
    } finally {
      await quiesce(saves.on);
    }
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
    if (isKubernetesNotFoundError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
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
    if (isKubernetesNotFoundError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
