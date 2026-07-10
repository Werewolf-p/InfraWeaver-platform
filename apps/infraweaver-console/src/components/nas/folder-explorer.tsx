"use client";

// Shares → folders → access & mount. The missing middle of the Storage page.
//
// Before this existed the NAS tab could show providers and existing mounts, but
// there was no way to see what was *on* the NAS, let alone carve out a folder to
// hand to a workload. This panel browses a share, creates subfolders, shows who
// can reach each one and which workloads already mount it, and opens the mount
// sheet for whichever folder the operator picked.
//
// Everything it renders is already scoped by the server: `/api/nas/folders` omits
// folders the caller cannot read and tags each survivor with the access they
// hold. So the badges below are the truth, not a hint — and a user granted one
// folder simply does not see the rest of the share.

import { useMemo, useState } from "react";
import {
  ChevronRight,
  Eye,
  Folder,
  FolderPlus,
  Home,
  KeyRound,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Server,
} from "lucide-react";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { EmptyState } from "@/components/ui/empty-state";
import { NasMountSheet } from "@/components/nas/mount-sheet";
import { StorageAccessSheet } from "@/components/nas/storage-access-sheet";
import { cn } from "@/lib/utils";
import {
  useNasCreateFolder,
  useNasFolders,
  useNasMounts,
  useNasShares,
  type NasAccessMode,
  type NasProvider,
} from "@/hooks/use-nas";

const INPUT_CLASS =
  "rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-1.5 text-sm text-gray-900 dark:text-white placeholder:text-slate-400 focus:border-[#0078D4]/50 focus:outline-none focus:ring-1 focus:ring-[#0078D4]/40";

/** Breadcrumb segments for `media/movies` → [{label:"media",path:"media"}, …]. */
function crumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  return parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join("/") }));
}

/**
 * The caller's own access, as a badge. Read-write is the notable state (it can
 * destroy data), so it carries the colour; read-only is deliberately quiet.
 */
