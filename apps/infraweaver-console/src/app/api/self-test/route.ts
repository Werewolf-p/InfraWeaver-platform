import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { auth } from "@/lib/auth";
import { safeError } from "@/lib/utils";

const K8S_API = "https://kubernetes.default.svc";
const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";

function getToken(): string | null {
  if (process.env.CONSOLE_SA_TOKEN) return process.env.CONSOLE_SA_TOKEN;
  try {
    return readFileSync(SA_TOKEN_PATH, "utf8").trim();
  } catch {
    return null;
  }
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = getToken();
  if (!token) {
    return NextResponse.json({ healthy: false, error: "No SA token available" });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  try {
    const [podsRes, nodesRes, deploymentsRes] = await Promise.all([
      fetch(`${K8S_API}/api/v1/pods`, { headers, signal: AbortSignal.timeout(8000) }),
      fetch(`${K8S_API}/api/v1/nodes`, { headers, signal: AbortSignal.timeout(8000) }),
      fetch(`${K8S_API}/apis/apps/v1/deployments`, { headers, signal: AbortSignal.timeout(8000) }),
    ]);

    if (!podsRes.ok) throw new Error(`Pods API: ${podsRes.status}`);
    if (!nodesRes.ok) throw new Error(`Nodes API: ${nodesRes.status}`);
    if (!deploymentsRes.ok) throw new Error(`Deployments API: ${deploymentsRes.status}`);

    const [podsData, nodesData, deploymentsData] = await Promise.all([
      podsRes.json() as Promise<{ items?: unknown[] }>,
      nodesRes.json() as Promise<{ items?: unknown[] }>,
      deploymentsRes.json() as Promise<{ items?: unknown[] }>,
    ]);

    return NextResponse.json({
      healthy: true,
      podCount: podsData.items?.length ?? 0,
      appCount: deploymentsData.items?.length ?? 0,
      nodeCount: nodesData.items?.length ?? 0,
      testedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({
      healthy: false,
      error: safeError(err),
    });
  }
}
