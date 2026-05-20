import * as k8s from "@kubernetes/client-node";
import { PassThrough, type Writable } from "stream";
import { loadKubeConfig } from "@/lib/k8s";

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

function encodeEvent(encoder: TextEncoder, line: string) {
  return encoder.encode(`data: ${JSON.stringify(line)}\n\n`);
}

export function createPodLogStreamResponse(namespace: string, pod: string, container: string, signal?: AbortSignal) {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const log = new k8s.Log(loadKubeConfig());
      const passThrough = new PassThrough();
      let closed = false;

      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      const abort = () => {
        passThrough.destroy();
        close();
      };

      signal?.addEventListener("abort", abort, { once: true });

      passThrough.on("data", (chunk: Buffer) => {
        const lines = chunk.toString("utf-8").split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          controller.enqueue(encodeEvent(encoder, line));
        }
      });
      passThrough.on("end", close);
      passThrough.on("error", close);
      passThrough.on("close", close);

      void log.log(namespace, pod, container, passThrough as unknown as Writable, {
        follow: true,
        pretty: false,
        timestamps: false,
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unable to stream logs";
        controller.enqueue(encodeEvent(encoder, `[stream-error] ${message}`));
        close();
      });
    },
  });

  return new Response(readable, { headers: sseHeaders() });
}

export function createMockPodLogStreamResponse() {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeEvent(encoder, "[simulated] Log stream not available in dev"));
      controller.close();
    },
  });

  return new Response(readable, { headers: sseHeaders() });
}
