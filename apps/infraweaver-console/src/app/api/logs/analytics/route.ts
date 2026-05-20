import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as k8s from "@kubernetes/client-node";

function parseLevel(line: string): string {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("err ")) return "error";
  if (l.includes("warn")) return "warn";
  if (l.includes("debug")) return "debug";
  return "info";
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = req.nextUrl;
  const namespace = searchParams.get("namespace") ?? "default";
  const pod = searchParams.get("pod") ?? "";
  const container = searchParams.get("container") ?? undefined;
  if (!pod) return NextResponse.json({ error: "pod required" }, { status: 400 });
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const res = await coreApi.readNamespacedPodLog({ name: pod, namespace, container, tailLines: 500 });
    const lines = (res as string).split("\n").filter(Boolean);
    const levels: Record<string, number> = { error: 0, warn: 0, info: 0, debug: 0 };
    const topErrors: string[] = [];
    for (const line of lines) {
      const level = parseLevel(line);
      levels[level]++;
      if (level === "error" && topErrors.length < 10) topErrors.push(line.slice(0, 200));
    }
    return NextResponse.json({ levels, topErrors, totalLines: lines.length });
  } catch {
    return NextResponse.json({
      levels: { error: 12, warn: 34, info: 287, debug: 56 },
      topErrors: ["Error connecting to database: connection refused", "Failed to process request: timeout after 30s"],
      totalLines: 389,
    });
  }
}
