"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock, KeyRound, Layers, Plus, ShieldCheck, Timer, Trash2, UserPlus, Users, X, Zap,
} from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { apiClient, toApiErrorMessage } from "@/lib/api-client";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useRBAC } from "@/hooks/use-rbac";
import type { Permission } from "@/lib/rbac";
import {
  PIM_DURATION_OPTIONS,
  type CustomGroup,
  type PimActivation,
  type PimEligibility,
  type PimRoleDefinition,
  type ResourceAssignment,
  type ResourceType,
} from "@/lib/pim";

const ASSIGNABLE_PERMISSIONS: Permission[] = [
  "apps:read", "apps:write", "apps:sync",
  "config:read", "config:write",
  "cluster:read", "cluster:admin",
  "security:read", "security:write",
  "infra:read", "rbac:admin",
  "game-hub:read", "game-hub:write", "game-hub:admin",
];

type TabId = "pim" | "groups" | "assignments";

interface ActivationDecorated extends PimActivation {
  status: "active" | "expired" | "deactivated";
  roleName: string;
}

interface EligibilityDecorated extends PimEligibility {
  roleDefinition: PimRoleDefinition;
}

interface EligibilityResponse {
  roles: PimRoleDefinition[];
  eligible: EligibilityDecorated[];
  all?: PimEligibility[];
  canManage: boolean;
}

interface ActivationsResponse {
  active: ActivationDecorated[];
  history: ActivationDecorated[];
  canManageAll: boolean;
}

function formatRemaining(expiresAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(expiresAt) - now);
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export default function AccessPage() {
  const { canAny } = useRBAC();
  const canManage = canAny(["rbac:admin", "cluster:admin"]);
  const [tab, setTab] = useState<TabId>("pim");

  const tabs: Array<{ id: TabId; label: string; icon: typeof Zap }> = [
    { id: "pim", label: "PIM (Just-in-Time)", icon: Zap },
    { id: "groups", label: "Groups", icon: Users },
    { id: "assignments", label: "Assignments", icon: Layers },
  ];

  return (
    <PageScaffold
      icon={ShieldCheck}
      title="Access Management"
      subtitle="Custom groups, resource assignments, and privileged just-in-time elevation"
    >
      <div className="mb-6 flex flex-wrap gap-2">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition",
              tab === id
                ? "border-blue-500/50 bg-blue-500/10 text-blue-600 dark:text-blue-300"
                : "border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === "pim" && <PimTab canManage={canManage} />}
      {tab === "groups" && <GroupsTab canManage={canManage} />}
      {tab === "assignments" && <AssignmentsTab canManage={canManage} />}
    </PageScaffold>
  );
}

// ── PIM tab ───────────────────────────────────────────────────────────────────

