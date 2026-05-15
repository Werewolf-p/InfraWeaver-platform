import { NextRequest, NextResponse } from "next/server";
import type { ScheduledTask } from "@/types";
import { apiError, apiSuccess, parseJsonBody, requireRoutePermissions } from "@/lib/route-utils";

const tasks: ScheduledTask[] = [
  {
    id: "1",
    name: "Daily Cache Flush",
    namespace: "default",
    pod: "cache-pod",
    schedule: "0 2 * * *",
    command: "ls",
    enabled: true,
    createdAt: new Date().toISOString(),
  },
];

export async function GET() {
  const session = await requireRoutePermissions({ any: ["cluster:read", "infra:read"] });
  if (session instanceof NextResponse) return session;

  return apiSuccess({ tasks });
}

export async function POST(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const body = await parseJsonBody<Partial<ScheduledTask>>(request);
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
  return apiSuccess({ task }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const body = await parseJsonBody<{ id?: string; enabled?: boolean }>(request);
  const task = tasks.find((entry) => entry.id === body.id);
  if (!task) {
    return apiError("Not found", { status: 404 });
  }

  if (body.enabled !== undefined) {
    task.enabled = body.enabled;
  }

  return apiSuccess({ task });
}

export async function DELETE(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const id = request.nextUrl.searchParams.get("id");
  const taskIndex = tasks.findIndex((entry) => entry.id === id);
  if (taskIndex === -1) {
    return apiError("Not found", { status: 404 });
  }

  tasks.splice(taskIndex, 1);
  return apiSuccess({ ok: true });
}
