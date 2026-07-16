"use client";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Ban, Clock, Sparkles, Plus, Trash2, User, Users, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PrincipalPreview } from "@/lib/rbac-effective-preview";

/** Springy-but-quick default for the preview's mount / undo / apply motion. */
const SPRING = { type: "spring" as const, stiffness: 500, damping: 32, mass: 0.6 };

const NET_META: Record<PrincipalPreview["net"], { label: string; className: string; Icon: React.ElementType }> = {
  gain: { label: "gains access", className: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30", Icon: ArrowUpRight },
  loss: { label: "loses access", className: "text-red-300 bg-red-500/10 border-red-500/30", Icon: ArrowDownRight },
  mixed: { label: "access changes", className: "text-amber-300 bg-amber-500/10 border-amber-500/30", Icon: Sparkles },
  none: { label: "no net change", className: "text-gray-400 dark:text-[#888] bg-white dark:bg-[#1a1a1a] border-gray-200 dark:border-[#2a2a2a]", Icon: Check },
};

/** One capability chip — allow (emerald) or deny (red), with an optional scope tag. */
function RightChip({ label, tone, scopeLabel: scope }: Omit<PrincipalPreview["rights"][number], "key">) {
  const allow = tone === "allow";
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.8, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.8, y: -4 }}
      transition={SPRING}
      className={cn(
        "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-medium",
        allow
          ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
          : "bg-red-500/10 border-red-500/30 text-red-300",
      )}
    >
      {allow ? <Check className="w-2.5 h-2.5 flex-shrink-0" /> : <Ban className="w-2.5 h-2.5 flex-shrink-0" />}
      {label}
      {scope && <span className="opacity-60 font-mono">· {scope}</span>}
    </motion.span>
  );
}

/**
 * Live read-out of what each staged principal will actually be able to do once
 * the editor's pending changes are applied — humanized rights, Allow/Deny, and
 * expiry, with springy motion as grants are staged, undone, or applied.
 */
export function EffectiveAccessPreview({ previews }: { previews: PrincipalPreview[] }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      exit={{ opacity: 0, y: -8, height: 0 }}
      transition={SPRING}
      className="rounded-xl border border-[#0078D4]/30 bg-[#0a1929] overflow-hidden"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#0078D4]/20">
        <Sparkles className="w-3.5 h-3.5 text-[#4fc3f7]" />
        <span className="text-xs font-semibold text-[#4fc3f7] uppercase tracking-wide">Effective access after apply</span>
        <span className="text-[10px] text-[#4a8ec2]">— what each person can do once you click Apply</span>
      </div>
      <div className="divide-y divide-[#0078D4]/10">
        <AnimatePresence initial={false}>
          {previews.map((p) => {
            const net = NET_META[p.net];
            return (
              <motion.div
                key={p.key}
                layout
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.98 }}
                transition={SPRING}
                className="px-4 py-3 space-y-2.5"
              >
                {/* Principal + net badge */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-6 h-6 rounded-full bg-white dark:bg-[#111] border border-[#0078D4]/30 flex items-center justify-center flex-shrink-0">
                      {p.principalType === "group" ? <Users className="w-3 h-3 text-indigo-400" /> : <User className="w-3 h-3 text-[#4fc3f7]" />}
                    </div>
                    <span className="text-xs font-medium text-gray-900 dark:text-[#f2f2f2] truncate">{p.principalLabel}</span>
                    {p.expiringSoon && (
                      <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300">
                        <Clock className="w-2.5 h-2.5" /> expiring soon
                      </span>
                    )}
                  </div>
                  <motion.span
                    layout
                    className={cn("inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium flex-shrink-0", net.className)}
                  >
                    <net.Icon className="w-2.5 h-2.5" /> {net.label}
                  </motion.span>
                </div>

                {/* Humanized rights */}
                {p.rights.length > 0 ? (
                  <motion.div layout className="flex flex-wrap gap-1">
                    <AnimatePresence initial={false}>
                      {p.rights.map((right) => (
                        <RightChip key={right.key} label={right.label} tone={right.tone} scopeLabel={right.scopeLabel} />
                      ))}
                    </AnimatePresence>
                  </motion.div>
                ) : (
                  <p className="text-[10px] text-gray-400 dark:text-[#9a9a9a] italic">No effective access remains — this principal will hold no roles.</p>
                )}

                {/* Delta grant lines */}
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  <AnimatePresence initial={false}>
                    {p.grants.map((g) => (
                      <motion.span
                        key={g.key}
                        layout
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.85 }}
                        transition={SPRING}
                        className={cn(
                          "inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-mono border",
                          g.state === "added" && "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
                          g.state === "removed" && "bg-red-500/5 border-red-500/30 text-red-300 line-through opacity-70",
                          g.state === "existing" && "bg-white dark:bg-[#111] border-gray-200 dark:border-[#2a2a2a] text-gray-400 dark:text-[#888]",
                        )}
                        title={`${g.roleName} @ ${g.scopeLabel}${g.expiresAt ? ` · expires ${new Date(g.expiresAt).toLocaleDateString()}` : ""}`}
                      >
                        {g.state === "added" && <Plus className="w-2.5 h-2.5" />}
                        {g.state === "removed" && <Trash2 className="w-2.5 h-2.5" />}
                        {g.effect === "Deny" && <Ban className="w-2.5 h-2.5 text-red-400" />}
                        {g.roleName}
                        <span className="opacity-60">· {g.scopeLabel}</span>
                        {g.expiresAt && <Clock className="w-2.5 h-2.5 text-amber-400" />}
                      </motion.span>
                    ))}
                  </AnimatePresence>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
