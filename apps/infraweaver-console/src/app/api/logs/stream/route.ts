import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canAccessLogsTarget, getGameHubAccessContext } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { isValidContainerName, isValidK8sName, isValidNamespace } from "@/lib/validate";
import * as k8s from "@kubernetes/client-node";
import { Writable, PassThrough } from "stream";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(rateLimitKey("logs-stream", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const namespace = searchParams.get("namespace") ?? "";
  const pod = searchParams.get("pod") ?? "";
  const container = searchParams.get("container") ?? "";
  if (!namespace || !pod || !container) {
    return NextResponse.json({ error: "namespace, pod, container required" }, { status: 400 });
  }
  if (!isValidNamespace(namespace) || !isValidK8sName(pod) || !isValidContainerName(container)) {
    return NextResponse.json({ error: "Invalid resource name" }, { status: 400 });
  }

  const access = await getGameHubAccessContext(session, 60);
  if (!canAccessLogsTarget(access.groups, access.username, access.roleAssignments, namespace, pod)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const kc = loadKubeConfig();
    const log = new k8s.Log(kc);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const passThrough = new PassThrough();

    passThrough.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        void writer.write(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      }
    });
    passThrough.on("end", () => void writer.close());
    passThrough.on("error", () => void writer.close());

    void log.log(namespace, pod, container, passThrough as unknown as Writable, { follow: true, pretty: false, timestamps: false });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch {
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(`data: ${JSON.stringify("[simulated] Log stream not available in dev")}\n\n`));
    await writer.close();
    return new Response(stream.readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }
}
