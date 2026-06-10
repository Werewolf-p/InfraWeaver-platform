import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { withRoute } from "@/lib/route-utils";

const namespaceSchema = z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const resourceNameSchema = z.string().min(1).max(253).regex(/^[a-z0-9]([-.a-z0-9]*[a-z0-9])?$/);
const secretDeleteSchema = z.object({
  namespace: namespaceSchema,
  name: resourceNameSchema,
}).strict();

export const GET = withRoute("security:read", async (request: NextRequest, session) => {
  const clusterId = getRequestClusterId(request);
  const namespace = request.nextUrl.searchParams.get("namespace");
  const path = namespace ? `/secrets?namespace=${encodeURIComponent(namespace)}` : "/secrets";
  const res = await iwApiFetch(path, session, clusterId);
  return NextResponse.json(await res.json(), { status: res.status });
});

export const DELETE = withRoute("security:write", async (request: NextRequest, session) => {
  const clusterId = getRequestClusterId(request);
  const rawBody = await request.json().catch(() => null);
  const parsed = secretDeleteSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const { namespace, name } = parsed.data;
  const res = await iwApiFetch(`/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, session, clusterId, { method: "DELETE" });
  return NextResponse.json(await res.json(), { status: res.status });
});
