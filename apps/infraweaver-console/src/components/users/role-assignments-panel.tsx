"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, Plus, Trash2, Clock, Globe, Loader2 } from "lucide-react";
import { toast } from "@/lib/notify";
import { buildScopes, scopeLabel, type RoleAssignment, type RoleDefinition } from "@/lib/rbac";
import { cn, formatDate } from "@/lib/utils";
import type { PlatformUser } from "@/hooks/use-users-config";
import { useRBAC } from "@/hooks/use-rbac";

interface Props {
  user: PlatformUser | null;
  isAdmin: boolean;
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
  onSave: (payload: { roleId: string; scope: string; principalType: "user"; expiresAt?: string }) => void;
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
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200 dark:border-white/10">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white">Cancel</button>
          <button
            onClick={() => onSave({ roleId, scope, principalType: "user", expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined })}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/30"
          >
            <Plus className="w-4 h-4" /> Add Assignment
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

  const addMutation = useMutation({
    mutationFn: async (payload: { roleId: string; scope: string; principalType: "user"; expiresAt?: string }) => {
      const res = await fetch(`/api/users-config/${user?.username}/rbac`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add assignment");
      return data;
    },
    onSuccess: () => {
      toast.success("Assignment added");
      setModalOpen(false);
      qc.invalidateQueries({ queryKey: ["users-config", user?.username, "rbac"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const removeMutation = useMutation({
    mutationFn: async (assignmentId: string) => {
      const res = await fetch(`/api/users-config/${user?.username}/rbac`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to remove assignment");
      return data;
    },
    onSuccess: () => {
      toast.success("Assignment removed");
      qc.invalidateQueries({ queryKey: ["users-config", user?.username, "rbac"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const roles = rolesQuery.data?.roles ?? [];
  const roleMap = new Map(roles.map((role) => [role.id, role]));
  const assignments = assignmentsQuery.data?.role_assignments ?? [];
  const gameServers = (gameServersQuery.data?.servers ?? []).map((server) => server.name);

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
      ) : assignments.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">No scoped assignments for this user.</div>
      ) : (
        <div className="divide-y divide-white/5">
          {assignments.map((assignment) => {
            const role = roleMap.get(assignment.roleId);
            return (
              <div key={assignment.id} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("text-xs px-2 py-0.5 rounded-full border", role ? "bg-indigo-500/10 border-indigo-500/20 text-indigo-300" : "bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 text-slate-700 dark:text-slate-300")}>
                      {role?.name ?? assignment.roleId}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
                      <Globe className="w-3 h-3" /> {scopeLabel(assignment.scope)}
                    </span>
                    {assignment.expiresAt && (
                      <span className="text-xs text-amber-300 inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Expires {formatDate(assignment.expiresAt)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">Granted by {assignment.grantedBy} on {formatDate(assignment.grantedAt)}</p>
                </div>
                {canManageAssignments && (
                  <button
                    onClick={() => removeMutation.mutate(assignment.id)}
                    disabled={removeMutation.isPending}
                    className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && user && canManageAssignments && (
        <AddAssignmentModal
          roles={roles}
          gameServers={gameServers}
          onClose={() => setModalOpen(false)}
          onSave={(payload) => addMutation.mutate(payload)}
        />
      )}
    </div>
  );
}