function PimTab({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);

  const eligibilityQuery = useQuery({
    queryKey: ["pim", "eligibility"],
    queryFn: () => apiClient.get<EligibilityResponse>("/api/pim/eligibility"),
    staleTime: 30_000,
  });

  const activationsQuery = useQuery({
    queryKey: ["pim", "activations"],
    queryFn: () => apiClient.get<ActivationsResponse>("/api/pim/activations"),
    refetchInterval: 15_000,
  });

  // Live countdown ticker.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["pim", "activations"] });
    queryClient.invalidateQueries({ queryKey: ["pim", "eligibility"] });
  }, [queryClient]);

  const activate = useCallback(
    async (role: string, durationMinutes: number, reason: string) => {
      setBusy(role);
      try {
        await apiClient.post("/api/pim/activate", { json: { role, durationMinutes, reason } });
        toast.success("Role activated");
        refresh();
      } catch (error) {
        toast.error(toApiErrorMessage(error, "Activation failed"));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const deactivate = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await apiClient.post("/api/pim/deactivate", { json: { id } });
        toast.success("Elevation deactivated");
        refresh();
      } catch (error) {
        toast.error(toApiErrorMessage(error, "Deactivation failed"));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const eligible = eligibilityQuery.data?.eligible ?? [];
  const active = activationsQuery.data?.active ?? [];
  const history = activationsQuery.data?.history ?? [];

  return (
    <div className="space-y-8">
      {/* Active elevations */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <Timer className="h-4 w-4 text-emerald-500" /> Active Elevations
        </h3>
        {active.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-200 dark:border-white/10 p-4 text-sm text-gray-500">
            No active elevations. Activate an eligible role below.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {active.map((activation) => {
              const remaining = formatRemaining(activation.expiresAt, now);
              const expired = Date.parse(activation.expiresAt) <= now;
              return (
                <div
                  key={activation.id}
                  className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">{activation.roleName}</p>
                      <p className="mt-0.5 text-xs text-gray-500">{activation.reason}</p>
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-300">
                      <Clock className="h-3 w-3" />
                      {expired ? "expiring…" : remaining}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={busy === activation.id}
                    onClick={() => deactivate(activation.id)}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" /> Deactivate now
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Eligible roles */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <Zap className="h-4 w-4 text-amber-500" /> Roles You Can Activate
        </h3>
        {eligible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-200 dark:border-white/10 p-4 text-sm text-gray-500">
            You are not currently eligible for any privileged roles.
            {canManage ? " Grant eligibility in the Eligibility section below." : ""}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {eligible.map((entry) => (
              <EligibleRoleCard
                key={entry.id}
                entry={entry}
                busy={busy === entry.role}
                alreadyActive={active.some((a) => a.role === entry.role)}
                onActivate={activate}
              />
            ))}
          </div>
        )}
      </section>

      {/* Audit history */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <Clock className="h-4 w-4 text-gray-400" /> Activation History
        </h3>
        {history.length === 0 ? (
          <p className="text-sm text-gray-500">No past activations.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-white/10">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-white/5 text-left text-xs uppercase text-gray-500">
                <tr>
                  {activationsQuery.data?.canManageAll && <th className="px-4 py-2">User</th>}
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Reason</th>
                  <th className="px-4 py-2">Granted</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                {history.map((a) => (
                  <tr key={a.id}>
                    {activationsQuery.data?.canManageAll && <td className="px-4 py-2 text-gray-600 dark:text-gray-300">{a.user}</td>}
                    <td className="px-4 py-2 font-medium text-gray-900 dark:text-white">{a.roleName}</td>
                    <td className="px-4 py-2 text-gray-500">{a.reason}</td>
                    <td className="px-4 py-2 text-gray-500">{new Date(a.grantedAt).toLocaleString()}</td>
                    <td className="px-4 py-2">
                      <span className={cn(
                        "rounded-full px-2 py-0.5 text-xs",
                        a.status === "deactivated" ? "bg-gray-500/15 text-gray-500" : "bg-amber-500/15 text-amber-600 dark:text-amber-300",
                      )}>{a.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canManage && <EligibilityManager all={eligibilityQuery.data?.all ?? []} roles={eligibilityQuery.data?.roles ?? []} onChange={refresh} />}
    </div>
  );
}

function EligibleRoleCard({
  entry, busy, alreadyActive, onActivate,
}: {
  entry: EligibilityDecorated;
  busy: boolean;
  alreadyActive: boolean;
  onActivate: (role: string, duration: number, reason: string) => void;
}) {
  const cap = entry.maxDurationMinutes ?? 60;
  const options = PIM_DURATION_OPTIONS.filter((d) => d <= cap);
  const [duration, setDuration] = useState<number>(options[0] ?? cap);
  const [reason, setReason] = useState("");

  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/10 p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-amber-500" />
        <p className="font-medium text-gray-900 dark:text-white">{entry.roleDefinition?.name ?? entry.role}</p>
      </div>
      <p className="mt-1 text-xs text-gray-500">{entry.roleDefinition?.description}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
          className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm"
        >
          {(options.length ? options : [cap]).map((d) => (
            <option key={d} value={d}>{d} min</option>
          ))}
        </select>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Justification (required)"
          className="flex-1 min-w-[160px] rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm"
        />
      </div>
      <button
        type="button"
        disabled={busy || alreadyActive || reason.trim().length < 3}
        onClick={() => onActivate(entry.role, duration, reason)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        <Zap className="h-4 w-4" /> {alreadyActive ? "Already active" : "Activate"}
      </button>
    </div>
  );
}

function EligibilityManager({
  all, roles, onChange,
}: {
  all: PimEligibility[];
  roles: PimRoleDefinition[];
  onChange: () => void;
}) {
  const [principalType, setPrincipalType] = useState<"user" | "group">("user");
  const [principalId, setPrincipalId] = useState("");
  const [role, setRole] = useState<string>(roles[0]?.id ?? "security-reader");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!principalId.trim()) return;
    setBusy(true);
    try {
      await apiClient.post("/api/pim/eligibility", { json: { principalType, principalId, role } });
      toast.success("Eligibility granted");
      setPrincipalId("");
      onChange();
    } catch (error) {
      toast.error(toApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await apiClient.delete(`/api/pim/eligibility/${id}`);
      onChange();
    } catch (error) {
      toast.error(toApiErrorMessage(error));
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 dark:border-white/10 p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
        <ShieldCheck className="h-4 w-4 text-blue-500" /> Manage Eligibility
      </h3>
      <div className="flex flex-wrap items-end gap-2">
        <select value={principalType} onChange={(e) => setPrincipalType(e.target.value as "user" | "group")} className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm">
          <option value="user">User</option>
          <option value="group">Group</option>
        </select>
        <input value={principalId} onChange={(e) => setPrincipalId(e.target.value)} placeholder={principalType === "user" ? "user@domain" : "group name"} className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm" />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm">
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button type="button" disabled={busy} onClick={add} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          <Plus className="h-4 w-4" /> Grant
        </button>
      </div>
      {all.length > 0 && (
        <ul className="mt-4 space-y-2">
          {all.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm">
              <span className="text-gray-700 dark:text-gray-200">
                <span className="rounded bg-gray-200 dark:bg-white/10 px-1.5 py-0.5 text-xs">{entry.principalType}</span>{" "}
                <strong>{entry.principalId}</strong> → {entry.role}
              </span>
              <button type="button" onClick={() => remove(entry.id)} className="text-red-500 hover:text-red-600">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Groups tab ────────────────────────────────────────────────────────────────

function GroupsTab({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const groupsQuery = useQuery({
    queryKey: ["access", "groups"],
    queryFn: () => apiClient.get<{ groups: CustomGroup[] }>("/api/groups"),
  });
  const [creating, setCreating] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["access", "groups"] });
  const groups = groupsQuery.data?.groups ?? [];

  return (
    <div className="space-y-4">
      {canManage && (
        <button type="button" onClick={() => setCreating((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" /> New Group
        </button>
      )}
      {creating && <GroupEditor onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh(); }} />}
      {groups.length === 0 ? (
        <p className="text-sm text-gray-500">No custom groups yet.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {groups.map((group) => (
            <GroupCard key={group.id} group={group} canManage={canManage} onChange={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupCard({ group, canManage, onChange }: { group: CustomGroup; canManage: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState(false);

  const remove = async () => {
    try {
      await apiClient.delete(`/api/groups/${group.id}`);
      toast.success("Group deleted");
      onChange();
    } catch (error) {
      toast.error(toApiErrorMessage(error));
    }
  };

  if (editing) {
    return <GroupEditor group={group} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChange(); }} />;
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/10 p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="flex items-center gap-2 font-medium text-gray-900 dark:text-white"><Users className="h-4 w-4 text-blue-500" />{group.name}</p>
          <p className="mt-0.5 text-xs text-gray-500">{group.description || "No description"}</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button type="button" onClick={() => setEditing(true)} className="text-xs text-blue-600 hover:underline">Edit</button>
            <button type="button" onClick={remove} className="text-red-500 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {group.permissions.map((p) => (
          <span key={p} className="rounded bg-blue-500/10 px-1.5 py-0.5 text-xs text-blue-600 dark:text-blue-300">{p}</span>
        ))}
      </div>
      <p className="mt-3 flex items-center gap-1 text-xs text-gray-500"><UserPlus className="h-3 w-3" /> {group.members.length} member{group.members.length === 1 ? "" : "s"}</p>
    </div>
  );
}

function GroupEditor({ group, onClose, onSaved }: { group?: CustomGroup; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [permissions, setPermissions] = useState<Permission[]>(group?.permissions ?? []);
  const [members, setMembers] = useState(group?.members.join(", ") ?? "");
  const [busy, setBusy] = useState(false);

  const togglePerm = (p: Permission) =>
    setPermissions((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const save = async () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    setBusy(true);
    const payload = {
      name,
      description,
      permissions,
      members: members.split(",").map((m) => m.trim()).filter(Boolean),
    };
    try {
      if (group) await apiClient.patch(`/api/groups/${group.id}`, { json: payload });
      else await apiClient.post("/api/groups", { json: payload });
      toast.success(group ? "Group updated" : "Group created");
      onSaved();
    } catch (error) {
      toast.error(toApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm" />
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm" />
      </div>
      <p className="mt-3 mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">Permissions</p>
      <div className="flex flex-wrap gap-1.5">
        {ASSIGNABLE_PERMISSIONS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => togglePerm(p)}
            className={cn(
              "rounded px-2 py-1 text-xs",
              permissions.includes(p) ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300",
            )}
          >{p}</button>
        ))}
      </div>
      <p className="mt-3 mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">Members (comma-separated emails/usernames)</p>
      <input value={members} onChange={(e) => setMembers(e.target.value)} placeholder="alice@domain, bob@domain" className="w-full rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm" />
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} onClick={save} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Save</button>
        <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 dark:border-white/10 px-3 py-1.5 text-sm">Cancel</button>
      </div>
    </div>
  );
}

// ── Assignments tab ───────────────────────────────────────────────────────────

const RESOURCE_LABELS: Record<ResourceType, string> = {
  app: "App",
  "game-server": "Game Server",
  hostname: "Hostname (.int)",
};

function AssignmentsTab({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["access", "assignments"],
    queryFn: () => apiClient.get<{ assignments: ResourceAssignment[] }>("/api/access/assignments"),
  });
  const groupsQuery = useQuery({
    queryKey: ["access", "groups"],
    queryFn: () => apiClient.get<{ groups: CustomGroup[] }>("/api/groups"),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["access", "assignments"] });
  const assignments = query.data?.assignments ?? [];

  const remove = async (id: string) => {
    try {
      await apiClient.delete(`/api/access/assignments/${id}`);
      refresh();
    } catch (error) {
      toast.error(toApiErrorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      {canManage && <AssignmentEditor groups={groupsQuery.data?.groups ?? []} onSaved={refresh} />}
      {assignments.length === 0 ? (
        <p className="text-sm text-gray-500">No resource assignments yet.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-white/5 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">Principal</th>
                <th className="px-4 py-2">Resource</th>
                <th className="px-4 py-2">Permissions</th>
                {canManage && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-white/5">
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2"><span className="rounded bg-gray-200 dark:bg-white/10 px-1.5 py-0.5 text-xs">{a.principalType}</span> {a.principalId}</td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{RESOURCE_LABELS[a.resourceType]}: <strong>{a.resourceId}</strong></td>
                  <td className="px-4 py-2 text-gray-500">{a.permissions.join(", ") || "—"}</td>
                  {canManage && (
                    <td className="px-4 py-2 text-right">
                      <button type="button" onClick={() => remove(a.id)} className="text-red-500 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AssignmentEditor({ groups, onSaved }: { groups: CustomGroup[]; onSaved: () => void }) {
  const [principalType, setPrincipalType] = useState<"user" | "group">("user");
  const [principalId, setPrincipalId] = useState("");
  const [resourceType, setResourceType] = useState<ResourceType>("app");
  const [resourceId, setResourceId] = useState("");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [busy, setBusy] = useState(false);

  const togglePerm = (p: Permission) =>
    setPermissions((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const save = async () => {
    if (!principalId.trim() || !resourceId.trim()) { toast.error("Principal and resource are required"); return; }
    setBusy(true);
    try {
      await apiClient.post("/api/access/assignments", {
        json: { principalType, principalId, resourceType, resourceId, permissions },
      });
      toast.success("Assignment created");
      setResourceId("");
      setPrincipalId("");
      setPermissions([]);
      onSaved();
    } catch (error) {
      toast.error(toApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/10 p-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <select value={principalType} onChange={(e) => setPrincipalType(e.target.value as "user" | "group")} className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm">
          <option value="user">User</option>
          <option value="group">Group</option>
        </select>
        {principalType === "group" && groups.length > 0 ? (
          <select value={principalId} onChange={(e) => setPrincipalId(e.target.value)} className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm">
            <option value="">Select group…</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        ) : (
          <input value={principalId} onChange={(e) => setPrincipalId(e.target.value)} placeholder={principalType === "user" ? "user@domain" : "group id"} className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm" />
        )}
        <select value={resourceType} onChange={(e) => setResourceType(e.target.value as ResourceType)} className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm">
          {(Object.keys(RESOURCE_LABELS) as ResourceType[]).map((rt) => <option key={rt} value={rt}>{RESOURCE_LABELS[rt]}</option>)}
        </select>
        <input value={resourceId} onChange={(e) => setResourceId(e.target.value)} placeholder={resourceType === "hostname" ? "app.int.rlservers.com" : "resource name"} className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm" />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ASSIGNABLE_PERMISSIONS.map((p) => (
          <button key={p} type="button" onClick={() => togglePerm(p)} className={cn("rounded px-2 py-1 text-xs", permissions.includes(p) ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300")}>{p}</button>
        ))}
      </div>
      <button type="button" disabled={busy} onClick={save} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        <Plus className="h-4 w-4" /> Add Assignment
      </button>
    </div>
  );
}
