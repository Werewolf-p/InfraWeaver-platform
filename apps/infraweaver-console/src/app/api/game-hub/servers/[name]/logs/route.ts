import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { PassThrough } from "stream";

const ISO_TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s([\s\S]*)$/;
const LOG_HISTORY_LIMIT = 2000;
const OVERLAP_LINE_COUNT = 50;

function emitEvent(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, payload: unknown) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function emitLogLine(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, raw: string) {
  if (!raw.trim()) return null;
  const tsMatch = raw.match(ISO_TIMESTAMP_PREFIX);
  const timestamp = tsMatch ? tsMatch[1] : undefined;
  const line = tsMatch ? (tsMatch[2] ?? "") : raw;
  emitEvent(controller, encoder, {
    type: "log",
    line,
    ...(timestamp ? { timestamp } : {}),
  });
  return raw;
}

function emitLogChunk(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, chunk: string) {
  const lines: string[] = [];
  for (const raw of chunk.split(/\r?\n/)) {
    const emitted = emitLogLine(controller, encoder, raw);
    if (emitted) lines.push(emitted);
  }
  return lines;
}

function toSinceSeconds(value: Date | null) {
  if (!value || Number.isNaN(value.getTime())) return undefined;
  return Math.max(1, Math.ceil((Date.now() - value.getTime()) / 1000));
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey(`game-hub-logs:${name}`, req), 10, 60_000)) {
    return new Response("Rate limit exceeded", { status: 429 });
  }

  const requestedTail = Number.parseInt(req.nextUrl.searchParams.get("tail") ?? String(LOG_HISTORY_LIMIT), 10);
  const tail = Math.min(Math.max(Number.isFinite(requestedTail) ? requestedTail : LOG_HISTORY_LIMIT, 1), LOG_HISTORY_LIMIT);
  const sinceTimeParam = req.nextUrl.searchParams.get("sinceTime");
  const sinceTime = sinceTimeParam ? new Date(sinceTimeParam) : null;
  const sinceSeconds = toSinceSeconds(sinceTime);

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig(getRequestClusterId(req));
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
    // Exclude Terminating pods (they have a deletionTimestamp) to avoid reading stale/dying containers
    const activePods = (pods.items ?? []).filter((p) => !p.metadata?.deletionTimestamp);
    const pod = activePods.find((entry) => entry.status?.phase === "Running") ?? activePods[0];

    if (!pod?.metadata?.name) {
      return new Response(`data: ${JSON.stringify({ type: "error", line: "No running pod found — server may be stopped or still starting" })}\n\n`, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }

    const encoder = new TextEncoder();
    const logStream = new PassThrough();
    const containerName = pod.spec?.containers?.[0]?.name ?? name;
    let cancelled = false;
    let followAbortController: AbortController | null = null;

    const readable = new ReadableStream({
      async start(controller) {
        try {
          emitEvent(controller, encoder, { type: "connected", pod: pod.metadata?.name ?? name, container: containerName });
          const historyLog = await coreApi.readNamespacedPodLog({
            name: pod.metadata!.name!,
            namespace: GAME_HUB_NAMESPACE,
            container: containerName,
            tailLines: tail,
            timestamps: true,
            ...(sinceSeconds ? { sinceSeconds } : {}),
          });
          const historyLines = emitLogChunk(controller, encoder, historyLog);
          const lastHistoryTimestamp = historyLines[historyLines.length - 1]?.match(ISO_TIMESTAMP_PREFIX)?.[1];
          if (historyLines.length > 0) {
            emitEvent(controller, encoder, { type: "history-end", line: "Live logs" });
          }

          const overlapLines = lastHistoryTimestamp
            ? historyLines.filter((line) => line.startsWith(lastHistoryTimestamp)).slice(-OVERLAP_LINE_COUNT)
            : [];
          let pendingChunk = "";
          const log = new k8s.Log(kc);
          const followSinceTime = lastHistoryTimestamp
            ?? (sinceTime && !Number.isNaN(sinceTime.getTime()) ? sinceTime.toISOString() : new Date().toISOString());

          logStream.on("data", (chunk: Buffer | string) => {
            if (cancelled) return;
            pendingChunk += chunk.toString();
            const parts = pendingChunk.split(/\r?\n/);
            pendingChunk = parts.pop() ?? "";
            for (const raw of parts) {
              if (!raw.trim()) continue;
              if (overlapLines.length > 0 && raw === overlapLines[0]) {
                overlapLines.shift();
                continue;
              }
              overlapLines.length = 0;
              try {
                emitLogLine(controller, encoder, raw);
              } catch {
                cancelled = true;
                followAbortController?.abort();
                logStream.destroy();
                break;
              }
            }
          });

          logStream.on("end", () => {
            if (cancelled) return;
            if (pendingChunk.trim()) {
              try {
                emitLogLine(controller, encoder, pendingChunk);
              } catch {
                cancelled = true;
              }
            }
            try {
              controller.close();
            } catch {}
          });

          logStream.on("error", (error) => {
            if (cancelled) return;
            try {
              emitEvent(controller, encoder, { type: "error", line: safeError(error) });
              controller.close();
            } catch {}
          });

          followAbortController = await log.log(
            GAME_HUB_NAMESPACE,
            pod.metadata!.name!,
            containerName,
            logStream,
            (error) => {
              if (error && !cancelled) {
                try {
                  emitEvent(controller, encoder, { type: "error", line: safeError(error) });
                } catch {}
              }
              if (!cancelled) {
                try {
                  controller.close();
                } catch {}
              }
            },
            {
              follow: true,
              timestamps: true,
              pretty: false,
              sinceTime: followSinceTime,
            } as import("@kubernetes/client-node").LogOptions,
          );
        } catch (error) {
          if (!cancelled) {
            try {
              emitEvent(controller, encoder, { type: "error", line: safeError(error) });
              controller.close();
            } catch {}
          }
        }
      },
      cancel() {
        cancelled = true;
        followAbortController?.abort();
        logStream.destroy();
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return new Response(`data: ${JSON.stringify({ type: "error", line: safeError(error) })}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
      status: 200,
    });
  }
}
