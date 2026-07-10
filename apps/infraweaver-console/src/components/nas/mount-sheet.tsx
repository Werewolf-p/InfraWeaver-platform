"use client";

// "Mount to workload" — hand one NAS folder to any number of workloads at once.
//
// The access mode is chosen per target, which is the whole point: the same
// folder can be read-write for Nextcloud and read-only for Jellyfin in a single
// commit. Targets come from `/api/nas/mount-targets` (the GitOps catalog), so
// the operator never types a manifest path and cannot pick a workload the
// console has no manifest to patch.

import { useMemo, useState } from "react";
import { HardDrive, Loader2, Lock, Search, Unlock } from "lucide-react";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { cn } from "@/lib/utils";
import {
  useNasMountTargets,
  useNasMountWorkload,
  type NasMountRequestTarget,
  type NasMountTarget,
} from "@/hooks/use-nas";

const INPUT_CLASS =
  "w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-slate-400 focus:border-[#0078D4]/50 focus:outline-none focus:ring-1 focus:ring-[#0078D4]/40";

type Access = "readonly" | "readwrite";

interface Selection {
  access: Access;
  mountPath: string;
  container: string;
}

function targetKey(target: NasMountTarget): string {
  return `${target.namespace}/${target.kind}/${target.name}`;
}

/** `media/movies` → `/data/movies` is a poor guess; `/data` plus the leaf reads better. */
function defaultMountPath(subfolder: string): string {
  const leaf = subfolder.split("/").filter(Boolean).pop();
  return leaf ? `/data/${leaf}` : "/data";
}

