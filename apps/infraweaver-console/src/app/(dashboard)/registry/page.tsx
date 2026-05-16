"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Package, Search, ChevronDown, ChevronRight, Trash2, Info, Terminal, X } from "lucide-react";
import { toast } from "@/lib/notify";
import { useRegistryRepos, useRegistryTags, useDeleteTag } from "@/hooks/use-registry";
import { useRBAC } from "@/hooks/use-rbac";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { cn, formatBytes } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";

const REGISTRY_HOST = "registry.int.rlservers.com";

function TagRow({ repo, tag, onDelete, isAdmin }: {
  repo: string;
  tag: { tag: string; digest: string; size: number; pushedAt: string | null };
  onDelete: () => void;
  isAdmin: boolean;
}) {
  const pullCmd = `docker pull ${REGISTRY_HOST}/${repo}:${tag.tag}`;
  return (
    <div className="flex items-center gap-4 px-4 py-2.5 bg-white/3 border-b border-white/5 last:border-0 text-sm overflow-x-auto">
      <PageHeader icon={Package} title="Container Registry" />
      <span className="text-slate-300 font-mono text-xs w-32 truncate">{tag.tag}</span>
      <span className="text-slate-500 font-mono text-xs w-36 truncate">{tag.digest || "—"}</span>
      <span className="text-slate-400 text-xs w-20">{tag.size ? formatBytes(tag.size) : "—"}</span>
      <span className="text-slate-500 text-xs flex-1">{tag.pushedAt ? new Date(tag.pushedAt).toLocaleDateString() : "—"}</span>
      <div className="flex items-center gap-2">
        <CopyButton text={pullCmd} label="Pull" />
        {isAdmin && (
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function RepoRow({ name }: { name: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data: tagsData, isLoading: tagsLoading } = useRegistryTags(expanded ? name : "");
  const deleteMutation = useDeleteTag();
  const { isAdmin } = useRBAC();
  const [deleteTarget, setDeleteTarget] = useState<{ repo: string; tag: string } | null>(null);

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
        className="border-b border-white/5 last:border-0"
      >
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-white/5 transition-colors text-left"
        >
          {expanded ? <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />}
          <Package className="w-4 h-4 text-indigo-400 flex-shrink-0" />
          <span className="text-sm font-medium text-white flex-1">{name}</span>
          <span className="text-xs text-slate-500">{tagsData?.tags?.length ?? "—"} tags</span>
        </button>
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden bg-slate-950/50"
            >
              {tagsLoading ? (
                <div className="px-4 py-3 space-y-2">
                  {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-8" />)}
                </div>
              ) : (
                <div>
                  {(tagsData?.tags ?? []).map(tag => (
                    <TagRow
                      key={tag.tag}
                      repo={name}
                      tag={tag}
                      isAdmin={isAdmin}
                      onDelete={() => setDeleteTarget({ repo: name, tag: tag.tag })}
                    />
                  ))}
                  {!tagsData?.tags?.length && (
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

  const repos = (data?.repositories ?? []).filter(r => r.toLowerCase().includes(search.toLowerCase()));
  const loginCmd = `docker login ${REGISTRY_HOST}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Package className="w-5 h-5 text-indigo-400" />
            Container Registry
          </h2>
          <p className="text-sm text-slate-400 mt-0.5">{REGISTRY_HOST}</p>
        </div>
        <button
          onClick={() => setShowLoginModal(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors"
        >
          <Terminal className="w-4 h-4" />
          Login Instructions
        </button>
      </div>

      <div className="relative mb-5 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search repositories..."
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
        />
      </div>

      {data?.mock && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400">
          <Info className="w-4 h-4 flex-shrink-0" />
          Registry unreachable — check REGISTRY_HOST, REGISTRY_USERNAME and REGISTRY_PASSWORD configuration
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      ) : (
        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl overflow-hidden">
          <div className="grid grid-cols-[auto_1fr_auto] gap-4 px-4 py-2 border-b border-white/5 text-xs text-slate-500 font-medium uppercase tracking-wide">
            <span className="w-4" />
            <span>Repository</span>
            <span>Tags</span>
          </div>
          {repos.map(name => <RepoRow key={name} name={name} />)}
          {repos.length === 0 && (
            <div className="py-12 text-center text-slate-500 text-sm">No repositories found</div>
          )}
        </div>
      )}

      <AnimatePresence>
        {showLoginModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowLoginModal(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-md bg-slate-900 border border-white/10 rounded-xl p-6 shadow-2xl z-10"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-white">Registry Login</h3>
                <button onClick={() => setShowLoginModal(false)} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
              </div>
              <p className="text-sm text-slate-400 mb-4">Run the following command to authenticate with the registry:</p>
              <div className="bg-slate-950 border border-white/10 rounded-lg p-3 font-mono text-sm text-green-400 mb-3">
                {loginCmd}
              </div>
              <CopyButton text={loginCmd} label="Copy command" className="w-full justify-center" />
              <p className="text-xs text-slate-500 mt-4">Then push images with: <span className="font-mono text-slate-300">docker push {REGISTRY_HOST}/your-image:tag</span></p>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
