import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";
import { PassThrough } from "stream";

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return new Response("Forbidden", { status: 403 });
  }

  const tail = parseInt(req.nextUrl.searchParams.get("tail") ?? "200", 10);
  const sinceTimeParam = req.nextUrl.searchParams.get("sinceTime");
  const sinceTime = sinceTimeParam ? new Date(sinceTimeParam) : null;

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
    const pod = pods.items?.find((entry) => entry.status?.phase === "Running") ?? pods.items?.[0];

    if (!pod?.metadata?.name) {
      return new Response(`data: ${JSON.stringify({ type: "error", line: "No pod found — server may be stopped" })}\n\n`, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }

    const encoder = new TextEncoder();
    const logStream = new PassThrough();
    let cancelled = false;

    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected", pod: pod.metadata?.name ?? name, container: pod.spec?.containers?.[0]?.name ?? name })}\n\n`));
        const log = new k8s.Log(kc);

        const logOptions: { follow: boolean; timestamps: boolean; tailLines?: number; sinceTime?: Date; pretty: boolean } = {
          follow: true,
          timestamps: true,
          pretty: false,
        };

        if (sinceTime && !isNaN(sinceTime.getTime())) {
          logOptions.sinceTime = sinceTime;
        } else {
          logOptions.tailLines = tail;
        }

        log.log(
          GAME_HUB_NAMESPACE,
          pod.metadata!.name!,
          pod.spec?.containers?.[0]?.name ?? name,
          logStream,
          (error) => {
            if (error && !cancelled) {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", line: safeError(error) })}\n\n`));
              } catch {}
            }
            try { controller.close(); } catch {}
          },
          logOptions as unknown as import("@kubernetes/client-node").LogOptions,
        );

        logStream.on("data", (chunk: Buffer) => {
          if (cancelled) return;
          for (const raw of chunk.toString("utf8").split("\n")) {
            if (!raw.trim()) continue;
            const tsMatch = raw.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s([\s\S]*)$/);
            const timestamp = tsMatch ? tsMatch[1] : undefined;
            const line = tsMatch ? (tsMatch[2] ?? "") : raw;
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "log", line, ...(timestamp ? { timestamp } : {}) })}\n\n`));
            } catch {
              cancelled = true;
            }
          }
        });

        logStream.on("end", () => { try { controller.close(); } catch {} });
        logStream.on("error", (error) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", line: safeError(error) })}\n\n`));
            controller.close();
          } catch {}
        });
      },
      cancel() {
        cancelled = true;
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
