"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import { X, Mail, Copy, Check, ChevronDown } from "lucide-react";
import { toast } from "@/lib/notify";
import { useRBAC } from "@/hooks/use-rbac";

interface Props {
  open: boolean;
  onClose: () => void;
}

const EXPIRY_OPTIONS = [
  { label: "1 hour", value: 1 },
  { label: "6 hours", value: 6 },
  { label: "24 hours", value: 24 },
  { label: "3 days", value: 72 },
  { label: "7 days", value: 168 },
];

const inputCls = "w-full rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 py-3 text-base text-gray-900 dark:text-[#f2f2f2] placeholder:text-gray-400 dark:placeholder:text-[#444] focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6] sm:text-sm";

export function InviteModal({ open, onClose }: Props) {
  const { canAny } = useRBAC();
  const canManageUsers = canAny(["users:invite", "users:write", "rbac:admin"]);
  const [email, setEmail] = useState("");
  const [expiryHours, setExpiryHours] = useState(24);
  const [loading, setLoading] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canManageUsers) {
      toast.error("You do not have permission to invite users");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, groups: [], expiryHours }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed");
      setInviteUrl(data.url);
      toast.success("Invite created");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    toast.success("Invite link copied");
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose() {
    setEmail("");
    setExpiryHours(24);
    setInviteUrl("");
    setCopied(false);
    onClose();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 top-0 z-50 w-full overflow-y-auto bg-white dark:bg-[#111] p-4 pt-[calc(env(safe-area-inset-top,0px)+1rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] text-gray-900 dark:text-[#f2f2f2] shadow-2xl focus:outline-none sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:border-gray-200 dark:border-[#2a2a2a] sm:p-6 sm:pt-6 sm:pb-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">
              <Mail className="h-4 w-4 text-[#3b82f6]" />
              Invite User
            </Dialog.Title>
            <button onClick={handleClose} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]">
              <X className="h-4 w-4" />
            </button>
          </div>

          {inviteUrl ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-500 dark:text-[#888]">Share this link with the user:</p>
              <div className="group flex items-center gap-2 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3">
                <span className="flex-1 truncate font-mono text-xs text-gray-700 dark:text-[#d4d4d4]">{inviteUrl}</span>
                <button
                  onClick={handleCopy}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#888] opacity-0 transition-all group-hover:opacity-100 hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] focus:opacity-100"
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <button
                onClick={handleClose}
                className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8]"
              >
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-[#d4d4d4]">Email address</label>
                <input
                  autoFocus
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  placeholder="user@example.com"
                  className={inputCls}
                />
              </div>
              <div>
                <p className="mt-2 text-sm text-gray-400 dark:text-[#666]">The invite link stays below the input on mobile so expiry is never hidden behind the keyboard.</p>
                <label className="mb-2 mt-3 block text-sm font-medium text-gray-700 dark:text-[#d4d4d4]">Link expiry</label>
                <Select.Root value={String(expiryHours)} onValueChange={(value) => setExpiryHours(Number(value))}>
                  <Select.Trigger className="flex min-h-[48px] w-full items-center justify-between rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 text-base text-gray-900 dark:text-[#f2f2f2] focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6] sm:text-sm">
                    <Select.Value />
                    <ChevronDown className="h-4 w-4 text-gray-500 dark:text-[#888]" />
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content className="z-[60] overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-900 dark:text-[#f2f2f2] shadow-2xl">
                      <Select.Viewport className="p-1">
                        {EXPIRY_OPTIONS.map((option) => (
                          <Select.Item
                            key={option.value}
                            value={String(option.value)}
                            className="flex cursor-pointer items-center rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none data-[highlighted]:bg-[#1a1a1a] data-[highlighted]:text-[#f2f2f2]"
                          >
                            <Select.ItemText>{option.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleClose}
                  className="flex min-h-[48px] flex-1 items-center justify-center rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-transparent px-4 text-sm text-gray-700 dark:text-[#d4d4d4] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] active:bg-gray-200 dark:active:bg-[#1f1f1f]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !email || !canManageUsers}
                  className="flex min-h-[48px] flex-1 items-center justify-center rounded-2xl bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? "Creating…" : "Create Invite"}
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
