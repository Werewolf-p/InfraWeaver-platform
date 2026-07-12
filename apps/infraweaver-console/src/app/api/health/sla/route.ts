import { NextResponse } from "next/server";
import { calcUptime, fetchGatusStatuses } from "@/lib/gatus";
import { unavailableResponse } from "@/lib/route-utils";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: "config:read" }, async () => {
  try {
    const endpoints = await fetchGatusStatuses();
    const slaData = endpoints.map(ep => ({
      name: ep.name,
      uptime24h: calcUptime(ep.results, 24, 2),
      uptime7d: calcUptime(ep.results, 168, 2),
      uptime30d: calcUptime(ep.results, 720, 2),
    }));
    const overall24h = slaData.length > 0 ? Math.round(slaData.reduce((a, b) => a + b.uptime24h, 0) / slaData.length * 100) / 100 : 100;
    const overall7d = slaData.length > 0 ? Math.round(slaData.reduce((a, b) => a + b.uptime7d, 0) / slaData.length * 100) / 100 : 100;
    const overall30d = slaData.length > 0 ? Math.round(slaData.reduce((a, b) => a + b.uptime30d, 0) / slaData.length * 100) / 100 : 100;
    return NextResponse.json({ sla: slaData, overall: { uptime24h: overall24h, uptime7d: overall7d, uptime30d: overall30d }, live: true });
  } catch (error) {
    // FAIL CLOSED: no mock SLA numbers when Gatus is unreachable.
    return unavailableResponse(error);
  }
});
