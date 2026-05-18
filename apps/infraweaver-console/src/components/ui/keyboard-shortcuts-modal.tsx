"use client";
import { useState, useEffect } from "react";
import { X, Keyboard } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { KEYBOARD_SHORTCUTS } from "@/lib/keyboard-shortcuts";

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ open, onClose }: KeyboardShortcutsModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const categories = [...new Set(KEYBOARD_SHORTCUTS.map((shortcut) => shortcut.category))];

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.2 }}
            className="relative z-10 w-full max-w-lg rounded-2xl border border-gray-200 dark:border-white/10 bg-neutral-900 shadow-2xl"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-white/10">
              <div className="flex items-center gap-2">
                <Keyboard className="w-4 h-4 text-gray-500 dark:text-white/50" />
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Keyboard Shortcuts</h2>
              </div>
              <button onClick={onClose} className="text-gray-400 dark:text-white/40 hover:text-gray-900 dark:hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
              {categories.map(cat => (
                <div key={cat}>
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-white/30 mb-3">{cat}</h3>
                  <div className="space-y-2">
                    {KEYBOARD_SHORTCUTS.filter((shortcut) => shortcut.category === cat).map((shortcut, index) => (
                      <div key={`${cat}-${index}`} className="flex items-center justify-between">
                        <span className="text-sm text-gray-600 dark:text-white/70">{shortcut.description}</span>
                        <div className="flex items-center gap-1">
                          {shortcut.keys.map((key, keyIndex) => (
                            <kbd key={`${shortcut.description}-${keyIndex}`} className={cn(
                              "px-1.5 py-0.5 text-xs rounded border border-gray-200 dark:border-white/20 bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-white/60 font-mono",
                              keyIndex < shortcut.keys.length - 1 && "mr-0.5"
                            )}>{key}</kbd>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export function KeyboardShortcutsProvider() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        setOpen(o => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return <KeyboardShortcutsModal open={open} onClose={() => setOpen(false)} />;
}
