import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { listItems, makeCoreApi } from "@/lib/kube-client";
import { withAuth } from "@/lib/with-auth";

// Deterministic colors for the well-known storage classes; anything else falls
// through to the palette below so the pie always renders.
const CLASS_COLORS: Record<string, string> = {
  "longhorn": "#6366f1",
  "longhorn-retain": "#8b5cf6",
  "local-path": "#f59e0b",
  "other": "#64748b",
};
const NAS_PALETTE = ["#06b6d4", "#0ea5e9", "#0891b2", "#2563eb", "#7c3aed"];

function parseGi(str: string): number {
  if (!str) return 0;
  if (str.endsWith("Gi")) return parseFloat(str);
  if (str.endsWith("Mi")) return parseFloat(str) / 1024;
  if (str.endsWith("Ti")) return parseFloat(str) * 1024;
  if (str.endsWith("Ki")) return parseFloat(str) / (1024 * 1024);
  return parseFloat(str) / (1024 * 1024 * 1024);
}

export const GET = withAuth({ permission: "config:read" }, async ({ req }) => {
  try {
    const coreApi = makeCoreApi(getRequestClusterId(req));
    const pvcsResp = await coreApi.listPersistentVolumeClaimForAllNamespaces();
    const breakdown: Record<string, { totalGi: number; pvcCount: number }> = {};
    // Bin every real StorageClass by name — no allowlist, so NAS-backed SCs
    // (smb-<user>-<share>-<ro|rw>) show up automatically (plan §4).
    for (const pvc of listItems<unknown>(pvcsResp)) {
      const p = pvc as {
        spec?: { storageClassName?: string; resources?: { requests?: { storage?: string } } };
      };
      const className = p.spec?.storageClassName ?? "other";
      const gi = parseGi(p.spec?.resources?.requests?.storage ?? "0");
      if (!breakdown[className]) breakdown[className] = { totalGi: 0, pvcCount: 0 };
      breakdown[className].totalGi += gi;
      breakdown[className].pvcCount++;
    }
    let nasIndex = 0;
    const result = Object.entries(breakdown).map(([name, { totalGi, pvcCount }]) => {
      const color = CLASS_COLORS[name]
        ?? (name.startsWith("smb-") || name.startsWith("nfs-") ? NAS_PALETTE[nasIndex++ % NAS_PALETTE.length] : CLASS_COLORS.other);
      return {
        name,
        totalGi: Math.round(totalGi * 10) / 10,
        pvcCount,
        color,
      };
    });
    return NextResponse.json({ breakdown: result });
  } catch {
    return NextResponse.json({ breakdown: [] });
  }
});
