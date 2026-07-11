"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, Plus, Trash2, Clock, Globe, Loader2, Undo2, Check, X, Pencil } from "lucide-react";
import { toast } from "@/lib/notify";
import { buildScopes, scopeLabel, type RoleAssignment, type RoleDefinition } from "@/lib/rbac";
import { cn, formatDate } from "@/lib/utils";
import type { PlatformUser } from "@/hooks/use-users-config";
import { useRBAC } from "@/hooks/use-rbac";

interface Props {
  user: PlatformUser | null;
  isAdmin: boolean;
}

/** A staged grant that has not been written yet — no id until it is applied. */
interface GrantDraft {
  roleId: string;
  scope: string;
  expiresAt?: string;
}

function AddAssignmentModal({
  roles,
  gameServers,
  onClose,
  onSave,
}: {
  roles: RoleDefinition[];
  gameServers: string[];
  onClose: () => void;
  onSave: (payload: GrantDraft) => void;
}) {
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [scope, setScope] = useState("/");
  const [expiresAt, setExpiresAt] = useState("");
  const scopes = buildScopes(gameServers);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-white/10">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Add Role Assignment</h3>
          <button onClick={onClose} className="text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1.5">Role</label>
            <select
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
              className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white"
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>{role.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1.5">Scope</label>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white"
            >
              {scopes.map((entry) => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1.5">Expiry (optional)</label>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white"
            />
          </div>
          <p className="text-[11px] text-slate-500">Staged locally — nothing is written until you click <strong>Apply changes</strong>.</p>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200 dark:border-white/10">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white">Cancel</button>
          <button
            onClick={() => onSave({ roleId, scope, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined })}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/30"
          >
            <Plus className="w-4 h-4" /> Stage assignment
          </button>
        </div>
      </div>
    </div>
  );
}

export function RoleAssignmentsPanel({ user, isAdmin }: Props) {
  const { canAny } = useRBAC();
  const canViewAssignments = canAny(["users:read", "users:write", "rbac:admin"]);
  const canManageAssignments = isAdmin && canAny(["users:write", "rbac:admin"]);
  const [modalOpen, setModalOpen] = useState(false);
  // Staged, unwritten edits. Revokes hold existing assignment ids; grants are new.
  const [pendingRevokes, setPendingRevokes] = useState<Set<string>>(new Set());
  const [pendingGrants, setPendingGrants] = useState<GrantDraft[]>([]);
  // Id of the assignment whose role is being edited inline (null = none), plus
  // the role picked in that inline editor.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRoleId, setEditRoleId] = useState("");
  const qc = useQueryClient();

  const rolesQuery = useQuery<{ roles: RoleDefinition[] }>({
    queryKey: ["security", "roles"],
    queryFn: async () => {
      const res = await fetch("/api/security/roles");
      if (!res.ok) throw new Error("Failed to load roles");
      return res.json();
    },
    staleTime: 60_000,
  });

  const assignmentsQuery = useQuery<{ role_assignments: RoleAssignment[] }>({
    queryKey: ["users-config", user?.username, "rbac"],
    enabled: !!user && canViewAssignments,
    queryFn: async () => {
      const res = await fetch(`/api/users-config/${user?.username}/rbac`);
      if (!res.ok) throw new Error("Failed to load assignments");
      return res.json();
    },
  });

  const gameServersQuery = useQuery<{ servers: Array<{ name: string }> }>({
    queryKey: ["game-hub", "servers"],
    enabled: canManageAssignments,
    queryFn: async () => {
      const res = await fetch("/api/game-hub/servers");
      if (!res.ok) return { servers: [] };
      return res.json();
    },
    staleTime: 60_000,
  });

  const discard = () => {
    setPendingRevokes(new Set());
    setPendingGrants([]);
  };

  const applyMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/rbac/assignments/apply", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          principalType: "user",
          username: user?.username,
          grants: pendingGrants,
          revokes: [...pendingRevokes],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to apply changes");
      return data;
    },
    onSuccess: () => {
      toast.success("Changes applied");
      discard();
      qc.invalidateQueries({ queryKey: ["users-config", user?.username, "rbac"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const roles = useMemo(() => rolesQuery.data?.roles ?? [], [rolesQuery.data?.roles]);
  const roleMap = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const assignments = assignmentsQuery.data?.role_assignments ?? [];
  const gameServers = (gameServersQuery.data?.servers ?? []).map((server) => server.name);

  const dirtyCount = pendingRevokes.size + pendingGrants.length;
  const roleName = (id: string) => roleMap.get(id)?.name ?? id;

  const toggleRevoke = (id: string) =>
    setPendingRevokes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const stageGrant = (draft: GrantDraft) => {
    setPendingGrants((prev) => [...prev, draft]);
    setModalOpen(false);
  };

  const unstageGrant = (index: number) => setPendingGrants((prev) => prev.filter((_, i) => i !== index));

  const startRoleEdit = (assignment: RoleAssignment) => {
    setEditingId(assignment.id);
    setEditRoleId(assignment.roleId);
  };

  const cancelRoleEdit = () => {
    setEditingId(null);
    setEditRoleId("");
  };

  /**
   * Swap an existing assignment's role at the SAME scope: stage a revoke of the
   * old grant and a grant of the new role together, so the apply lands as one
   * commit and a single "changed" email (see applyRoleAssignments). A no-op when
   * the role is unchanged. Scope and expiry ride along untouched — only the role
   * moves.
   */
  const confirmRoleEdit = (assignment: RoleAssignment) => {
    if (editRoleId && editRoleId !== assignment.roleId) {
      setPendingRevokes((prev) => new Set(prev).add(assignment.id));
      setPendingGrants((prev) => [
        ...prev,
        { roleId: editRoleId, scope: assignment.scope, ...(assignment.expiresAt ? { expiresAt: assignment.expiresAt } : {}) },
      ]);
    }
    cancelRoleEdit();
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 backdrop-blur-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-white/10">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Shield className="w-4 h-4 text-indigo-400" />
            Role Assignments{user ? ` · @${user.username}` : ""}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Scoped RBAC assignments stored in users.yaml.</p>
        </div>
        {canManageAssignments && user && (
          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30"
          >
            <Plus className="w-4 h-4" /> Add Assignment
          </button>
        )}
      </div>

      {!user ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">Select a user to manage role assignments.</div>
      ) : !canViewAssignments ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">You do not have permission to view role assignments.</div>
      ) : assignmentsQuery.isLoading || rolesQuery.isLoading ? (
        <div className="px-4 py-10 flex items-center justify-center text-slate-500 dark:text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /></div>
      ) : assignments.length === 0 && pendingGrants.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">No scoped assignments for this user.</div>
      ) : (
        <div className="divide-y divide-gray-200 dark:divide-white/5">
          {assignments.map((assignment) => {
            const role = roleMap.get(assignment.roleId);
            const markedForRemoval = pendingRevokes.has(assignment.id);
            return (
              <div
                key={assignment.id}
                className={cn("flex items-start justify-between gap-4 px-4 py-3", markedForRemoval && "bg-red-500/5")}
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full border",
                        markedForRemoval && "line-through opacity-60",
                        role ? "bg-indigo-500/10 border-indigo-500/20 text-indigo-300" : "bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 text-slate-700 dark:text-slate-300",
                      )}
                    >
                      {role?.name ?? assignment.roleId}
                    </span>
                    <span className={cn("text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-1", markedForRemoval && "line-through opacity-60")}>
                      <Globe className="w-3 h-3" /> {scopeLabel(assignment.scope)}
                    </span>
                    {assignment.expiresAt && (
                      <span className="text-xs text-amber-300 inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Expires {formatDate(assignment.expiresAt)}
                      </span>
                    )}
                    {markedForRemoval && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-red-400">will remove</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">Granted by {assignment.grantedBy} on {formatDate(assignment.grantedAt)}</p>
                </div>
                {canManageAssignments &&
                  (editingId === assignment.id ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <select
                        aria-label="New role"
                        value={editRoleId}
                        onChange={(event) => setEditRoleId(event.target.value)}
                        className="bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-gray-900 dark:text-white"
                      >
                        {roles.map((entry) => (
                          <option key={entry.id} value={entry.id}>{entry.name}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => confirmRoleEdit(assignment)}
                        aria-label="Confirm role change"
                        title="Confirm role change"
                        className="p-2 rounded-lg text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={cancelRoleEdit}
                        aria-label="Cancel role change"
                        title="Cancel role change"
                        className="p-2 rounded-lg text-slate-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-500/10"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0">
                      {!markedForRemoval && (
                        <button
                          onClick={() => startRoleEdit(assignment)}
                          aria-label={`Change role at ${scopeLabel(assignment.scope)}`}
                          title="Change role"
                          className="p-2 rounded-lg text-slate-500 hover:text-indigo-400 hover:bg-indigo-500/10"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => toggleRevoke(assignment.id)}
                        title={markedForRemoval ? "Keep this assignment" : "Mark for removal"}
                        className={cn(
                          "p-2 rounded-lg",
                          markedForRemoval
                            ? "text-slate-500 hover:text-indigo-400 hover:bg-indigo-500/10"
                            : "text-slate-500 hover:text-red-400 hover:bg-red-500/10",
                        )}
                      >
                        {markedForRemoval ? <Undo2 className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
                      </button>
                    </div>
                  ))}
              </div>
            );
          })}

          {/* Staged additions, not yet written */}
          {pendingGrants.map((draft, index) => (
            <div key={`draft-${index}`} className="flex items-start justify-between gap-4 px-4 py-3 bg-emerald-500/5">
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs px-2 py-0.5 rounded-full border bg-emerald-500/10 border-emerald-500/20 text-emerald-300">
                    {roleName(draft.roleId)}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
                    <Globe className="w-3 h-3" /> {scopeLabel(draft.scope)}
                  </span>
                  {draft.expiresAt && (
                    <span className="text-xs text-amber-300 inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Expires {formatDate(draft.expiresAt)}
                    </span>
                  )}
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400">will add</span>
                </div>
              </div>
              <button
                onClick={() => unstageGrant(index)}
                title="Discard this staged assignment"
                className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Apply bar — appears only when there are staged changes */}
      {canManageAssignments && dirtyCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-indigo-500/20 bg-indigo-500/5">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            {pendingGrants.length > 0 && <span>{pendingGrants.length} to add</span>}
            {pendingGrants.length > 0 && pendingRevokes.size > 0 && <span> · </span>}
            {pendingRevokes.size > 0 && <span>{pendingRevokes.size} to remove</span>}
            <span className="text-slate-400"> — applied as one change{pendingGrants.length + pendingRevokes.size === 1 ? "" : "s"} (one commit, one email).</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={discard}
              disabled={applyMutation.isPending}
              className="px-3 py-1.5 text-sm rounded-lg text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={() => applyMutation.mutate()}
              disabled={applyMutation.isPending}
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {applyMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Apply {dirtyCount} change{dirtyCount === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}

      {modalOpen && user && canManageAssignments && (
        <AddAssignmentModal
          roles={roles}
          gameServers={gameServers}
          onClose={() => setModalOpen(false)}
          onSave={stageGrant}
        />
      )}
    </div>
  );
}
