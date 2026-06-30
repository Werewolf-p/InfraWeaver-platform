"use client";

import { CornerDownRight, FolderTree, MapPin } from "lucide-react";
import { ROLE_COLOR_CLASSES } from "@/lib/rbac";
import { buildScopeTree, flattenScopeTree, type ScopeTreeNode } from "./scope-tree";
import type { SubjectBinding } from "./types";

const INDENT_PER_DEPTH_REM = 1.1;

function bindingBadge(binding: SubjectBinding): string {
  return binding.color ? ROLE_COLOR_CLASSES[binding.color].badge : ROLE_COLOR_CLASSES.gray.badge;
}

function ScopeNodeRow({ node }: { node: ScopeTreeNode }) {
  const hasGrants = node.direct.length > 0 || node.inherited.length > 0;
  return (
    <div
      style={{ marginLeft: `${node.depth * INDENT_PER_DEPTH_REM}rem` }}
      className="border-l border-gray-200 dark:border-white/10 pl-3"
    >
      <div className="flex items-center gap-1.5 py-1">
        <FolderTree className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />
        <span className="text-sm font-medium text-gray-900 dark:text-white">{node.label}</span>
        <code className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-white/10 dark:text-slate-400">
          {node.scope}
        </code>
      </div>

      {hasGrants ? (
        <div className="mb-1 space-y-1 pl-5">
          {node.direct.map((binding, i) => (
            <div key={`direct-${binding.roleId}-${binding.scope}-${i}`} className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${bindingBadge(binding)}`}>{binding.roleName}</span>
              <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                <MapPin className="h-3 w-3" />assigned here
              </span>
              <span className="text-[11px] text-slate-400 dark:text-slate-500">{binding.sourceLabel}</span>
            </div>
          ))}
          {node.inherited.map((grant, i) => (
            <div key={`inherited-${grant.binding.roleId}-${grant.fromScope}-${i}`} className="flex flex-wrap items-center gap-1.5 opacity-90">
              <span className={`rounded-md border border-dashed px-2 py-0.5 text-xs font-semibold ${bindingBadge(grant.binding)}`}>{grant.binding.roleName}</span>
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                <CornerDownRight className="h-3 w-3" />inherited from {grant.fromLabel}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {node.children.map((child) => (
        <ScopeNodeRow key={child.scope} node={child} />
      ))}
    </div>
  );
}

interface ScopeTreePanelProps {
  bindings: SubjectBinding[];
}

/**
 * Renders a subject's grants as the Azure-style scope hierarchy, distinguishing
 * grants assigned directly on a scope from grants inherited from an ancestor.
 */
export function ScopeTreePanel({ bindings }: ScopeTreePanelProps) {
  const roots = buildScopeTree(bindings);
  if (roots.length === 0) return null;

  const inheritedCount = flattenScopeTree(roots).reduce((sum, node) => sum + node.inherited.length, 0);

  return (
    <section>
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <FolderTree className="h-3.5 w-3.5" />Scope inheritance
      </h4>
      <p className="mb-2 text-[11px] text-slate-400 dark:text-slate-500">
        A grant on a parent scope cascades to all child scopes.
        {inheritedCount > 0 ? ` ${inheritedCount} inherited grant${inheritedCount === 1 ? "" : "s"} shown.` : ""}
      </p>
      <div className="space-y-0.5 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 p-3">
        {roots.map((root) => (
          <ScopeNodeRow key={root.scope} node={root} />
        ))}
      </div>
    </section>
  );
}
