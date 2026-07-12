import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/with-auth";

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

export const GET = withAuth({ permission: "apps:read" }, async () => {
  return NextResponse.json({ maintenance });
});

export const POST = withAuth({ permission: "config:write", bodySchema: postBodySchema }, async ({ session, body }) => {
  const existing = maintenance.find(m => m.id === body!.id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const active = body!.active ?? existing.active;
  const entry: MaintenanceEntry = {
    ...existing,
    active,
    message: body!.message ?? existing.message,
    enabledAt: active ? new Date().toISOString() : undefined,
    enabledBy: active ? ((session.user as { name?: string }).name ?? "unknown") : undefined,
  };
  maintenance = maintenance.map(m => (m.id === body!.id ? entry : m));
  return NextResponse.json({ entry });
});

export const DELETE = withAuth({ permission: "config:write" }, async ({ req }) => {
  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");
  if (!maintenance.some(m => m.id === id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  maintenance = maintenance.filter(m => m.id !== id);
  return NextResponse.json({ ok: true });
});
