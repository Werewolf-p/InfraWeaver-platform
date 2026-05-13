"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Copy, Check, AlertTriangle, KeyRound } from "lucide-react";
import { toast } from "sonner";

interface Props {
  username: string;
  open: boolean;
  onClose: () => void;
}

export function ResetPasswordModal({ username, open, onClose }: Props) {
  const [step, setStep] = useState<"confirm" | "done">("confirm");
  const [tempPassword, setTempPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleReset() {
    setLoading(true);
    try {
      const response = await fetch("/api/users/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed");
      setTempPassword(data.tempPassword);
      toast.success("Temporary password generated");
      setStep("done");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    toast.success("Temporary password copied");
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose() {
    setStep("confirm");
    setTempPassword("");
    setCopied(false);
    onClose();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#2a2a2a] bg-[#111] p-6 text-[#f2f2f2] shadow-2xl focus:outline-none">
          <div className="mb-5 flex items-center justify-between gap-3">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-[#f2f2f2]">
              <KeyRound className="h-4 w-4 text-amber-400" />
              Reset Password
            </Dialog.Title>
            <button onClick={handleClose} className="rounded-lg p-1.5 text-[#888] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2]">
              <X className="h-4 w-4" />
            </button>
          </div>

          {step === "confirm" ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-amber-300">Confirm password reset</p>
                  <p className="mt-1 text-xs leading-relaxed text-amber-200/80">
                    A new temporary password will be generated for <strong className="text-amber-200">@{username}</strong>. Their current password will be invalidated.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="flex h-9 flex-1 items-center justify-center rounded-lg border border-[#2a2a2a] bg-transparent px-4 text-sm text-[#d4d4d4] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2] active:bg-[#1f1f1f]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReset}
                  disabled={loading}
                  className="flex h-9 flex-1 items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 text-sm font-medium text-amber-300 transition-colors hover:bg-amber-500/20 active:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? "Resetting…" : "Reset Password"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-4">
                <p className="mb-2 text-xs text-[#888]">Temporary password for @{username}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-lg border border-[#2a2a2a] bg-[#111] px-3 py-2 font-mono text-sm text-[#f2f2f2]">
                    {tempPassword}
                  </code>
                  <button
                    onClick={handleCopy}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#111] text-[#888] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2]"
                  >
                    {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <p className="text-xs text-red-400">Share this once — it cannot be retrieved again.</p>
              </div>
              <button
                onClick={handleClose}
                className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8]"
              >
                Done
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
