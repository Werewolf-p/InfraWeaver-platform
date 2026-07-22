"use client";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Power, PowerOff, Trash2, Layers } from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { useApiMutation, useApiQuery } from "@/hooks/use-api-query";
import { useRBAC } from "@/hooks/use-rbac";
import { toast } from "@/lib/notify";

interface ArgoItem {
  metadata?: { name?: string };
  spec?: { destination?: { namespace?: string } };
  status?: { health?: { status?: string }; sync?: { status?: string } };
}
interface AppGroup { id: string; name: string; apps: string[] }
type PowerState = "on" | "off" | "unknown";

export default function PowerGroupsPage() {
  const { can } = useRBAC();
  const canManage = can("cluster:admin");
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const { data: appsData } = useApiQuery<ArgoItem[]>({
    queryKey: ["argocd-applications"],
    path: "/api/argocd/apps",
  });
  const { data: groupsData } = useApiQuery<{ groups: AppGroup[]; powerStates: Record<string, PowerState> }>({
    queryKey: ["app-groups"],
    path: "/api/app-groups",
  });

  const appNames = useMemo(
    () => (appsData ?? []).map((a) => a.metadata?.name).filter((n): n is string => !!n).sort(),
    [appsData],
  );
  const groups = groupsData?.groups ?? [];
  const states = groupsData?.powerStates ?? {};

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["app-groups"] });
    qc.invalidateQueries({ queryKey: ["argocd-applications"] });
  };

  const togglePick = (app: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(app)) next.delete(app);
      else next.add(app);
      return next;
    });

  const saveMutation = useApiMutation<unknown, { name: string; apps: string[] }>({
    path: "/api/app-groups",
    successMessage: (_d, vars) => `Group "${vars.name}" saved`,
    errorMessage: (e) => (e instanceof Error ? e.message : "Failed to save group"),
    onSuccess: () => { setName(""); setPicked(new Set()); refresh(); },
  });

  const saveGroup = () => {
    if (!name.trim() || picked.size === 0) { toast.error("Name the group and pick at least one app"); return; }
    saveMutation.mutate({ name: name.trim(), apps: [...picked] });
  };

  const removeMutation = useApiMutation<unknown, string>({
    method: "DELETE",
    path: (id) => `/api/app-groups?id=${encodeURIComponent(id)}`,
    successMessage: "Group deleted",
    errorMessage: "Failed to delete group",
    onSuccess: () => refresh(),
  });

  const powerMutation = useApiMutation<{ ok?: boolean; error?: string }, { groupId: string; action: "start" | "stop"; label: string }>({
    path: "/api/app-groups/power",
    request: ({ groupId, action }) => ({ json: { groupId, action } }),
    successMessage: (_d, { label }) => label,
    errorMessage: (e) => (e instanceof Error ? e.message : "Power action failed"),
    onSuccess: () => { setTimeout(refresh, 1500); },
  });

  const rowBusy = (groupId: string) =>
    (removeMutation.isPending && removeMutation.variables === groupId) ||
    (powerMutation.isPending && powerMutation.variables?.groupId === groupId);

  const groupState = (g: AppGroup): PowerState => {
    const s = g.apps.map((a) => states[a]);
    if (s.length && s.every((x) => x === "off")) return "off";
    if (s.some((x) => x === "off")) return "unknown";
    return "on";
  };

  return (
    <PageScaffold icon={Layers} title="Power Groups" bodyClassName="space-y-6">
      <p className="text-sm text-muted-foreground">
        Group any apps — private or not — and stop or start them as one unit. Stop scales the
        group to zero and pauses ArgoCD sync so it stays off until you start it again. Data is kept.
      </p>

      {/* Create group */}
      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">New group</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Group name (e.g. trading-stack)"
          disabled={!canManage}
          className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap gap-2">
          {appNames.map((app) => (
            <button
              key={app}
              type="button"
              onClick={() => togglePick(app)}
              disabled={!canManage}
              className={`rounded-full border px-3 py-1 text-xs ${picked.has(app) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
            >
              {app}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={saveGroup}
          disabled={!canManage || saveMutation.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {saveMutation.isPending ? "Saving…" : "Save group"}
        </button>
      </section>

      {/* Existing groups */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Groups</h2>
        {groups.length === 0 && <p className="text-sm text-muted-foreground">No groups yet.</p>}
        {groups.map((g) => {
          const st = groupState(g);
          return (
            <div key={g.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  {g.name}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${st === "off" ? "bg-amber-500/15 text-amber-500" : st === "on" ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground"}`}>{st}</span>
                </div>
                <div className="text-xs text-muted-foreground">{g.apps.join(", ")}</div>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" disabled={!canManage || rowBusy(g.id)}
                  onClick={() => powerMutation.mutate({ groupId: g.id, action: "stop", label: `Stopping ${g.name}` })}
                  className="flex items-center gap-1 rounded-md border border-amber-500/40 px-3 py-1.5 text-xs text-amber-500 disabled:opacity-50">
                  <PowerOff size={14} /> Stop
                </button>
                <button type="button" disabled={!canManage || rowBusy(g.id)}
                  onClick={() => powerMutation.mutate({ groupId: g.id, action: "start", label: `Starting ${g.name}` })}
                  className="flex items-center gap-1 rounded-md border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-500 disabled:opacity-50">
                  <Power size={14} /> Start
                </button>
                <button type="button" disabled={!canManage || rowBusy(g.id)} onClick={() => removeMutation.mutate(g.id)}
                  className="rounded-md border border-border p-1.5 text-muted-foreground disabled:opacity-50">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </section>
    </PageScaffold>
  );
}
