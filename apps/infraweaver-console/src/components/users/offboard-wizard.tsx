"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { X, AlertTriangle, CheckCircle2, XCircle, Loader2, UserX } from "lucide-react";
import { toast } from "sonner";

interface OffboardStep {
  name: string;
  success: boolean;
  message: string;
}

interface Props {
  username: string;
  open: boolean;
  onClose: () => void;
}

const PLANNED_STEPS = [
  "Disable account",
  "Revoke tokens",
  "Remove from groups",
  "Remove from users.yaml",
];

const variants = {
  enter: { opacity: 0, x: 30 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -30 },
};

export function OffboardWizard({ username, open, onClose }: Props) {
  const [step, setStep] = useState(0); // 0=confirm, 1=preview, 2=executing, 3=summary
  const [typed, setTyped] = useState("");
  const [results, setResults] = useState<OffboardStep[]>([]);
  const [loading, setLoading] = useState(false);

  function handleClose() {
    setStep(0);
    setTyped("");
    setResults([]);
    setLoading(false);
    onClose();
  }

  async function handleExecute() {
    setStep(2);
    setLoading(true);
    try {
      const r = await fetch(`/api/users/${username}/offboard`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed");
      setResults(data.steps ?? []);
      setStep(3);
    } catch (e) {
      toast.error(String(e));
      setStep(1);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg bg-slate-900 border border-white/10 rounded-2xl shadow-2xl focus:outline-none overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-white">
              <UserX className="w-4 h-4 text-red-400" />
              Offboard User
            </Dialog.Title>
            <button onClick={handleClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="overflow-hidden">
            <AnimatePresence mode="wait" initial={false}>
              {step === 0 && (
                <motion.div key="confirm" variants={variants} initial="enter" animate="center" exit="exit" className="p-6 space-y-4">
                  <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
                    <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-red-300">Confirm offboarding</p>
                      <p className="text-xs text-red-400/70 mt-1">
                        This will disable <strong className="text-red-300">@{username}</strong>&apos;s account, revoke all tokens, remove group memberships, and remove them from the platform config.
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-2">
                      Type <span className="text-white font-mono">{username}</span> to continue
                    </label>
                    <input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder={username}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-red-500/50"
                    />
                  </div>
                  <div className="flex gap-3">
                    <button onClick={handleClose} className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors">
                      Cancel
                    </button>
                    <button
                      onClick={() => setStep(1)}
                      disabled={typed !== username}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-red-500/20 border border-red-500/30 text-sm text-red-300 hover:bg-red-500/30 transition-colors disabled:opacity-40"
                    >
                      Continue
                    </button>
                  </div>
                </motion.div>
              )}

              {step === 1 && (
                <motion.div key="preview" variants={variants} initial="enter" animate="center" exit="exit" className="p-6 space-y-4">
                  <p className="text-sm text-slate-400">The following actions will be executed for <strong className="text-white">@{username}</strong>:</p>
                  <div className="space-y-2">
                    {PLANNED_STEPS.map((s) => (
                      <div key={s} className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/10">
                        <div className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                        <span className="text-sm text-slate-300">{s}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => setStep(0)} className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors">
                      Back
                    </button>
                    <button
                      onClick={handleExecute}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-red-500/20 border border-red-500/30 text-sm text-red-300 hover:bg-red-500/30 transition-colors"
                    >
                      Execute Offboarding
                    </button>
                  </div>
                </motion.div>
              )}

              {step === 2 && (
                <motion.div key="executing" variants={variants} initial="enter" animate="center" exit="exit" className="p-6 flex flex-col items-center gap-4 py-12">
                  <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
                  <p className="text-sm text-slate-400">Offboarding <strong className="text-white">@{username}</strong>…</p>
                </motion.div>
              )}

              {step === 3 && (
                <motion.div key="summary" variants={variants} initial="enter" animate="center" exit="exit" className="p-6 space-y-4">
                  <p className="text-sm font-medium text-white">Offboarding complete</p>
                  <div className="space-y-2">
                    {results.map((r) => (
                      <div key={r.name} className={`flex items-start gap-3 p-3 rounded-xl border ${r.success ? "bg-green-500/5 border-green-500/20" : "bg-red-500/5 border-red-500/20"}`}>
                        {r.success ? (
                          <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                        )}
                        <div className="min-w-0">
                          <p className={`text-sm font-medium ${r.success ? "text-green-300" : "text-red-300"}`}>{r.name}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{r.message}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button onClick={handleClose} className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors">
                    Close
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
