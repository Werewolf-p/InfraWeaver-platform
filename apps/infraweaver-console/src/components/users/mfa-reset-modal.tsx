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
      const r = await fetch(`/api/users/${username}/mfa`, { method: "DELETE" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed");
      setDone(true);
      toast.success("MFA reset successfully");
    } catch (e) {
      toast.error(String(e));
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
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-slate-900 border border-white/10 rounded-2xl shadow-2xl p-6 focus:outline-none">
          <div className="flex items-center justify-between mb-5">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-white">
              <ShieldOff className="w-4 h-4 text-red-400" />
              Reset MFA
            </Dialog.Title>
            <button onClick={handleClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          {done ? (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/20 text-center">
                <p className="text-sm text-green-300">All MFA devices for <strong>@{username}</strong> have been removed.</p>
              </div>
              <button
                onClick={handleClose}
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors"
              >
                Close
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-300">This will remove all MFA devices</p>
                  <p className="text-xs text-red-400/70 mt-1">
                    All TOTP, WebAuthn, and static token devices for <strong className="text-red-300">@{username}</strong> will be deleted.
                  </p>
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-2">
                  Type <span className="text-white font-mono">{username}</span> to confirm
                </label>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={username}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-red-500/50"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={typed !== username || loading}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-red-500/20 border border-red-500/30 text-sm text-red-300 hover:bg-red-500/30 transition-colors disabled:opacity-40"
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
