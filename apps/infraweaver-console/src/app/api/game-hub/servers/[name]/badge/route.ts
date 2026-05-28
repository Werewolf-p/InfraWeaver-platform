import { NextRequest } from "next/server";
import { GAME_HUB_NS, makeGameHubClients, parsePlayerHistory } from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBadge(message: string, color: string) {
  const label = "Game Server";
  const labelWidth = Math.max(70, label.length * 7 + 16);
  const messageWidth = Math.max(90, message.length * 7 + 16);
  const width = labelWidth + messageWidth;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(message)}">
  <linearGradient id="smooth" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".7"/>
    <stop offset=".1" stop-color="#aaa" stop-opacity=".1"/>
    <stop offset=".9" stop-opacity=".3"/>
    <stop offset="1" stop-opacity=".5"/>
  </linearGradient>
  <mask id="round"><rect width="${width}" height="20" rx="3" fill="#fff"/></mask>
  <g mask="url(#round)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${color}"/>
    <rect width="${width}" height="20" fill="url(#smooth)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${Math.floor(labelWidth / 2)}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${Math.floor(labelWidth / 2)}" y="14">${escapeXml(label)}</text>
    <text x="${labelWidth + Math.floor(messageWidth / 2)}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text>
    <text x="${labelWidth + Math.floor(messageWidth / 2)}" y="14">${escapeXml(message)}</text>
  </g>
</svg>`;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) {
    return new Response(renderBadge("INVALID", "#9f9f9f"), {
      status: nameErr.status,
      headers: { "Cache-Control": "public, max-age=30", "Content-Type": "image/svg+xml" },
    });
  }

  try {
    const { appsApi } = makeGameHubClients();
    const deployment = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS });
    const container = deployment.spec?.template?.spec?.containers?.[0];
    const playerHistory = parsePlayerHistory(deployment.metadata?.annotations?.["infraweaver/player-history"]);
    const currentPlayers = playerHistory[playerHistory.length - 1]?.n ?? 0;
    const maxPlayers = container?.env?.find((entry) => ["MAX_PLAYERS", "MAXPLAYERS", "SRCDS_MAXPLAYERS"].includes(entry.name))?.value ?? null;
    const maintenanceMode = deployment.metadata?.annotations?.["infraweaver/maintenance"] === "true";
    const online = !maintenanceMode && (deployment.spec?.replicas ?? 0) > 0 && (deployment.status?.readyReplicas ?? 0) > 0;
    const message = maintenanceMode
      ? "MAINTENANCE"
      : online
        ? maxPlayers
          ? `ONLINE ${currentPlayers}/${maxPlayers} players`
          : `ONLINE ${currentPlayers} players`
        : "OFFLINE";
    const color = maintenanceMode ? "#dfb317" : online ? "#4c1" : "#e05d44";

    return new Response(renderBadge(message, color), {
      headers: {
        "Cache-Control": "public, max-age=30",
        "Content-Type": "image/svg+xml",
      },
    });
  } catch {
    return new Response(renderBadge("ERROR", "#9f9f9f"), {
      status: 500,
      headers: {
        "Cache-Control": "public, max-age=30",
        "Content-Type": "image/svg+xml",
      },
    });
  }
}
