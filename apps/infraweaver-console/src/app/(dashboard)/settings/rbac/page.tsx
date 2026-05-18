"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield, Plus, Trash2, ChevronRight, Loader2, X,
  User, Users, Lock, CheckCircle, AlertTriangle, Info,
  ShieldCheck, Gamepad2, HardDrive, Network, Package, BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import {
  BUILT_IN_ROLES, STATIC_SCOPES, buildScopes, scopeLabel, ROLE_COLOR_CLASSES,
  type RoleDefinition, type RoleAssignment,
} from "@/lib/rbac";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Assignment extends RoleAssignment {
  username: string;
  userEmail: string;
  userName: string;
}
interface PlatformUser { username: string; name?: string; email?: string }

// ─── Category icons ───────────────────────────────────────────────────────────
const CATEGORY_ICON: Record<string, React.ElementType> = {
  platform: Shield,
  "game-hub": Gamepad2,
  wiki: BookOpen,
  storage: HardDrive,
  network: Network,
  catalog: Package,
};
const CATEGORY_LABEL: Record<string, string> = {
  platform: "Platform",
  "game-hub": "Game Hub",
  wiki: "Wiki",
  storage: "Storage",
  network: "Network",
  catalog: "Catalog",
};
const builtInRoles = Object.values(BUILT_IN_ROLES);

// ─── Role Card ────────────────────────────────────────────────────────────────
function RoleCard({
  role, assignmentCount, onClick, selected,
}: { role: RoleDefinition; assignmentCount: number; onClick: () => void; selected: boolean }) {
  const colors = ROLE_COLOR_CLASSES[role.color ?? "gray"];
  const Icon = CATEGORY_ICON[role.category ?? "platform"] ?? Shield;
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-xl border p-4 transition-all group",
        selected
          ? "border-[#0078D4] bg-[#0d1e33]"
          : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] hover:border-[#333] hover:bg-[#141414]"
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className={cn("w-2 h-2 rounded-full flex-shrink-0 mt-0.5", colors.dot)} />
          <span className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2] leading-tight">{role.name}</span>
        </div>
        <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-mono flex-shrink-0", colors.badge)}>
          {CATEGORY_LABEL[role.category ?? "platform"]}
        </span>
      </div>
      <p className="text-xs text-gray-400 dark:text-[#666] mb-3 leading-relaxed">{role.description}</p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-[10px] text-gray-400 dark:text-[#555]">
          <Lock className="w-3 h-3" />
          <span>{role.permissions.includes("*") ? "All permissions" : `${role.permissions.length} permissions`}</span>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-gray-400 dark:text-[#555]">
          <Users className="w-3 h-3" />
          <span>{assignmentCount} assignment{assignmentCount !== 1 ? "s" : ""}</span>
        </div>
      </div>
    </button>
  );
}

// ─── Permission Badge ─────────────────────────────────────────────────────────
function PermBadge({ perm }: { perm: string }) {
  const isWild = perm === "*";
  return (
    <span className={cn(
      "inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border",
      isWild
        ? "bg-red-900/20 text-red-300 border-red-700/30"
        : "bg-white dark:bg-[#1a1a1a] text-gray-500 dark:text-[#888] border-gray-200 dark:border-[#2a2a2a]"
    )}>
      {isWild && <ShieldCheck className="w-2.5 h-2.5" />}
      {perm}
    </span>
  );
}

