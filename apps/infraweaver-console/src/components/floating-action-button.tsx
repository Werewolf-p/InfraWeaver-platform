"use client";
import { useState, useMemo, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, RefreshCw, Bell, X, UserPlus, Globe, Layers,
  Server, FileText, Shield, MessageSquarePlus, ChevronUp,
  HardDrive, Upload,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useRBAC } from "@/hooks/useRBAC";
import { apiClient, toApiErrorMessage } from "@/lib/api-client";

interface FABAction {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  color?: string;
}

export function FloatingActionButton() {
  const [open, setOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState<"bug" | "feature-request" | "note">("bug");
  const [feedbackDesc, setFeedbackDesc] = useState("");
  const [feedbackSeverity, setFeedbackSeverity] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [submitting, setSubmitting] = useState(false);
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useRBAC();

  const submitFeedback = useCallback(async () => {
    if (!feedbackDesc.trim()) { toast.error("Please describe the issue"); return; }
    setSubmitting(true);
    try {
      await apiClient.post("/api/feedback", {
        json: { description: feedbackDesc.trim(), type: feedbackType, pagePath: pathname, severity: feedbackType === "bug" ? feedbackSeverity : undefined },
      });
      toast.success("Feedback submitted");
      setFeedbackDesc("");
      setFeedbackType("bug");
      setFeedbackOpen(false);
    } catch (error) {
      toast.error(toApiErrorMessage(error, "Submit failed"));
    } finally {
      setSubmitting(false);
    }
  }, [feedbackDesc, feedbackType, feedbackSeverity, pathname]);

  const scrollToTop = useCallback(() => {
    document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" });
    setOpen(false);
  }, []);

  const pageActions = useMemo<FABAction[]>(() => {
    const items: FABAction[] = [];

    // Page-specific actions
    if (pathname === "/game-hub" && can("game-hub:write")) {
      items.push({ icon: Plus, label: "New Server", color: "bg-[#0078D4]/20 border-[#0078D4]/30 text-[#4db3ff]", onClick: () => { setOpen(false); router.push("/game-hub/new"); } });
    }
    if (pathname === "/game-hub" && can("game-hub:admin", "/game-hub/")) {
      items.push({ icon: HardDrive, label: "Cleanup PVCs", color: "bg-[#0078D4]/20 border-[#0078D4]/30 text-[#4db3ff]", onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:game-hub:cleanup-pvcs")); } });
      items.push({ icon: Upload, label: "Import Config", color: "bg-[#0078D4]/20 border-[#0078D4]/30 text-[#4db3ff]", onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:game-hub:import-config")); } });
    }
    if (pathname === "/dns" && can("config:write")) {
      items.push({ icon: Globe, label: "Add DNS Record", color: "bg-teal-500/20 border-teal-500/30 text-teal-300", onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:dns:add")); } });
    }
    if ((pathname.startsWith("/users") || pathname === "/settings/rbac") && can("users:invite")) {
      items.push({ icon: UserPlus, label: "Invite User", color: "bg-purple-500/20 border-purple-500/30 text-purple-300", onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:users:invite")); } });
    }
    if ((pathname === "/apps" || pathname === "/community-apps") && can("catalog:write")) {
      items.push({ icon: Layers, label: "Install App", color: "bg-green-500/20 border-green-500/30 text-green-300", onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:apps:install")); } });
    }
    if ((pathname === "/logs" || pathname === "/log-analytics") && can("cluster:read")) {
      items.push({ icon: FileText, label: "Export Logs", color: "bg-amber-500/20 border-amber-500/30 text-amber-300", onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:logs:export")); } });
    }
    if ((pathname.startsWith("/security") || pathname === "/image-vulnerabilities") && can("security:read")) {
      items.push({ icon: Shield, label: "Run Scan", color: "bg-red-500/20 border-red-500/30 text-red-300", onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:security:scan")); } });
    }
    if (["/home", "/cluster", "/health", "/status"].includes(pathname) || pathname.startsWith("/gitops")) {
      if (can("apps:sync")) {
        items.push({
          icon: RefreshCw, label: "Sync All", color: "bg-indigo-500/20 border-indigo-500/30 text-indigo-300",
          onClick: async () => {
            setOpen(false);
            try { const res = await fetch("/api/argocd/sync-all", { method: "POST" }); if (res.ok) { toast.success("Sync triggered"); qc.invalidateQueries({ queryKey: ["argocd", "apps"] }); } else { toast.error("Sync failed"); } } catch { toast.error("Sync failed"); }
          },
        });
      }
      if (["/home", "/cluster", "/health", "/status"].includes(pathname)) {
        items.push({ icon: Bell, label: "View Events", color: "bg-amber-500/20 border-amber-500/30 text-amber-300", onClick: () => { setOpen(false); router.push("/events"); } });
      }
    }

    // Always-available actions
    items.push({ icon: MessageSquarePlus, label: "Report Feedback", color: "bg-emerald-500/20 border-emerald-500/30 text-emerald-300", onClick: () => { setOpen(false); setFeedbackOpen(true); } });
    items.push({ icon: ChevronUp, label: "Back to Top", color: "bg-gray-500/20 border-gray-500/30 text-gray-300", onClick: scrollToTop });

    return items;
  }, [pathname, can, qc, router, scrollToTop]);

  // Game server detail pages: no global FAB (detail view has its own controls)
  if (pathname.startsWith("/game-hub/") && pathname !== "/game-hub/new" && pathname !== "/game-hub") return null;

  return (
    <>
      <div className="fixed bottom-24 right-4 sm:bottom-6 sm:right-6 z-40 flex flex-col items-end gap-2">
        <AnimatePresence>
          {open && pageActions.map((action, i) => (
            <motion.button
              key={action.label}
              initial={{ opacity: 0, scale: 0.8, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: 10 }}
              transition={{ delay: i * 0.04, type: "spring", stiffness: 400, damping: 25 }}
              onClick={action.onClick}
              className={cn("flex items-center gap-2 px-4 py-2 rounded-full border text-sm font-medium shadow-lg backdrop-blur-sm", action.color)}
            >
              <action.icon className="w-4 h-4" />
              {action.label}
            </motion.button>
          ))}
        </AnimatePresence>

        <motion.button
          onClick={() => setOpen(o => !o)}
          whileTap={{ scale: 0.9 }}
          animate={{ rotate: open ? 45 : 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
          className="w-14 h-14 rounded-full bg-indigo-500 shadow-lg shadow-indigo-500/30 flex items-center justify-center text-white border border-indigo-400/50"
        >
          {open ? <X className="w-6 h-6" /> : <Plus className="w-6 h-6" />}
        </motion.button>
      </div>

      {/* Inline feedback modal */}
      <AnimatePresence>
        {feedbackOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setFeedbackOpen(false)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} onClick={e => e.stopPropagation()} className="w-full max-w-md mx-4 p-6 rounded-2xl border border-gray-200 dark:border-[#333] bg-white dark:bg-[#1a1a1a] shadow-2xl">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Report Feedback</h3>
              <div className="flex gap-2 mb-3">
                {(["bug", "feature-request", "note"] as const).map(t => (
                  <button key={t} onClick={() => setFeedbackType(t)} className={cn("px-3 py-1.5 rounded-full text-xs font-medium border transition", feedbackType === t ? "bg-indigo-500 text-white border-indigo-500" : "border-gray-300 dark:border-[#444] text-gray-600 dark:text-gray-400")}>
                    {t === "bug" ? "🐛 Bug" : t === "feature-request" ? "✨ Feature" : "📝 Note"}
                  </button>
                ))}
              </div>
              {feedbackType === "bug" && (
                <div className="flex gap-2 mb-3">
                  {(["low", "medium", "high", "critical"] as const).map(s => (
                    <button key={s} onClick={() => setFeedbackSeverity(s)} className={cn("px-2 py-1 rounded text-xs border transition", feedbackSeverity === s ? "bg-orange-500 text-white border-orange-500" : "border-gray-300 dark:border-[#444] text-gray-500 dark:text-gray-400")}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <textarea value={feedbackDesc} onChange={e => setFeedbackDesc(e.target.value)} placeholder="Describe the issue or idea..." className="w-full h-28 px-3 py-2 rounded-lg border border-gray-300 dark:border-[#444] bg-gray-50 dark:bg-[#111] text-sm text-gray-900 dark:text-white resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-3">Page: {pathname}</p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setFeedbackOpen(false)} className="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-[#222]">Cancel</button>
                <button onClick={submitFeedback} disabled={submitting} className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50">
                  {submitting ? "Sending..." : "Submit"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
