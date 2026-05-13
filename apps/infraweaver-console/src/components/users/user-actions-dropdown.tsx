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

const inputCls = "w-full rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2.5 text-sm text-[#f2f2f2] placeholder:text-[#444] focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6]";
const ghostButtonCls = "inline-flex h-9 items-center justify-center rounded-lg border border-[#2a2a2a] bg-transparent px-4 text-sm text-[#d4d4d4] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2] active:bg-[#1f1f1f]";
const primaryButtonCls = "inline-flex h-9 items-center justify-center rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8]";

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
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#2a2a2a] bg-[#111] p-5 text-[#f2f2f2] shadow-2xl focus:outline-none">
          <div className="mb-4 flex items-center justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold text-[#f2f2f2]">{title}</Dialog.Title>
            <button onClick={onClose} className="rounded-lg p-1.5 text-[#888] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2]">
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

  const itemCls = "flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2 text-sm text-[#f2f2f2] outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-[#1a1a1a] data-[highlighted]:text-[#f2f2f2]";
  const destructiveCls = "flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-400 outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-300";

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-1.5 text-[#888] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2] active:scale-95">
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="z-50 min-w-[200px] rounded-xl border border-[#2a2a2a] bg-[#111] p-1 text-[#f2f2f2] shadow-2xl"
            sideOffset={5}
            align="end"
          >
            {isAdmin ? (
              <DropdownMenu.Item className={itemCls} onSelect={onEdit}>
                <Pencil className="h-3.5 w-3.5" />
                Edit User
              </DropdownMenu.Item>
            ) : null}

            {isAdmin ? <DropdownMenu.Separator className="my-1 border-t border-[#2a2a2a]" /> : null}

            {isAdmin && !isSelf ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowResetPassword(true)}>
                <KeyRound className="h-3.5 w-3.5" />
                Reset Password
              </DropdownMenu.Item>
            ) : null}
            {isAdmin ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => { setNewEmail(user.email); setShowChangeEmail(true); }}>
                <Mail className="h-3.5 w-3.5" />
                Change Email
              </DropdownMenu.Item>
            ) : null}
            {isAdmin && !isSelf ? (
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
            {isAdmin ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowMFAReset(true)}>
                <ShieldOff className="h-3.5 w-3.5" />
                Reset MFA
              </DropdownMenu.Item>
            ) : null}
            {isAdmin ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowSessions(true)}>
                <MonitorSmartphone className="h-3.5 w-3.5" />
                View Sessions
              </DropdownMenu.Item>
            ) : null}
            {isAdmin ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => setShowHistory(true)}>
                <History className="h-3.5 w-3.5" />
                Login History
              </DropdownMenu.Item>
            ) : null}
            {isAdmin && !isSelf ? (
              <DropdownMenu.Item className={itemCls} onSelect={() => { setNewUsername(user.username); setShowChangeUsername(true); }}>
                <UserCog className="h-3.5 w-3.5" />
                Change Username
              </DropdownMenu.Item>
            ) : null}

            {isAdmin && !isSelf ? <DropdownMenu.Separator className="my-1 border-t border-[#2a2a2a]" /> : null}

            {isAdmin && !isSelf ? (
              <DropdownMenu.Item className={destructiveCls} onSelect={() => setShowOffboard(true)}>
                <UserX className="h-3.5 w-3.5" />
                Offboard User
              </DropdownMenu.Item>
            ) : null}
            {isAdmin && !isSelf ? (
              <DropdownMenu.Item className={destructiveCls} onSelect={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </DropdownMenu.Item>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

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
            <p className="mt-1.5 text-xs text-[#888]">3-32 chars, lowercase letters, numbers, dots, hyphens</p>
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
