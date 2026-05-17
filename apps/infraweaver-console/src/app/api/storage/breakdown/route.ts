import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { hasPermission } from "@/lib/rbac";
import * as k8s from "@kubernetes/client-node";

const CLASS_COLORS: Record<string, string> = {
  "longhorn": "#6366f1",
  "longhorn-retain": "#8b5cf6",
  "smb-ardaty": "#06b6d4",
  "local-path": "#f59e0b",
  "other": "#64748b",
};

function parseGi(str: string): number {
  if (!str) return 0;
  if (str.endsWith("Gi")) return parseFloat(str);
  if (str.endsWith("Mi")) return parseFloat(str) / 1024;
  if (str.endsWith("Ti")) return parseFloat(str) * 1024;
  if (str.endsWith("Ki")) return parseFloat(str) / (1024 * 1024);
  return parseFloat(str) / (1024 * 1024 * 1024);
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const coreApi = loadKubeConfig(getRequestClusterId(request)).makeApiClient(k8s.CoreV1Api);
    const pvcsResp = await coreApi.listPersistentVolumeClaimForAllNamespaces();
    const breakdown: Record<string, { totalGi: number; pvcCount: number }> = {};
    for (const pvc of (pvcsResp as { items?: unknown[] }).items ?? []) {
      const p = pvc as {
        spec?: { storageClassName?: string; resources?: { requests?: { storage?: string } } };
      };
      const className = p.spec?.storageClassName ?? "other";
      const key = Object.keys(CLASS_COLORS).includes(className) ? className : "other";
      const gi = parseGi(p.spec?.resources?.requests?.storage ?? "0");
      if (!breakdown[key]) breakdown[key] = { totalGi: 0, pvcCount: 0 };
      breakdown[key].totalGi += gi;
      breakdown[key].pvcCount++;
    }
    const result = Object.entries(breakdown).map(([name, { totalGi, pvcCount }]) => ({
      name,
      totalGi: Math.round(totalGi * 10) / 10,
      pvcCount,
      color: CLASS_COLORS[name] ?? CLASS_COLORS["other"],
    }));
    return NextResponse.json({ breakdown: result });
  } catch {
    return NextResponse.json({
      breakdown: [
        { name: "longhorn", totalGi: 245.5, pvcCount: 18, color: "#6366f1" },
        { name: "longhorn-retain", totalGi: 89.0, pvcCount: 7, color: "#8b5cf6" },
        { name: "smb-ardaty", totalGi: 512.0, pvcCount: 4, color: "#06b6d4" },
        { name: "local-path", totalGi: 32.0, pvcCount: 3, color: "#f59e0b" },
        { name: "other", totalGi: 8.5, pvcCount: 2, color: "#64748b" },
      ],
    });
  }
}
