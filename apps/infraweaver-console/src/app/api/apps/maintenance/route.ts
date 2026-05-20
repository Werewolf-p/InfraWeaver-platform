import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

const postBodySchema = z.object({
  id: z.string(),
  active: z.boolean().optional(),
  message: z.string().optional(),
});

interface MaintenanceEntry {
  id: string;
  appName: string;
  namespace: string;
  active: boolean;
  message: string;
  enabledAt?: string;
  enabledBy?: string;
}

const maintenance: MaintenanceEntry[] = [
  { id: "1", appName: "my-app", namespace: "default", active: false, message: "Scheduled maintenance" },
  { id: "2", appName: "api-server", namespace: "default", active: false, message: "Upgrade in progress" },
];

async function requireAccess(permission: "apps:read" | "config:write") {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, permission)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return session;
}

export async function GET() {
  const session = await requireAccess("apps:read");
  if (session instanceof NextResponse) return session;
  return NextResponse.json({ maintenance });
}

export async function POST(req: NextRequest) {
  const session = await requireAccess("config:write");
  if (session instanceof NextResponse) return session;
  const rawBody = await req.json().catch(() => null);
  const parsed = postBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;
  const entry = maintenance.find(m => m.id === body.id);
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });
  entry.active = body.active ?? entry.active;
  entry.message = body.message ?? entry.message;
  entry.enabledAt = entry.active ? new Date().toISOString() : undefined;
  entry.enabledBy = entry.active ? ((session.user as { name?: string }).name ?? "unknown") : undefined;
  return NextResponse.json({ entry });
}

export async function DELETE(req: NextRequest) {
  const session = await requireAccess("config:write");
  if (session instanceof NextResponse) return session;
  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");
  const idx = maintenance.findIndex(m => m.id === id);
  if (idx === -1) return NextResponse.json({ error: "Not found" }, { status: 404 });
  maintenance.splice(idx, 1);
  return NextResponse.json({ ok: true });
}
