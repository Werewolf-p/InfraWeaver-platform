"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, Plus, Pencil, Trash2, Search, Save, X, ChevronDown,
  Shield, Eye, User, CheckCircle2, XCircle, AlertTriangle, ChevronRight,
  Info, Lock, HardDrive, Mail,
} from "lucide-react";
import { UserActionsDropdown } from "@/components/users/user-actions-dropdown";
import { InviteModal } from "@/components/users/invite-modal";
import { toast } from "sonner";
import { useUsersConfig, useSaveUsersConfig, type PlatformUser } from "@/hooks/use-users-config";
import { useRBAC } from "@/hooks/use-rbac";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useSession } from "next-auth/react";
import { StorageTab } from "@/components/users/storage-tab";

const ACCESS_LEVELS = ["admin", "platform-user", "viewer"] as const;
const WIKI_ROLES = ["admin", "editor", "reader"];
const COMMON_GROUPS = ["platform-admins", "platform-operators", "platform-users", "wiki-admins", "wiki-editors"];
const ARGOCD_ROLES = ["role:admin", "role:operator", "role:readonly", ""];

const ROLE_CONFIG = {
  admin: {
    label: "Admin",
    icon: Shield,
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    selectedBorder: "border-red-500/60",
    badgeBg: "bg-red-500/10 border-red-500/20 text-red-400",
    description: "Full cluster access & user management",
    warning: "Admins have full cluster access including destructive operations.",
  },
  "platform-user": {
    label: "User",
    icon: User,
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
    selectedBorder: "border-blue-500/50",
    badgeBg: "bg-blue-500/10 border-blue-500/20 text-blue-400",
    description: "Sync apps, view logs, manage config",
    warning: null,
  },
  viewer: {
    label: "Viewer",
    icon: Eye,
    color: "text-slate-400",
    bg: "bg-slate-500/10",
    border: "border-slate-500/20",
    selectedBorder: "border-slate-500/40",
    badgeBg: "bg-slate-500/10 border-slate-500/20 text-slate-400",
    description: "Read-only access to logs and status",
    warning: null,
  },
} as const;

const PERMISSIONS = [
  { label: "Full cluster access",    admin: true,  user: false, viewer: false },
  { label: "Manage users",           admin: true,  user: false, viewer: false },
  { label: "Delete applications",    admin: true,  user: false, viewer: false },
  { label: "Sync applications",      admin: true,  user: true,  viewer: false },
  { label: "Manage config files",    admin: true,  user: true,  viewer: false },
  { label: "View security reports",  admin: true,  user: true,  viewer: true  },
  { label: "View pod logs",          admin: true,  user: true,  viewer: true  },
  { label: "View cluster nodes",     admin: true,  user: true,  viewer: true  },
  { label: "View network peers",     admin: true,  user: true,  viewer: true  },
  { label: "Browse app registry",    admin: true,  user: true,  viewer: true  },
];

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
  const cfg = ROLE_CONFIG[level as keyof typeof ROLE_CONFIG];
  if (!cfg) return (
    <span className="text-[11px] px-2 py-0.5 rounded-full border font-medium bg-slate-500/10 border-slate-500/20 text-slate-400">
      {level}
    </span>
  );
  return (
    <span className={cn("text-[11px] px-2 py-0.5 rounded-full border font-medium", cfg.badgeBg)}>
      {cfg.label}
    </span>
  );
}

function RoleCard({
  level,
  selected,
  onSelect,
}: {
  level: keyof typeof ROLE_CONFIG;
  selected: boolean;
  onSelect: () => void;
}) {
  const cfg = ROLE_CONFIG[level];
  const Icon = cfg.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative flex-1 min-w-0 p-3 rounded-xl border-2 text-left transition-all",
        cfg.bg,
        selected ? cfg.selectedBorder : cfg.border,
        "hover:border-opacity-60"
      )}
    >
      {selected && (
        <span className="absolute top-2 right-2">
          <CheckCircle2 className={cn("w-4 h-4", cfg.color)} />
        </span>
      )}
      <Icon className={cn("w-5 h-5 mb-1.5", cfg.color)} />
      <p className={cn("text-sm font-semibold", cfg.color)}>{cfg.label}</p>
      <p className="text-[11px] text-slate-500 mt-0.5 leading-tight">{cfg.description}</p>
    </button>
  );
}

