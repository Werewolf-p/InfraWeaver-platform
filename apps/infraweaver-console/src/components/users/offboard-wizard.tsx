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
  const [step, setStep] = useState(0);
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
      const response = await fetch(`/api/users/${username}/offboard`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed");
      setResults(data.steps ?? []);
      toast.success("Offboarding workflow completed");
      setStep(3);
    } catch (error) {
      toast.error(String(error));
      setStep(1);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#111] text-[#f2f2f2] shadow-2xl focus:outline-none">
          <div className="flex items-center justify-between border-b border-[#2a2a2a] px-6 py-4">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-[#f2f2f2]">
              <UserX className="h-4 w-4 text-red-400" />
              Offboard User
            </Dialog.Title>
            <button onClick={handleClose} className="rounded-lg p-1.5 text-[#888] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2]">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="overflow-hidden">
            <AnimatePresence mode="wait" initial={false}>
              {step === 0 ? (
                <motion.div key="confirm" variants={variants} initial="enter" animate="center" exit="exit" className="space-y-4 p-6">
                  <div className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-red-300">Confirm offboarding</p>
                      <p className="mt-1 text-xs leading-relaxed text-red-200/80">
                        This will disable <strong className="text-red-200">@{username}</strong>&apos;s account, revoke all tokens, remove group memberships, and remove them from the platform config.
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="mb-2 block text-xs text-[#888]">
                      Type <span className="font-mono text-[#f2f2f2]">{username}</span> to continue
                    </label>
                    <input
                      value={typed}
                      onChange={(event) => setTyped(event.target.value)}
                      placeholder={username}
                      className="w-full rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2.5 text-sm text-[#f2f2f2] placeholder:text-[#444] focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
                    />
                  </div>
                  <div className="flex gap-3">
                    <button onClick={handleClose} className="flex h-9 flex-1 items-center justify-center rounded-lg border border-[#2a2a2a] bg-transparent px-4 text-sm text-[#d4d4d4] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2] active:bg-[#1f1f1f]">Cancel</button>
                    <button
                      onClick={() => setStep(1)}
                      disabled={typed !== username}
                      className="flex h-9 flex-1 items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/20 active:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Continue
                    </button>
                  </div>
                </motion.div>
              ) : null}

              {step === 1 ? (
                <motion.div key="preview" variants={variants} initial="enter" animate="center" exit="exit" className="space-y-4 p-6">
                  <p className="text-sm text-[#d4d4d4]">The following actions will be executed for <strong className="text-[#f2f2f2]">@{username}</strong>:</p>
                  <div className="space-y-2">
                    {PLANNED_STEPS.map((plannedStep) => (
                      <div key={plannedStep} className="flex items-center gap-3 rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-3">
                        <div className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                        <span className="text-sm text-[#d4d4d4]">{plannedStep}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => setStep(0)} className="flex h-9 flex-1 items-center justify-center rounded-lg border border-[#2a2a2a] bg-transparent px-4 text-sm text-[#d4d4d4] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2] active:bg-[#1f1f1f]">Back</button>
                    <button
                      onClick={handleExecute}
                      className="flex h-9 flex-1 items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/20 active:bg-red-500/25"
                    >
                      Execute Offboarding
                    </button>
                  </div>
                </motion.div>
              ) : null}

              {step === 2 ? (
                <motion.div key="executing" variants={variants} initial="enter" animate="center" exit="exit" className="flex flex-col items-center gap-4 px-6 py-12 text-center">
                  <Loader2 className="h-8 w-8 animate-spin text-[#3b82f6]" />
                  <p className="text-sm text-[#d4d4d4]">Offboarding <strong className="text-[#f2f2f2]">@{username}</strong>…</p>
                </motion.div>
              ) : null}

              {step === 3 ? (
                <motion.div key="summary" variants={variants} initial="enter" animate="center" exit="exit" className="space-y-4 p-6">
                  <p className="text-sm font-medium text-[#f2f2f2]">Offboarding complete</p>
                  <div className="space-y-2">
                    {results.map((result) => (
                      <div key={result.name} className={`flex items-start gap-3 rounded-xl border p-3 ${result.success ? "border-emerald-500/20 bg-emerald-500/10" : "border-red-500/20 bg-red-500/10"}`}>
                        {result.success ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                        ) : (
                          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                        )}
                        <div className="min-w-0">
                          <p className={`text-sm font-medium ${result.success ? "text-emerald-300" : "text-red-300"}`}>{result.name}</p>
                          <p className="mt-0.5 text-xs text-[#888]">{result.message}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button onClick={handleClose} className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8]">Close</button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
