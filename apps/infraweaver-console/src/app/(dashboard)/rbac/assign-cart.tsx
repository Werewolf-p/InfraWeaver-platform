"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Check, Loader2, Plus, Trash2, Undo2, X, ShoppingCart, AlertTriangle, Ban } from "lucide-react";
import { resolveRoleDefinition, scopeLabel } from "@/lib/rbac";
import { computeEffectivePreview } from "@/lib/rbac-effective-preview";
import { EffectiveAccessPreview } from "@/components/rbac/effective-access-preview";
import type { RbacCart } from "./use-rbac-cart";
import type { AssignmentRow } from "./resources";

interface AssignCartProps {
  cart: RbacCart;
  assignments: AssignmentRow[];
}

/**
 * The staging rail: unwritten grants + revokes, a live effective-access preview,
 * per-principal apply results, and the Apply bar. Apply is delegated to the cart,
 * which issues one canonical PUT per principal.
 */
export function AssignCart({ cart, assignments }: AssignCartProps) {
  const assignmentById = new Map(assignments.map((assignment) => [assignment.id, assignment]));

  const preview = computeEffectivePreview({
    assignments: assignments.map((a) => ({ ...a, principal: a.username, principalLabel: a.userName || a.username })),
    pendingGrants: cart.pendingGrants.map((g) => ({
      principalType: g.principalType,
      principal: g.principal,
      principalLabel: g.principalLabel,
      roleId: g.roleId,
      scope: g.scope,
    })),
    revokedIds: [...cart.pendingRevokes.keys()],
  });

  const failures = cart.results.filter((result) => !result.ok);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-[#2a2a2a] dark:bg-[#111]">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-[#1e1e1e]">
          <ShoppingCart className="h-3.5 w-3.5 text-gray-400 dark:text-[#555]" />
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-[#888]">Staged changes</span>
          <span className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] text-gray-400 dark:border-[#2a2a2a] dark:bg-[#1a1a1a] dark:text-[#555]">{cart.dirtyCount}</span>
        </div>

        {cart.dirtyCount === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-xs text-slate-400">
            <ShoppingCart className="h-5 w-5 text-gray-300 dark:text-[#333]" />
            Nothing staged yet. Use <span className="font-medium text-slate-500">Grant access</span> or pick a subject / resource to add or remove rights.
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-[#1a1a1a]">
            <AnimatePresence initial={false}>
              {cart.pendingGrants.map((grant) => {
                const role = resolveRoleDefinition(grant.roleId);
                return (
                  <motion.div
                    key={`grant-${grant.key}`}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    className="flex items-center gap-2 bg-emerald-500/5 px-4 py-2.5"
                  >
                    <Plus className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-gray-900 dark:text-[#f2f2f2]">{grant.principalLabel}</p>
                      <p className="truncate text-[10px] text-slate-400">
                        {grant.effect === "Deny" && <span className="mr-1 text-red-400">Deny</span>}
                        {role?.name ?? grant.roleId} · {scopeLabel(grant.scope)}
                        {grant.expiresAt ? ` · expires ${new Date(grant.expiresAt).toLocaleDateString()}` : ""}
                      </p>
                    </div>
                    <button onClick={() => cart.unstageGrant(grant.key)} aria-label="Remove from staged" className="p-1 text-gray-400 transition-colors hover:text-red-400 dark:text-[#444]"><X className="h-3.5 w-3.5" /></button>
                  </motion.div>
                );
              })}
              {[...cart.pendingRevokes.entries()].map(([id, meta]) => {
                const assignment = assignmentById.get(id);
                const role = assignment ? resolveRoleDefinition(assignment.roleId) : null;
                return (
                  <motion.div
                    key={`revoke-${id}`}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    className="flex items-center gap-2 bg-red-500/5 px-4 py-2.5"
                  >
                    <Trash2 className="h-3.5 w-3.5 flex-shrink-0 text-red-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-gray-900 line-through dark:text-[#f2f2f2]">{assignment?.userName || meta.principal}</p>
                      <p className="truncate text-[10px] text-slate-400 line-through">
                        {assignment ? `${role?.name ?? assignment.roleId} · ${scopeLabel(assignment.scope)}` : "assignment"}
                      </p>
                    </div>
                    <button onClick={() => cart.toggleRevoke({ id, principalType: meta.principalType, principal: meta.principal })} aria-label="Keep this assignment" className="p-1 text-indigo-400 transition-colors hover:text-indigo-300"><Undo2 className="h-3.5 w-3.5" /></button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}

        {cart.dirtyCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#0078D4]/30 bg-[#0078D4]/5 px-4 py-3">
            <p className="text-[11px] text-gray-500 dark:text-[#888]">Batched per person — one commit &amp; one email each.</p>
            <div className="flex items-center gap-2">
              <button onClick={cart.discardAll} disabled={cart.isApplying} className="px-3 py-1.5 text-xs text-gray-500 transition-colors hover:text-gray-900 disabled:opacity-50 dark:text-[#888] dark:hover:text-[#f2f2f2]">Discard</button>
              <button
                onClick={cart.apply}
                disabled={cart.isApplying}
                className="flex items-center gap-1.5 rounded-lg bg-[#0078D4] px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#006cbd] disabled:opacity-50"
              >
                {cart.isApplying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Apply {cart.dirtyCount} change{cart.dirtyCount === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        )}

        {failures.length > 0 && (
          <div className="space-y-1 border-t border-red-500/30 bg-red-500/5 px-4 py-3">
            {failures.map((failure) => (
              <p key={failure.principal} className="flex items-start gap-1.5 text-[11px] text-red-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" /> <span><span className="font-medium">{failure.principal}</span>: {failure.error}</span>
              </p>
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {preview.length > 0 && <EffectiveAccessPreview previews={preview} />}
      </AnimatePresence>

      {cart.pendingGrants.some((g) => g.effect === "Deny") && (
        <p className="flex items-center gap-1 px-1 text-[10px] text-slate-400">
          <Ban className="h-3 w-3 text-red-400" /> Deny grants apply correctly; the preview above summarizes allows.
        </p>
      )}
    </div>
  );
}