function UserFormModal({
  open,
  onClose,
  onSave,
  initialUser,
  isNew,
  currentUsername,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (user: PlatformUser) => Promise<void>;
  initialUser: PlatformUser;
  isNew: boolean;
  currentUsername?: string;
}) {
  const [form, setForm] = useState<PlatformUser>(initialUser);
  const [loading, setLoading] = useState(false);

  // Reset form when initialUser changes
  useState(() => { setForm(initialUser); });

  if (!open) return null;

  const isSelf = !isNew && currentUsername === initialUser.username;
  const selectedLevel = form.access_level as keyof typeof ROLE_CONFIG;
  const roleWarning = ROLE_CONFIG[selectedLevel]?.warning;

  const autoUsername = (name: string) =>
    name.toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "");

  const toggleGroup = (group: string) => {
    const groups = form.authentik_groups ?? [];
    setForm(prev => ({
      ...prev,
      authentik_groups: groups.includes(group) ? groups.filter(g => g !== group) : [...groups, group],
    }));
  };

  const isValid = form.username.trim() && form.email.trim() && form.name.trim();

  const handleSubmit = async () => {
    if (!isValid) return;
    setLoading(true);
    try {
      await onSave(form);
    } finally {
      setLoading(false);
    }
  };

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
          <h2 className="font-semibold text-white">
            {isNew ? "Add User" : `Edit ${initialUser.username}`}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors active:scale-95">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Basic fields */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Full Name *</label>
            <input
              value={form.name}
              onChange={e => {
                const name = e.target.value;
                setForm(prev => ({
                  ...prev,
                  name,
                  username: isNew ? autoUsername(name) : prev.username,
                }));
              }}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-base md:text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
              placeholder="John Doe"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Username *</label>
              <input
                value={form.username}
                onChange={e => setForm(prev => ({ ...prev, username: e.target.value }))}
                disabled={!isNew}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-base md:text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="jdoe"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Email *</label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-base md:text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
                placeholder="jdoe@example.com"
              />
            </div>
          </div>

          {/* Role radio cards */}
          <div>
            <label className="text-xs text-slate-400 mb-2 block font-medium">Role</label>
            {isSelf && (
              <div className="flex items-center gap-2 p-2.5 mb-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400">
                <Lock className="w-3.5 h-3.5 flex-shrink-0" />
                Cannot change your own role to prevent self-lockout
              </div>
            )}
            <div className="flex gap-2">
              {ACCESS_LEVELS.map(level => (
                <RoleCard
                  key={level}
                  level={level}
                  selected={form.access_level === level}
                  onSelect={() => !isSelf && setForm(prev => ({ ...prev, access_level: level }))}
                />
              ))}
            </div>
            {roleWarning && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="flex items-start gap-2 mt-2 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400"
              >
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                {roleWarning}
              </motion.div>
            )}
          </div>

          {/* Additional fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                    "px-2.5 py-1 rounded-full text-xs border transition-colors active:scale-95",
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

        <div className="flex flex-col-reverse sm:flex-row gap-3 p-5 border-t border-white/5 sm:justify-end">
          <button
            onClick={onClose}
            className="w-full sm:w-auto px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors active:scale-95 touch-manipulation"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid || loading}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50 active:scale-95 touch-manipulation"
          >
            {loading ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full"
              />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {isNew ? "Add User" : "Save Changes"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function DeleteConfirmModal({
  user,
  onConfirm,
  onCancel,
}: {
  user: PlatformUser;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const matches = input === user.username;

  const handleConfirm = async () => {
    if (!matches) return;
    setLoading(true);
    try { await onConfirm(); } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="relative w-full max-w-md bg-slate-900 border border-red-500/20 rounded-2xl shadow-2xl z-10 p-6"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
            <Trash2 className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h2 className="font-semibold text-white">Delete User</h2>
            <p className="text-xs text-slate-500">This action cannot be undone</p>
          </div>
        </div>
        <p className="text-sm text-slate-400 mb-4">
          This will permanently remove <span className="text-white font-medium">@{user.username}</span> from the platform.
          Type the username to confirm:
        </p>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={user.username}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-red-500/50 mb-4 font-mono"
        />
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors active:scale-95"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!matches || loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-sm text-red-300 hover:bg-red-500/30 transition-colors disabled:opacity-40 active:scale-95"
          >
            {loading ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full"
              />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            Delete User
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function PermissionMatrix() {
  return (
    <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
      <div className="grid grid-cols-[1fr_repeat(3,_80px)] px-4 py-2.5 border-b border-white/5 bg-white/[0.02]">
        <span className="text-xs text-slate-500 font-medium">Permission</span>
        {(["admin", "platform-user", "viewer"] as const).map(level => {
          const cfg = ROLE_CONFIG[level];
          return (
            <span key={level} className={cn("text-xs font-semibold text-center", cfg.color)}>
              {cfg.label}
            </span>
          );
        })}
      </div>
      {PERMISSIONS.map((perm, i) => (
        <div
          key={perm.label}
          className={cn(
            "grid grid-cols-[1fr_repeat(3,_80px)] px-4 py-2.5 items-center",
            i % 2 === 0 ? "" : "bg-white/[0.02]",
            "border-b border-white/5 last:border-0"
          )}
        >
          <span className="text-xs text-slate-400">{perm.label}</span>
          {[perm.admin, perm.user, perm.viewer].map((allowed, j) => (
            <div key={j} className="flex justify-center">
              {allowed ? (
                <CheckCircle2 className="w-4 h-4 text-green-400" />
              ) : (
                <XCircle className="w-4 h-4 text-slate-700" />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RBACInfoCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-medium text-white">What can each role do?</span>
        </div>
        <ChevronRight className={cn("w-4 h-4 text-slate-400 transition-transform", open && "rotate-90")} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-white/5"
          >
            <div className="px-4 py-4 grid sm:grid-cols-3 gap-4">
              {(["admin", "platform-user", "viewer"] as const).map(level => {
                const cfg = ROLE_CONFIG[level];
                const Icon = cfg.icon;
                return (
                  <div key={level} className={cn("rounded-lg border p-3", cfg.bg, cfg.border)}>
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className={cn("w-4 h-4", cfg.color)} />
                      <span className={cn("text-sm font-semibold", cfg.color)}>{cfg.label}</span>
                    </div>
                    <p className="text-xs text-slate-500 leading-relaxed">{cfg.description}</p>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function UserMobileCard({ user, isAdmin, isSelf, onEdit, onDelete, actionsDropdown }: {
  user: PlatformUser;
  isAdmin: boolean;
  isSelf: boolean;
  onEdit: () => void;
  onDelete: () => void;
  actionsDropdown?: React.ReactNode;
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
        className="w-full flex items-center gap-3 px-4 py-4 text-left min-h-[64px] touch-manipulation active:opacity-70 transition-opacity"
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
                  <span key={g} className="text-xs px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">{g}</span>
                ))}
              </div>
              {isAdmin && (
                <div className="flex gap-2 pt-1">
                  {actionsDropdown ? actionsDropdown : (
                    <>
                      <button
                        onClick={onEdit}
                        className="flex-1 min-h-[48px] flex items-center justify-center gap-2 rounded-lg bg-white/5 border border-white/10 text-slate-300 hover:text-white hover:bg-white/10 transition-colors text-sm active:scale-95"
                      >
                        <Pencil className="w-4 h-4" /> Edit
                      </button>
                      <button
                        onClick={onDelete}
                        disabled={isSelf}
                        className="flex-1 min-h-[48px] flex items-center justify-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors text-sm disabled:opacity-40 active:scale-95"
                      >
                        <Trash2 className="w-4 h-4" /> Delete
                      </button>
                    </>
                  )}
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
  const { data: session } = useSession();

  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editUser, setEditUser] = useState<PlatformUser | null>(null);
  const [deleteUser, setDeleteUser] = useState<PlatformUser | null>(null);
  const [activeTab, setActiveTab] = useState<"users" | "storage">("users");
  const [inviteOpen, setInviteOpen] = useState(false);

  const currentEmail = session?.user?.email ?? "";
  const users = data?.users ?? [];

  const selfUser = users.find(u => u.email === currentEmail);
  const currentUsername = selfUser?.username;

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
      if (users.find(u => u.username === user.username)) {
        toast.error(`Username @${user.username} already exists`);
        return;
      }
      if (users.find(u => u.email === user.email)) {
        toast.error(`Email ${user.email} already in use`);
        return;
      }
      updated = [...users, user];
    }
    try {
      await saveMutation.mutateAsync({ users: updated, sha: data?.sha });
      toast.success(editUser ? `Updated @${user.username}` : `Added @${user.username}`);
      setModalOpen(false);
      setEditUser(null);
    } catch {
      toast.error("Failed to save users");
    }
  };

  const handleDelete = async () => {
    if (!deleteUser) return;
    if (deleteUser.username === currentUsername) {
      toast.error("Cannot delete your own account");
      return;
    }
    const admins = users.filter(u => u.access_level === "admin");
    if (deleteUser.access_level === "admin" && admins.length <= 1) {
      toast.error("Cannot delete the last admin account");
      return;
    }
    const updated = users.filter(u => u.username !== deleteUser.username);
    try {
      await saveMutation.mutateAsync({ users: updated, sha: data?.sha });
      toast.success(`Deleted @${deleteUser.username}`);
      setDeleteUser(null);
    } catch {
      toast.error("Failed to delete user");
    }
  };

  return (
    <div className="space-y-6">
      {/* Page header with gradient */}
      <div className="relative rounded-xl overflow-hidden">
        <div className="absolute inset-0 page-gradient-users pointer-events-none" />
        <div className="relative flex items-center justify-between p-5">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Users className="w-5 h-5 text-purple-400" />
              User Management
            </h2>
            <p className="text-sm text-slate-400 mt-0.5">
              {users.length} user{users.length !== 1 ? "s" : ""} · RBAC-managed platform access
            </p>
          </div>
          {isAdmin && activeTab === "users" && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setInviteOpen(true)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors active:scale-95 touch-manipulation"
              >
                <Mail className="w-4 h-4" />
                Invite
              </button>
              <button
                onClick={() => { setEditUser(null); setModalOpen(true); }}
                className="flex items-center justify-center gap-2 w-full sm:w-auto px-3 py-2.5 rounded-lg bg-purple-500/20 border border-purple-500/30 text-sm text-purple-300 hover:bg-purple-500/30 transition-colors active:scale-95 touch-manipulation"
              >
                <Plus className="w-4 h-4" />
                Add User
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-white/5 border border-white/10 rounded-lg p-1 w-fit">
        <button
          onClick={() => setActiveTab("users")}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all",
            activeTab === "users"
              ? "bg-white/10 text-white"
              : "text-slate-400 hover:text-white"
          )}
        >
          <Users className="w-4 h-4" />
          Users
        </button>
        <button
          onClick={() => setActiveTab("storage")}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all",
            activeTab === "storage"
              ? "bg-white/10 text-white"
              : "text-slate-400 hover:text-white"
          )}
        >
          <HardDrive className="w-4 h-4" />
          Storage Access
        </button>
      </div>

      {activeTab === "storage" && (
        <StorageTab users={users} isAdmin={isAdmin} />
      )}

      {activeTab === "users" && (
        <>
      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search users..."
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2.5 text-base md:text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
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
            <div className="grid grid-cols-[1fr_1fr_1fr_auto_auto_auto] gap-4 px-4 py-2.5 border-b border-white/5 sticky-header">
              <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">User</span>
              <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Email</span>
              <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Role</span>
              <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Wiki</span>
              <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Groups</span>
              {isAdmin && <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Actions</span>}
            </div>
            <AnimatePresence mode="popLayout">
              {filtered.map((user, i) => {
                const isSelf = user.email === currentEmail || user.username === currentUsername;
                return (
                  <motion.div
                    key={user.username}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ delay: i * 0.03 }}
                    className="grid grid-cols-[1fr_1fr_1fr_auto_auto_auto] gap-4 items-center px-4 py-3 border-b border-white/5 last:border-0 hover:bg-white/[0.03] transition-colors min-h-[56px]"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300 flex-shrink-0">
                        {(user.name || user.username)[0]?.toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate flex items-center gap-1.5">
                          {user.name || user.username}
                          {isSelf && <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">you</span>}
                        </p>
                        <p className="text-xs text-slate-500 truncate">@{user.username}</p>
                      </div>
                    </div>
                    <span className="text-sm text-slate-400 truncate">{user.email}</span>
                    <AccessBadge level={user.access_level} />
                    <span className="text-xs text-slate-400">{user.wiki_role ?? "—"}</span>
                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                      {(user.authentik_groups ?? []).slice(0, 2).map(g => (
                        <span key={g} className="text-xs px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">{g}</span>
                      ))}
                      {(user.authentik_groups ?? []).length > 2 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">+{(user.authentik_groups ?? []).length - 2}</span>
                      )}
                    </div>
                    {isAdmin && (
                      <div className="flex items-center gap-2">
                        <UserActionsDropdown
                          user={user}
                          isSelf={isSelf}
                          isAdmin={isAdmin}
                          onEdit={() => { setEditUser(user); setModalOpen(true); }}
                          onDelete={() => setDeleteUser(user)}
                          onRefetch={() => { /* react-query will refetch */ }}
                        />
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {filtered.length === 0 && (
              <div className="py-12 text-center text-slate-500 text-sm">No users found</div>
            )}
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            <AnimatePresence mode="popLayout">
              {filtered.map(user => (
                <UserMobileCard
                  key={user.username}
                  user={user}
                  isAdmin={isAdmin}
                  isSelf={user.email === currentEmail || user.username === currentUsername}
                  onEdit={() => { setEditUser(user); setModalOpen(true); }}
                  onDelete={() => setDeleteUser(user)}
                  actionsDropdown={
                    <UserActionsDropdown
                      user={user}
                      isSelf={user.email === currentEmail || user.username === currentUsername}
                      isAdmin={isAdmin}
                      onEdit={() => { setEditUser(user); setModalOpen(true); }}
                      onDelete={() => setDeleteUser(user)}
                      onRefetch={() => { /* react-query will refetch */ }}
                    />
                  }
                />
              ))}
            </AnimatePresence>
            {filtered.length === 0 && (
              <div className="py-12 text-center text-slate-500 text-sm">No users found</div>
            )}
          </div>
        </>
      )}

      {/* Permission Matrix */}
      <div>
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4 text-purple-400" />
          Role Permission Matrix
        </h3>
        <PermissionMatrix />
      </div>

      {/* RBAC info card */}
      <RBACInfoCard />
        </>
      )}

      {/* Modals */}
      <AnimatePresence>
        {modalOpen && (
          <UserFormModal
            open={modalOpen}
            onClose={() => { setModalOpen(false); setEditUser(null); }}
            onSave={handleSave}
            initialUser={editUser ?? defaultUser}
            isNew={!editUser}
            currentUsername={currentUsername}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteUser && (
          <DeleteConfirmModal
            user={deleteUser}
            onConfirm={handleDelete}
            onCancel={() => setDeleteUser(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {inviteOpen && <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}
