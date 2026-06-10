"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  HardDrive,
  Server,
  Database,
  GitBranch,
  Clock,
  Settings,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface DeleteResource {
  icon: React.ReactNode;
  label: string;
  detail?: string;
}

type DeletePhase = "confirm" | "deleting" | "done" | "error";

interface DeletionStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "skipped";
}

const DELETION_STEPS: DeletionStep[] = [
  { id: "git", label: "Removing git manifest", status: "pending" },
  { id: "deployment", label: "Deleting deployment", status: "pending" },
  { id: "service", label: "Removing service & ports", status: "pending" },
  { id: "config", label: "Cleaning up config & secrets", status: "pending" },
  { id: "cronjobs", label: "Removing scheduled jobs", status: "pending" },
  { id: "storage", label: "Deleting persistent storage", status: "pending" },
];

interface DeleteServerModalProps {
  open: boolean;
  serverName: string;
  hasPvc: boolean;
  hasCronJobs: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteServerModal({
  open,
  serverName,
  hasPvc,
  hasCronJobs,
  onClose,
  onDeleted,
}: DeleteServerModalProps) {
  const [phase, setPhase] = useState<DeletePhase>("confirm");
  const [typedName, setTypedName] = useState("");
  const [steps, setSteps] = useState<DeletionStep[]>(DELETION_STEPS);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isMatch = typedName === serverName;

  useEffect(() => {
    if (!open) {
      setPhase("confirm");
      setTypedName("");
      setSteps(DELETION_STEPS);
      setErrorMsg(null);
    } else {
      setTimeout(() => inputRef.current?.focus(), 120);
    }
  }, [open]);

  const resources: DeleteResource[] = [
    {
      icon: <Server className="w-3.5 h-3.5" />,
      label: "Deployment & pods",
      detail: serverName,
    },
    {
      icon: <Settings className="w-3.5 h-3.5" />,
      label: "Service, ConfigMaps & Secrets",
    },
    ...(hasCronJobs
      ? [
          {
            icon: <Clock className="w-3.5 h-3.5" />,
            label: "Scheduled jobs (restart, backup, start/stop)",
          },
        ]
      : []),
    ...(hasPvc
      ? [
          {
            icon: <HardDrive className="w-3.5 h-3.5" />,
            label: "Persistent storage (all game data)",
            detail: "⚠ Cannot be recovered",
          },
        ]
      : []),
    {
      icon: <GitBranch className="w-3.5 h-3.5" />,
      label: "Git manifest",
      detail: `kubernetes/catalog/game-hub/servers/${serverName}.yaml`,
    },
    {
      icon: <Database className="w-3.5 h-3.5" />,
      label: "Audit log & token records",
    },
  ];

  function advanceSteps(ids: string[]) {
    setSteps((prev) =>
      prev.map((s) => (ids.includes(s.id) ? { ...s, status: "done" } : s)),
    );
  }

  async function handleDelete() {
    if (!isMatch) {
      setShake(true);
      setTimeout(() => setShake(false), 500);
      return;
    }

    setPhase("deleting");

    // Animate steps in sequence while real deletion happens
    const stepDelay = (id: string, ms: number) =>
      new Promise<void>((res) => {
        setTimeout(() => {
          setSteps((prev) =>
            prev.map((s) =>
              s.id === id ? { ...s, status: "running" } : s,
            ),
          );
          res();
        }, ms);
      });

    // Start animated progression
    void stepDelay("git", 0);
    void stepDelay("deployment", 400);
    void stepDelay("service", 700);
    void stepDelay("config", 1000);
    void stepDelay("cronjobs", 1200);
    void stepDelay("storage", 1500);

    try {
      const res = await fetch(`/api/game-hub/servers/${serverName}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as {
        deleted?: boolean;
        error?: string;
      };

      if (!res.ok) {
        throw new Error(data.error ?? `Server returned ${res.status}`);
      }

      // Mark all steps done
      setTimeout(() => {
        advanceSteps(["git", "deployment", "service", "config", "cronjobs", "storage"]);
        if (!hasPvc)
          setSteps((prev) =>
            prev.map((s) =>
              s.id === "storage" ? { ...s, status: "skipped" } : s,
            ),
          );
        if (!hasCronJobs)
          setSteps((prev) =>
            prev.map((s) =>
              s.id === "cronjobs" ? { ...s, status: "skipped" } : s,
            ),
          );
        setTimeout(() => setPhase("done"), 400);
      }, 200);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && phase !== "deleting" && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed inset-x-0 bottom-0 top-0 z-[61] w-full overflow-y-auto bg-white dark:bg-[#111] p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] pt-[calc(env(safe-area-inset-top,0px)+1rem)] text-gray-900 dark:text-[#f2f2f2] shadow-2xl focus:outline-none sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:border-gray-200 dark:border-[#2a2a2a] sm:p-6"
          onInteractOutside={(e) => phase === "deleting" && e.preventDefault()}
        >
          <AnimatePresence mode="wait">
            {/* ── CONFIRM PHASE ── */}
            {phase === "confirm" && (
              <motion.div
                key="confirm"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
              >
                <button
                  onClick={onClose}
                  className="absolute top-4 right-4 p-1.5 rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-[#f2f2f2] hover:bg-gray-100 dark:hover:bg-[#1a1a1a]"
                >
                  <X className="w-4 h-4" />
                </button>

                <div className="flex items-start gap-3 mb-5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-red-500/20 bg-red-500/10">
                    <AlertTriangle className="h-5 w-5 text-red-400" />
                  </div>
                  <div>
                    <Dialog.Title className="text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">
                      Delete <span className="font-mono text-red-400">{serverName}</span>?
                    </Dialog.Title>
                    <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-[#888]">
                      This permanently removes all server resources. It cannot be undone.
                    </Dialog.Description>
                  </div>
                </div>

                {/* Resource list */}
                <div className="mb-5 rounded-lg border border-red-500/15 bg-red-500/5 divide-y divide-red-500/10">
                  {resources.map((r, i) => (
                    <div key={i} className="flex items-center gap-2.5 px-3 py-2">
                      <span className="text-red-400/70 shrink-0">{r.icon}</span>
                      <span className="text-sm text-gray-700 dark:text-[#ccc]">{r.label}</span>
                      {r.detail && (
                        <span className="ml-auto text-xs text-gray-400 dark:text-[#666] font-mono truncate max-w-[40%]">
                          {r.detail}
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Type to confirm */}
                <div className="space-y-1.5 mb-6">
                  <p className="text-xs text-gray-500 dark:text-[#888]">
                    Type{" "}
                    <span className="font-mono font-semibold text-gray-900 dark:text-[#f2f2f2]">
                      {serverName}
                    </span>{" "}
                    to confirm deletion:
                  </p>
                  <motion.div animate={shake ? { x: [-6, 6, -5, 5, -3, 3, 0] } : { x: 0 }} transition={{ duration: 0.4 }}>
                    <input
                      ref={inputRef}
                      value={typedName}
                      onChange={(e) => setTypedName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && isMatch && void handleDelete()}
                      placeholder={serverName}
                      className={cn(
                        "w-full rounded-lg border bg-white dark:bg-[#0d0d0d] px-3 py-2 text-sm font-mono text-gray-900 dark:text-[#f2f2f2] placeholder:text-gray-400 dark:placeholder:text-[#444] transition-colors focus:outline-none focus:ring-1 focus:ring-red-500/50",
                        typedName === "" ? "border-gray-200 dark:border-[#2a2a2a]"
                          : isMatch ? "border-emerald-500/40"
                          : "border-red-500/30",
                      )}
                    />
                  </motion.div>
                  {typedName.length > 0 && !isMatch && (
                    <p className="text-xs text-red-400">Doesn&apos;t match — keep typing</p>
                  )}
                  {isMatch && typedName.length > 0 && (
                    <p className="text-xs text-emerald-400">✓ Confirmed</p>
                  )}
                </div>

                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <button
                    onClick={onClose}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 dark:border-[#2a2a2a] px-4 text-sm text-gray-700 dark:text-[#d4d4d4] hover:bg-gray-100 dark:hover:bg-[#1a1a1a]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handleDelete()}
                    disabled={!isMatch}
                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-sm font-medium text-red-400 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                  >
                    Permanently Delete Server
                  </button>
                </div>
              </motion.div>
            )}

            {/* ── DELETING PHASE ── */}
            {phase === "deleting" && (
              <motion.div
                key="deleting"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="py-2"
              >
                <div className="flex items-center gap-3 mb-6">
                  <Loader2 className="w-5 h-5 text-red-400 animate-spin shrink-0" />
                  <div>
                    <p className="text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">
                      Deleting <span className="font-mono text-red-400">{serverName}</span>
                    </p>
                    <p className="text-sm text-gray-500 dark:text-[#888]">Please don&apos;t close this page…</p>
                  </div>
                </div>

                <div className="space-y-2">
                  {steps.map((step) => (
                    <div key={step.id} className="flex items-center gap-3">
                      <div className="w-5 h-5 shrink-0 flex items-center justify-center">
                        {step.status === "done" && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                        {step.status === "running" && <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />}
                        {step.status === "skipped" && <span className="w-4 h-4 flex items-center justify-center text-gray-400 text-xs">—</span>}
                        {step.status === "pending" && <div className="w-2 h-2 rounded-full bg-gray-300 dark:bg-[#3a3a3a]" />}
                      </div>
                      <span
                        className={cn(
                          "text-sm",
                          step.status === "done" && "text-emerald-400",
                          step.status === "running" && "text-blue-400",
                          step.status === "skipped" && "text-gray-400 line-through",
                          step.status === "pending" && "text-gray-400 dark:text-[#666]",
                        )}
                      >
                        {step.label}
                      </span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* ── DONE PHASE ── */}
            {phase === "done" && (
              <motion.div
                key="done"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="py-4 flex flex-col items-center text-center gap-4"
              >
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 300, damping: 20 }}
                >
                  <CheckCircle2 className="w-12 h-12 text-emerald-400" />
                </motion.div>
                <div>
                  <p className="text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">
                    Server deleted
                  </p>
                  <p className="text-sm text-gray-500 dark:text-[#888] mt-1">
                    <span className="font-mono">{serverName}</span> and all its resources have been removed.
                  </p>
                </div>
                <button
                  onClick={onDeleted}
                  className="mt-2 px-6 py-2 bg-[#3b82f6] hover:bg-[#2563eb] text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Back to Game Hub
                </button>
              </motion.div>
            )}

            {/* ── ERROR PHASE ── */}
            {phase === "error" && (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="py-2"
              >
                <button
                  onClick={onClose}
                  className="absolute top-4 right-4 p-1.5 rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-[#f2f2f2] hover:bg-gray-100 dark:hover:bg-[#1a1a1a]"
                >
                  <X className="w-4 h-4" />
                </button>

                <div className="flex items-start gap-3 mb-4">
                  <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">
                      Deletion failed
                    </p>
                    <p className="mt-1 text-sm text-gray-500 dark:text-[#888] font-mono break-all">
                      {errorMsg}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 mb-5">
                  <p className="text-xs text-amber-400">
                    Some resources may have been partially removed. Check the cluster and git repo for any remaining resources.
                  </p>
                </div>

                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <button
                    onClick={onClose}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 dark:border-[#2a2a2a] px-4 text-sm text-gray-700 dark:text-[#d4d4d4] hover:bg-gray-100 dark:hover:bg-[#1a1a1a]"
                  >
                    Close
                  </button>
                  <button
                    onClick={() => {
                      setPhase("confirm");
                      setSteps(DELETION_STEPS.map((s) => ({ ...s, status: "pending" })));
                      setErrorMsg(null);
                    }}
                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-sm font-medium text-red-400 hover:bg-red-500/20"
                  >
                    Retry deletion
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
