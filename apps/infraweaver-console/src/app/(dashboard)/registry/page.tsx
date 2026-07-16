"use client";
import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Package, Search, ChevronDown, ChevronRight, Trash2, Info, Terminal, X } from "lucide-react";
import { toast } from "@/lib/notify";
import { useRegistryRepos, useRegistryTags, useDeleteTag, type RegistryTag } from "@/hooks/use-registry";
import { useRBAC } from "@/hooks/use-rbac";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { RelativeTime } from "@/components/ui/relative-time";
import { formatBytes } from "@/lib/utils";
import { publicHost } from "@/lib/domain";

const DEFAULT_REGISTRY_HOST = publicHost("onedev");
const DEFAULT_PROJECT_PATH = "infraweaver-platform";

const TAG_ROW_GRID = "sm:grid sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-4";

/** Trim a digest to `sha256:abcdef123456` so a row stays scannable but still identifiable. */
function shortDigest(digest: string): string {
  const [algo, hex] = digest.includes(":") ? digest.split(":") : ["", digest];
  const head = (hex ?? "").slice(0, 12);
  return algo ? `${algo}:${head}` : head;
}

function TagRow({ registryPath, tag, onDelete, isAdmin }: {
  registryPath: string;
  tag: RegistryTag;
  onDelete: () => void;
  isAdmin: boolean;
}) {
  const pullCmd = `docker pull ${registryPath}:${tag.tag}`;
  return (
    <div className={`flex flex-col gap-2 px-4 py-3 border-b border-gray-200 dark:border-white/5 last:border-0 text-sm ${TAG_ROW_GRID}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-xs font-medium text-slate-700 dark:text-slate-200 truncate" title={tag.tag}>{tag.tag}</span>
        {tag.size ? (
          <span className="shrink-0 rounded-md bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500 dark:text-slate-400">{formatBytes(tag.size)}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        {tag.digest ? (
          <>
            <span className="min-w-0 truncate font-mono text-[11px] text-slate-500" title={tag.digest}>{shortDigest(tag.digest)}</span>
            <CopyButton text={tag.digest} label="Digest" className="shrink-0" />
          </>
        ) : (
          <span className="text-xs text-slate-500">—</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 sm:justify-end">
        <span className="text-xs text-slate-500">
          {tag.pushedAt ? <RelativeTime date={tag.pushedAt} /> : "—"}
        </span>
        <div className="flex items-center gap-2">
          <CopyButton text={pullCmd} label="Pull" />
          {isAdmin && (
            <button
              onClick={onDelete}
              aria-label={`Delete tag ${tag.tag}`}
              className="p-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RepoRow({ name, registryHost, projectPath }: { name: string; registryHost: string; projectPath: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data: tagsData, isLoading: tagsLoading } = useRegistryTags(expanded ? name : "");
  const deleteMutation = useDeleteTag();
  const { isAdmin } = useRBAC();
  const [deleteTarget, setDeleteTarget] = useState<{ repo: string; tag: string } | null>(null);
  const registryPath = `${registryHost}/${projectPath}/${name}`;

  // Newest push first; tags without a timestamp sink to the bottom.
  const sortedTags = useMemo(() => {
    const list = tagsData?.tags ?? [];
    return [...list].sort((a, b) => {
      const at = a.pushedAt ? new Date(a.pushedAt).getTime() : 0;
      const bt = b.pushedAt ? new Date(b.pushedAt).getTime() : 0;
      return bt - at;
    });
  }, [tagsData?.tags]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget);
      toast.success(`Deleted ${deleteTarget.tag}`);
      setDeleteTarget(null);
    } catch {
      toast.error("Failed to delete tag");
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="border-b border-gray-200 dark:border-white/5 last:border-0"
      >
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors text-left"
        >
          {expanded ? <ChevronDown className="w-4 h-4 text-slate-500 dark:text-slate-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 dark:text-slate-400 flex-shrink-0" />}
          <Package className="w-4 h-4 text-indigo-400 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-900 dark:text-white flex-1">{name}</span>
          <span className="text-xs text-slate-500">{tagsData?.tags?.length ?? "—"} tags</span>
        </button>
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden bg-slate-100 dark:bg-slate-950/50"
            >
              {tagsLoading ? (
                <div className="px-4 py-3 space-y-2">
                  {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-8" />)}
                </div>
              ) : (
                <div>
                  {sortedTags.length > 0 && (
                    <div className={`hidden px-4 py-2 border-b border-gray-200 dark:border-white/5 text-[10px] font-medium uppercase tracking-wide text-slate-500 ${TAG_ROW_GRID}`}>
                      <span>Tag</span>
                      <span>Digest</span>
                      <span className="text-right">Pushed</span>
                    </div>
                  )}
                  {sortedTags.map(tag => (
                    <TagRow
                      key={tag.tag}
                      registryPath={registryPath}
                      tag={tag}
                      isAdmin={isAdmin}
                      onDelete={() => setDeleteTarget({ repo: name, tag: tag.tag })}
                    />
                  ))}
                  {sortedTags.length === 0 && (
                    <div className="px-8 py-4 text-xs text-slate-500">No tags found</div>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      <ConfirmDialog
        open={!!deleteTarget}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        title={`Delete tag ${deleteTarget?.tag}?`}
        description={`This will permanently delete ${deleteTarget?.tag} from ${name}. This cannot be undone.`}
        confirmText="Delete Tag"
        danger
      />
    </>
  );
}

export default function RegistryPage() {
  const { data, isLoading } = useRegistryRepos();
  const [search, setSearch] = useState("");
  const [showLoginModal, setShowLoginModal] = useState(false);

  const meta = data as { registryHost?: string; projectPath?: string; error?: string } | undefined;
  const registryHost = meta?.registryHost ?? DEFAULT_REGISTRY_HOST;
  const projectPath = (meta?.projectPath ?? DEFAULT_PROJECT_PATH).toLowerCase();
  const error = meta?.error;

  const repos = (data?.repositories ?? []).filter(r => r.toLowerCase().includes(search.toLowerCase()));
  const loginCmd = `docker login ${registryHost}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Package className="w-5 h-5 text-indigo-400" />
            Container Registry
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{registryHost}/{projectPath}</p>
        </div>
        <button
          onClick={() => setShowLoginModal(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-slate-700 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          <Terminal className="w-4 h-4" />
          Login Instructions
        </button>
      </div>

      <div className="relative mb-5 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 dark:text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search repositories..."
          className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-900 dark:text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
        />
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400">
          <Info className="w-4 h-4 flex-shrink-0" />
          {error === "Registry not configured"
            ? "Registry not configured — set ONEDEV_URL, ONEDEV_TOKEN and ONEDEV_USERNAME for the console."
            : "OneDev registry unreachable — check ONEDEV_URL connectivity and the onedev-token secret."}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      ) : (
        <div className="bg-gray-100 dark:bg-white/5 backdrop-blur-sm border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
          <div className="grid grid-cols-[auto_1fr_auto] gap-4 px-4 py-2 border-b border-gray-200 dark:border-white/5 text-xs text-slate-500 font-medium uppercase tracking-wide">
            <span className="w-4" />
            <span>Repository</span>
            <span>Tags</span>
          </div>
          {repos.map(name => <RepoRow key={name} name={name} registryHost={registryHost} projectPath={projectPath} />)}
          {repos.length === 0 && !error && (
            <div className="py-12 text-center text-slate-500 text-sm">
              {search ? "No repositories match your search" : "No container images published to OneDev yet"}
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {showLoginModal && (
          <div className="fixed inset-0 z-modal flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowLoginModal(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-md bg-slate-100 dark:bg-slate-900 border border-gray-200 dark:border-white/10 rounded-xl p-6 shadow-2xl z-10"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">Registry Login</h3>
                <button onClick={() => setShowLoginModal(false)} className="text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"><X className="w-5 h-5" /></button>
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Run the following command to authenticate with the registry:</p>
              <div className="bg-slate-100 dark:bg-slate-950 border border-gray-200 dark:border-white/10 rounded-lg p-3 font-mono text-sm text-green-400 mb-3">
                {loginCmd}
              </div>
              <CopyButton text={loginCmd} label="Copy command" className="w-full justify-center" />
              <p className="text-xs text-slate-500 mt-4">Then push images with: <span className="font-mono text-slate-700 dark:text-slate-300">docker push {registryHost}/{projectPath}/your-image:tag</span></p>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
