import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { GAME_HUB_NS, getServerDeployment, makeGameHubClients, parseCpuQuantity, parseMemoryBytes } from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-server-cost", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });

  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const container = deployment.spec?.template?.spec?.containers?.[0];
    const pvcName = deployment.spec?.template?.spec?.volumes
      ?.find((volume) => volume.persistentVolumeClaim?.claimName)
      ?.persistentVolumeClaim?.claimName ?? `${name}-data`;
    const pvc = await clients.coreApi.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: GAME_HUB_NS }).catch(() => null);
    const cpuCores = parseCpuQuantity(typeof container?.resources?.limits?.cpu === "string" ? container.resources.limits.cpu : null);
    const ramGB = parseMemoryBytes(typeof container?.resources?.limits?.memory === "string" ? container.resources.limits.memory : null) / 1024 ** 3;
    const storageGB = parseMemoryBytes(typeof pvc?.spec?.resources?.requests?.storage === "string" ? pvc.spec.resources.requests.storage : null) / 1024 ** 3;
    const cpuMonthlyCost = roundCurrency(cpuCores * 0.048 * 24 * 30);
    const ramMonthlyCost = roundCurrency(ramGB * 0.006 * 24 * 30);
    const storageMonthlyCost = roundCurrency(storageGB * 0.10);

    return NextResponse.json({
      cpuCores: roundCurrency(cpuCores),
      ramGB: roundCurrency(ramGB),
      storageGB: roundCurrency(storageGB),
      cpuMonthlyCost,
      ramMonthlyCost,
      storageMonthlyCost,
      totalMonthlyCost: roundCurrency(cpuMonthlyCost + ramMonthlyCost + storageMonthlyCost),
      currency: "USD",
    });
  } catch (error) {
    console.error("server cost route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
