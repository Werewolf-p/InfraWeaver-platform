"use client";
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, Plus, Pencil, Trash2, Save, ChevronDown,
  Shield, Eye, User, CheckCircle2, XCircle, AlertTriangle, ChevronRight,
  Info, Lock, HardDrive, Mail, Zap,
} from "lucide-react";
import { UserActionsDropdown } from "@/components/users/user-actions-dropdown";
import { InviteModal } from "@/components/users/invite-modal";
import { toast } from "@/lib/notify";
import { useUsersConfig, useSaveUsersConfig, type PlatformUser } from "@/hooks/use-users-config";
import { useRBAC } from "@/hooks/use-rbac";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { CopyButton } from "@/components/ui/copy-button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SearchInput } from "@/components/ui/search-input";
import { HorizontalScrollHint } from "@/components/ui/horizontal-scroll-hint";
import { cn } from "@/lib/utils";
import { useSession } from "next-auth/react";
import { StorageTab } from "@/components/users/storage-tab";
import { RoleAssignmentsPanel } from "@/components/users/role-assignments-panel";
import { useSimpleMode } from "@/contexts/simple-mode-context";

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
    color: "text-slate-500 dark:text-slate-400",
    bg: "bg-slate-500/10",
    border: "border-slate-500/20",
    selectedBorder: "border-slate-500/40",
    badgeBg: "bg-slate-500/10 border-slate-500/20 text-slate-500 dark:text-slate-400",
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
    <span className="rounded-full border border-slate-500/20 bg-slate-500/10 px-2.5 py-1 text-xs font-medium text-slate-500 dark:text-slate-400 sm:text-[11px]">
      {level}
    </span>
  );
  return (
    <span className={cn("rounded-full border px-2.5 py-1 text-xs font-medium sm:text-[11px]", cfg.badgeBg)}>
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
        "relative flex min-h-[124px] flex-1 min-w-0 rounded-2xl border-2 p-4 text-left transition-all",
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
      <p className="mt-1 text-sm leading-tight text-slate-500 dark:text-slate-400">{cfg.description}</p>
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
  simpleMode,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (user: PlatformUser) => Promise<void>;
  initialUser: PlatformUser;
  isNew: boolean;
  currentUsername?: string;
  simpleMode: boolean;
}) {
  const [form, setForm] = useState<PlatformUser>(initialUser);
  const [loading, setLoading] = useState(false);

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

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
  const usernameValid = /^[a-z0-9.\-]{3,32}$/.test(form.username.trim());
  const isValid = form.username.trim() && form.email.trim() && form.name.trim() && emailValid && usernameValid;

  const handleSubmit = async () => {
    if (!isValid) return;
    setLoading(true);
    try {
      let submitForm = form;
      if (simpleMode) {
        // Apply defaults based on access_level
        const levelDefaults: Record<string, { wiki_role: string; argocd_role: string; authentik_groups: string[] }> = {
          admin: { wiki_role: "admin", argocd_role: "role:admin", authentik_groups: ["platform-admins", "platform-users"] },
          "platform-user": { wiki_role: "editor", argocd_role: "role:operator", authentik_groups: ["platform-users"] },
          viewer: { wiki_role: "reader", argocd_role: "role:readonly", authentik_groups: ["platform-users"] },
        };
        const defaults = levelDefaults[form.access_level] ?? levelDefaults["viewer"];
        submitForm = { ...form, ...defaults };
      }
      await onSave(submitForm);
    } finally {
      setLoading(false);
    }
  };

  const formId = isNew ? "user-form-new" : `user-form-${initialUser.username}`;

  return (
    <ResponsiveSheet
      open={open}
      onClose={onClose}
      size="lg"
      title={isNew ? "Add User" : `Edit ${initialUser.username}`}
      description="Large tap targets, helper text under every field, and a swipe-to-dismiss mobile editor."
      footer={
        <div className="grid grid-cols-1 gap-3 sm:flex sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[48px] items-center justify-center rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 text-sm font-medium text-slate-700 dark:text-slate-300 transition-colors hover:text-gray-900 dark:hover:text-white"
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            disabled={!isValid || loading}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-indigo-500/30 bg-indigo-500/20 px-4 text-sm font-semibold text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {loading ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                className="h-4 w-4 rounded-full border-2 border-indigo-400 border-t-transparent"
              />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {isNew ? "Add User" : "Save Changes"}
          </button>
        </div>
      }
    >
      <form
        id={formId}
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Full Name *</label>
          <input
            autoFocus
            value={form.name}
            onChange={e => {
              const name = e.target.value;
              setForm(prev => ({
                ...prev,
                name,
                username: isNew ? autoUsername(name) : prev.username,
              }));
            }}
            className="w-full rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-3 text-base text-gray-900 dark:text-white placeholder-slate-500 focus:border-indigo-500/50 focus:outline-none"
            placeholder="John Doe"
          />
          <p className="mt-2 text-sm text-slate-500">Shown in approvals, activity history, and role assignments.</p>
          {!form.name.trim() && <p className="mt-2 text-sm text-red-300">Full name is required.</p>}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Username *</label>
            <input
              value={form.username}
              onChange={e => setForm(prev => ({ ...prev, username: e.target.value }))}
              disabled={!isNew}
              className="w-full rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-3 text-base text-gray-900 dark:text-white placeholder-slate-500 focus:border-indigo-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="jdoe"
            />
            <p className="mt-2 text-sm text-slate-500">Auto-generated for new users. Keep it short for CLI and audit logs.</p>
            {!usernameValid && <p className="mt-2 text-sm text-red-300">Use 3-32 lowercase letters, numbers, dots, or dashes.</p>}
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Email *</label>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
              className="w-full rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-3 text-base text-gray-900 dark:text-white placeholder-slate-500 focus:border-indigo-500/50 focus:outline-none"
              placeholder="jdoe@example.com"
            />
            <p className="mt-2 text-sm text-slate-500">Used for login, invites, password resets, and MFA recovery.</p>
            {form.email.trim() && !emailValid && <p className="mt-2 text-sm text-red-300">Enter a valid email address.</p>}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Role</label>
          {isSelf && (
            <div className="mb-3 flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-300">
              <Lock className="h-4 w-4 flex-shrink-0" />
              Cannot change your own role to prevent self-lockout.
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
              className="mt-3 flex items-start gap-2 rounded-2xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              {roleWarning}
            </motion.div>
          )}
        </div>

        {simpleMode && (
          <div className="flex items-center gap-2 rounded-2xl border border-indigo-500/20 bg-indigo-500/10 p-3 text-sm text-indigo-300">
            <Zap className="h-4 w-4 flex-shrink-0" />
            Simple mode hides advanced fields and auto-fills wiki, ArgoCD, and group defaults.
          </div>
        )}

        {!simpleMode && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Wiki Role</label>
              <select
                value={form.wiki_role ?? "reader"}
                onChange={e => setForm(prev => ({ ...prev, wiki_role: e.target.value }))}
                className="w-full rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-800 px-4 py-3 text-base text-gray-900 dark:text-white focus:border-indigo-500/50 focus:outline-none"
              >
                {WIKI_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <p className="mt-2 text-sm text-slate-500">Controls wiki editing, publishing, and admin access.</p>
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">ArgoCD Role</label>
              <select
                value={form.argocd_role ?? ""}
                onChange={e => setForm(prev => ({ ...prev, argocd_role: e.target.value }))}
                className="w-full rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-800 px-4 py-3 text-base text-gray-900 dark:text-white focus:border-indigo-500/50 focus:outline-none"
              >
                {ARGOCD_ROLES.map(r => <option key={r} value={r}>{r || "(none)"}</option>)}
              </select>
              <p className="mt-2 text-sm text-slate-500">Maps app sync and deployment privileges in ArgoCD.</p>
            </div>
          </div>
        )}

        {!simpleMode && (
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Authentik Groups</label>
            <p className="mb-3 text-sm text-slate-500">Groups control SSO defaults and operator access across the console.</p>
            <div className="flex flex-wrap gap-2">
              {COMMON_GROUPS.map(g => (
                <button
                  key={g}
                  type="button"
                  onClick={() => toggleGroup(g)}
                  className={cn(
                    "min-h-[44px] rounded-full border px-4 py-2 text-sm transition-colors active:scale-95",
                    (form.authentik_groups ?? []).includes(g)
                      ? "border-indigo-500/30 bg-indigo-500/20 text-indigo-300"
                      : "border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
                  )}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </ResponsiveSheet>
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
    <ResponsiveSheet
      open
      onClose={onCancel}
      size="sm"
      title="Delete User"
      description="This action cannot be undone. Type the username below to confirm removal."
      footer={
        <div className="grid grid-cols-1 gap-3 sm:flex sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-[48px] items-center justify-center rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 text-sm font-medium text-slate-700 dark:text-slate-300 transition-colors hover:text-gray-900 dark:hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!matches || loading}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-red-500/30 bg-red-500/20 px-4 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/30 disabled:opacity-40"
          >
            {loading ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                className="h-4 w-4 rounded-full border-2 border-red-400 border-t-transparent"
              />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Delete User
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-100">
          This will permanently remove <span className="font-semibold">@{user.username}</span> from the platform, revoke related access, and remove their saved assignments.
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Confirm username</label>
          <input
            autoFocus
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={user.username}
            onKeyDown={(event) => { if (event.key === "Enter" && matches) void handleConfirm(); }}
            className="w-full rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-3 font-mono text-base text-gray-900 dark:text-white placeholder-slate-500 focus:border-red-500/50 focus:outline-none"
          />
          <p className="mt-2 text-sm text-slate-500">Enter <span className="font-mono text-slate-700 dark:text-slate-300">{user.username}</span> exactly to unlock the delete button.</p>
        </div>
      </div>
    </ResponsiveSheet>
  );
}

function PermissionMatrix() {
  return (
    <div className="bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
      <div className="grid grid-cols-[1fr_repeat(3,_80px)] px-4 py-2.5 border-b border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-white/[0.02]">
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
            i % 2 === 0 ? "" : "bg-gray-50 dark:bg-white/[0.02]",
            "border-b border-gray-200 dark:border-white/5 last:border-0"
          )}
        >
          <span className="text-xs text-slate-500 dark:text-slate-400">{perm.label}</span>
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
    <div className="bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-medium text-gray-900 dark:text-white">What can each role do?</span>
        </div>
        <ChevronRight className={cn("w-4 h-4 text-slate-500 dark:text-slate-400 transition-transform", open && "rotate-90")} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-gray-200 dark:border-white/5"
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
      className="bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden"
    >
      <button
        className="w-full flex items-center gap-3 px-4 py-4 text-left min-h-[64px] touch-manipulation active:opacity-70 transition-opacity"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="w-9 h-9 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300 flex-shrink-0">
          {(user.name || user.username)[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{user.name || user.username}</p>
          <p className="text-xs text-slate-500 truncate">@{user.username}</p>
        </div>
        <AccessBadge level={user.access_level} />
        <ChevronDown className={cn("w-4 h-4 text-slate-500 dark:text-slate-400 flex-shrink-0 transition-transform ml-1", expanded && "rotate-180")} />
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-3 border-t border-gray-200 dark:border-white/5 pt-3">
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">Email</span>
                <span className="text-slate-700 dark:text-slate-300 truncate ml-4">{user.email}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">Wiki Role</span>
                <span className="text-slate-700 dark:text-slate-300">{user.wiki_role ?? "—"}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">ArgoCD Role</span>
                <span className="text-slate-700 dark:text-slate-300">{user.argocd_role || "—"}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {(user.authentik_groups ?? []).map(g => (
                  <span key={g} className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-slate-500 dark:text-slate-400">{g}</span>
                ))}
              </div>
              {isAdmin && (
                <div className="flex gap-2 pt-1">
                  {actionsDropdown ? actionsDropdown : (
                    <>
                      <button
                        onClick={onEdit}
                        className="flex-1 min-h-[48px] flex items-center justify-center gap-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-slate-700 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/10 transition-colors text-sm active:scale-95"
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
  const { simpleMode, toggle: toggleSimpleMode } = useSimpleMode();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "username" | "role">("name");
  const [modalOpen, setModalOpen] = useState(false);
  const [editUser, setEditUser] = useState<PlatformUser | null>(null);
  const [deleteUser, setDeleteUser] = useState<PlatformUser | null>(null);
  const [selectedUsername, setSelectedUsername] = useState("");
  const [activeTab, setActiveTab] = useState<"users" | "storage">("users");
  const [inviteOpen, setInviteOpen] = useState(false);

  const currentEmail = session?.user?.email ?? "";
  const users = useMemo(() => data?.users ?? [], [data?.users]);

  const selfUser = users.find(u => u.email === currentEmail);
  const currentUsername = selfUser?.username;
  const roleCounts = useMemo(() => ({
    total: users.length,
    admin: users.filter((user) => user.access_level === "admin").length,
    platformUser: users.filter((user) => user.access_level === "platform-user").length,
    viewer: users.filter((user) => user.access_level === "viewer").length,
  }), [users]);

  useEffect(() => {
    const handleFabInvite = () => {
      setActiveTab("users");
      setInviteOpen(true);
    };

    window.addEventListener("fab:users:invite", handleFabInvite);
    return () => window.removeEventListener("fab:users:invite", handleFabInvite);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const filtered = useMemo(() => {
    const results = users.filter(u =>
      !debouncedSearch ||
      u.username.toLowerCase().includes(debouncedSearch) ||
      u.name?.toLowerCase().includes(debouncedSearch) ||
      u.email?.toLowerCase().includes(debouncedSearch)
    );
    return [...results].sort((a, b) => {
      if (sortBy === "role") return a.access_level.localeCompare(b.access_level);
      if (sortBy === "username") return a.username.localeCompare(b.username);
      return (a.name || a.username).localeCompare(b.name || b.username);
    });
  }, [debouncedSearch, sortBy, users]);

  const selectedUser = filtered.find(user => user.username === selectedUsername) ?? filtered[0] ?? null;

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
      <PageHeader icon={Users} title="Users" subtitle="User management and access control" />
      {/* Page header with gradient */}
      <div className="relative rounded-xl overflow-hidden">
        <div className="absolute inset-0 page-gradient-users pointer-events-none" />
        <div className="relative flex items-center justify-between p-5">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Users className="w-5 h-5 text-purple-400" />
              User Management
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              {users.length} user{users.length !== 1 ? "s" : ""} · RBAC-managed platform access
            </p>
          </div>
          {isAdmin && activeTab === "users" && (
            <div className="flex items-center gap-2">
              <button
                onClick={toggleSimpleMode}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-colors",
                  simpleMode
                    ? "bg-indigo-500/20 border-indigo-500/30 text-indigo-300"
                    : "bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
                )}
              >
                <Zap className="w-3.5 h-3.5" />
                {simpleMode ? "Simple" : "Advanced"}
              </button>
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

      <HorizontalScrollHint className="-mx-1" contentClassName="px-1" hint="Swipe tabs">
        <div className="flex w-max gap-2 rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-1">
          <button
            onClick={() => setActiveTab("users")}
            className={cn(
              "inline-flex min-h-[44px] items-center gap-2 rounded-2xl px-4 text-sm font-medium transition-all",
              activeTab === "users"
                ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white"
                : "text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            <Users className="h-4 w-4" />
            Users
          </button>
          <button
            onClick={() => setActiveTab("storage")}
            className={cn(
              "inline-flex min-h-[44px] items-center gap-2 rounded-2xl px-4 text-sm font-medium transition-all",
              activeTab === "storage"
                ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white"
                : "text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            <HardDrive className="h-4 w-4" />
            Storage Access
          </button>
        </div>
      </HorizontalScrollHint>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Total users", value: roleCounts.total, accent: "text-gray-900 dark:text-white" },
          { label: "Admins", value: roleCounts.admin, accent: "text-red-300" },
          { label: "Platform users", value: roleCounts.platformUser, accent: "text-blue-300" },
          { label: "Viewers", value: roleCounts.viewer, accent: "text-slate-700 dark:text-slate-300" },
        ].map((item) => (
          <div key={item.label} className="rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-4">
            <p className="text-sm text-slate-500 dark:text-slate-400">{item.label}</p>
            <p className={cn("mt-1 text-2xl font-semibold", item.accent)}>{item.value}</p>
          </div>
        ))}
      </div>

      {activeTab === "storage" && (
        <StorageTab users={users} isAdmin={isAdmin} />
      )}

      {activeTab === "users" && (
        <>
      <div className="space-y-3 rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-3 sm:border-0 sm:bg-transparent sm:p-0">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 max-w-full sm:max-w-sm">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search users by name, username, or email"
              className="rounded-2xl"
            />
            <p className="mt-2 text-sm text-slate-500">Helper text stays visible on mobile so you never rely on placeholder-only inputs.</p>
          </div>
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value as "name" | "username" | "role")} className="min-h-[48px] rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 text-base text-gray-900 dark:text-white focus:border-indigo-500/50 focus:outline-none sm:text-sm">
            <option value="name">Sort by name</option>
            <option value="username">Sort by username</option>
            <option value="role">Sort by role</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16" />)}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-gray-100 dark:bg-white/5 backdrop-blur-sm border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_1fr_auto_auto_auto] gap-4 px-4 py-2.5 border-b border-gray-200 dark:border-white/5 sticky-header">
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
                    onClick={() => setSelectedUsername(user.username)}
                    className={cn(
                      "grid grid-cols-[1fr_1fr_1fr_auto_auto_auto] gap-4 items-center px-4 py-3 border-b border-gray-200 dark:border-white/5 last:border-0 hover:bg-white/[0.03] transition-colors min-h-[56px] cursor-pointer",
                      selectedUsername === user.username && "bg-indigo-500/10"
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300 flex-shrink-0">
                        {(user.name || user.username)[0]?.toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate flex items-center gap-1.5">
                          {user.name || user.username}
                          {isSelf && <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">you</span>}
                        </p>
                        <p className="text-xs text-slate-500 truncate">@{user.username}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm text-slate-500 dark:text-slate-400 truncate">{user.email}</span>
                      <CopyButton text={user.email} className="px-1.5 py-1" />
                    </div>
                    <AccessBadge level={user.access_level} />
                    <span className="text-xs text-slate-500 dark:text-slate-400">{user.wiki_role ?? "—"}</span>
                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                      {(user.authentik_groups ?? []).slice(0, 2).map(g => (
                        <span key={g} className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-slate-500 dark:text-slate-400">{g}</span>
                      ))}
                      {(user.authentik_groups ?? []).length > 2 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-slate-500 dark:text-slate-400">+{(user.authentik_groups ?? []).length - 2}</span>
                      )}
                    </div>
                    {isAdmin && (
                      <div className="flex items-center gap-2">
                        <UserActionsDropdown
                          user={user}
                          isSelf={isSelf}
                          isAdmin={isAdmin}
                          onEdit={() => { setSelectedUsername(user.username); setEditUser(user); setModalOpen(true); }}
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
              <div className="py-12 text-center text-slate-500 text-sm">No users found. Try a different name, username, email, or sort order.</div>
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
                  onEdit={() => { setSelectedUsername(user.username); setEditUser(user); setModalOpen(true); }}
                  onDelete={() => setDeleteUser(user)}
                  actionsDropdown={
                    <UserActionsDropdown
                      user={user}
                      isSelf={user.email === currentEmail || user.username === currentUsername}
                      isAdmin={isAdmin}
                      onEdit={() => { setSelectedUsername(user.username); setEditUser(user); setModalOpen(true); }}
                      onDelete={() => setDeleteUser(user)}
                      onRefetch={() => { /* react-query will refetch */ }}
                    />
                  }
                />
              ))}
            </AnimatePresence>
            {filtered.length === 0 && (
              <div className="py-12 text-center text-slate-500 text-sm">No users found. Try a different name, username, email, or sort order.</div>
            )}
          </div>

          <RoleAssignmentsPanel user={selectedUser} isAdmin={isAdmin} />

          {/* Permission Matrix */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
              <Shield className="w-4 h-4 text-purple-400" />
              Role Permission Matrix
            </h3>
            <PermissionMatrix />
          </div>

          {/* RBAC info card */}
          <RBACInfoCard />
        </>
      )}
        </>
      )}

      {/* Modals */}
      <AnimatePresence>
        {modalOpen && (
          <UserFormModal
            key={editUser?.username ?? "new-user"}
            open={modalOpen}
            onClose={() => { setModalOpen(false); setEditUser(null); }}
            onSave={handleSave}
            initialUser={editUser ?? defaultUser}
            isNew={!editUser}
            currentUsername={currentUsername}
            simpleMode={simpleMode}
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
