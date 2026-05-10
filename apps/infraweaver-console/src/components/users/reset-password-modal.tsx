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
      const r = await fetch("/api/users/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed");
      setTempPassword(data.tempPassword);
      setStep("done");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose() {
    setStep("confirm");
    setTempPassword("");
    setCopied(false);
    onClose();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-slate-900 border border-white/10 rounded-2xl shadow-2xl p-6 focus:outline-none">
          <div className="flex items-center justify-between mb-5">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-white">
              <KeyRound className="w-4 h-4 text-amber-400" />
              Reset Password
            </Dialog.Title>
            <button onClick={handleClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          {step === "confirm" ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-amber-300">Confirm password reset</p>
                  <p className="text-xs text-amber-400/70 mt-1">
                    A new temporary password will be generated for <strong className="text-amber-300">@{username}</strong>. Their current password will be invalidated.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReset}
                  disabled={loading}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-amber-500/20 border border-amber-500/30 text-sm text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                >
                  {loading ? "Resetting…" : "Reset Password"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                <p className="text-xs text-slate-400 mb-2">Temporary password for @{username}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm font-mono text-white bg-black/30 rounded-lg px-3 py-2 break-all">
                    {tempPassword}
                  </code>
                  <button
                    onClick={handleCopy}
                    className="p-2 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white transition-colors flex-shrink-0"
                  >
                    {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
                <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-red-400">Share this once — it cannot be retrieved again.</p>
              </div>
              <button
                onClick={handleClose}
                className="w-full px-4 py-2.5 rounded-xl bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors"
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
