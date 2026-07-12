import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { getRequestClusterId } from "@/lib/cluster-context";
import { withAuth } from "@/lib/with-auth";
import {
  createGroup,
  deleteGroup,
  loadGroups,
  powerStateOf,
  updateGroup,
  type PowerState,
} from "@/lib/app-power";
import { makeCustomApi } from "@/lib/kube-client";

/** Power state for every app referenced by any group (bounded, best-effort). */
async function powerStates(clusterId: string, apps: string[]): Promise<Record<string, PowerState>> {
  const out: Record<string, PowerState> = {};
  if (apps.length === 0) return out;
  const api = makeCustomApi(clusterId);
  await Promise.all(
    apps.map(async (name) => {
      try {
        const app = (await api.getNamespacedCustomObject({
          group: "argoproj.io",
          version: "v1alpha1",
          namespace: "argocd",
          plural: "applications",
          name,
        })) as Parameters<typeof powerStateOf>[0];
        out[name] = powerStateOf(app);
      } catch {
        out[name] = "unknown";
      }
    }),
  );
  return out;
}

export const GET = withAuth({ permission: ["cluster:read", "infra:read"] }, async ({ req }) => {
  const groups = await loadGroups();
  const clusterId = getRequestClusterId(req);
  const referenced = [...new Set(groups.flatMap((g) => g.apps))];
  const states = clusterId === "all" ? {} : await powerStates(clusterId, referenced);
  return NextResponse.json({ groups, powerStates: states });
});

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  apps: z.array(z.string().min(1).max(253)).max(100),
});

export const POST = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "app-groups-write", limit: 30, windowMs: 60_000 } },
  async ({ req, session }) => {
    const parsed = upsertSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const { id, name, apps } = parsed.data;
    const group = id ? await updateGroup(id, { name, apps }) : await createGroup(name, apps);
    if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
    await auditLog("app-groups:write", session.user?.email ?? "unknown", `${id ? "updated" : "created"} group ${name}`);
    return NextResponse.json({ group }, { status: id ? 200 : 201 });
  },
);

export const DELETE = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "app-groups-delete", limit: 30, windowMs: 60_000 } },
  async ({ req, session }) => {
    const id = req.nextUrl.searchParams.get("id") ?? "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const ok = await deleteGroup(id);
    if (!ok) return NextResponse.json({ error: "Group not found" }, { status: 404 });
    await auditLog("app-groups:delete", session.user?.email ?? "unknown", `deleted group ${id}`);
    return NextResponse.json({ ok: true });
  },
);
