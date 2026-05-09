"use client";
import { useState, useEffect, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  description?: string;
  confirmText?: string;
  danger?: boolean;
  /** If set, user must type this exact string to enable the confirm button */
  requireTyping?: string;
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  description,
  confirmText = "Confirm",
  danger = false,
  requireTyping,
}: ConfirmDialogProps) {
  const [typedValue, setTypedValue] = useState("");
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isTypingMatch = !requireTyping || typedValue === requireTyping;

  // Reset typed value when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setTypedValue("");
      setShake(false);
    } else if (requireTyping) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, requireTyping]);

  const handleConfirmClick = () => {
    if (!isTypingMatch) {
      setShake(true);
      setTimeout(() => setShake(false), 500);
      return;
    }
    onConfirm();
    setTypedValue("");
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[60] backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[61] w-full max-w-md bg-slate-900 border border-white/10 rounded-xl p-6 shadow-2xl focus:outline-none">
          <div className="flex items-start gap-4">
            {danger && (
              <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
            )}
            <div className="flex-1">
              <Dialog.Title className="text-base font-semibold text-white mb-1">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="text-sm text-slate-400">{description}</Dialog.Description>
              )}
            </div>
          </div>

          {/* Type-to-confirm input */}
          <AnimatePresence>
            {requireTyping && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-4 space-y-1.5">
                  <p className="text-xs text-slate-400">
                    Type <span className="font-mono font-semibold text-white">{requireTyping}</span> to confirm:
                  </p>
                  <motion.div
                    animate={shake ? { x: [-6, 6, -5, 5, -3, 3, 0] } : { x: 0 }}
                    transition={{ duration: 0.4 }}
                  >
                    <input
                      ref={inputRef}
                      value={typedValue}
                      onChange={(e) => setTypedValue(e.target.value)}
                      placeholder={requireTyping}
                      className={cn(
                        "w-full bg-slate-800 border rounded-lg px-3 py-2 text-sm font-mono text-white placeholder-slate-600 focus:outline-none transition-colors",
                        typedValue === ""
                          ? "border-white/10 focus:border-white/20"
                          : isTypingMatch
                          ? "border-green-500/50 focus:border-green-500"
                          : "border-red-500/40 focus:border-red-500"
                      )}
                    />
                  </motion.div>
                  {typedValue.length > 0 && !isTypingMatch && (
                    <p className="text-xs text-red-400">Does not match — keep typing</p>
                  )}
                  {isTypingMatch && typedValue.length > 0 && (
                    <p className="text-xs text-green-400">✓ Confirmed</p>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex gap-3 mt-6 justify-end">
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmClick}
              disabled={!isTypingMatch}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
                danger
                  ? "bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30"
                  : "bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/30"
              )}
            >
              {confirmText}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
