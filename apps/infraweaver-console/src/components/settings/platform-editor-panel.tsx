"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AlertCircle,
  GitBranch,
  Globe,
  HardDrive,
  Loader2,
  Lock,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useRBAC } from "@/hooks/use-rbac";
import { cn } from "@/lib/utils";

type SettingType = "number" | "string" | "select";

interface PlatformSettingDefinition {
  key: string;
  group: string;
  label: string;
  description: string;
  file: string;
  yamlPath: string;
  type: SettingType;
  options?: string[];
  min?: number;
  max?: number;
  argoApp: string;
  unit?: string;
}

interface PlatformEditorResponse {
  schema: PlatformSettingDefinition[];
  values: Record<string, unknown>;
  files: Record<string, string>;
}

interface PlatformEditorResult {
  ok: boolean;
  affectedApps: string[];
}

interface PlatformEditorChange {
  key: string;
  value: unknown;
}

const GROUP_META = {
  "Longhorn Storage": {
    icon: HardDrive,
    iconClassName: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20",
    badgeClassName: "border border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    cardClassName: "border-white/10 bg-white/[0.03]",
    accentClassName: "from-emerald-500/20 to-transparent",
    sliderColor: "#10b981",
  },
  Traefik: {
    icon: Globe,
    iconClassName: "bg-blue-500/15 text-blue-300 border border-blue-500/20",
    badgeClassName: "border border-blue-500/20 bg-blue-500/10 text-blue-300",
    cardClassName: "border-white/10 bg-white/[0.03]",
    accentClassName: "from-blue-500/20 to-transparent",
    sliderColor: "#3b82f6",
  },
  ArgoCD: {
    icon: GitBranch,
    iconClassName: "bg-violet-500/15 text-violet-300 border border-violet-500/20",
    badgeClassName: "border border-violet-500/20 bg-violet-500/10 text-violet-300",
    cardClassName: "border-white/10 bg-white/[0.03]",
    accentClassName: "from-violet-500/20 to-transparent",
    sliderColor: "#8b5cf6",
  },
  Authentik: {
    icon: ShieldCheck,
    iconClassName: "bg-orange-500/15 text-orange-300 border border-orange-500/20",
    badgeClassName: "border border-orange-500/20 bg-orange-500/10 text-orange-300",
    cardClassName: "border-white/10 bg-white/[0.03]",
    accentClassName: "from-orange-500/20 to-transparent",
    sliderColor: "#f97316",
  },
} as const;

function sliderTrackStyle(value: number, min: number, max: number, color: string) {
  const percent = ((Math.min(Math.max(value, min), max) - min) / Math.max(max - min, 1)) * 100;
  return {
    background: `linear-gradient(90deg, ${color} 0%, ${color} ${percent}%, #1f2937 ${percent}%, #1f2937 100%)`,
  } as const;
}

function clampNumber(value: number, min?: number, max?: number) {
  if (!Number.isFinite(value)) {
    return min ?? 0;
  }

  let nextValue = value;
  if (min !== undefined) {
    nextValue = Math.max(min, nextValue);
  }
  if (max !== undefined) {
    nextValue = Math.min(max, nextValue);
  }
  return nextValue;
}

function getSettingUnit(setting: PlatformSettingDefinition) {
  if (setting.unit) {
    return setting.unit;
  }

  return /replica/i.test(setting.label) || /replica/i.test(setting.key) ? "replicas" : undefined;
}

function getDirtyValue(draftValues: Record<string, unknown>, key: string, fallback: unknown) {
  return Object.prototype.hasOwnProperty.call(draftValues, key) ? draftValues[key] : fallback;
}

function getNumericSettingValue(setting: PlatformSettingDefinition, value: unknown, fallback: unknown) {
  const candidate = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : Number(fallback);
  return clampNumber(candidate, setting.min, setting.max);
}

function humanizeValue(value: unknown) {
  if (typeof value !== "string") {
    return String(value ?? "—");
  }
  return value.replace(/-/g, " ");
}

function formatSettingValue(setting: PlatformSettingDefinition, value: unknown) {
  if (value === undefined || value === null || value === "") {
    return "—";
  }

  if (setting.type === "number") {
    const unit = getSettingUnit(setting);
    return unit ? `${value} ${unit}` : String(value);
  }

  return humanizeValue(value);
}

