"use client";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Keyboard } from "lucide-react";
import { cn } from "@/lib/utils";

interface ShortcutRow {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  category: string;
  shortcuts: ShortcutRow[];
}

const shortcutGroups: ShortcutGroup[] = [
  {
    category: "Navigation",
    shortcuts: [
      { keys: ["⌘K"], label: "Open command palette" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
      { keys: ["G", "D"], label: "Go to Dashboard" },
      { keys: ["G", "A"], label: "Go to Apps" },
      { keys: ["U"], label: "Go to Users" },
      { keys: ["G", "H"], label: "Go to Health" },
      { keys: ["G", "K"], label: "Go to Cluster" },
      { keys: ["G", "S"], label: "Go to Storage" },
      { keys: ["G", "N"], label: "Go to Network" },
      { keys: ["G", "Z"], label: "Go to DNS" },
      { keys: ["G", "L"], label: "Go to Logs" },
      { keys: ["G", "C"], label: "Go to Config" },
      { keys: ["G", "Y"], label: "Go to Security" },
      { keys: ["G", "O"], label: "Go to Home Portal" },
    ],
  },
  {
    category: "Actions",
    shortcuts: [
      { keys: ["Esc"], label: "Close modal / palette" },
      { keys: ["R"], label: "Refresh current view" },
    ],
  },
];

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ open, onClose }: KeyboardShortcutsModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[9998] flex items-center justify-center px-4"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="relative w-full max-w-lg bg-slate-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Keyboard className="w-4 h-4 text-indigo-400" />
                <h2 className="text-sm font-semibold text-white">Keyboard Shortcuts</h2>
              </div>
              <button
                onClick={onClose}
                className="text-slate-500 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content */}
            <div className="px-5 py-4 space-y-5 max-h-[70vh] overflow-y-auto">
              {shortcutGroups.map(group => (
                <div key={group.category}>
                  <h3 className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 mb-2">
                    {group.category}
                  </h3>
                  <div className="space-y-1.5">
                    {group.shortcuts.map((shortcut, idx) => (
                      <div key={idx} className="flex items-center justify-between">
                        <span className="text-sm text-slate-300">{shortcut.label}</span>
                        <div className="flex items-center gap-1">
                          {shortcut.keys.map((key, ki) => (
                            <kbd
                              key={ki}
                              className={cn(
                                "text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-800 border border-white/10 text-slate-300",
                                shortcut.keys.length > 1 && ki < shortcut.keys.length - 1 && "mr-0.5"
                              )}
                            >
                              {key}
                            </kbd>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-white/5 text-[11px] text-slate-600 text-center">
              Press <kbd className="bg-slate-800 border border-white/10 rounded px-1 text-slate-400">?</kbd> anytime to open this
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function KeyboardShortcutsProvider({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;
      if (isInput) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen(prev => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      {children}
      <KeyboardShortcutsModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
