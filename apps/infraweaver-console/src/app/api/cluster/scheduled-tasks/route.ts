import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";

interface ScheduledTask {
  id: string;
  name: string;
  namespace: string;
  pod: string;
  schedule: string;
  command: string;
  enabled: boolean;
  lastRun?: string;
  createdAt: string;
}

const tasks: ScheduledTask[] = [
  { id: "1", name: "Daily Cache Flush", namespace: "default", pod: "cache-pod", schedule: "0 2 * * *", command: "ls", enabled: true, createdAt: new Date().toISOString() },
];

async function requireReadAccess() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["cluster:read", "infra:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return session;
}

async function requireWriteAccess() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return session;
}

export async function GET() {
  const session = await requireReadAccess();
  if (session instanceof NextResponse) return session;
  return NextResponse.json({ tasks });
}

export async function POST(req: NextRequest) {
  const session = await requireWriteAccess();
  if (session instanceof NextResponse) return session;
  const body = await req.json() as Partial<ScheduledTask>;
  const task: ScheduledTask = {
    id: Date.now().toString(),
    name: body.name ?? "New Task",
    namespace: body.namespace ?? "default",
    pod: body.pod ?? "",
    schedule: body.schedule ?? "0 * * * *",
    command: body.command ?? "ls",
    enabled: body.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  return NextResponse.json({ task });
}

export async function PATCH(req: NextRequest) {
  const session = await requireWriteAccess();
  if (session instanceof NextResponse) return session;
  const body = await req.json() as { id?: string; enabled?: boolean };
  const task = tasks.find(t => t.id === body.id);
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (body.enabled !== undefined) task.enabled = body.enabled;
  return NextResponse.json({ task });
}

export async function DELETE(req: NextRequest) {
  const session = await requireWriteAccess();
  if (session instanceof NextResponse) return session;
  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return NextResponse.json({ error: "Not found" }, { status: 404 });
  tasks.splice(idx, 1);
  return NextResponse.json({ ok: true });
}
