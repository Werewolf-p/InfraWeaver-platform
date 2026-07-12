import { NextResponse } from "next/server";
import { z } from "zod";
import { appendServerAudit, makeGameHubClients, readServerAudit, withGameHubAuth } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

const auditPostBodySchema = z.object({
  action: z.string().min(1),
  details: z.string().optional(),
});

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export const GET = withGameHubAuth({ permission: "game-hub:read" }, async ({ req, name }) => {
  try {
    const { coreApi } = makeGameHubClients();
    const entries = await readServerAudit(coreApi, name);
    if (req.nextUrl.searchParams.get("format") === "csv") {
      const csv = [
        "timestamp,user,action,details",
        ...entries.map((entry) => [entry.timestamp, entry.user, entry.action, entry.details].map(csvCell).join(",")),
      ].join("\n");
      return new Response(csv, {
        headers: {
          "Content-Disposition": `attachment; filename="audit-${name}.csv"`,
          "Content-Type": "text/csv",
        },
      });
    }
    return NextResponse.json({ entries });
  } catch (error) {
    console.error("audit route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export const POST = withGameHubAuth(
  { permission: "game-hub:write", rateLimit: { name: "game-hub-audit-post", limit: 20, windowMs: 60_000 } },
  async ({ req, session, name }) => {
    const rawBody = await req.json().catch(() => null);
    const parsed = auditPostBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;

    try {
      const { coreApi } = makeGameHubClients();
      await appendServerAudit(coreApi, name, {
        timestamp: new Date().toISOString(),
        user: session.user?.email ?? "unknown",
        action: body.action,
        details: body.details ?? "",
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      console.error("audit append failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
