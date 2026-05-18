"use client";
import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Server, Database, HardDrive, Plus, Trash2, ChevronRight,
  CheckCircle2, XCircle, FolderOpen, Shield, Eye, Wifi, WifiOff,
  Loader2, AlertTriangle, Copy, Check,
} from "lucide-react";
import { toast } from "@/lib/notify";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  useNasProviders,
  useNasShares,
  useNasFolders,
  useNasAssignments,
  useNasAssign,
  useNasUnassign,
  type NasProvider,
  type NasShare,
  type NasAssignment,
} from "@/hooks/use-nas";
import type { PlatformUser } from "@/hooks/use-users-config";

interface StorageTabProps {
  users: PlatformUser[];
  isAdmin: boolean;
}

function ProviderCard({ provider }: { provider: NasProvider }) {
  const Icon = provider.id === "synology" ? Server : Database;
  return (
    <div className="bg-gray-100 dark:bg-white/5 backdrop-blur-sm border border-gray-200 dark:border-white/10 rounded-xl p-4 flex items-center gap-4">
      <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0",
        provider.reachable ? "bg-emerald-500/15 border border-emerald-500/30" : "bg-red-500/10 border border-red-500/20"
      )}>
        <Icon className={cn("w-5 h-5", provider.reachable ? "text-emerald-400" : "text-red-400")} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 dark:text-white">{provider.name}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{provider.host}:{provider.port}</p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {provider.reachable ? (
          <>
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-emerald-400 font-medium">Online</span>
          </>
        ) : !provider.enabled ? (
          <>
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            <span className="text-xs text-slate-500 dark:text-slate-400">Not configured</span>
          </>
        ) : (
          <>
            <span className="w-2 h-2 rounded-full bg-red-400" />
            <span className="text-xs text-red-400">Offline</span>
          </>
        )}
      </div>
    </div>
  );
}

function AccessBadge({ access }: { access: string }) {
  return (
    <span className={cn(
      "text-[11px] px-2 py-0.5 rounded-full border font-medium",
      access === "readwrite"
        ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
        : "bg-amber-500/10 border-amber-500/20 text-amber-400"
    )}>
      {access === "readwrite" ? "RW" : "RO"}
    </span>
  );
}