// ─── Add Assignment Modal ─────────────────────────────────────────────────────
function AddAssignmentModal({
  onClose, users, preselectedRoleId, gameServers,
}: { onClose: () => void; users: PlatformUser[]; preselectedRoleId?: string; gameServers: string[] }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [roleId, setRoleId] = useState(preselectedRoleId ?? "");
  const [scope, setScope] = useState("/");

  const allScopes = buildScopes(gameServers);

  // Auto-set scope to game-hub when a per-server role is chosen
  const handleRoleChange = (id: string) => {
    setRoleId(id);
    if (["game-hub-server-admin","game-hub-server-editor","game-hub-server-reader"].includes(id)) {
      // If only one game server exists, pre-select it
      if (gameServers.length === 1) setScope(`/game-hub/servers/${gameServers[0]}`);
      else if (!scope.startsWith("/game-hub/servers/")) setScope("/game-hub/servers/");
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/rbac/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, roleId, scope }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? "Failed"); }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Role assignment added");
      qc.invalidateQueries({ queryKey: ["rbac", "assignments"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const selectedRole = builtInRoles.find((role) => role.id === roleId);
  const isPerServerRole = ["game-server-admin", "game-server-operator", "game-server-viewer", "game-hub-server-admin", "game-hub-server-editor", "game-hub-server-reader"].includes(roleId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-md rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-[#1e1e1e]">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-[#0078D4]/20 flex items-center justify-center">
              <Plus className="w-4 h-4 text-[#0078D4]" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Add role assignment</h2>
              <p className="text-[10px] text-gray-400 dark:text-[#555]">Grant a role to a platform user</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 dark:text-[#555] hover:text-gray-700 dark:hover:text-[#888] p-1"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* User */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-[#888] mb-1.5 font-medium">Member</label>
            <select
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full bg-white dark:bg-[#0d0d0d] border border-gray-200 dark:border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            >
              <option value="">Select a user…</option>
              {users.map(u => (
                <option key={u.username} value={u.username}>
                  {u.name ?? u.username} ({u.email ?? u.username})
                </option>
              ))}
            </select>
          </div>

          {/* Role */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-[#888] mb-1.5 font-medium">Role</label>
            <select
              value={roleId}
              onChange={e => handleRoleChange(e.target.value)}
              className="w-full bg-white dark:bg-[#0d0d0d] border border-gray-200 dark:border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            >
              <option value="">Select a role…</option>
              {["platform", "game-hub", "wiki", "storage", "catalog"].map(cat => (
                <optgroup key={cat} label={CATEGORY_LABEL[cat]}>
                  {builtInRoles.filter((role) => role.category === cat).map((role) => (
                    <option key={role.id} value={role.id}>{role.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Scope */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-[#888] mb-1.5 font-medium">
              Scope
              {isPerServerRole && <span className="text-[#0078D4] ml-1">← select a specific server</span>}
            </label>
            <select
              value={scope}
              onChange={e => setScope(e.target.value)}
              className="w-full bg-white dark:bg-[#0d0d0d] border border-gray-200 dark:border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            >
              {allScopes.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <p className="text-[10px] text-gray-400 dark:text-[#555] mt-1 flex items-center gap-1">
              <Info className="w-3 h-3" />
              {isPerServerRole
                ? "Pick \"Server: <name>\" to limit this role to one game server."
                : "A broader scope like \"Platform\" grants access to all child resources."}
            </p>
          </div>

          {/* Role preview */}
          {selectedRole && (
            <div className="rounded-lg border border-gray-200 dark:border-[#1e1e1e] bg-white dark:bg-[#0d0d0d] p-3 space-y-2">
              <p className="text-xs font-medium text-gray-500 dark:text-[#888]">Permissions included:</p>
              <div className="flex flex-wrap gap-1">
                {selectedRole.permissions.map(p => <PermBadge key={p} perm={p} />)}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-200 dark:border-[#1e1e1e] bg-white dark:bg-[#0d0d0d]">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-[#f2f2f2] transition-colors">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!username || !roleId || mutation.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-[#0078D4] hover:bg-[#006cbd] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-xs font-medium text-white transition-colors"
          >
            {mutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
            Add assignment
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function RBACPage() {
  const qc = useQueryClient();
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addModalPreRole, setAddModalPreRole] = useState<string | undefined>();
  const [filterUser, setFilterUser] = useState("");

  const { data: assignmentsData, isLoading: assignmentsLoading } = useQuery<{ assignments: Assignment[] }>({
    queryKey: ["rbac", "assignments"],
    queryFn: async () => {
      const r = await fetch("/api/rbac/assignments");
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const { data: usersData } = useQuery<{ users: PlatformUser[] }>({
    queryKey: ["users-config"],
    queryFn: async () => {
      const r = await fetch("/api/users-config");
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  // Load deployed game servers for scope selector
  const { data: gameServersData } = useQuery<{ servers: Array<{ name: string }> }>({
    queryKey: ["game-hub", "servers"],
    queryFn: async () => {
      const r = await fetch("/api/game-hub/servers");
      if (!r.ok) return { servers: [] };
      return r.json();
    },
    staleTime: 60_000,
  });
  const gameServers = (gameServersData?.servers ?? []).map(s => s.name);

  const revokeMutation = useMutation({
    mutationFn: async ({ id, username }: { id: string; username: string }) => {
      const res = await fetch("/api/rbac/assignments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, username }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? "Failed"); }
    },
    onSuccess: () => { toast.success("Assignment revoked"); qc.invalidateQueries({ queryKey: ["rbac", "assignments"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const assignments = assignmentsData?.assignments ?? [];
  const users = usersData?.users ?? [];

  // Count per role
  const countByRole: Record<string, number> = {};
  for (const a of assignments) countByRole[a.roleId] = (countByRole[a.roleId] ?? 0) + 1;

  const selectedRole = builtInRoles.find((role) => role.id === selectedRoleId);
  const visibleAssignments = assignments.filter(a => {
    if (selectedRoleId && a.roleId !== selectedRoleId) return false;
    if (filterUser && !a.userName.toLowerCase().includes(filterUser.toLowerCase()) &&
        !a.userEmail.toLowerCase().includes(filterUser.toLowerCase())) return false;
    return true;
  });

  const groupedRoles: Record<string, RoleDefinition[]> = {};
  for (const role of builtInRoles) {
    const category = role.category ?? "platform";
    (groupedRoles[category] ??= []).push(role);
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-[#f2f2f2] flex items-center gap-2">
            <Shield className="w-5 h-5 text-[#0078D4]" />
            Access Control (RBAC)
          </h1>
          <p className="text-sm text-gray-400 dark:text-[#555] mt-1">
            Manage who has access to what — inspired by Azure role-based access control.
          </p>
        </div>
        <button
          onClick={() => { setAddModalPreRole(undefined); setShowAddModal(true); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0078D4] hover:bg-[#006cbd] rounded-lg text-xs font-medium text-white transition-colors flex-shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> Add assignment
        </button>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-3 rounded-xl border border-[#1e3a5f] bg-[#0a1929] p-4">
        <Info className="w-4 h-4 text-[#0078D4] flex-shrink-0 mt-0.5" />
        <div className="text-xs text-[#4a8ec2] space-y-1">
          <p className="font-medium text-[#4fc3f7]">How RBAC works on this platform</p>
          <p>Users inherit a base role from their Authentik group (<span className="font-mono">platform-admins</span>, <span className="font-mono">platform-operators</span>, <span className="font-mono">platform-users</span>). You can additionally grant granular roles scoped to specific resources. Assignments are stored in <span className="font-mono">users.yaml</span> and evaluated on every API request.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: role list */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-gray-500 dark:text-[#888] uppercase tracking-wide">Built-in Roles</h2>
            <span className="text-[10px] text-gray-400 dark:text-[#555] px-1.5 py-0.5 rounded bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a]">{builtInRoles.length} roles</span>
          </div>
          {Object.entries(groupedRoles).map(([cat, roles]) => (
            <div key={cat} className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-[#555] uppercase tracking-wide">
                {(() => { const Icon = CATEGORY_ICON[cat] ?? Shield; return <Icon className="w-3 h-3" />; })()}
                {CATEGORY_LABEL[cat]}
              </div>
              {roles.map(role => (
                <RoleCard
                  key={role.id}
                  role={role}
                  assignmentCount={countByRole[role.id] ?? 0}
                  selected={selectedRoleId === role.id}
                  onClick={() => setSelectedRoleId(prev => prev === role.id ? null : role.id)}
                />
              ))}
            </div>
          ))}
        </div>

        {/* Right: detail + assignments */}
        <div className="lg:col-span-2 space-y-4">
          {/* Role detail panel */}
          <AnimatePresence mode="wait">
            {selectedRole ? (
              <motion.div
                key={selectedRole.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="rounded-xl border border-[#0078D4]/30 bg-[#0d1e33] p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">{selectedRole.name}</h3>
                    <p className="text-xs text-gray-400 dark:text-[#666] mt-0.5">{selectedRole.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setAddModalPreRole(selectedRole.id); setShowAddModal(true); }}
                      className="flex items-center gap-1 px-2.5 py-1 bg-[#0078D4]/20 hover:bg-[#0078D4]/30 border border-[#0078D4]/40 rounded-lg text-xs text-[#4fc3f7] transition-colors"
                    >
                      <Plus className="w-3 h-3" /> Assign
                    </button>
                    <button onClick={() => setSelectedRoleId(null)} className="text-gray-400 dark:text-[#555] hover:text-gray-700 dark:hover:text-[#888]"><X className="w-4 h-4" /></button>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 dark:text-[#555] uppercase tracking-wide mb-2">Permissions</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedRole.permissions.map(p => <PermBadge key={p} perm={p} />)}
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="rounded-xl border border-dashed border-gray-200 dark:border-[#2a2a2a] p-6 flex flex-col items-center justify-center text-center gap-2"
              >
                <Shield className="w-8 h-8 text-gray-700 dark:text-[#333]" />
                <p className="text-xs text-gray-400 dark:text-[#555]">Select a role to view its permissions and manage assignments</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Assignments table */}
          <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Users className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
                <span className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
                  {selectedRoleId ? `Assignments for ${selectedRole?.name}` : "All Assignments"}
                </span>
                <span className="text-[10px] text-gray-400 dark:text-[#555] px-1.5 py-0.5 rounded bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a]">{visibleAssignments.length}</span>
              </div>
              <input
                placeholder="Filter by user…"
                value={filterUser}
                onChange={e => setFilterUser(e.target.value)}
                className="text-xs bg-white dark:bg-[#0d0d0d] border border-gray-200 dark:border-[#2a2a2a] rounded-lg px-2.5 py-1 text-gray-500 dark:text-[#888] focus:outline-none focus:border-[#444] w-40"
              />
            </div>

            {assignmentsLoading ? (
              <div className="flex items-center justify-center h-24"><Loader2 className="w-4 h-4 animate-spin text-gray-400 dark:text-[#555]" /></div>
            ) : visibleAssignments.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-24 text-xs text-gray-400 dark:text-[#555] gap-2">
                <AlertTriangle className="w-5 h-5 text-gray-700 dark:text-[#333]" />
                No assignments found
              </div>
            ) : (
              <div className="divide-y divide-[#1a1a1a]">
                {/* Column headers */}
                <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-3 px-4 py-2 bg-white dark:bg-[#0d0d0d]">
                  {["User", "Role", "Scope", ""].map((h, i) => (
                    <span key={i} className="text-[10px] text-gray-400 dark:text-[#444] uppercase tracking-wide font-medium">{h}</span>
                  ))}
                </div>
                {visibleAssignments.map(a => {
                  const role = builtInRoles.find((entry) => entry.id === a.roleId);
                  const colors = role ? ROLE_COLOR_CLASSES[role.color ?? "gray"] : ROLE_COLOR_CLASSES.gray;
                  return (
                    <div key={a.id} className="grid grid-cols-[1fr_1fr_auto_auto] gap-3 px-4 py-3 items-center hover:bg-[#0d0d0d] transition-colors">
                      {/* User */}
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-6 h-6 rounded-full bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a] flex items-center justify-center flex-shrink-0">
                          <User className="w-3 h-3 text-gray-400 dark:text-[#666]" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs text-gray-900 dark:text-[#f2f2f2] truncate">{a.userName || a.username}</p>
                          <p className="text-[10px] text-gray-400 dark:text-[#555] truncate">{a.userEmail}</p>
                        </div>
                      </div>
                      {/* Role badge */}
                      <span className={cn("text-[10px] px-2 py-0.5 rounded border font-medium self-center truncate", colors.badge)}>
                        {role?.name ?? a.roleId}
                      </span>
                      {/* Scope */}
                      <span className="text-[10px] text-gray-400 dark:text-[#666] font-mono self-center whitespace-nowrap">
                        {scopeLabel(a.scope)}
                      </span>
                      {/* Revoke */}
                      <button
                        onClick={() => revokeMutation.mutate({ id: a.id, username: a.username })}
                        disabled={revokeMutation.isPending}
                        className="text-gray-400 dark:text-[#444] hover:text-red-400 transition-colors p-1 self-center"
                        title="Revoke assignment"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="rounded-xl border border-gray-200 dark:border-[#1e1e1e] bg-white dark:bg-[#0d0d0d] p-4">
            <p className="text-[10px] text-gray-400 dark:text-[#555] uppercase tracking-wide mb-3 font-medium">Scope Hierarchy</p>
            <div className="space-y-1.5">
              {buildScopes(gameServers).map((s, i) => (
                <div key={s.value} className="flex items-center gap-2 text-xs text-gray-400 dark:text-[#666]">
                  <div style={{ width: Math.min(i, 4) * 12 }} />
                  <ChevronRight className="w-3 h-3 text-gray-700 dark:text-[#333] flex-shrink-0" />
                  <span className="font-mono text-gray-400 dark:text-[#555]">{s.value}</span>
                  <span className="text-gray-400 dark:text-[#444]">—</span>
                  <span>{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showAddModal && (
          <AddAssignmentModal
            onClose={() => setShowAddModal(false)}
            users={users}
            preselectedRoleId={addModalPreRole}
            gameServers={gameServers}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