function PlatformEditorLoading() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-11 w-11 rounded-xl" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-28" />
              </div>
            </div>
            <Skeleton className="h-6 w-12 rounded-full" />
          </div>
          <div className="mt-5 space-y-3">
            {Array.from({ length: 3 }).map((__, rowIndex) => (
              <div key={rowIndex} className="flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <div className="w-full max-w-sm space-y-3">
                  <Skeleton className="ml-auto h-8 w-24 rounded-full" />
                  <Skeleton className="h-10 w-full rounded-xl" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlatformEditorContent({ data, canWrite }: { data: PlatformEditorResponse; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>(data.values);
  const [showConfirm, setShowConfirm] = useState(false);

  const groupedSettings = useMemo(() => {
    const groups = new Map<string, PlatformSettingDefinition[]>();
    for (const setting of data.schema) {
      const groupSettings = groups.get(setting.group) ?? [];
      groupSettings.push(setting);
      groups.set(setting.group, groupSettings);
    }

    return Array.from(groups.entries());
  }, [data]);

  const dirtyEntries = useMemo(() => {
    return data.schema
      .map((definition) => {
        const originalValue = data.values[definition.key];
        const nextValue = getDirtyValue(draftValues, definition.key, originalValue);
        if (Object.is(originalValue, nextValue)) {
          return null;
        }
        return { definition, value: nextValue };
      })
      .filter((entry): entry is { definition: PlatformSettingDefinition; value: unknown } => entry !== null);
  }, [data, draftValues]);

  const changedCountByGroup = useMemo(() => {
    return dirtyEntries.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.definition.group] = (counts[entry.definition.group] ?? 0) + 1;
      return counts;
    }, {});
  }, [dirtyEntries]);

  const affectedApps = useMemo(() => {
    return Array.from(new Set(dirtyEntries.map((entry) => entry.definition.argoApp)));
  }, [dirtyEntries]);

  const saveMutation = useMutation<PlatformEditorResult, Error, PlatformEditorChange[]>({
    mutationFn: async (changes) => {
      const response = await fetch("/api/platform-editor", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      const payload = (await response.json().catch(() => null)) as PlatformEditorResult & { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to save platform settings");
      }
      return payload as PlatformEditorResult;
    },
    onSuccess: () => {
      setShowConfirm(false);
      toast.success("Changes committed — ArgoCD is rolling updates");
      void queryClient.invalidateQueries({ queryKey: ["settings", "platform-editor"] });
    },
    onError: (mutationError) => {
      toast.error(mutationError.message);
    },
  });

  const handleValueChange = (key: string, value: unknown) => {
    setDraftValues((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const handleReset = () => {
    setDraftValues(data.values);
  };

  const handleApply = () => {
    if (!dirtyEntries.length || saveMutation.isPending) {
      return;
    }

    saveMutation.mutate(
      dirtyEntries.map((entry) => ({
        key: entry.definition.key,
        value: entry.value,
      })),
    );
  };

  return (
    <>
      <div className="space-y-4">
        <div className="rounded-2xl border border-[#2a2a2a] bg-[#111] p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-blue-500/20 bg-blue-500/10 text-blue-300">
              <GitBranch className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <p className="text-base font-semibold text-[#f2f2f2]">Rolling deploy</p>
              <p className="mt-1 text-sm text-[#888]">
                Changes are committed to git → ArgoCD auto-syncs → Helm upgrade triggers rolling restart of affected pods.
              </p>
              <p className="mt-2 text-xs text-[#666]">
                ArgoCD polls for drift, detects the change, and Kubernetes rolls pods with zero-downtime where replica counts allow it.
              </p>
            </div>
          </div>
        </div>

        {!canWrite ? (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-100">
            <div className="flex items-start gap-3">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <p>You have read access to platform settings, but config:write is required to apply changes.</p>
            </div>
          </div>
        ) : null}

        {groupedSettings.map(([groupName, settings], index) => {
          const meta = GROUP_META[groupName as keyof typeof GROUP_META];
          const Icon = meta.icon;
          const changedInGroup = changedCountByGroup[groupName] ?? 0;

          return (
            <motion.div
              key={groupName}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.04 }}
              className={cn("relative overflow-hidden rounded-2xl border p-5", meta.cardClassName)}
            >
              <div className={cn("pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b opacity-60", meta.accentClassName)} />
              <div className="relative">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={cn("flex h-11 w-11 items-center justify-center rounded-xl", meta.iconClassName)}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-base font-semibold text-[#f2f2f2]">{groupName}</p>
                      <p className="text-xs text-[#888]">{settings.length} editable setting{settings.length === 1 ? "" : "s"}</p>
                    </div>
                  </div>
                  <span className={cn("inline-flex min-w-8 items-center justify-center rounded-full px-2.5 py-1 text-xs font-medium", meta.badgeClassName)}>
                    {changedInGroup}
                  </span>
                </div>

                <div className="rounded-xl border border-white/5 bg-black/20 px-4">
                  {settings.map((setting) => {
                    const originalValue = data.values[setting.key];
                    const currentValue = getDirtyValue(draftValues, setting.key, originalValue);
                    const numericValue = setting.type === "number"
                      ? getNumericSettingValue(setting, currentValue, originalValue)
                      : 0;
                    const isDirty = dirtyEntries.some((entry) => entry.definition.key === setting.key);
                    const unit = getSettingUnit(setting);

                    return (
                      <div
                        key={setting.key}
                        className={cn(
                          "flex items-center justify-between gap-4 py-3 border-b border-white/5 last:border-0",
                          isDirty && "rounded-xl bg-white/[0.02]",
                        )}
                      >
                        <div className="min-w-0 flex-1 pr-2">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-[#f2f2f2]">{setting.label}</p>
                            {isDirty ? (
                              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[#9ca3af]">
                                Modified
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-sm text-[#888]">{setting.description}</p>
                        </div>

                        <div className="w-full max-w-md space-y-2">
                          <div className="flex items-center justify-end gap-2">
                            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-[#d4d4d4]">
                              {formatSettingValue(setting, currentValue)}
                            </span>
                            <span className="text-[11px] uppercase tracking-[0.18em] text-[#666]">{setting.argoApp}</span>
                          </div>

                          {setting.type === "number" ? (
                            <div className="flex items-center gap-3">
                              <input
                                type="range"
                                min={setting.min}
                                max={setting.max}
                                step={1}
                                value={numericValue}
                                onChange={(event) => handleValueChange(setting.key, clampNumber(Number(event.target.value), setting.min, setting.max))}
                                disabled={!canWrite || saveMutation.isPending}
                                style={sliderTrackStyle(numericValue, setting.min ?? 0, setting.max ?? 100, meta.sliderColor)}
                                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-[#1f2937] disabled:cursor-not-allowed disabled:opacity-60"
                              />
                              <div className="flex items-center gap-2">
                                <input
                                  type="number"
                                  min={setting.min}
                                  max={setting.max}
                                  value={typeof currentValue === "string" ? currentValue : numericValue}
                                  onChange={(event) => {
                                    const nextValue = event.target.value;
                                    if (nextValue === "") {
                                      handleValueChange(setting.key, "");
                                      return;
                                    }
                                    handleValueChange(setting.key, clampNumber(Number(nextValue), setting.min, setting.max));
                                  }}
                                  onBlur={(event) => {
                                    if (event.target.value === "") {
                                      handleValueChange(setting.key, originalValue);
                                    }
                                  }}
                                  disabled={!canWrite || saveMutation.isPending}
                                  className="w-24 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                                />
                                {unit ? <span className="text-xs text-[#888]">{unit}</span> : null}
                              </div>
                            </div>
                          ) : setting.type === "select" ? (
                            <select
                              value={typeof currentValue === "string" ? currentValue : String(currentValue ?? "")}
                              onChange={(event) => handleValueChange(setting.key, event.target.value)}
                              disabled={!canWrite || saveMutation.isPending}
                              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {setting.options?.map((option) => (
                                <option key={option} value={option}>
                                  {humanizeValue(option)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={typeof currentValue === "string" ? currentValue : String(currentValue ?? "")}
                              onChange={(event) => handleValueChange(setting.key, event.target.value)}
                              disabled={!canWrite || saveMutation.isPending}
                              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          );
        })}

        {dirtyEntries.length > 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-base font-semibold text-[#f2f2f2]">Apply Changes</p>
                <p className="mt-1 text-sm text-[#888]">
                  Saving commits changes to GitHub and triggers rolling updates for the affected ArgoCD apps.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {affectedApps.map((app) => (
                    <span key={app} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-[#d4d4d4]">
                      {app}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-col-reverse gap-3 sm:flex-row">
                <button
                  onClick={handleReset}
                  disabled={saveMutation.isPending}
                  className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-medium text-[#d4d4d4] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </button>
                <button
                  onClick={() => setShowConfirm(true)}
                  disabled={!canWrite || saveMutation.isPending}
                  className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Apply Changes
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={showConfirm}
        onCancel={() => setShowConfirm(false)}
        onConfirm={handleApply}
        title="Apply platform changes?"
        description={`This will commit changes to git and trigger rolling updates for: ${affectedApps.join(", ")}. ArgoCD will apply within ~30 seconds.`}
        confirmText="Commit changes"
      />
    </>
  );
}

export function PlatformEditorPanel() {
  const { can } = useRBAC();
  const canWrite = can("config:write");

  const { data, isLoading, error, refetch } = useQuery<PlatformEditorResponse, Error>({
    queryKey: ["settings", "platform-editor"],
    queryFn: async () => {
      const response = await fetch("/api/platform-editor");
      const payload = (await response.json().catch(() => null)) as Partial<PlatformEditorResponse> & { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to load platform settings");
      }
      return payload as PlatformEditorResponse;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return <PlatformEditorLoading />;
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-200">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
          <div>
            <p className="font-medium text-white">Unable to load platform settings</p>
            <p className="mt-1 text-red-200/80">{error.message}</p>
            <button
              onClick={() => void refetch()}
              className="mt-4 inline-flex min-h-[40px] items-center rounded-lg border border-red-500/30 bg-red-500/10 px-4 text-sm font-medium text-red-100 transition-colors hover:bg-red-500/20"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const dataVersion = Object.entries(data.files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, sha]) => `${filePath}:${sha}`)
    .join("|");

  return <PlatformEditorContent key={dataVersion} data={data} canWrite={canWrite} />;
}
