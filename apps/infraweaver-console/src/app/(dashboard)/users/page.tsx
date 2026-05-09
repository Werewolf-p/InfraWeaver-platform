"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Users, Plus, Pencil, Trash2, Search, Save, X, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { useUsersConfig, useSaveUsersConfig, type PlatformUser } from "@/hooks/use-users-config";
import { useRBAC } from "@/hooks/use-rbac";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

const ACCESS_LEVELS = ["admin", "platform-user"];
const WIKI_ROLES = ["admin", "editor", "reader"];
const COMMON_GROUPS = ["platform-admins", "platform-operators", "platform-users", "wiki-admins", "wiki-editors"];
const ARGOCD_ROLES = ["role:admin", "role:operator", "role:readonly", ""];

const defaultUser: PlatformUser = {
  username: "",
  name: "",
  email: "",
  access_level: "platform-user",
  wiki_role: "reader",
  authentik_groups: ["platform-users"],
  argocd_role: "role:readonly",
};

function AccessBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    admin: "bg-red-500/10 border-red-500/20 text-red-400",
    "platform-user": "bg-blue-500/10 border-blue-500/20 text-blue-400",
  };
  return (
    <span className={cn("text-[11px] px-2 py-0.5 rounded-full border font-medium", colors[level] ?? "bg-slate-500/10 border-slate-500/20 text-slate-400")}>
      {level}
    </span>
  );
}

