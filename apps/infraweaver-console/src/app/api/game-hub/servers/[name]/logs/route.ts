import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { PassThrough } from "stream";

const GAME_HUB_NS = "game-hub";

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { name } = await params;
  const tail = parseInt(req.nextUrl.searchParams.get("tail") ?? "200", 10);

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    // Find the running pod
    const pods = await coreApi.listNamespacedPod({
      namespace: GAME_HUB_NS,
      labelSelector: `app=${name}`,
    });
    const pod = pods.items?.find(p => p.status?.phase === "Running") ?? pods.items?.[0];

    if (!pod?.metadata?.name) {
      return new Response("data: " + JSON.stringify({ type: "error", line: "No pod found — server may be stopped" }) + "\n\n", {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    const podName = pod.metadata.name;
    const containerName = pod.spec?.containers?.[0]?.name ?? name;

    const encoder = new TextEncoder();
    const logStream = new PassThrough();
    let cancelled = false;

    const readable = new ReadableStream({
      start(controller) {
        // Send initial connected event
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: "connected", pod: podName, container: containerName })}\n\n`
        ));

        const log = new k8s.Log(kc);
        log.log(
          GAME_HUB_NS, podName, containerName, logStream,
          (err) => {
            if (err && !cancelled) {
              try {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: "error", line: String(err) })}\n\n`
                ));
              } catch {}
            }
            try { controller.close(); } catch {}
          },
          { follow: true, tailLines: tail, timestamps: false, pretty: false },
        );

        logStream.on("data", (chunk: Buffer) => {
          if (cancelled) return;
          const text = chunk.toString("utf8");
          const lines = text.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: "log", line })}\n\n`
              ));
            } catch { cancelled = true; }
          }
        });

        logStream.on("end", () => {
          try { controller.close(); } catch {}
        });

        logStream.on("error", (err) => {
          try {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: "error", line: String(err) })}\n\n`
            ));
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
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return new Response(
      `data: ${JSON.stringify({ type: "error", line: String(err) })}\n\n`,
      {
        headers: { "Content-Type": "text/event-stream" },
        status: 200,
      }
    );
  }
}
