"use client";

/**
 * The Explorer's left rail: the taxonomy-backed folder tree from `media.tree`
 * (pseudo-folders All = -1 and Unfiled = 0 above the real tree), plus create +
 * delete over the signed `media.folder` op. TERMS ONLY — deleting a folder removes
 * the term and its relationships; every attachment is left byte-identical (the
 * connector enforces this; the UI copy makes the guarantee explicit).
 */

import { useState, type ReactNode } from "react";
import { Folder, FolderOpen, Inbox, Layers, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "../../demo/manage/panel-shell";
import type { MediaFolderNode, MediaTree } from "../../../lib/manage/media";

export interface FolderTreeProps {
  readonly tree: MediaTree | null;
  readonly activeFolderId: number;
  readonly onSelect: (folderId: number) => void;
  /** Present only when the site is entitled + not read-only — enables mutations. */
  readonly onCreate?: (name: string, parent: number) => Promise<void>;
  readonly onDelete?: (id: number) => Promise<void>;
  readonly busy?: boolean;
}

function TreeRow({
  label,
  count,
  icon,
  active,
  depth,
  onClick,
  onDelete,
}: {
  label: string;
  count?: number;
  icon: ReactNode;
  active: boolean;
  depth: number;
  onClick: () => void;
  onDelete?: () => void;
}): ReactNode {
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-lg pr-1.5 text-sm",
        active ? "bg-sky-500/10 text-sky-700 dark:text-sky-300" : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/60",
      )}
      style={{ paddingLeft: `${0.4 + depth * 0.85}rem` }}
    >
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left focus-visible:outline-none">
        <span className={cn("shrink-0", active ? "text-current" : "text-zinc-400")}>{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {typeof count === "number" ? <span className="shrink-0 tabular-nums text-xs text-current opacity-60">{count}</span> : null}
      </button>
      {onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete folder ${label}`}
          className="shrink-0 rounded p-1 text-zinc-400 opacity-0 transition-opacity hover:text-red-500 focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export function MediaFolderTree({ tree, activeFolderId, onSelect, onCreate, onDelete, busy }: FolderTreeProps): ReactNode {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const folders: readonly MediaFolderNode[] = tree?.folders ?? [];
  const counts = tree?.counts ?? { all: 0, unfiled: 0 };

  async function submitCreate(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || !onCreate) return;
    await onCreate(trimmed, 0);
    setName("");
    setCreating(false);
  }

  return (
    <nav aria-label="Media folders" className="space-y-0.5">
      <TreeRow label="All media" count={counts.all} icon={<Layers className="h-4 w-4" />} active={activeFolderId === -1} depth={0} onClick={() => onSelect(-1)} />
      <TreeRow label="Unfiled" count={counts.unfiled} icon={<Inbox className="h-4 w-4" />} active={activeFolderId === 0} depth={0} onClick={() => onSelect(0)} />
      {folders.map((f) => (
        <TreeRow
          key={f.id}
          label={f.name}
          count={f.count}
          icon={activeFolderId === f.id ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
          active={activeFolderId === f.id}
          depth={f.depth}
          onClick={() => onSelect(f.id)}
          onDelete={onDelete ? () => void onDelete(f.id) : undefined}
        />
      ))}

      {onCreate ? (
        <div className="pt-1.5">
          {creating ? (
            <div className="flex items-center gap-1.5 px-1">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCreate();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="Folder name"
                maxLength={100}
                className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => void submitCreate()}
                disabled={busy || !name.trim()}
                className="rounded-md bg-sky-500 px-2 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
              >
                {busy ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : "Add"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100"
            >
              <Plus className="h-4 w-4" aria-hidden /> New folder
            </button>
          )}
        </div>
      ) : null}
    </nav>
  );
}