export function NasMountSheet({
  open,
  onClose,
  provider,
  share,
  subfolder,
  access = "readwrite",
}: {
  open: boolean;
  onClose: () => void;
  provider: string;
  share: string;
  subfolder: string;
  /**
   * The caller's own access on this folder. A read-only holder cannot mount
   * read-write — the server refuses it — so the option is not offered rather
   * than presented and then rejected after a round trip.
   */
  access?: Access;
}) {
  const targetsQuery = useNasMountTargets();
  const mount = useNasMountWorkload();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, Selection>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);

  const canMountReadWrite = access === "readwrite";

  const targets = useMemo(() => {
    const all = targetsQuery.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((target) =>
      `${target.app} ${target.namespace} ${target.name}`.toLowerCase().includes(needle));
  }, [targetsQuery.data, search]);

  const chosen = Object.entries(selected);

  function toggle(target: NasMountTarget) {
    const key = targetKey(target);
    setSelected((current) => {
      if (current[key]) {
        const rest = { ...current };
        delete rest[key];
        return rest;
      }
      return {
        ...current,
        [key]: { access: "readonly", mountPath: defaultMountPath(subfolder), container: target.containers[0] ?? "" },
      };
    });
  }

  function update(key: string, patch: Partial<Selection>) {
    setSelected((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }

  async function submit() {
    setError(null);
    const byKey = new Map((targetsQuery.data ?? []).map((target) => [targetKey(target), target]));
    const requestTargets: NasMountRequestTarget[] = chosen.flatMap(([key, selection]) => {
      const target = byKey.get(key);
      if (!target) return [];
      return [{
        namespace: target.namespace,
        workload: target.name,
        kind: target.kind,
        container: selection.container || undefined,
        mount_path: selection.mountPath,
        access: selection.access,
        manifest_path: target.manifestPath,
      }];
    });
    try {
      const result = await mount.mutateAsync({ provider, share, subfolder, targets: requestTargets });
      setDone(result.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mount folder");
    }
  }

  function close() {
    setSelected({});
    setError(null);
    setDone(null);
    setSearch("");
    onClose();
  }

  const canSubmit = chosen.length > 0
    && chosen.every(([, selection]) => selection.mountPath.startsWith("/"))
    && !mount.isPending;

  return (
    <ResponsiveSheet
      open={open}
      onClose={close}
      title={`Mount ${share}/${subfolder || "(share root)"}`}
      description="Pick the workloads that should see this folder. Each one gets its own access mode; read-only mounts receive the read-only NAS credential and a read-only kernel mount."
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-slate-500">{chosen.length} workload{chosen.length === 1 ? "" : "s"} selected</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={close} className="rounded-lg border border-gray-200 dark:border-white/10 px-4 py-2 text-sm text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white">
              {done ? "Close" : "Cancel"}
            </button>
            {done ? null : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className={cn(
                  "flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                  canSubmit
                    ? "border border-[#0078D4]/30 bg-[#0078D4]/20 text-[#7cb9ff] hover:bg-[#0078D4]/30"
                    : "border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-400",
                )}
              >
                {mount.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Mount
              </button>
            )}
          </div>
        </div>
      }
    >
      {done ? (
        <div className="space-y-3">
          <p className="text-sm text-emerald-300">Committed to GitOps. ArgoCD will roll the pods.</p>
          <ul className="space-y-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 p-3">
            {done.map((file) => (
              <li key={file} className="break-all font-mono text-xs text-slate-500 dark:text-slate-400">{file}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search workloads…"
              className={cn(INPUT_CLASS, "pl-9")}
            />
          </div>

          {targetsQuery.isLoading ? (
            <p className="py-6 text-center text-sm text-slate-500">Loading workloads from the catalog…</p>
          ) : targets.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              No catalog workloads found. A workload is mountable only if its Deployment or StatefulSet manifest lives under <code>kubernetes/catalog/</code>.
            </p>
          ) : (
            <ul className="space-y-2">
              {targets.map((target) => {
                const key = targetKey(target);
                const selection = selected[key];
                const readOnly = selection?.access === "readonly";
                return (
                  <li key={key} className={cn(
                    "rounded-xl border p-3 transition-colors",
                    selection ? "border-[#0078D4]/40 bg-[#0078D4]/5" : "border-gray-200 dark:border-white/10 bg-white dark:bg-white/5",
                  )}>
                    <label className="flex cursor-pointer items-start gap-3">
                      <input type="checkbox" checked={Boolean(selection)} onChange={() => toggle(target)} className="mt-1 h-4 w-4 shrink-0 accent-[#0078D4]" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-gray-900 dark:text-white">{target.name}</span>
                          <span className="rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] font-medium text-slate-400">{target.kind}</span>
                          <span className="text-xs text-slate-500">{target.namespace}</span>
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-500">{target.manifestPath}</span>
                      </span>
                    </label>

                    {selection ? (
                      <div className="mt-3 grid gap-2 pl-7 sm:grid-cols-[auto_1fr_auto]">
                        <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          Access
                          <select
                            value={selection.access}
                            onChange={(event) => update(key, { access: event.target.value as Access })}
                            className="rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-[#0d0d0d] px-2 py-1.5 text-sm text-gray-900 dark:text-white"
                          >
                            <option value="readonly">Read-only</option>
                            <option value="readwrite" disabled={!canMountReadWrite}>
                              Read-write{canMountReadWrite ? "" : " — needs read-write access"}
                            </option>
                          </select>
                        </label>
                        <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          Mount path
                          <input
                            value={selection.mountPath}
                            onChange={(event) => update(key, { mountPath: event.target.value })}
                            placeholder="/data"
                            spellCheck={false}
                            className={cn(INPUT_CLASS, "py-1.5")}
                          />
                        </label>
                        {target.containers.length > 1 ? (
                          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            Container
                            <select
                              value={selection.container}
                              onChange={(event) => update(key, { container: event.target.value })}
                              className="rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-[#0d0d0d] px-2 py-1.5 text-sm text-gray-900 dark:text-white"
                            >
                              {target.containers.map((container) => <option key={container} value={container}>{container}</option>)}
                            </select>
                          </label>
                        ) : (
                          <span className={cn(
                            "inline-flex items-center gap-1 self-center rounded-full px-2 py-1 text-xs font-medium",
                            readOnly ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300",
                          )}>
                            {readOnly ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                            {readOnly ? "RO" : "RW"}
                          </span>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="flex items-start gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 p-3 text-xs text-slate-500 dark:text-slate-400">
            <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Mounting writes a PersistentVolume, a PersistentVolumeClaim and a credential ExternalSecret per namespace, and patches each workload — all in one GitOps commit. Unmounting later never deletes data on the NAS.
          </p>

          {error ? <p className="text-xs text-red-400">{error}</p> : null}
        </div>
      )}
    </ResponsiveSheet>
  );
}
