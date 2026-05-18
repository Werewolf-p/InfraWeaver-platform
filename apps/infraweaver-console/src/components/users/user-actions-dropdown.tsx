"use client";
import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  MoreVertical, Pencil, KeyRound, Mail, PowerOff, PowerIcon,
  ShieldOff, MonitorSmartphone, History, UserCog, UserX, Trash2, X, Check,
} from "lucide-react";
import { toast } from "@/lib/notify";
import { type PlatformUser } from "@/hooks/use-users-config";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { ResetPasswordModal } from "./reset-password-modal";
import { MFAResetModal } from "./mfa-reset-modal";
import { SessionsPanel } from "./sessions-panel";
import { HistoryDrawer } from "./history-drawer";
import { OffboardWizard } from "./offboard-wizard";
import { useRBAC } from "@/hooks/use-rbac";

interface Props {
  user: PlatformUser;
  isSelf: boolean;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRefetch: () => void;
}

const inputCls = "w-full rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 py-3 text-base text-gray-900 dark:text-[#f2f2f2] placeholder:text-gray-400 dark:placeholder:text-[#444] focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6] sm:text-sm";
const ghostButtonCls = "inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-transparent px-4 text-sm text-gray-700 dark:text-[#d4d4d4] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] active:bg-gray-200 dark:active:bg-[#1f1f1f]";
const primaryButtonCls = "inline-flex min-h-[44px] items-center justify-center rounded-2xl bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8]";

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
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 top-0 z-50 w-full overflow-y-auto bg-white dark:bg-[#111] p-4 pt-[calc(env(safe-area-inset-top,0px)+1rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] text-gray-900 dark:text-[#f2f2f2] shadow-2xl focus:outline-none sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:border-gray-200 dark:border-[#2a2a2a] sm:p-5 sm:pt-5 sm:pb-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <Dialog.Title className="text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{title}</Dialog.Title>
            <button onClick={onClose} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]">
              <X className="h-4 w-4" />
            </button>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function UserActionsDropdown({ user, isSelf, isAdmin, onEdit, onDelete, onRefetch }: Props) {
  const { canAny } = useRBAC();
  const canViewUserData = isAdmin && canAny(["users:read", "users:write", "users:invite", "rbac:admin"]);
  const canManageUsers = isAdmin && canAny(["users:write", "users:invite", "rbac:admin"]);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [showMFAReset, setShowMFAReset] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showOffboard, setShowOffboard] = useState(false);
  const [showChangeEmail, setShowChangeEmail] = useState(false);
  const [showChangeUsername, setShowChangeUsername] = useState(false);
  const [showMobileActions, setShowMobileActions] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [statusLoading, setStatusLoading] = useState(false);

  async function handleToggleStatus() {
    setStatusLoading(true);
    try {
      const currentlyActive = (user as PlatformUser & { is_active?: boolean }).is_active !== false;
      const response = await fetch(`/api/users/${user.username}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !currentlyActive }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed");
      toast.success(`User ${currentlyActive ? "disabled" : "enabled"}`);
      onRefetch();
    } catch (error) {
      toast.error(String(error));
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
      const response = await fetch(`/api/users/${user.username}/email`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed");
      toast.success("Email updated");
      setShowChangeEmail(false);
      setNewEmail("");
      onRefetch();
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function handleChangeUsername() {
    if (!newUsername || !/^[a-z0-9.-]{3,32}$/.test(newUsername)) {
      toast.error("Invalid username (3-32 chars, a-z0-9.-)");
      return;
    }
    try {
      const response = await fetch(`/api/users/${user.username}/username`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newUsername }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed");
      toast.success("Username updated");
      setShowChangeUsername(false);
      setNewUsername("");
      onRefetch();
    } catch (error) {
      toast.error(String(error));
    }
  }

  const itemCls = "flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-[#1a1a1a] data-[highlighted]:text-[#f2f2f2]";
  const destructiveCls = "flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-400 outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-300";
  const primaryActions = [
    canManageUsers ? { label: "Edit User", icon: Pencil, onSelect: onEdit } : null,
    canManageUsers && !isSelf ? { label: "Reset Password", icon: KeyRound, onSelect: () => setShowResetPassword(true) } : null,
    canManageUsers ? { label: "Change Email", icon: Mail, onSelect: () => { setNewEmail(user.email); setShowChangeEmail(true); } } : null,
    canManageUsers && !isSelf ? { label: statusLoading ? "Updating status…" : "Toggle Status", icon: statusLoading ? PowerOff : PowerIcon, onSelect: () => { void handleToggleStatus(); }, disabled: statusLoading } : null,
    canManageUsers ? { label: "Reset MFA", icon: ShieldOff, onSelect: () => setShowMFAReset(true) } : null,
    canViewUserData ? { label: "View Sessions", icon: MonitorSmartphone, onSelect: () => setShowSessions(true) } : null,
    canViewUserData ? { label: "Login History", icon: History, onSelect: () => setShowHistory(true) } : null,
    canManageUsers && !isSelf ? { label: "Change Username", icon: UserCog, onSelect: () => { setNewUsername(user.username); setShowChangeUsername(true); } } : null,
  ].filter(Boolean) as Array<{ label: string; icon: typeof Pencil; onSelect: () => void; disabled?: boolean }>;
  const dangerActions = [
    canManageUsers && !isSelf ? { label: "Offboard User", icon: UserX, onSelect: () => setShowOffboard(true) } : null,
    canManageUsers && !isSelf ? { label: "Delete", icon: Trash2, onSelect: onDelete } : null,
  ].filter(Boolean) as Array<{ label: string; icon: typeof Pencil; onSelect: () => void; disabled?: boolean }>;

  return (
    <>
      <button
        type="button"
        onClick={() => setShowMobileActions(true)}
        className="inline-flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 text-sm font-medium text-gray-700 dark:text-[#d4d4d4] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] sm:hidden"
      >
        <MoreVertical className="h-4 w-4" />
        Actions
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="hidden min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] active:scale-95 sm:inline-flex">
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="z-50 min-w-[200px] rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-1 text-gray-900 dark:text-[#f2f2f2] shadow-2xl"
            sideOffset={5}
            align="end"
          >
            {canManageUsers ? (
              <DropdownMenu.Item className={itemCls} onSelect={onEdit}>
                <Pencil className="h-3.5 w-3.5" />
                Edit User
              </DropdownMenu.Item>
            ) : null}

            {canManageUsers ? <DropdownMenu.Separator className="my-1 border-t border-gray-200 dark:border-[#2a2a2a]" /> : null}

            {canManageUsers && !isSelf ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowResetPassword(true)}>
                <KeyRound className="h-3.5 w-3.5" />
                Reset Password
              </DropdownMenu.Item>
            ) : null}
            {canManageUsers ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => { setNewEmail(user.email); setShowChangeEmail(true); }}>
                <Mail className="h-3.5 w-3.5" />
                Change Email
              </DropdownMenu.Item>
            ) : null}
            {canManageUsers && !isSelf ? (
              <DropdownMenu.Item
                className={itemCls}
                disabled={statusLoading}
                onSelect={handleToggleStatus}
              >
                {statusLoading ? (
                  <PowerOff className="h-3.5 w-3.5 animate-pulse" />
                ) : (
                  <PowerIcon className="h-3.5 w-3.5" />
                )}
                Toggle Status
              </DropdownMenu.Item>
            ) : null}
            {canManageUsers ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowMFAReset(true)}>
                <ShieldOff className="h-3.5 w-3.5" />
                Reset MFA
              </DropdownMenu.Item>
            ) : null}
            {canViewUserData ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowSessions(true)}>
                <MonitorSmartphone className="h-3.5 w-3.5" />
                View Sessions
              </DropdownMenu.Item>
            ) : null}
            {canViewUserData ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowHistory(true)}>
                <History className="h-3.5 w-3.5" />
                Login History
              </DropdownMenu.Item>
            ) : null}
            {canManageUsers && !isSelf ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => { setNewUsername(user.username); setShowChangeUsername(true); }}>
                <UserCog className="h-3.5 w-3.5" />
                Change Username
              </DropdownMenu.Item>
            ) : null}

            {canManageUsers && !isSelf ? <DropdownMenu.Separator className="my-1 border-t border-gray-200 dark:border-[#2a2a2a]" /> : null}

            {canManageUsers && !isSelf ? (
              <DropdownMenu.Item className={destructiveCls} onSelect={() => setShowOffboard(true)}>
                <UserX className="h-3.5 w-3.5" />
                Offboard User
              </DropdownMenu.Item>
            ) : null}
            {canManageUsers && !isSelf ? (
              <DropdownMenu.Item className={destructiveCls} onSelect={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </DropdownMenu.Item>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ResponsiveSheet
        open={showMobileActions}
        onClose={() => setShowMobileActions(false)}
        size="sm"
        title={`Actions for @${user.username}`}
        description="Large mobile actions replace tiny dropdown targets on phones."
      >
        <div className="space-y-2">
          {primaryActions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              onClick={() => {
                setShowMobileActions(false);
                action.onSelect();
              }}
              className="flex min-h-[52px] w-full items-center gap-3 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-left text-sm font-medium text-gray-900 dark:text-[#f2f2f2] transition-colors hover:border-[#3a3a3a] hover:text-gray-900 dark:hover:text-white disabled:opacity-50"
            >
              <action.icon className="h-4 w-4" />
              {action.label}
            </button>
          ))}
          {dangerActions.length > 0 ? <div className="pt-2 text-sm text-gray-400 dark:text-[#666]">Destructive actions</div> : null}
          {dangerActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                setShowMobileActions(false);
                action.onSelect();
              }}
              className="flex min-h-[52px] w-full items-center gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 text-left text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20"
            >
              <action.icon className="h-4 w-4" />
              {action.label}
            </button>
          ))}
        </div>
      </ResponsiveSheet>

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

      <SmallDialog
        open={showChangeEmail}
        onClose={() => { setShowChangeEmail(false); setNewEmail(""); }}
        title={<span className="flex items-center gap-2"><Mail className="h-4 w-4 text-[#3b82f6]" />Change Email</span>}
      >
        <div className="space-y-3">
          <input
            type="email"
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            placeholder="new@email.com"
            className={inputCls}
          />
          <div className="flex gap-2">
            <button
              onClick={() => { setShowChangeEmail(false); setNewEmail(""); }}
              className={`${ghostButtonCls} flex-1`}
            >
              Cancel
            </button>
            <button
              onClick={handleChangeEmail}
              className={`${primaryButtonCls} flex-1 gap-1.5`}
            >
              <Check className="h-3.5 w-3.5" /> Save
            </button>
          </div>
        </div>
      </SmallDialog>

      <SmallDialog
        open={showChangeUsername}
        onClose={() => { setShowChangeUsername(false); setNewUsername(""); }}
        title={<span className="flex items-center gap-2"><UserCog className="h-4 w-4 text-[#3b82f6]" />Change Username</span>}
      >
        <div className="space-y-3">
          <div>
            <input
              type="text"
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value.toLowerCase())}
              placeholder="new-username"
              pattern="[a-z0-9.\-]{3,32}"
              className={inputCls}
            />
            <p className="mt-1.5 text-xs text-gray-500 dark:text-[#888]">3-32 chars, lowercase letters, numbers, dots, hyphens</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { setShowChangeUsername(false); setNewUsername(""); }}
              className={`${ghostButtonCls} flex-1`}
            >
              Cancel
            </button>
            <button
              onClick={handleChangeUsername}
              className={`${primaryButtonCls} flex-1 gap-1.5`}
            >
              <Check className="h-3.5 w-3.5" /> Save
            </button>
          </div>
        </div>
      </SmallDialog>
    </>
  );
}
