"use client";

import React, { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  GitBranch,
  ArrowUp,
  Zap,
  RefreshCw,
  Package,
  Settings,
  ChevronDown,
  ChevronUp,
  Loader2,
  Check,
} from "lucide-react";
import { toast } from "@/lib/notify";
import { useRBAC } from "@/hooks/use-rbac";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

type UpdateSchedule = "continuous" | "daily" | "weekly" | "monthly" | "manual";
type UpdateStrategy = "semver-patch" | "semver-minor" | "semver-major" | "digest" | "newest-build";
type DeploymentStrategy = "rolling" | "recreate";

interface UpdatePolicy {
  enabled: boolean;
  schedule: UpdateSchedule;
  strategy: UpdateStrategy;
  deploymentStrategy: DeploymentStrategy;
  includePreRelease: boolean;
  minimumAge: "none" | "7d" | "14d" | "30d";
  autoMerge: boolean;
  imageRef?: string;
  imageConstraint?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STRATEGY_OPTIONS: Array<{
  value: UpdateStrategy;
  icon: React.ElementType;
  label: string;
  desc: string;
}> = [
  { value: "semver-patch", icon: GitBranch, label: "Patch only", desc: "Security & bug fixes (1.2.3 → 1.2.4)" },
  { value: "semver-minor", icon: ArrowUp, label: "Minor + Patch", desc: "New features + bug fixes (1.2.3 → 1.3.0)" },
  { value: "semver-major", icon: Zap, label: "Any version", desc: "All updates including major (1.x → 2.x)" },
  { value: "digest", icon: RefreshCw, label: "Track digest", desc: "Always follow :latest by digest" },
  { value: "newest-build", icon: Package, label: "Newest build", desc: "Always the newest built image" },
];

const SCHEDULE_OPTIONS: Array<{
  value: UpdateSchedule;
  label: string;
  desc: string;
  badge: string;
  badgeColor: string;
}> = [
  { value: "continuous", label: "Continuous", desc: "Update within ~2 min of new release", badge: "ArgoCD Image Updater", badgeColor: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  { value: "daily", label: "Daily", desc: "Every day between 2–4 AM", badge: "Renovate", badgeColor: "bg-violet-500/15 text-violet-400 border-violet-500/30" },
  { value: "weekly", label: "Weekly", desc: "Monday between 2–4 AM", badge: "Renovate", badgeColor: "bg-violet-500/15 text-violet-400 border-violet-500/30" },
  { value: "monthly", label: "Monthly", desc: "1st of month between 2–4 AM", badge: "Renovate", badgeColor: "bg-violet-500/15 text-violet-400 border-violet-500/30" },
  { value: "manual", label: "Manual", desc: "Create PR for review, never auto-merge", badge: "Renovate", badgeColor: "bg-[#333]/50 text-[#9e9e9e] border-[#444]" },
];

const DEPLOYMENT_OPTIONS: Array<{
  value: DeploymentStrategy;
  label: string;
  desc: string;
}> = [
  { value: "rolling", label: "Rolling Update", desc: "Zero downtime, gradual pod replacement" },
  { value: "recreate", label: "Recreate", desc: "Stop all pods, then start new (brief outage)" },
];

const MIN_AGE_OPTIONS: Array<{ value: UpdatePolicy["minimumAge"]; label: string }> = [
  { value: "none", label: "None — update immediately" },
  { value: "7d", label: "7 days — cautious" },
  { value: "14d", label: "14 days — n-1 stable" },
  { value: "30d", label: "30 days — very conservative" },
];

const DEFAULT_POLICY: UpdatePolicy = {
  enabled: true,
  schedule: "weekly",
  strategy: "semver-minor",
  deploymentStrategy: "rolling",
  includePreRelease: false,
  minimumAge: "7d",
  autoMerge: true,
  imageRef: undefined,
  imageConstraint: undefined,
};

// ── Toggle component ──────────────────────────────────────────────────────────

function Toggle({
  value,
  onChange,
  label,
  subtitle,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
  subtitle?: string;
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="flex items-center justify-between w-full min-h-[44px] touch-manipulation text-left"
    >
      <div>
        <p className="text-sm font-medium text-[#f2f2f2]">{label}</p>
        {subtitle && <p className="text-xs text-[#9e9e9e] mt-0.5">{subtitle}</p>}
      </div>
      <div
        className={cn(
          "relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ml-4",
          value ? "bg-[#0078D4]" : "bg-[#333]"
        )}
      >
        <span
          className={cn(
            "absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform shadow-sm",
            value && "translate-x-5"
          )}
        />
      </div>
    </button>
  );
}

// ── Info bar ──────────────────────────────────────────────────────────────────

function EngineInfoBar({ policy }: { policy: UpdatePolicy }) {
  if (!policy.enabled) {
    return (
      <div className="rounded-lg border border-[#2a2a2a] bg-[#141414] px-4 py-3 text-xs text-[#9e9e9e]">
        🚫 Auto-updates are disabled. Image tags will not be updated automatically.
      </div>
    );
  }
  if (policy.schedule === "continuous" || policy.strategy === "newest-build") {
    return (
      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-xs text-[#9e9e9e]">
        🤖 <span className="text-blue-400 font-medium">ArgoCD Image Updater</span> will monitor the registry every ~2 min and commit image tag updates directly to Git.
      </div>
    );
  }
  if (policy.schedule === "manual") {
    return (
      <div className="rounded-lg border border-[#2a2a2a] bg-[#141414] px-4 py-3 text-xs text-[#9e9e9e]">
        👤 <span className="text-[#f2f2f2] font-medium">Renovate</span> will open a PR when updates are available. You review and merge.
      </div>
    );
  }
  const scheduleLabel = SCHEDULE_OPTIONS.find(s => s.value === policy.schedule)?.label ?? policy.schedule;
  return (
    <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 px-4 py-3 text-xs text-[#9e9e9e]">
      📅 <span className="text-violet-400 font-medium">Renovate</span> will run on a <span className="text-[#f2f2f2]">{scheduleLabel}</span> schedule and open a PR (or auto-merge) to update image tags in Git.
    </div>
  );
}

// ── Portal ────────────────────────────────────────────────────────────────────

function BodyPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

// ── Main Modal ────────────────────────────────────────────────────────────────

interface UpdatePolicyModalProps {
  appName: string;
  appSlug: string;
  imageRef?: string;
  open: boolean;
  onClose: () => void;
}

export function UpdatePolicyModal({ appName, appSlug, imageRef, open, onClose }: UpdatePolicyModalProps) {
  const { can } = useRBAC();
  const canWritePolicy = can("apps:write");
  const [policy, setPolicy] = useState<UpdatePolicy>({ ...DEFAULT_POLICY, imageRef });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const updatePolicy = useCallback(<K extends keyof UpdatePolicy>(key: K, value: UpdatePolicy[K]) => {
    setPolicy(prev => ({ ...prev, [key]: value }));
  }, []);

  // Fetch current policy when modal opens
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/api/apps/update-policy?app=${encodeURIComponent(appSlug)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { policy?: UpdatePolicy } | null) => {
        if (data?.policy) {
          setPolicy({
            ...DEFAULT_POLICY,
            ...data.policy,
            imageRef: data.policy.imageRef ?? imageRef,
          });
        } else {
          setPolicy({ ...DEFAULT_POLICY, imageRef });
        }
      })
      .catch(() => {
        setPolicy({ ...DEFAULT_POLICY, imageRef });
      })
      .finally(() => setLoading(false));
  }, [open, appSlug, imageRef]);

  const handleSave = async () => {
    if (!canWritePolicy) {
      toast.error("You do not have permission to update app policies");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/apps/update-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName: appSlug, policy }),
      });
      const data = await res.json() as { ok?: boolean; error?: unknown; message?: string };
      if (!res.ok || !data.ok) {
        toast.error(`Failed to save policy: ${String(data.error ?? "Unknown error")}`);
        return;
      }
      toast.success(data.message ?? "Update policy saved");
      onClose();
    } catch (err) {
      toast.error(`Failed to save policy: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const showAutoMerge = policy.enabled && policy.schedule !== "continuous" && policy.strategy !== "newest-build";

  return (
    <BodyPortal>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[400] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={onClose}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={{ duration: 0.15 }}
              className="bg-[#111] border border-[#222] rounded-2xl w-full max-w-lg max-h-[90dvh] overflow-y-auto shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[#1e1e1e] sticky top-0 bg-[#111] z-10">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-[#0078D4]/15 border border-[#0078D4]/30 flex items-center justify-center">
                    <Settings className="w-4 h-4 text-[#0078D4]" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-[#f2f2f2]">Update Policy</h2>
                    <p className="text-xs text-[#9e9e9e] font-mono">{appName}</p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#222] transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="w-7 h-7 text-[#0078D4] animate-spin" />
                </div>
              ) : (
                <div className="p-5 space-y-6">
                  {/* ── Section 1: Enable toggle ── */}
                  <div className="rounded-xl border border-[#222] bg-[#141414] p-4">
                    <Toggle
                      value={policy.enabled}
                      onChange={v => updatePolicy("enabled", v)}
                      label="Enable Auto Updates"
                      subtitle="Automatically track and apply new image versions"
                    />
                  </div>

                  {policy.enabled && (
                    <>
                      {/* ── Section 2: Update Strategy ── */}
                      <div>
                        <p className="text-xs font-semibold text-[#9e9e9e] uppercase tracking-wide mb-3">
                          Update Strategy
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          {STRATEGY_OPTIONS.map(opt => {
                            const Icon = opt.icon;
                            const selected = policy.strategy === opt.value;
                            return (
                              <button
                                key={opt.value}
                                onClick={() => updatePolicy("strategy", opt.value)}
                                className={cn(
                                  "flex flex-col items-start gap-2 p-3 rounded-xl border text-left transition-all min-h-[44px] touch-manipulation",
                                  selected
                                    ? "bg-[rgba(0,120,212,0.15)] border-[#0078D4]"
                                    : "bg-[#141414] border-[#222] hover:border-[#333]"
                                )}
                              >
                                <div className="flex items-center gap-2">
                                  <Icon className={cn("w-4 h-4", selected ? "text-[#0078D4]" : "text-[#9e9e9e]")} />
                                  {selected && <Check className="w-3 h-3 text-[#0078D4] ml-auto" />}
                                </div>
                                <div>
                                  <p className={cn("text-xs font-medium", selected ? "text-[#f2f2f2]" : "text-[#9e9e9e]")}>
                                    {opt.label}
                                  </p>
                                  <p className="text-[10px] text-[#666] mt-0.5 leading-relaxed">{opt.desc}</p>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* ── Section 3: Schedule ── */}
                      <div>
                        <p className="text-xs font-semibold text-[#9e9e9e] uppercase tracking-wide mb-3">
                          Schedule
                        </p>
                        <div className="rounded-xl border border-[#222] overflow-hidden divide-y divide-[#1e1e1e]">
                          {SCHEDULE_OPTIONS.filter(s =>
                            // newest-build is ACIU only, so hide non-continuous schedules when strategy is newest-build
                            policy.strategy !== "newest-build" || s.value === "continuous"
                          ).map(opt => {
                            const selected = policy.schedule === opt.value || (policy.strategy === "newest-build" && opt.value === "continuous");
                            return (
                              <button
                                key={opt.value}
                                onClick={() => updatePolicy("schedule", opt.value)}
                                className={cn(
                                  "flex items-center justify-between w-full px-4 py-3 text-left transition-colors min-h-[44px] touch-manipulation",
                                  selected ? "bg-[rgba(0,120,212,0.1)]" : "bg-[#141414] hover:bg-[#1a1a1a]"
                                )}
                              >
                                <div className="flex items-center gap-3">
                                  <div className={cn(
                                    "w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                                    selected ? "border-[#0078D4] bg-[#0078D4]" : "border-[#444]"
                                  )}>
                                    {selected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                                  </div>
                                  <div>
                                    <p className={cn("text-sm font-medium", selected ? "text-[#f2f2f2]" : "text-[#9e9e9e]")}>
                                      {opt.label}
                                    </p>
                                    <p className="text-[11px] text-[#666]">{opt.desc}</p>
                                  </div>
                                </div>
                                <span className={cn(
                                  "flex-shrink-0 ml-3 px-2 py-0.5 rounded border text-[10px] font-medium",
                                  opt.badgeColor
                                )}>
                                  {opt.badge}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* ── Section 4: Deployment Strategy ── */}
                      <div>
                        <p className="text-xs font-semibold text-[#9e9e9e] uppercase tracking-wide mb-3">
                          Deployment Strategy
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          {DEPLOYMENT_OPTIONS.map(opt => {
                            const selected = policy.deploymentStrategy === opt.value;
                            return (
                              <button
                                key={opt.value}
                                onClick={() => updatePolicy("deploymentStrategy", opt.value)}
                                className={cn(
                                  "flex flex-col items-start gap-1.5 p-3 rounded-xl border text-left transition-all min-h-[44px] touch-manipulation",
                                  selected
                                    ? "bg-[rgba(0,120,212,0.15)] border-[#0078D4]"
                                    : "bg-[#141414] border-[#222] hover:border-[#333]"
                                )}
                              >
                                <div className="flex items-center justify-between w-full">
                                  <p className={cn("text-xs font-medium", selected ? "text-[#f2f2f2]" : "text-[#9e9e9e]")}>
                                    {opt.label}
                                  </p>
                                  {selected && <Check className="w-3 h-3 text-[#0078D4]" />}
                                </div>
                                <p className="text-[10px] text-[#666] leading-relaxed">{opt.desc}</p>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* ── Section 5: Advanced (collapsible) ── */}
                      <div className="rounded-xl border border-[#222] overflow-hidden">
                        <button
                          onClick={() => setAdvancedOpen(p => !p)}
                          className="flex items-center justify-between w-full px-4 py-3 bg-[#141414] hover:bg-[#1a1a1a] transition-colors min-h-[44px] touch-manipulation"
                        >
                          <span className="text-sm font-medium text-[#9e9e9e]">Advanced options</span>
                          {advancedOpen ? (
                            <ChevronUp className="w-4 h-4 text-[#666]" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-[#666]" />
                          )}
                        </button>

                        <AnimatePresence>
                          {advancedOpen && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.15 }}
                              className="overflow-hidden"
                            >
                              <div className="px-4 py-4 space-y-4 border-t border-[#1e1e1e]">
                                {/* Image ref */}
                                <div>
                                  <label className="block text-xs font-medium text-[#9e9e9e] mb-1.5">
                                    Image reference <span className="text-[#666]">(auto-detected if blank)</span>
                                  </label>
                                  <input
                                    type="text"
                                    value={policy.imageRef ?? ""}
                                    onChange={e => updatePolicy("imageRef", e.target.value || undefined)}
                                    placeholder="ghcr.io/org/app"
                                    className="w-full bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] placeholder:text-[#555] focus:outline-none focus:border-[#0078D4]/50 font-mono"
                                  />
                                </div>

                                {/* Pre-release toggle */}
                                <Toggle
                                  value={policy.includePreRelease}
                                  onChange={v => updatePolicy("includePreRelease", v)}
                                  label="Include pre-releases"
                                  subtitle="Track alpha, beta, and RC versions"
                                />

                                {/* Minimum age */}
                                <div>
                                  <label className="block text-xs font-medium text-[#9e9e9e] mb-1.5">
                                    Minimum release age
                                  </label>
                                  <select
                                    value={policy.minimumAge}
                                    onChange={e => updatePolicy("minimumAge", e.target.value as UpdatePolicy["minimumAge"])}
                                    className="w-full bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]/50 min-h-[44px]"
                                  >
                                    {MIN_AGE_OPTIONS.map(opt => (
                                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                  </select>
                                </div>

                                {/* Auto-merge (Renovate only) */}
                                {showAutoMerge && (
                                  <Toggle
                                    value={policy.autoMerge}
                                    onChange={v => updatePolicy("autoMerge", v)}
                                    label="Auto-merge"
                                    subtitle="Automatically merge Renovate PRs without review"
                                  />
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      {/* Engine info bar */}
                      <EngineInfoBar policy={policy} />
                    </>
                  )}

                  {!policy.enabled && <EngineInfoBar policy={policy} />}

                  {/* Footer */}
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={onClose}
                      className="flex-1 px-4 py-2.5 rounded-lg border border-[#2a2a2a] text-sm text-[#9e9e9e] hover:text-[#f2f2f2] hover:border-[#333] transition-colors min-h-[44px] touch-manipulation"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void handleSave()}
                      disabled={saving || !canWritePolicy}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#0078D4] hover:bg-[#006CBE] disabled:opacity-60 text-white text-sm font-medium transition-colors min-h-[44px] touch-manipulation"
                    >
                      {saving ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Saving…
                        </>
                      ) : (
                        "Save Policy"
                      )}
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </BodyPortal>
  );
}
