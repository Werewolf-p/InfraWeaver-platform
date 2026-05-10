"use client";
import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  MoreVertical, Pencil, KeyRound, Mail, PowerOff, PowerIcon,
  ShieldOff, MonitorSmartphone, History, UserCog, UserX, Trash2, X, Check,
} from "lucide-react";
import { toast } from "sonner";
import { type PlatformUser } from "@/hooks/use-users-config";
import { ResetPasswordModal } from "./reset-password-modal";
import { MFAResetModal } from "./mfa-reset-modal";
import { SessionsPanel } from "./sessions-panel";
import { HistoryDrawer } from "./history-drawer";
import { OffboardWizard } from "./offboard-wizard";

interface Props {
  user: PlatformUser;
  isSelf: boolean;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRefetch: () => void;
}

function SmallDialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm bg-slate-900 border border-white/10 rounded-2xl shadow-2xl p-5 focus:outline-none">
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-sm font-semibold text-white">{title}</Dialog.Title>
            <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function UserActionsDropdown({ user, isSelf, isAdmin, onEdit, onDelete, onRefetch }: Props) {
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [showMFAReset, setShowMFAReset] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showOffboard, setShowOffboard] = useState(false);
  const [showChangeEmail, setShowChangeEmail] = useState(false);
  const [showChangeUsername, setShowChangeUsername] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [statusLoading, setStatusLoading] = useState(false);

  async function handleToggleStatus() {
    setStatusLoading(true);
    try {
      const currentlyActive = (user as PlatformUser & { is_active?: boolean }).is_active !== false;
      const r = await fetch(`/api/users/${user.username}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !currentlyActive }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed");
      toast.success(`User ${currentlyActive ? "disabled" : "enabled"}`);
      onRefetch();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setStatusLoading(false);
    }
  }

  async function handleChangeEmail() {
    if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      toast.error("Invalid email");
      return;
    }
    try {
      const r = await fetch(`/api/users/${user.username}/email`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed");
      toast.success("Email updated");
      setShowChangeEmail(false);
      setNewEmail("");
      onRefetch();
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleChangeUsername() {
    if (!newUsername || !/^[a-z0-9.-]{3,32}$/.test(newUsername)) {
      toast.error("Invalid username (3-32 chars, a-z0-9.-)");
      return;
    }
    try {
      const r = await fetch(`/api/users/${user.username}/username`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newUsername }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed");
      toast.success("Username updated");
      setShowChangeUsername(false);
      setNewUsername("");
      onRefetch();
    } catch (e) {
      toast.error(String(e));
    }
  }

  const itemCls = "flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:text-white hover:bg-white/5 cursor-pointer rounded-lg focus:outline-none select-none";
  const destructiveCls = "flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 cursor-pointer rounded-lg focus:outline-none select-none";

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="p-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-colors active:scale-95">
            <MoreVertical className="w-3.5 h-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="bg-slate-900 border border-white/10 rounded-xl shadow-2xl min-w-[200px] z-50 p-1"
            sideOffset={5}
            align="end"
          >
            {isAdmin && (
              <DropdownMenu.Item className={itemCls} onSelect={onEdit}>
                <Pencil className="w-3.5 h-3.5" />
                Edit User
              </DropdownMenu.Item>
            )}

            {isAdmin && <DropdownMenu.Separator className="my-1 border-t border-white/10" />}

            {isAdmin && !isSelf && (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowResetPassword(true)}>
                <KeyRound className="w-3.5 h-3.5" />
                Reset Password
              </DropdownMenu.Item>
            )}
            {isAdmin && (
              <DropdownMenu.Item className={itemCls} onSelect={() => { setNewEmail(user.email); setShowChangeEmail(true); }}>
                <Mail className="w-3.5 h-3.5" />
                Change Email
              </DropdownMenu.Item>
            )}
            {isAdmin && !isSelf && (
              <DropdownMenu.Item
                className={itemCls}
                disabled={statusLoading}
                onSelect={handleToggleStatus}
              >
                {statusLoading ? (
                  <PowerOff className="w-3.5 h-3.5 animate-pulse" />
                ) : (
                  <PowerIcon className="w-3.5 h-3.5" />
                )}
                Toggle Status
              </DropdownMenu.Item>
            )}
            {isAdmin && (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowMFAReset(true)}>
                <ShieldOff className="w-3.5 h-3.5" />
                Reset MFA
              </DropdownMenu.Item>
            )}
            {isAdmin && (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowSessions(true)}>
                <MonitorSmartphone className="w-3.5 h-3.5" />
                View Sessions
              </DropdownMenu.Item>
            )}
            {isAdmin && (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowHistory(true)}>
                <History className="w-3.5 h-3.5" />
                Login History
              </DropdownMenu.Item>
            )}
            {isAdmin && !isSelf && (
              <DropdownMenu.Item className={itemCls} onSelect={() => { setNewUsername(user.username); setShowChangeUsername(true); }}>
                <UserCog className="w-3.5 h-3.5" />
                Change Username
              </DropdownMenu.Item>
            )}

            {isAdmin && !isSelf && <DropdownMenu.Separator className="my-1 border-t border-white/10" />}

            {isAdmin && !isSelf && (
              <DropdownMenu.Item className={destructiveCls} onSelect={() => setShowOffboard(true)}>
                <UserX className="w-3.5 h-3.5" />
                Offboard User
              </DropdownMenu.Item>
            )}
            {isAdmin && !isSelf && (
              <DropdownMenu.Item className={destructiveCls} onSelect={onDelete}>
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Modals */}
      <ResetPasswordModal
        open={showResetPassword}
        username={user.username}
        onClose={() => setShowResetPassword(false)}
      />
      <MFAResetModal
        open={showMFAReset}
        username={user.username}
        onClose={() => setShowMFAReset(false)}
      />
      <SessionsPanel
        open={showSessions}
        username={user.username}
        onClose={() => setShowSessions(false)}
      />
      <HistoryDrawer
        open={showHistory}
        username={user.username}
        onClose={() => setShowHistory(false)}
      />
      <OffboardWizard
        open={showOffboard}
        username={user.username}
        onClose={() => setShowOffboard(false)}
      />

      {/* Change Email Dialog */}
      <SmallDialog
        open={showChangeEmail}
        onClose={() => { setShowChangeEmail(false); setNewEmail(""); }}
        title={<span className="flex items-center gap-2"><Mail className="w-4 h-4 text-indigo-400" />Change Email</span>}
      >
        <div className="space-y-3">
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="new@email.com"
            className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
          />
          <div className="flex gap-2">
            <button
              onClick={() => { setShowChangeEmail(false); setNewEmail(""); }}
              className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleChangeEmail}
              className="flex-1 px-3 py-2 rounded-xl bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors flex items-center justify-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" /> Save
            </button>
          </div>
        </div>
      </SmallDialog>

      {/* Change Username Dialog */}
      <SmallDialog
        open={showChangeUsername}
        onClose={() => { setShowChangeUsername(false); setNewUsername(""); }}
        title={<span className="flex items-center gap-2"><UserCog className="w-4 h-4 text-indigo-400" />Change Username</span>}
      >
        <div className="space-y-3">
          <div>
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value.toLowerCase())}
              placeholder="new-username"
              pattern="[a-z0-9.\-]{3,32}"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
            />
            <p className="text-xs text-slate-500 mt-1.5">3-32 chars, lowercase letters, numbers, dots, hyphens</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { setShowChangeUsername(false); setNewUsername(""); }}
              className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleChangeUsername}
              className="flex-1 px-3 py-2 rounded-xl bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors flex items-center justify-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" /> Save
            </button>
          </div>
        </div>
      </SmallDialog>
    </>
  );
}
