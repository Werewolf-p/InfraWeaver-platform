import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import * as k8s from "@kubernetes/client-node";
import { Writable, PassThrough } from "stream";

const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Log streaming exposes potentially sensitive container output — operator+ only
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  const role = getRole(groups);
  if (role !== "admin" && role !== "operator") {
    return NextResponse.json({ error: "Forbidden: operator or admin role required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const namespace = searchParams.get("namespace") ?? "";
  const pod = searchParams.get("pod") ?? "";
  const container = searchParams.get("container") ?? "";
  if (!namespace || !pod || !container) {
    return NextResponse.json({ error: "namespace, pod, container required" }, { status: 400 });
  }
  if (!K8S_NAME_RE.test(namespace) || !K8S_NAME_RE.test(pod) || !K8S_NAME_RE.test(container)) {
    return NextResponse.json({ error: "Invalid resource name" }, { status: 400 });
  }
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const log = new k8s.Log(kc);

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const passThrough = new PassThrough();
    passThrough.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        writer.write(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)).catch(() => {});
      }
    });
    passThrough.on("end", () => writer.close().catch(() => {}));
    passThrough.on("error", () => writer.close().catch(() => {}));

    void log.log(namespace, pod, container, passThrough as unknown as Writable, {
      follow: true,
      pretty: false,
      timestamps: false,
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch {
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    writer.write(encoder.encode(`data: ${JSON.stringify("[simulated] Log stream not available in dev")}\n\n`));
    writer.close();
    return new Response(stream.readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }
}
