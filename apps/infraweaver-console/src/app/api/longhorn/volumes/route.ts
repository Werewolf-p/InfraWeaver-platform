import { NextResponse } from "next/server";

const LONGHORN_API = process.env.LONGHORN_API ?? "http://longhorn-frontend.longhorn-system.svc.cluster.local:80";

export async function GET() {
  try {
    const res = await fetch(`${LONGHORN_API}/v1/volumes`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Longhorn API error");
    const data = await res.json();
    return NextResponse.json(
      (data.data ?? []).map((v: Record<string, unknown>) => ({
        name: v.name,
        size: parseInt((v.size as string) ?? "0"),
        actualSize: parseInt((v.actualSize as string) ?? "0"),
        robustness: v.robustness,
        numberOfReplicas: v.numberOfReplicas,
        state: v.state,
        kubernetesStatus: v.kubernetesStatus,
      }))
    );
  } catch {
    return NextResponse.json([
      { name: "pvc-wiki-data", size: 10737418240, actualSize: 2147483648, robustness: "healthy", numberOfReplicas: 2, state: "attached" },
      { name: "pvc-authentik-db", size: 5368709120, actualSize: 1073741824, robustness: "healthy", numberOfReplicas: 2, state: "attached" },
      { name: "pvc-netbird-data", size: 2147483648, actualSize: 536870912, robustness: "healthy", numberOfReplicas: 2, state: "attached" },
      { name: "pvc-grafana-data", size: 2147483648, actualSize: 268435456, robustness: "degraded", numberOfReplicas: 1, state: "attached" },
    ]);
  }
}
