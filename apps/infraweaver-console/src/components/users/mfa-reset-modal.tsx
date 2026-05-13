"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ShieldOff, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface Props {
  username: string;
  open: boolean;
  onClose: () => void;
}

export function MFAResetModal({ username, open, onClose }: Props) {
  const [typed, setTyped] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleDelete() {
    if (typed !== username) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/users/${username}/mfa`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed");
      setDone(true);
      toast.success("MFA reset successfully");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setTyped("");
    setDone(false);
    onClose();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#2a2a2a] bg-[#111] p-6 text-[#f2f2f2] shadow-2xl focus:outline-none">
          <div className="mb-5 flex items-center justify-between gap-3">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-[#f2f2f2]">
              <ShieldOff className="h-4 w-4 text-red-400" />
              Reset MFA
            </Dialog.Title>
            <button onClick={handleClose} className="rounded-lg p-1.5 text-[#888] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2]">
              <X className="h-4 w-4" />
            </button>
          </div>

          {done ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-center">
                <p className="text-sm text-emerald-300">All MFA devices for <strong>@{username}</strong> have been removed.</p>
              </div>
              <button
                onClick={handleClose}
                className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8]"
              >
                Close
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-red-300">This will remove all MFA devices</p>
                  <p className="mt-1 text-xs leading-relaxed text-red-200/80">
                    All TOTP, WebAuthn, and static token devices for <strong className="text-red-200">@{username}</strong> will be deleted.
                  </p>
                </div>
              </div>
              <div>
                <label className="mb-2 block text-xs text-[#888]">
                  Type <span className="font-mono text-[#f2f2f2]">{username}</span> to confirm
                </label>
                <input
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder={username}
                  className="w-full rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2.5 text-sm text-[#f2f2f2] placeholder:text-[#444] focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="flex h-9 flex-1 items-center justify-center rounded-lg border border-[#2a2a2a] bg-transparent px-4 text-sm text-[#d4d4d4] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2] active:bg-[#1f1f1f]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={typed !== username || loading}
                  className="flex h-9 flex-1 items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/20 active:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? "Removing…" : "Reset MFA"}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
