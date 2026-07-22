"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Clock, KeyRound, Layers, Plus, ShieldCheck, Timer, Trash2, UserPlus, Users, X, Zap,
} from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { SectionTabs } from "@/components/ui/section-tabs";
import { toApiErrorMessage } from "@/lib/api-client";
import { toast } from "@/lib/notify";
import { useApiMutation, useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";
import { INTERNAL_DOMAIN } from "@/lib/domain";
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

export function AccessView() {
  const { canAny } = useRBAC();
  const canManage = canAny(["rbac:admin", "cluster:admin"]);
  const [tab, setTab] = useState<TabId>("pim");

  const tabs: Array<{ value: TabId; label: string; icon: typeof Zap }> = [
    { value: "pim", label: "PIM (Just-in-Time)", icon: Zap },
    { value: "groups", label: "Groups", icon: Users },
    { value: "assignments", label: "Assignments", icon: Layers },
  ];

  return (
    <PageScaffold
      icon={ShieldCheck}
      title="Access Management"
      subtitle="Custom groups, resource assignments, and privileged just-in-time elevation"
    >
      <SectionTabs
        tabs={tabs}
        activeTab={tab}
        onTabChange={(value) => setTab(value as TabId)}
        className="mb-6"
      />

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

  const eligibilityQuery = useApiQuery<EligibilityResponse>({
    queryKey: ["pim", "eligibility"],
    path: "/api/pim/eligibility",
    staleTime: 30_000,
  });

  const activationsQuery = useApiQuery<ActivationsResponse>({
    queryKey: ["pim", "activations"],
    path: "/api/pim/activations",
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

  const activateMutation = useApiMutation<unknown, { role: string; durationMinutes: number; reason: string }>({
    path: "/api/pim/activate",
    successMessage: "Role activated",
    errorMessage: (error) => toApiErrorMessage(error, "Activation failed"),
    invalidateQueryKeys: [["pim", "activations"], ["pim", "eligibility"]],
  });

  const deactivateMutation = useApiMutation<unknown, { id: string }>({
    path: "/api/pim/deactivate",
    successMessage: "Elevation deactivated",
    errorMessage: (error) => toApiErrorMessage(error, "Deactivation failed"),
    invalidateQueryKeys: [["pim", "activations"], ["pim", "eligibility"]],
  });

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
                    disabled={deactivateMutation.isPending && deactivateMutation.variables?.id === activation.id}
                    onClick={() => deactivateMutation.mutate({ id: activation.id })}
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
        {eligibilityQuery.isLoading ? (
          <p className="rounded-xl border border-dashed border-gray-200 dark:border-white/10 p-4 text-sm text-gray-400">Loading…</p>
        ) : eligible.length === 0 ? (
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
                busy={activateMutation.isPending && activateMutation.variables?.role === entry.role}
                alreadyActive={active.some((a) => a.role === entry.role)}
                onActivate={(role, durationMinutes, reason) => activateMutation.mutate({ role, durationMinutes, reason })}
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

  const addMutation = useApiMutation<unknown, { principalType: "user" | "group"; principalId: string; role: string }>({
    path: "/api/pim/eligibility",
    successMessage: "Eligibility granted",
    onSuccess: () => {
      setPrincipalId("");
      onChange();
    },
  });

  const add = () => {
    if (!principalId.trim()) return;
    addMutation.mutate({ principalType, principalId, role });
  };

  const removeMutation = useApiMutation<unknown, string>({
    method: "DELETE",
    path: (id) => `/api/pim/eligibility/${id}`,
    onSuccess: () => onChange(),
  });

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
        <button type="button" disabled={addMutation.isPending} onClick={add} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
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
              <button type="button" onClick={() => removeMutation.mutate(entry.id)} className="text-red-500 hover:text-red-600">
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
  const groupsQuery = useApiQuery<{ groups: CustomGroup[] }>({
    queryKey: ["access", "groups"],
    path: "/api/groups",
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
      {groupsQuery.isLoading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : groups.length === 0 ? (
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

  const removeMutation = useApiMutation<unknown, void>({
    method: "DELETE",
    path: `/api/groups/${group.id}`,
    successMessage: "Group deleted",
    onSuccess: () => onChange(),
  });

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
            <button type="button" onClick={() => removeMutation.mutate()} className="text-red-500 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
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

  const togglePerm = (p: Permission) =>
    setPermissions((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const saveMutation = useApiMutation<unknown, { name: string; description: string; permissions: Permission[]; members: string[] }>({
    method: group ? "PATCH" : "POST",
    path: group ? `/api/groups/${group.id}` : "/api/groups",
    successMessage: group ? "Group updated" : "Group created",
    onSuccess: () => onSaved(),
  });

  const save = () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    saveMutation.mutate({
      name,
      description,
      permissions,
      members: members.split(",").map((m) => m.trim()).filter(Boolean),
    });
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
        <button type="button" disabled={saveMutation.isPending} onClick={save} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Save</button>
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
  const query = useApiQuery<{ assignments: ResourceAssignment[] }>({
    queryKey: ["access", "assignments"],
    path: "/api/access/assignments",
  });
  const groupsQuery = useApiQuery<{ groups: CustomGroup[] }>({
    queryKey: ["access", "groups"],
    path: "/api/groups",
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["access", "assignments"] });
  const assignments = query.data?.assignments ?? [];

  const removeMutation = useApiMutation<unknown, string>({
    method: "DELETE",
    path: (id) => `/api/access/assignments/${id}`,
    onSuccess: () => refresh(),
  });

  return (
    <div className="space-y-4">
      {canManage && <AssignmentEditor groups={groupsQuery.data?.groups ?? []} onSaved={refresh} />}
      {query.isLoading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : assignments.length === 0 ? (
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
                      <button type="button" onClick={() => removeMutation.mutate(a.id)} className="text-red-500 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
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

  const togglePerm = (p: Permission) =>
    setPermissions((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const saveMutation = useApiMutation<unknown, { principalType: "user" | "group"; principalId: string; resourceType: ResourceType; resourceId: string; permissions: Permission[] }>({
    path: "/api/access/assignments",
    successMessage: "Assignment created",
    onSuccess: () => {
      setResourceId("");
      setPrincipalId("");
      setPermissions([]);
      onSaved();
    },
  });

  const save = () => {
    if (!principalId.trim() || !resourceId.trim()) { toast.error("Principal and resource are required"); return; }
    saveMutation.mutate({ principalType, principalId, resourceType, resourceId, permissions });
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
        <input value={resourceId} onChange={(e) => setResourceId(e.target.value)} placeholder={resourceType === "hostname" ? `app.${INTERNAL_DOMAIN}` : "resource name"} className="rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm" />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ASSIGNABLE_PERMISSIONS.map((p) => (
          <button key={p} type="button" onClick={() => togglePerm(p)} className={cn("rounded px-2 py-1 text-xs", permissions.includes(p) ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300")}>{p}</button>
        ))}
      </div>
      <button type="button" disabled={saveMutation.isPending} onClick={save} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        <Plus className="h-4 w-4" /> Add Assignment
      </button>
    </div>
  );
}
