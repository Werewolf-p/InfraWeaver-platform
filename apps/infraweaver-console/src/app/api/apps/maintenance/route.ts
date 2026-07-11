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

// NOTE: in-process state — per-replica and lost on restart. Persisting this in a
// backing store is tracked separately; here we only keep updates immutable.
let maintenance: MaintenanceEntry[] = [
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
  const existing = maintenance.find(m => m.id === body.id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const active = body.active ?? existing.active;
  const entry: MaintenanceEntry = {
    ...existing,
    active,
    message: body.message ?? existing.message,
    enabledAt: active ? new Date().toISOString() : undefined,
    enabledBy: active ? ((session.user as { name?: string }).name ?? "unknown") : undefined,
  };
  maintenance = maintenance.map(m => (m.id === body.id ? entry : m));
  return NextResponse.json({ entry });
}

export async function DELETE(req: NextRequest) {
  const session = await requireAccess("config:write");
  if (session instanceof NextResponse) return session;
  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");
  if (!maintenance.some(m => m.id === id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  maintenance = maintenance.filter(m => m.id !== id);
  return NextResponse.json({ ok: true });
}
