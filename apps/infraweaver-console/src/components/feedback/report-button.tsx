"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { MessageSquarePlus, X, Bug, Lightbulb, StickyNote } from "lucide-react";
import { apiClient, toApiErrorMessage } from "@/lib/api-client";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";

type FeedbackType = "bug" | "feature-request" | "note";
type Severity = "low" | "medium" | "high" | "critical";

const TYPE_OPTIONS: { id: FeedbackType; label: string; icon: typeof Bug }[] = [
  { id: "bug", label: "Bug", icon: Bug },
  { id: "feature-request", label: "Feature", icon: Lightbulb },
  { id: "note", label: "Note", icon: StickyNote },
];

const SEVERITY_OPTIONS: Severity[] = ["low", "medium", "high", "critical"];

/**
 * Small, unobtrusive bottom-right "report" button (Elementor-style). Lets a
 * developer flag the current page/object with a note. Submissions are persisted
 * via the auth-gated /api/feedback route and reviewed by an admin before any
 * automation runs — nothing here triggers a fix directly.
 */
export function ReportButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackType>("bug");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!description.trim()) {
      toast.error("Please describe the issue or request");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post("/api/feedback", {
        json: {
          description: description.trim(),
          type,
          pagePath: pathname,
          severity: type === "bug" ? severity : undefined,
        },
      });
      toast.success("Feedback submitted for review");
      setDescription("");
      setType("bug");
      setSeverity("medium");
      setOpen(false);
    } catch (error) {
      toast.error(toApiErrorMessage(error, "Failed to submit feedback"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Report feedback on this page"
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-20 sm:bottom-6 sm:right-24 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-emerald-400/50 bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-600"
      >
        <MessageSquarePlus className="h-5 w-5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-end justify-end p-4 sm:items-center sm:justify-center"
          >
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => !submitting && setOpen(false)}
            />
            <motion.div
              initial={{ y: 24, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 24, opacity: 0, scale: 0.98 }}
              className="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-[#262626] dark:bg-[#161616]"
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-gray-900 dark:text-white">Report feedback</h2>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => !submitting && setOpen(false)}
                  className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-[#222]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <p className="mb-3 truncate text-[11px] font-mono text-gray-400 dark:text-[#666]">
                Page: {pathname}
              </p>

              <div className="mb-3 grid grid-cols-3 gap-2">
                {TYPE_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  const active = type === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setType(opt.id)}
                      className={cn(
                        "flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-xs transition",
                        active
                          ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                          : "border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-[#262626] dark:text-[#888] dark:hover:bg-[#1d1d1d]",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              {type === "bug" && (
                <div className="mb-3">
                  <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-[#888]">Severity</label>
                  <div className="flex gap-2">
                    {SEVERITY_OPTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSeverity(s)}
                        className={cn(
                          "flex-1 rounded-lg border px-2 py-1 text-[11px] capitalize transition",
                          severity === s
                            ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                            : "border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-[#262626] dark:text-[#888] dark:hover:bg-[#1d1d1d]",
                        )}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={4000}
                placeholder="Describe the bug, request, or note for this page/object…"
                className="mb-3 w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-emerald-400 dark:border-[#262626] dark:bg-[#0f0f0f] dark:text-white"
              />

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => !submitting && setOpen(false)}
                  className="rounded-lg px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 dark:text-[#888] dark:hover:bg-[#222]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={submitting}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                >
                  {submitting ? "Submitting…" : "Submit"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default ReportButton;
