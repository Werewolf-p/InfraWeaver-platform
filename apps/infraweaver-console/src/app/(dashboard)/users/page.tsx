"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Users, Plus, Pencil, Trash2, Search, Save, X, Shield, Mail, Tag, ChevronDown, ChevronUp } from "lucide-react";
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

const inputClass = "w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 transition-colors";
const selectClass = "w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500/50 transition-colors";

function UserFormModal({ open, onClose, onSave, initialUser, isNew }: {
  open: boolean; onClose: () => void; onSave: (u: PlatformUser) => void;
  initialUser: PlatformUser; isNew: boolean;
}) {
  const [form, setForm] = useState<PlatformUser>(initialUser);
  if (!open) return null;

  const toggleGroup = (g: string) => {
    const gs = form.authentik_groups ?? [];
    setForm(p => ({ ...p, authentik_groups: gs.includes(g) ? gs.filter(x => x !== g) : [...gs, g] }));
  };
  const isValid = form.username.trim() && form.email.trim() && form.name.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: 60 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 60 }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
        className="relative w-full sm:max-w-lg bg-slate-900 border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl z-10 overflow-y-auto max-h-[92dvh]"
      >
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div>
            <h2 className="font-semibold text-white">{isNew ? "Add User" : `Edit ${initialUser.username}`}</h2>
            <p className="text-xs text-slate-500 mt-0.5">{isNew ? "Create a new platform user" : "Update user settings"}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-slate-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Username *</label>
              <input value={form.username} onChange={e => setForm(p => ({ ...p, username: e.target.value }))}
                disabled={!isNew} className={cn(inputClass, !isNew && "opacity-50")} placeholder="jdoe" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Full Name *</label>
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className={inputClass} placeholder="John Doe" />
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1.5 block">Email *</label>
            <input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
              className={inputClass} placeholder="jdoe@example.com" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Access Level</label>
              <select value={form.access_level} onChange={e => setForm(p => ({ ...p, access_level: e.target.value }))} className={selectClass}>
                {ACCESS_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Wiki Role</label>
              <select value={form.wiki_role ?? "reader"} onChange={e => setForm(p => ({ ...p, wiki_role: e.target.value }))} className={selectClass}>
                {WIKI_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">ArgoCD Role</label>
              <select value={form.argocd_role ?? ""} onChange={e => setForm(p => ({ ...p, argocd_role: e.target.value }))} className={selectClass}>
                {ARGOCD_ROLES.map(r => <option key={r} value={r}>{r || "(none)"}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-2 block">Authentik Groups</label>
            <div className="flex flex-wrap gap-2">
              {COMMON_GROUPS.map(g => (
                <button key={g} type="button" onClick={() => toggleGroup(g)}
                  className={cn("px-2.5 py-1.5 rounded-full text-xs border transition-all",
                    (form.authentik_groups ?? []).includes(g)
                      ? "bg-indigo-500/20 border-indigo-500/40 text-indigo-300"
                      : "bg-white/5 border-white/10 text-slate-400 hover:text-white")}>
                  {g}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-3 p-5 border-t border-white/5">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors">
            Cancel
          </button>
          <button onClick={() => isValid && onSave(form)} disabled={!isValid}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50">
            <Save className="w-4 h-4" />{isNew ? "Add User" : "Save Changes"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function UserCard({ user, onEdit, onDelete, isAdmin }: {
  user: PlatformUser; onEdit: () => void; onDelete: () => void; isAdmin: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -20 }}
      className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <div className="w-10 h-10 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-sm font-bold text-indigo-300 flex-shrink-0">
          {(user.name || user.username)[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{user.name || user.username}</p>
          <p className="text-xs text-slate-500 truncate">@{user.username}</p>
        </div>
        <AccessBadge level={user.access_level} />
        <button onClick={() => setExpanded(v => !v)}
          className="w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center text-slate-400 hover:text-white transition-colors flex-shrink-0">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden border-t border-white/5">
            <div className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{user.email}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                <div className="flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>ArgoCD: <span className="text-slate-300">{user.argocd_role || "—"}</span></span>
                </div>
                <span>Wiki: <span className="text-slate-300">{user.wiki_role || "—"}</span></span>
              </div>
              {(user.authentik_groups ?? []).length > 0 && (
                <div className="flex items-start gap-2 text-xs text-slate-400">
                  <Tag className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <div className="flex flex-wrap gap-1">
                    {(user.authentik_groups ?? []).map(g => (
                      <span key={g} className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">{g}</span>
                    ))}
                  </div>
                </div>
              )}
              {isAdmin && (
                <div className="flex gap-2 pt-1">
                  <button onClick={onEdit}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors">
                    <Pencil className="w-3.5 h-3.5" />Edit
                  </button>
                  <button onClick={onDelete}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400 hover:bg-red-500/20 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />Delete
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

function UserTableRow({ user, onEdit, onDelete, index }: {
  user: PlatformUser; onEdit: () => void; onDelete: () => void; index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -20 }}
      transition={{ delay: index * 0.03 }}
      className="grid grid-cols-[2fr_2fr_auto_auto_auto_auto] gap-3 items-center px-4 py-3 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors">
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
      <span className="text-xs text-slate-400 whitespace-nowrap">{user.wiki_role ?? "—"}</span>
      <div className="flex flex-wrap gap-1 max-w-[160px]">
        {(user.authentik_groups ?? []).slice(0, 2).map(g => (
          <span key={g} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">{g}</span>
        ))}
        {(user.authentik_groups ?? []).length > 2 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">+{(user.authentik_groups ?? []).length - 2}</span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <button onClick={onEdit} title="Edit" className="p-2 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button onClick={onDelete} title="Delete" className="p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
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
    (u.name ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (u.email ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const handleSave = async (user: PlatformUser) => {
    const updated = editUser ? users.map(u => u.username === editUser.username ? user : u) : [...users, user];
    try {
      await saveMutation.mutateAsync({ users: updated, sha: data?.sha });
      toast.success(editUser ? `Updated ${user.username}` : `Added ${user.username}`);
      setModalOpen(false); setEditUser(null);
    } catch { toast.error("Failed to save users"); }
  };

  const handleDelete = async () => {
    if (!deleteUser) return;
    try {
      await saveMutation.mutateAsync({ users: users.filter(u => u.username !== deleteUser.username), sha: data?.sha });
      toast.success(`Deleted ${deleteUser.username}`); setDeleteUser(null);
    } catch { toast.error("Failed to delete user"); }
  };

  const openEdit = (user: PlatformUser) => { setEditUser(user); setModalOpen(true); };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-400" />Users
          </h2>
          <p className="text-sm text-slate-400 mt-0.5">{users.length} platform {users.length === 1 ? "user" : "users"}</p>
        </div>
        {isAdmin && (
          <motion.button whileTap={{ scale: 0.95 }}
            onClick={() => { setEditUser(null); setModalOpen(true); }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors">
            <Plus className="w-4 h-4" /><span className="hidden sm:inline">Add User</span><span className="sm:hidden">Add</span>
          </motion.button>
        )}
      </div>

      <div className="relative mb-5">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, username, or email…"
          className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-10 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 transition-colors" />
        {search && (
          <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-500">
          <Users className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">{search ? "No users match your search" : "No users found"}</p>
        </div>
      ) : (
        <>
          <div className="md:hidden space-y-3">
            <AnimatePresence mode="popLayout">
              {filtered.map(user => (
                <UserCard key={user.username} user={user} onEdit={() => openEdit(user)} onDelete={() => setDeleteUser(user)} isAdmin={isAdmin} />
              ))}
            </AnimatePresence>
          </div>
          <div className="hidden md:block bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl overflow-hidden">
            <div className="grid grid-cols-[2fr_2fr_auto_auto_auto_auto] gap-3 px-4 py-2.5 border-b border-white/5 text-xs text-slate-500 font-semibold uppercase tracking-wider">
              <span>User</span><span>Email</span><span>Level</span><span>Wiki</span><span>Groups</span><span>Actions</span>
            </div>
            <AnimatePresence mode="popLayout">
              {filtered.map((user, i) => (
                <UserTableRow key={user.username} user={user} index={i} onEdit={() => openEdit(user)} onDelete={() => setDeleteUser(user)} />
              ))}
            </AnimatePresence>
          </div>
        </>
      )}

      <AnimatePresence>
        {modalOpen && (
          <UserFormModal open={modalOpen} onClose={() => { setModalOpen(false); setEditUser(null); }}
            onSave={handleSave} initialUser={editUser ?? defaultUser} isNew={!editUser} />
        )}
      </AnimatePresence>

      <ConfirmDialog open={!!deleteUser} onConfirm={handleDelete} onCancel={() => setDeleteUser(null)}
        title={`Delete ${deleteUser?.username}?`}
        description="This removes the user from users.yaml and commits to git. This cannot be undone."
        confirmText="Delete User" danger />
    </div>
  );
}