function DeleteConfirmDialog({
  username,
  assignment,
  onConfirm,
  onCancel,
  loading,
}: {
  username: string;
  assignment: NasAssignment;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-slate-100 dark:bg-slate-900 border border-gray-200 dark:border-white/10 rounded-xl p-6 max-w-md w-full"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Revoke Share Access</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">This will delete the K8s manifest from git</p>
          </div>
        </div>
        <p className="text-sm text-slate-700 dark:text-slate-300 mb-6">
          Remove <span className="font-mono text-gray-900 dark:text-white">{assignment.share}/{assignment.subfolder}</span> from{" "}
          <span className="text-emerald-400">@{username}</span>? The PVC and StorageClass will be deleted by ArgoCD.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-slate-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-sm text-red-300 hover:bg-red-500/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Revoke
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Step-by-step assign wizard ────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4 | 5;

interface WizardState {
  username: string;
  provider: "synology" | "truenas" | "";
  share: string;
  subfolder: string;
  access: "readonly" | "readwrite";
  pvc_namespace: string;
  pvc_name: string;
}

function generatePvcName(username: string, share: string) {
  if (!username || !share) return "";
  return `nas-${username}-${share.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

function generateYaml(state: WizardState): string {
  const host = state.provider === "synology" ? "10.25.0.21" : "10.25.0.135";
  const scName = `smb-${state.username}-${state.share.toLowerCase()}`;
  return `---
# NAS Share: ${state.username} → ${state.provider}:${state.share}/${state.subfolder}
# Generated by InfraWeaver Console
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${scName}
provisioner: smb.csi.k8s.io
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: false
parameters:
  source: "//${host}/${state.share}"
  subDir: "${state.subfolder}"
  csi.storage.k8s.io/provisioner-secret-name: synology-smb-credentials
  csi.storage.k8s.io/provisioner-secret-namespace: ${state.pvc_namespace}
  csi.storage.k8s.io/node-stage-secret-name: synology-smb-credentials
  csi.storage.k8s.io/node-stage-secret-namespace: ${state.pvc_namespace}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${state.pvc_name}
  namespace: ${state.pvc_namespace}
  labels:
    infraweaver.io/nas-share: "true"
    infraweaver.io/user: "${state.username}"
    infraweaver.io/provider: "${state.provider}"
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: ${scName}
  resources:
    requests:
      storage: 100Gi`;
}

const STEP_LABELS: Record<Step, string> = {
  1: "Select User",
  2: "Select Provider",
  3: "Select Share",
  4: "Configure",
  5: "Review & Confirm",
};

function StepIndicator({ current, total }: { current: Step; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-6">
      {Array.from({ length: total }, (_, i) => i + 1).map(step => (
        <div key={step} className="flex items-center gap-2">
          <div className={cn(
            "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all",
            step < current ? "bg-emerald-500/30 border border-emerald-500/50 text-emerald-400" :
            step === current ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300" :
            "bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-slate-500"
          )}>
            {step < current ? <Check className="w-3 h-3" /> : step}
          </div>
          {step < total && (
            <div className={cn("h-px w-6", step < current ? "bg-emerald-500/30" : "bg-gray-100 dark:bg-white/10")} />
          )}
        </div>
      ))}
      <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">{STEP_LABELS[current]}</span>
    </div>
  );
}

function AssignWizard({
  users,
  providers,
  onClose,
}: {
  users: PlatformUser[];
  providers: NasProvider[];
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [state, setState] = useState<WizardState>({
    username: "",
    provider: "",
    share: "",
    subfolder: "",
    access: "readwrite",
    pvc_namespace: "plex",
    pvc_name: "",
  });
  const [copied, setCopied] = useState(false);
  const assignMutation = useNasAssign();

  const { data: shares = [], isLoading: sharesLoading } = useNasShares(state.provider || null);
  const { data: folders = [], isLoading: foldersLoading } = useNasFolders(
    state.provider || null,
    state.share || null
  );

  const updateState = useCallback((partial: Partial<WizardState>) => {
    setState(prev => {
      const next = { ...prev, ...partial };
      if (partial.username !== undefined || partial.share !== undefined) {
        next.pvc_name = generatePvcName(next.username, next.share);
      }
      if (partial.username !== undefined) {
        next.subfolder = partial.username;
      }
      return next;
    });
  }, []);

  const canNext = (): boolean => {
    if (step === 1) return !!state.username;
    if (step === 2) return !!state.provider;
    if (step === 3) return !!state.share;
    if (step === 4) return !!state.pvc_namespace && !!state.pvc_name;
    return true;
  };

  const handleConfirm = async () => {
    try {
      await assignMutation.mutateAsync({
        username: state.username,
        provider: state.provider as "synology" | "truenas",
        share: state.share,
        subfolder: state.subfolder,
        access: state.access,
        pvc_namespace: state.pvc_namespace,
        pvc_name: state.pvc_name,
      });
      toast.success(`Share assigned to @${state.username} — ArgoCD will sync shortly`);
      onClose();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const copyYaml = () => {
    navigator.clipboard.writeText(generateYaml(state)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: "100%", opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="bg-slate-100 dark:bg-slate-900 border border-gray-200 dark:border-white/10 rounded-t-2xl sm:rounded-xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-200 dark:border-white/10 sticky top-0 bg-slate-100 dark:bg-slate-900 z-10">
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-emerald-400" />
              Assign NAS Share
            </h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
            <XCircle className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5">
          <StepIndicator current={step} total={5} />

          <AnimatePresence mode="wait">
            {/* Step 1: Select user */}
            {step === 1 && (
              <motion.div key="step1" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }}>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Choose which user will get access to this share</p>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {users.map(u => (
                    <button
                      key={u.username}
                      onClick={() => updateState({ username: u.username })}
                      className={cn(
                        "w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all",
                        state.username === u.username
                          ? "bg-emerald-500/10 border-emerald-500/40"
                          : "bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/[0.08]"
                      )}
                    >
                      <div className="w-8 h-8 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300 flex-shrink-0">
                        {(u.name || u.username)[0]?.toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-white">{u.name}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">@{u.username} · {u.access_level}</p>
                      </div>
                      {state.username === u.username && <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Step 2: Select provider */}
            {step === 2 && (
              <motion.div key="step2" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }}>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Select a NAS provider</p>
                <div className="space-y-3">
                  {providers.map(p => {
                    const Icon = p.id === "synology" ? Server : Database;
                    return (
                      <button
                        key={p.id}
                        onClick={() => p.reachable && updateState({ provider: p.id as "synology" | "truenas", share: "", subfolder: state.username })}
                        disabled={!p.reachable}
                        className={cn(
                          "w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all",
                          state.provider === p.id
                            ? "bg-emerald-500/10 border-emerald-500/40"
                            : p.reachable
                            ? "bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/[0.08]"
                            : "bg-gray-50 dark:bg-white/[0.02] border-gray-200 dark:border-white/5 opacity-50 cursor-not-allowed"
                        )}
                      >
                        <div className={cn(
                          "w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0",
                          p.reachable ? "bg-emerald-500/15 border border-emerald-500/30" : "bg-red-500/10 border border-red-500/20"
                        )}>
                          <Icon className={cn("w-5 h-5", p.reachable ? "text-emerald-400" : "text-red-400")} />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-gray-900 dark:text-white">{p.name}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">{p.host}</p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {p.reachable
                            ? <><Wifi className="w-3 h-3 text-emerald-400" /><span className="text-xs text-emerald-400">Online</span></>
                            : <><WifiOff className="w-3 h-3 text-red-400" /><span className="text-xs text-red-400">Offline</span></>
                          }
                        </div>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {/* Step 3: Select share + subfolder */}
            {step === 3 && (
              <motion.div key="step3" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} className="space-y-4">
                <div>
                  <label className="text-xs text-slate-500 dark:text-slate-400 mb-2 block">Share</label>
                  {sharesLoading ? (
                    <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {shares.map((s: NasShare) => (
                        <button
                          key={s.name}
                          onClick={() => updateState({ share: s.name })}
                          className={cn(
                            "w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all",
                            state.share === s.name
                              ? "bg-emerald-500/10 border-emerald-500/40"
                              : "bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/[0.08]"
                          )}
                        >
                          <FolderOpen className={cn("w-4 h-4 flex-shrink-0", state.share === s.name ? "text-emerald-400" : "text-slate-500 dark:text-slate-400")} />
                          <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-white">{s.name}</p>
                            {s.desc && <p className="text-xs text-slate-500 dark:text-slate-400">{s.desc}</p>}
                          </div>
                          {state.share === s.name && <CheckCircle2 className="w-4 h-4 text-emerald-400 ml-auto flex-shrink-0" />}
                        </button>
                      ))}
                      {shares.length === 0 && <p className="text-sm text-slate-500 py-4 text-center">No shares found</p>}
                    </div>
                  )}
                </div>

                {state.share && (
                  <div>
                    <label className="text-xs text-slate-500 dark:text-slate-400 mb-2 block">Subfolder (optional)</label>
                    <input
                      value={state.subfolder}
                      onChange={e => updateState({ subfolder: e.target.value })}
                      placeholder={state.username}
                      className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-gray-900 dark:text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 mb-3"
                    />
                    {foldersLoading ? (
                      <div className="space-y-1">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
                    ) : folders.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {folders.map(f => (
                          <button
                            key={f.name}
                            onClick={() => updateState({ subfolder: f.name })}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-xs border transition-all",
                              state.subfolder === f.name
                                ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                                : "bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-white/10"
                            )}
                          >
                            {f.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </motion.div>
            )}

            {/* Step 4: Configure */}
            {step === 4 && (
              <motion.div key="step4" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} className="space-y-4">
                <div>
                  <label className="text-xs text-slate-500 dark:text-slate-400 mb-2 block">Access Level</label>
                  <div className="grid grid-cols-2 gap-3">
                    {(["readwrite", "readonly"] as const).map(a => (
                      <button
                        key={a}
                        onClick={() => updateState({ access: a })}
                        className={cn(
                          "flex items-center gap-2 p-3 rounded-lg border transition-all",
                          state.access === a
                            ? a === "readwrite"
                              ? "bg-emerald-500/10 border-emerald-500/40"
                              : "bg-amber-500/10 border-amber-500/40"
                            : "bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/[0.08]"
                        )}
                      >
                        {a === "readwrite" ? <Shield className="w-4 h-4 text-emerald-400" /> : <Eye className="w-4 h-4 text-amber-400" />}
                        <span className="text-sm text-gray-900 dark:text-white">{a === "readwrite" ? "Read-Write" : "Read-Only"}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-500 dark:text-slate-400 mb-2 block">PVC Namespace</label>
                  <input
                    value={state.pvc_namespace}
                    onChange={e => updateState({ pvc_namespace: e.target.value })}
                    placeholder="plex"
                    className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-gray-900 dark:text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500 dark:text-slate-400 mb-2 block">PVC Name</label>
                  <input
                    value={state.pvc_name}
                    onChange={e => updateState({ pvc_name: e.target.value })}
                    placeholder={generatePvcName(state.username, state.share)}
                    className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-gray-900 dark:text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 font-mono"
                  />
                </div>
              </motion.div>
            )}

            {/* Step 5: Review */}
            {step === 5 && (
              <motion.div key="step5" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-gray-100 dark:bg-white/5 rounded-lg p-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">User</p>
                    <p className="text-gray-900 dark:text-white font-medium">@{state.username}</p>
                  </div>
                  <div className="bg-gray-100 dark:bg-white/5 rounded-lg p-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">Provider</p>
                    <p className="text-gray-900 dark:text-white font-medium capitalize">{state.provider}</p>
                  </div>
                  <div className="bg-gray-100 dark:bg-white/5 rounded-lg p-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">Share / Subfolder</p>
                    <p className="text-gray-900 dark:text-white font-mono text-xs">{state.share}/{state.subfolder}</p>
                  </div>
                  <div className="bg-gray-100 dark:bg-white/5 rounded-lg p-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">Access</p>
                    <AccessBadge access={state.access} />
                  </div>
                  <div className="col-span-2 bg-gray-100 dark:bg-white/5 rounded-lg p-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">PVC</p>
                    <p className="text-gray-900 dark:text-white font-mono text-xs">{state.pvc_namespace}/{state.pvc_name}</p>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Generated K8s Manifest</p>
                    <button
                      onClick={copyYaml}
                      className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                    >
                      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="bg-slate-100 dark:bg-slate-950 border border-gray-200 dark:border-white/10 rounded-lg p-4 text-xs text-slate-700 dark:text-slate-300 overflow-x-auto max-h-56 leading-relaxed font-mono whitespace-pre">
                    {generateYaml(state)}
                  </pre>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Navigation */}
          <div className="flex gap-3 mt-6 pt-4 border-t border-gray-200 dark:border-white/10">
            {step > 1 && (
              <button
                onClick={() => setStep(s => (s - 1) as Step)}
                className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-slate-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
              >
                Back
              </button>
            )}
            {step < 5 ? (
              <button
                onClick={() => canNext() && setStep(s => (s + 1) as Step)}
                disabled={!canNext()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-sm text-emerald-300 hover:bg-emerald-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={handleConfirm}
                disabled={assignMutation.isPending}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-sm text-emerald-300 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
              >
                {assignMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 animate-spin" />Committing to git...</>
                ) : (
                  <><CheckCircle2 className="w-4 h-4" />Confirm & Commit</>
                )}
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Main StorageTab component ──────────────────────────────────────────────────

export function StorageTab({ users, isAdmin }: StorageTabProps) {
  const { data: providers = [], isLoading: providersLoading } = useNasProviders();
  const { data: assignments = [], isLoading: assignmentsLoading } = useNasAssignments();
  const unassignMutation = useNasUnassign();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ username: string; assignment: NasAssignment } | null>(null);

  const flatAssignments = assignments.flatMap(ua =>
    ua.nas_shares.map(s => ({ ...s, username: ua.username, name: ua.name }))
  );

  const handleRevoke = async () => {
    if (!deleteTarget) return;
    try {
      await unassignMutation.mutateAsync({
        username: deleteTarget.username,
        provider: deleteTarget.assignment.provider,
        share: deleteTarget.assignment.share,
        subfolder: deleteTarget.assignment.subfolder,
      });
      toast.success(`Revoked access for @${deleteTarget.username}`);
      setDeleteTarget(null);
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="space-y-6">
      {/* Provider status cards */}
      <div>
        <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 mb-3 uppercase tracking-wide">Provider Status</h3>
        {providersLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {providers.map(p => <ProviderCard key={p.id} provider={p} />)}
          </div>
        )}
      </div>

      {/* Assignments table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            Share Assignments
            {flatAssignments.length > 0 && (
              <span className="ml-2 text-xs normal-case text-slate-500">({flatAssignments.length})</span>
            )}
          </h3>
          {isAdmin && (
            <button
              onClick={() => setWizardOpen(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-xs text-emerald-300 hover:bg-emerald-500/30 transition-colors active:scale-95"
            >
              <Plus className="w-3.5 h-3.5" />
              Assign Share
            </button>
          )}
        </div>

        {assignmentsLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14" />)}
          </div>
        ) : flatAssignments.length === 0 ? (
          <div className="bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl py-16 flex flex-col items-center gap-3">
            <HardDrive className="w-10 h-10 text-slate-600" />
            <p className="text-sm text-slate-500 dark:text-slate-400">No shares assigned yet</p>
            {isAdmin && (
              <button
                onClick={() => setWizardOpen(true)}
                className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
              >
                Assign the first share →
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
              <div className="grid grid-cols-[2fr_2fr_auto_2fr_auto] gap-4 px-4 py-2.5 border-b border-gray-200 dark:border-white/5">
                <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">User</span>
                <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Share</span>
                <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Access</span>
                <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">PVC</span>
                {isAdmin && <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Actions</span>}
              </div>
              <AnimatePresence mode="popLayout">
                {flatAssignments.map((a, i) => (
                  <motion.div
                    key={`${a.username}-${a.share}-${a.subfolder}-${i}`}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ delay: i * 0.03 }}
                    className="grid grid-cols-[2fr_2fr_auto_2fr_auto] gap-4 items-center px-4 py-3 border-b border-gray-200 dark:border-white/5 last:border-0 hover:bg-white/[0.03] transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300 flex-shrink-0">
                        {(a.name || a.username)[0]?.toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm text-gray-900 dark:text-white truncate">{a.name}</p>
                        <p className="text-xs text-slate-500">@{a.username}</p>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm text-gray-900 dark:text-white font-mono truncate">{a.share}/{a.subfolder}</p>
                      <p className="text-xs text-slate-500 capitalize">{a.provider}</p>
                    </div>
                    <AccessBadge access={a.access} />
                    <div className="min-w-0">
                      <p className="text-xs text-slate-700 dark:text-slate-300 font-mono truncate">{a.pvc_name ?? "—"}</p>
                      <p className="text-xs text-slate-500">{a.pvc_namespace ?? "—"}</p>
                    </div>
                    {isAdmin && (
                      <button
                        onClick={() => setDeleteTarget({ username: a.username, assignment: a })}
                        className="p-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors active:scale-95"
                        title="Revoke access"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-3">
              {flatAssignments.map((a, i) => (
                <div key={`${a.username}-${a.share}-${i}`} className="bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300">
                        {(a.name || a.username)[0]?.toUpperCase()}
                      </div>
                      <span className="text-sm font-medium text-gray-900 dark:text-white">@{a.username}</span>
                    </div>
                    <AccessBadge access={a.access} />
                  </div>
                  <div className="space-y-1 text-xs mb-3">
                    <p className="text-slate-500 dark:text-slate-400"><span className="text-slate-500">Share: </span><span className="font-mono text-slate-700 dark:text-slate-300">{a.share}/{a.subfolder}</span></p>
                    <p className="text-slate-500 dark:text-slate-400"><span className="text-slate-500">Provider: </span><span className="capitalize">{a.provider}</span></p>
                    <p className="text-slate-500 dark:text-slate-400"><span className="text-slate-500">PVC: </span><span className="font-mono text-slate-700 dark:text-slate-300">{a.pvc_name}</span></p>
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => setDeleteTarget({ username: a.username, assignment: a })}
                      className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400 hover:bg-red-500/20 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Revoke Access
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Wizard */}
      <AnimatePresence>
        {wizardOpen && (
          <AssignWizard
            users={users}
            providers={providers}
            onClose={() => setWizardOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Delete confirm */}
      <AnimatePresence>
        {deleteTarget && (
          <DeleteConfirmDialog
            username={deleteTarget.username}
            assignment={deleteTarget.assignment}
            onConfirm={handleRevoke}
            onCancel={() => setDeleteTarget(null)}
            loading={unassignMutation.isPending}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