function AccessBadge({ access }: { access?: NasAccessMode }) {
  if (!access) return null;
  const readwrite = access === "readwrite";
  const Icon = readwrite ? Pencil : Eye;
  return (
    <span
      title={readwrite ? "You can read and write here" : "You can read here"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
        // Read-write is the consequential state, so it gets the colour. Read-only
        // sits on a neutral surface rather than a grey tint — grey-on-grey reads
        // as disabled, and this badge is informative, not inert.
        readwrite
          ? "bg-teal-500/15 text-teal-600 dark:text-teal-300"
          : "border border-gray-200 bg-gray-50 text-slate-700 dark:border-white/10 dark:bg-white/10 dark:text-slate-300",
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {readwrite ? "read-write" : "read-only"}
    </span>
  );
}

/** Namespaces that already mount this exact folder, e.g. `jellyfin`, `nextcloud`. */
function MountedChips({ namespaces }: { namespaces: string[] }) {
  if (namespaces.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {namespaces.map((namespace) => (
        <span
          key={namespace}
          title={`Mounted into ${namespace}`}
          className="inline-flex items-center rounded-full bg-[#0078D4]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#7cb9ff]"
        >
          {namespace}
        </span>
      ))}
    </span>
  );
}

export function NasFolderExplorer({ providers }: { providers: NasProvider[] }) {
  const mountable = useMemo(() => providers.filter((provider) => provider.hasCredentials), [providers]);
  // Derived, not synced: until the operator picks one, the active provider is
  // simply the first usable one. An effect that setState'd this would cascade a
  // render on every providers refetch.
  const [chosenProvider, setChosenProvider] = useState<string>("");
  const providerId = chosenProvider || mountable[0]?.id || "";
  const [share, setShare] = useState<string>("");
  const [path, setPath] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [mountFor, setMountFor] = useState<string | null>(null);
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sharesQuery = useNasShares(providerId || null);
  const foldersQuery = useNasFolders(providerId || null, share || null, path);
  const mountsQuery = useNasMounts();
  const createFolder = useNasCreateFolder();

  const shares = sharesQuery.data ?? [];
  const listing = foldersQuery.data;
  const folders = listing?.folders ?? [];
  // The caller's access on the folder currently open. Gates "New folder": the
  // server would refuse the create anyway, so offering it would be a lie.
  const currentAccess: NasAccessMode = listing?.access ?? "readonly";
  const canWriteHere = currentAccess === "readwrite";

  /** `subfolder` → the namespaces whose workloads mount it today. */
  const mountedBySubfolder = useMemo(() => {
    const index = new Map<string, string[]>();
    for (const mount of mountsQuery.data ?? []) {
      if (mount.provider !== providerId || mount.subDir == null) continue;
      const existing = index.get(mount.subDir) ?? [];
      if (!existing.includes(mount.pvcNamespace)) existing.push(mount.pvcNamespace);
      index.set(mount.subDir, existing);
    }
    return index;
  }, [mountsQuery.data, providerId]);

  function openShare(name: string) {
    setShare(name);
    setPath("");
    setError(null);
  }

  function navigate(next: string) {
    setPath(next);
    setCreating(false);
    setError(null);
  }

  async function submitFolder() {
    const name = newFolder.trim();
    if (!name) return;
    setError(null);
    try {
      await createFolder.mutateAsync({ provider: providerId, share, path: path ? `${path}/${name}` : name });
      setNewFolder("");
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder");
    }
  }

  if (mountable.length === 0) {
    return (
      <EmptyState
        icon={Server}
        title="No NAS provider has credentials yet"
        description="Add a provider above, then come back to browse its shares and carve out folders for your workloads."
      />
    );
  }

  return (
    <CollapsibleSection title="Shares & folders" storageKey="storage-nas-folders" defaultOpen>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            Provider
            <select
              value={providerId}
              onChange={(event) => { setChosenProvider(event.target.value); setShare(""); setPath(""); }}
              className="rounded-md border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2 py-1.5 text-sm text-gray-900 dark:text-white"
            >
              {mountable.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <button
            type="button"
            onClick={() => { void sharesQuery.refetch(); void foldersQuery.refetch(); void mountsQuery.refetch(); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-white/10 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 transition-colors hover:text-gray-900 dark:hover:text-white"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", (sharesQuery.isFetching || foldersQuery.isFetching) && "animate-spin")} />
            Refresh
          </button>
        </div>

        {!share ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {sharesQuery.isLoading ? (
              <p className="text-sm text-slate-500">Loading shares…</p>
            ) : shares.length === 0 ? (
              <p className="text-sm text-slate-500">
                This provider exposes no shares you have access to, or its credentials were rejected.
              </p>
            ) : shares.map((entry) => (
              <div
                key={`${providerId}-${entry.name}`}
                className="group flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 transition-colors hover:border-[#0078D4]/40 dark:border-[#2a2a2a] dark:bg-[#111]"
              >
                <button type="button" onClick={() => openShare(entry.name)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#0078D4]/10 text-[#7cb9ff]">
                    <Folder className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium text-gray-900 dark:text-white">
                      {entry.name}
                      <AccessBadge access={entry.access} />
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{entry.path}</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => { setShare(entry.name); setAccessFor(""); }}
                  title={`Manage who can reach ${entry.name}`}
                  className="shrink-0 rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:border-[#0078D4]/40 hover:text-[#7cb9ff] dark:border-white/10"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1 text-sm">
              <button type="button" onClick={() => { setShare(""); setPath(""); }} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-slate-500 transition-colors hover:text-gray-900 dark:hover:text-white">
                <Home className="h-3.5 w-3.5" />
                Shares
              </button>
              <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
              <button type="button" onClick={() => navigate("")} className={cn("rounded-md px-1.5 py-1 font-medium transition-colors", path ? "text-slate-500 hover:text-gray-900 dark:hover:text-white" : "text-gray-900 dark:text-white")}>
                {share}
              </button>
              {crumbs(path).map((crumb, index, all) => (
                <span key={crumb.path} className="flex items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
                  <button
                    type="button"
                    onClick={() => navigate(crumb.path)}
                    className={cn("rounded-md px-1.5 py-1 transition-colors", index === all.length - 1 ? "font-medium text-gray-900 dark:text-white" : "text-slate-500 hover:text-gray-900 dark:hover:text-white")}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}

              <AccessBadge access={currentAccess} />

              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAccessFor(path)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-white/10 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 transition-colors hover:text-gray-900 dark:hover:text-white"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  Access
                </button>
                <button
                  type="button"
                  onClick={() => setCreating((value) => !value)}
                  disabled={!canWriteHere}
                  title={canWriteHere ? undefined : "You have read-only access to this folder"}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-white/10 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 transition-colors hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-white"
                >
                  {canWriteHere ? <FolderPlus className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                  New folder
                </button>
                <button
                  type="button"
                  onClick={() => setMountFor(path)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#0078D4]/30 bg-[#0078D4]/10 px-2.5 py-1.5 text-xs font-medium text-[#7cb9ff] transition-colors hover:bg-[#0078D4]/20"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Mount this folder
                </button>
              </div>
            </div>

            {creating ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 p-3">
                <span className="font-mono text-xs text-slate-500">{share}/{path ? `${path}/` : ""}</span>
                <input
                  autoFocus
                  value={newFolder}
                  onChange={(event) => setNewFolder(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void submitFolder(); if (event.key === "Escape") setCreating(false); }}
                  placeholder="media"
                  spellCheck={false}
                  className={INPUT_CLASS}
                />
                <button
                  type="button"
                  onClick={() => void submitFolder()}
                  disabled={!newFolder.trim() || createFolder.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#0078D4]/30 bg-[#0078D4]/20 px-3 py-1.5 text-xs font-medium text-[#7cb9ff] disabled:opacity-50"
                >
                  {createFolder.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Create
                </button>
                <p className="w-full text-xs text-slate-500 dark:text-slate-400">
                  Creating a folder also provisions this provider&apos;s scoped read-only and read-write NAS accounts and grants them access to it.
                </p>
              </div>
            ) : null}

            {foldersQuery.isLoading ? (
              <p className="py-6 text-center text-sm text-slate-500">Loading folders…</p>
            ) : foldersQuery.isError ? (
              <p className="py-6 text-center text-sm text-red-400">{(foldersQuery.error as Error).message}</p>
            ) : folders.length === 0 ? (
              <EmptyState
                icon={Folder}
                title="This folder is empty"
                description={
                  canWriteHere
                    ? "Create a subfolder to hand to a workload, or mount this folder directly."
                    : "Nothing here you have access to. Mount this folder directly, or ask an admin for read-write access to create subfolders."
                }
                {...(canWriteHere ? { action: { label: "New folder", onClick: () => setCreating(true) } } : {})}
              />
            ) : (
              <ul className="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 dark:divide-[#1c1c1c] dark:border-[#2a2a2a]">
                {folders.map((folder) => (
                  <li key={folder.subfolder} className="flex items-center gap-3 bg-white p-3 dark:bg-[#111]">
                    <button type="button" onClick={() => navigate(folder.subfolder)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <Folder className="h-4 w-4 shrink-0 text-[#7cb9ff]" />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm text-gray-900 dark:text-white">{folder.name}</span>
                          <AccessBadge access={folder.access} />
                        </span>
                        <MountedChips namespaces={mountedBySubfolder.get(folder.subfolder) ?? []} />
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setAccessFor(folder.subfolder)}
                      title={`Manage who can reach ${folder.name}`}
                      className="shrink-0 rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:border-[#0078D4]/40 hover:text-[#7cb9ff] dark:border-white/10"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setMountFor(folder.subfolder)}
                      className="shrink-0 rounded-lg border border-gray-200 dark:border-white/10 px-2.5 py-1 text-xs text-slate-500 dark:text-slate-400 transition-colors hover:border-[#0078D4]/40 hover:text-[#7cb9ff]"
                    >
                      Mount…
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {error ? <p className="text-xs text-red-400">{error}</p> : null}
          </div>
        )}
      </div>

      {mountFor !== null ? (
        <NasMountSheet
          open
          onClose={() => setMountFor(null)}
          provider={providerId}
          share={share}
          subfolder={mountFor}
          access={currentAccess}
        />
      ) : null}

      {accessFor !== null ? (
        <StorageAccessSheet
          open
          onClose={() => setAccessFor(null)}
          provider={providerId}
          share={share}
          subfolder={accessFor}
        />
      ) : null}
    </CollapsibleSection>
  );
}
