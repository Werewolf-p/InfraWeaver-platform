"use client";

import { motion } from "framer-motion";
import { KeyRound, Layers, ShieldCheck, Clock, Users } from "lucide-react";
import { ROLE_COLOR_CLASSES } from "@/lib/rbac";
import { ScopeTreePanel } from "./scope-tree-panel";
import type { SubjectBinding, SubjectKind } from "./types";

interface VizSubject {
  id: string;
  kind: SubjectKind;
  name: string;
  secondary?: string;
  related: string[];
  bindings: SubjectBinding[];
  permissions: string[];
}

const KIND_LABEL: Record<SubjectKind, string> = {
  User: "User",
  Group: "Group",
  ServiceAccount: "Service Account",
};

function bindingBadge(binding: SubjectBinding): string {
  return binding.color ? ROLE_COLOR_CLASSES[binding.color].badge : ROLE_COLOR_CLASSES.gray.badge;
}

interface SubjectDetailPanelProps {
  subject: VizSubject | null;
}

export function SubjectDetailPanel({ subject }: SubjectDetailPanelProps) {
  if (!subject) {
    return (
      <div className="flex h-full min-h-[20rem] flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/40 p-8 text-center">
        <ShieldCheck className="mb-3 h-8 w-8 text-slate-400 dark:text-slate-500" />
        <p className="text-sm font-medium text-gray-900 dark:text-white">Select a subject</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Pick a user, group, or service account to see its effective role bindings and permissions.</p>
      </div>
    );
  }

  const relatedLabel = subject.kind === "Group" ? "Members" : "Group memberships";

  return (
    <motion.div
      key={subject.id}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-5 rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-5 backdrop-blur-sm"
    >
      <div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">
          {KIND_LABEL[subject.kind]}
        </span>
        <h3 className="mt-2 break-all text-lg font-bold text-gray-900 dark:text-white">{subject.name}</h3>
        {subject.secondary ? <p className="text-sm text-slate-500 dark:text-slate-400">{subject.secondary}</p> : null}
      </div>

      <section>
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <Layers className="h-3.5 w-3.5" />Role bindings ({subject.bindings.length})
        </h4>
        {subject.bindings.length === 0 ? (
          <p className="rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
            No console role bindings resolved for this subject.
          </p>
        ) : (
          <div className="space-y-2">
            {subject.bindings.map((binding, i) => (
              <div key={`${binding.roleId}-${binding.scope}-${i}`} className="rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${bindingBadge(binding)}`}>{binding.roleName}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">on <span className="font-medium text-gray-700 dark:text-slate-200">{binding.scopeLabel}</span></span>
                  {binding.expiresAt ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                      <Clock className="h-3 w-3" />expires {new Date(binding.expiresAt).toLocaleDateString()}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">{binding.sourceLabel}</p>
                {binding.permissions.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {binding.permissions.map((permission) => (
                      <span key={permission} className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-700 dark:bg-white/10 dark:text-slate-300">
                        {permission === "*" ? "all permissions" : permission}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {subject.bindings.length > 0 ? <ScopeTreePanel bindings={subject.bindings} /> : null}

      {subject.permissions.length > 0 ? (
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <KeyRound className="h-3.5 w-3.5" />Effective permissions ({subject.permissions.includes("*") ? "all" : subject.permissions.length})
          </h4>
          <div className="flex flex-wrap gap-1">
            {subject.permissions.map((permission) => (
              <span key={permission} className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:text-emerald-300">
                {permission === "*" ? "* (full access)" : permission}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {subject.related.length > 0 ? (
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <Users className="h-3.5 w-3.5" />{relatedLabel} ({subject.related.length})
          </h4>
          <div className="flex flex-wrap gap-1">
            {subject.related.map((entry) => (
              <span key={entry} className="rounded-md border border-gray-200 dark:border-white/10 px-2 py-0.5 text-xs text-slate-600 dark:text-slate-300">{entry}</span>
            ))}
          </div>
        </section>
      ) : null}
    </motion.div>
  );
}
