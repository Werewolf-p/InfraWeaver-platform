import { NextRequest, NextResponse } from "next/server";
import type { ScheduledTask } from "@/types";
import { z } from "zod";
import { apiError, apiSuccess, requireRoutePermissions } from "@/lib/route-utils";

const createTaskSchema = z.object({
  name: z.string().optional(),
  namespace: z.string().optional(),
  pod: z.string().optional(),
  schedule: z.string().optional(),
  command: z.string().optional(),
  enabled: z.boolean().optional(),
});

const patchTaskSchema = z.object({
  id: z.string(),
  enabled: z.boolean().optional(),
});

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

  const rawBody = await request.json().catch(() => null);
  const parsed = createTaskSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError("Validation failed", { status: 400, details: parsed.error.flatten() });
  }
  const body = parsed.data;
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

  const rawBody = await request.json().catch(() => null);
  const parsedPatch = patchTaskSchema.safeParse(rawBody);
  if (!parsedPatch.success) {
    return apiError("Validation failed", { status: 400, details: parsedPatch.error.flatten() });
  }
  const body = parsedPatch.data;
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
