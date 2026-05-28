import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

const namespaceSchema = z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const resourceNameSchema = z.string().min(1).max(253).regex(/^[a-z0-9]([-.a-z0-9]*[a-z0-9])?$/);
const secretDeleteSchema = z.object({
  namespace: namespaceSchema,
  name: resourceNameSchema,
}).strict();

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "security:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const clusterId = getRequestClusterId(request);
  const namespace = request.nextUrl.searchParams.get("namespace");
  const path = namespace ? `/secrets?namespace=${encodeURIComponent(namespace)}` : "/secrets";
  const res = await iwApiFetch(path, session, clusterId);
  return NextResponse.json(await res.json(), { status: res.status });
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "security:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const clusterId = getRequestClusterId(request);
  const rawBody = await request.json().catch(() => null);
  const parsed = secretDeleteSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const { namespace, name } = parsed.data;
  const res = await iwApiFetch(`/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, session, clusterId, { method: "DELETE" });
  return NextResponse.json(await res.json(), { status: res.status });
}