function UserFormModal({
  open,
  onClose,
  onSave,
  initialUser,
  isNew,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (user: PlatformUser) => void;
  initialUser: PlatformUser;
  isNew: boolean;
}) {
  const [form, setForm] = useState<PlatformUser>(initialUser);

  if (!open) return null;

  const toggleGroup = (group: string) => {
    const groups = form.authentik_groups ?? [];
    setForm(prev => ({
      ...prev,
      authentik_groups: groups.includes(group) ? groups.filter(g => g !== group) : [...groups, group],
    }));
  };

  const isValid = form.username.trim() && form.email.trim() && form.name.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        className="relative w-full max-w-lg bg-slate-900 border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl z-10 overflow-y-auto max-h-[90vh]"
      >
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h2 className="font-semibold text-white">{isNew ? "Add User" : `Edit ${initialUser.username}`}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Username *</label>
              <input
                value={form.username}
                onChange={e => setForm(prev => ({ ...prev, username: e.target.value }))}
                disabled={!isNew}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 disabled:opacity-50"
                placeholder="jdoe"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Full Name *</label>
              <input
                value={form.name}
                onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
                placeholder="John Doe"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Email *</label>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
              placeholder="jdoe@example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Access Level</label>
              <select
                value={form.access_level}
                onChange={e => setForm(prev => ({ ...prev, access_level: e.target.value }))}
                className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500/50"
              >
                {ACCESS_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Wiki Role</label>
              <select
                value={form.wiki_role ?? "reader"}
                onChange={e => setForm(prev => ({ ...prev, wiki_role: e.target.value }))}
                className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500/50"
              >
                {WIKI_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">ArgoCD Role</label>
            <select
              value={form.argocd_role ?? ""}
              onChange={e => setForm(prev => ({ ...prev, argocd_role: e.target.value }))}
              className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500/50"
            >
              {ARGOCD_ROLES.map(r => <option key={r} value={r}>{r || "(none)"}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-2 block">Authentik Groups</label>
            <div className="flex flex-wrap gap-2">
              {COMMON_GROUPS.map(g => (
                <button
                  key={g}
                  type="button"
                  onClick={() => toggleGroup(g)}
                  className={cn(
                    "px-2.5 py-1 rounded-full text-xs border transition-colors",
                    (form.authentik_groups ?? []).includes(g)
                      ? "bg-indigo-500/20 border-indigo-500/30 text-indigo-300"
                      : "bg-white/5 border-white/10 text-slate-400 hover:text-white"
                  )}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-3 p-5 border-t border-white/5 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors">Cancel</button>
          <button
            onClick={() => isValid && onSave(form)}
            disabled={!isValid}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {isNew ? "Add User" : "Save Changes"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function UserMobileCard({ user, isAdmin, onEdit, onDelete }: {
  user: PlatformUser;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="bg-white/5 border border-white/10 rounded-xl overflow-hidden"
    >
      <button
        className="w-full flex items-center gap-3 px-4 py-4 text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="w-9 h-9 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300 flex-shrink-0">
          {(user.name || user.username)[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{user.name || user.username}</p>
          <p className="text-xs text-slate-500 truncate">@{user.username}</p>
        </div>
        <AccessBadge level={user.access_level} />
        <ChevronDown className={cn("w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ml-1", expanded && "rotate-180")} />
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3">
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">Email</span>
                <span className="text-slate-300 truncate ml-4">{user.email}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">Wiki Role</span>
                <span className="text-slate-300">{user.wiki_role ?? "—"}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">ArgoCD Role</span>
                <span className="text-slate-300">{user.argocd_role || "—"}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {(user.authentik_groups ?? []).map(g => (
                  <span key={g} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">{g}</span>
                ))}
              </div>
              {isAdmin && (
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={onEdit}
                    className="flex-1 min-h-[48px] flex items-center justify-center gap-2 rounded-lg bg-white/5 border border-white/10 text-slate-300 hover:text-white hover:bg-white/10 transition-colors text-sm"
                  >
                    <Pencil className="w-4 h-4" /> Edit
                  </button>
                  <button
                    onClick={onDelete}
                    className="flex-1 min-h-[48px] flex items-center justify-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors text-sm"
                  >
                    <Trash2 className="w-4 h-4" /> Delete
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function UsersPage() {
  const { data, isLoading } = useUsersConfig();
  const saveMutation = useSaveUsersConfig();
  const { isAdmin } = useRBAC();

  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editUser, setEditUser] = useState<PlatformUser | null>(null);
  const [deleteUser, setDeleteUser] = useState<PlatformUser | null>(null);

  const users = data?.users ?? [];
  const filtered = users.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase()) ||
    u.name?.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase())
  );

  const handleSave = async (user: PlatformUser) => {
    let updated: PlatformUser[];
    if (editUser) {
      updated = users.map(u => u.username === editUser.username ? user : u);
    } else {
      updated = [...users, user];
    }
    try {
      await saveMutation.mutateAsync({ users: updated, sha: data?.sha });
      toast.success(editUser ? `Updated ${user.username}` : `Added ${user.username}`);
      setModalOpen(false);
      setEditUser(null);
    } catch {
      toast.error("Failed to save users");
    }
  };

  const handleDelete = async () => {
    if (!deleteUser) return;
    const updated = users.filter(u => u.username !== deleteUser.username);
    try {
      await saveMutation.mutateAsync({ users: updated, sha: data?.sha });
      toast.success(`Deleted ${deleteUser.username}`);
      setDeleteUser(null);
    } catch {
      toast.error("Failed to delete user");
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-400" />
            Users
          </h2>
          <p className="text-sm text-slate-400 mt-0.5">Platform user management</p>
        </div>
        {isAdmin && (
          <button
            onClick={() => { setEditUser(null); setModalOpen(true); }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add User
          </button>
        )}
      </div>

      <div className="relative mb-5 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search users..."
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16" />)}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_1fr_auto_auto_auto] gap-4 px-4 py-2 border-b border-white/5 text-xs text-slate-500 font-medium uppercase tracking-wide">
              <span>User</span>
              <span>Email</span>
              <span>Access Level</span>
              <span>Wiki Role</span>
              <span>Groups</span>
              {isAdmin && <span>Actions</span>}
            </div>
            <AnimatePresence mode="popLayout">
              {filtered.map((user, i) => (
                <motion.div
                  key={user.username}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ delay: i * 0.03 }}
                  className="grid grid-cols-[1fr_1fr_1fr_auto_auto_auto] gap-4 items-center px-4 py-3 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300 flex-shrink-0">
                      {(user.name || user.username)[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">{user.name || user.username}</p>
                      <p className="text-xs text-slate-500 truncate">@{user.username}</p>
                    </div>
                  </div>
                  <span className="text-sm text-slate-400 truncate">{user.email}</span>
                  <AccessBadge level={user.access_level} />
                  <span className="text-xs text-slate-400">{user.wiki_role ?? "—"}</span>
                  <div className="flex flex-wrap gap-1 max-w-[200px]">
                    {(user.authentik_groups ?? []).slice(0, 2).map(g => (
                      <span key={g} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">{g}</span>
                    ))}
                    {(user.authentik_groups ?? []).length > 2 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">+{(user.authentik_groups ?? []).length - 2}</span>
                    )}
                  </div>
                  {isAdmin && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { setEditUser(user); setModalOpen(true); }}
                        className="p-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteUser(user)}
                        className="p-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
            {filtered.length === 0 && (
              <div className="py-12 text-center text-slate-500 text-sm">No users found</div>
            )}
          </div>

          {/* Mobile card view */}
          <div className="md:hidden space-y-3">
            <AnimatePresence mode="popLayout">
              {filtered.map(user => (
                <UserMobileCard
                  key={user.username}
                  user={user}
                  isAdmin={isAdmin}
                  onEdit={() => { setEditUser(user); setModalOpen(true); }}
                  onDelete={() => setDeleteUser(user)}
                />
              ))}
            </AnimatePresence>
            {filtered.length === 0 && (
              <div className="py-12 text-center text-slate-500 text-sm">No users found</div>
            )}
          </div>
        </>
      )}

      <AnimatePresence>
        {modalOpen && (
          <UserFormModal
            open={modalOpen}
            onClose={() => { setModalOpen(false); setEditUser(null); }}
            onSave={handleSave}
            initialUser={editUser ?? defaultUser}
            isNew={!editUser}
          />
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={!!deleteUser}
        onConfirm={handleDelete}
        onCancel={() => setDeleteUser(null)}
        title={`Delete ${deleteUser?.username}?`}
        description="This will remove the user from users.yaml and commit the change to git. This cannot be undone."
        confirmText="Delete User"
        danger
      />
    </div>
  );
}
