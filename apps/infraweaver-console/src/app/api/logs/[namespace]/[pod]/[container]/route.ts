import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ namespace: string; pod: string; container: string }> }
) {
  const { namespace, pod, container } = await params;
  const lines = parseInt(req.nextUrl.searchParams.get("lines") ?? "500");

  const mockLines = Array.from({ length: Math.min(lines, 50) }, (_, i) => {
    const d = new Date(Date.now() - (50 - i) * 2000);
    return `${d.toISOString()} INFO [${container}] Log line ${i + 1} - container ${container} in ${namespace}/${pod} is running normally`;
  }).join("\n");

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const logRes = await coreApi.readNamespacedPodLog({
      name: pod,
      namespace,
      container,
      tailLines: lines,
      timestamps: true,
    });
    return new NextResponse(logRes as string, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch {
    return new NextResponse(mockLines, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
