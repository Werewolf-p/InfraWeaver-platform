"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, ArrowRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface Step {
  title: string;
  description: string;
  action?: { label: string; href: string };
}

const STEPS: Step[] = [
  {
    title: "InfraWeaver Console",
    description: "One place to oversee Kubernetes, ArgoCD, storage, and security across your homelab.",
  },
  {
    title: "Your applications",
    description: "Check the health and sync state of every running application, and trigger a sync when needed.",
    action: { label: "Go to Apps", href: "/apps" },
  },
  {
    title: "Pod logs",
    description: "Stream live output from any pod, filter by log level, and copy lines to the clipboard.",
    action: { label: "Open Logs", href: "/logs" },
  },
  {
    title: "Settings",
    description: "Set your preferred refresh interval, display density, and color theme.",
    action: { label: "Open Settings", href: "/settings" },
  },
];

const STORAGE_KEY = "infraweaver:onboarded";

interface OnboardingWizardProps {
  className?: string;
}

export function OnboardingWizard({ className }: OnboardingWizardProps) {
  // Start hidden so the server render and the first client (hydration) render
  // agree — reading localStorage in the initial state made the server render
  // null while the client rendered the modal, tripping a hydration mismatch
  // (React #418). Reveal after mount, once localStorage is safe to read.
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!localStorage.getItem(STORAGE_KEY)) setVisible(true);
    } catch { /* localStorage unavailable — leave the tour hidden */ }
  }, []);

  if (!visible) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const handleDismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* ignore */ }
    setVisible(false);
  };

  const handleNext = () => {
    if (isLast) {
      handleDismiss();
    } else {
      setStep(s => s + 1);
    }
  };

  return (
    <AnimatePresence>
      {visible && (
        <div className={cn("fixed inset-0 z-modal flex items-center justify-center", className)}>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.2 }}
            className="relative z-10 w-full max-w-md rounded-2xl border border-gray-200 dark:border-white/10 bg-neutral-900 shadow-2xl p-8"
          >
            <button onClick={handleDismiss} className="absolute top-4 right-4 text-gray-400 dark:text-white/30 hover:text-white/60">
              <X className="w-4 h-4" />
            </button>

            <div className="flex gap-1.5 mb-6">
              {STEPS.map((_, i) => (
                <div key={i} className={cn("h-1 flex-1 rounded-full transition-colors", i <= step ? "bg-indigo-500" : "bg-gray-100 dark:bg-white/10")} />
              ))}
            </div>

            <CheckCircle className="w-8 h-8 text-indigo-400 mb-4" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{current.title}</h2>
            <p className="text-sm text-gray-500 dark:text-white/60 mb-8 leading-relaxed">{current.description}</p>

            <div className="flex items-center justify-between">
              <button onClick={handleDismiss} className="text-xs text-gray-400 dark:text-white/30 hover:text-white/60 transition-colors">
                Skip tour
              </button>
              <button
                onClick={handleNext}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                {isLast ? "Done" : "Next"}
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
