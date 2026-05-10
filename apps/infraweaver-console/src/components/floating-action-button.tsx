"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, RefreshCw, Bell, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface FABAction {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  color?: string;
}

export function FloatingActionButton() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const actions: FABAction[] = [
    {
      icon: RefreshCw,
      label: "Sync All",
      color: "bg-indigo-500/20 border-indigo-500/30 text-indigo-300",
      onClick: async () => {
        setOpen(false);
        try {
          const res = await fetch("/api/argocd/sync-all", { method: "POST" });
          if (res.ok) {
            toast.success("Sync triggered for all apps");
            qc.invalidateQueries({ queryKey: ["argocd", "apps"] });
          } else {
            toast.error("Sync all failed");
          }
        } catch {
          toast.error("Sync all failed");
        }
      },
    },
    {
      icon: Bell,
      label: "View Events",
      color: "bg-amber-500/20 border-amber-500/30 text-amber-300",
      onClick: () => {
        setOpen(false);
        window.location.href = "/events";
      },
    },
  ];

  return (
    <div className="fixed bottom-24 right-4 z-40 md:hidden flex flex-col items-end gap-3">
      <AnimatePresence>
        {open && (
          <>
            {actions.map((action, i) => (
              <motion.button
                key={action.label}
                initial={{ opacity: 0, scale: 0.8, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.8, y: 10 }}
                transition={{ delay: i * 0.05, type: "spring", stiffness: 400, damping: 25 }}
                onClick={action.onClick}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 rounded-full border text-sm font-medium shadow-lg backdrop-blur-sm",
                  action.color
                )}
              >
                <action.icon className="w-4 h-4" />
                {action.label}
              </motion.button>
            ))}
          </>
        )}
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
  );
}
