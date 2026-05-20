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

  useEffect(() => {
    if (!open || !requireTyping) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
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

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setTypedValue("");
      setShake(false);
      onCancel();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 top-0 z-[61] w-full overflow-y-auto bg-white dark:bg-[#111] p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] pt-[calc(env(safe-area-inset-top,0px)+1rem)] text-gray-900 dark:text-[#f2f2f2] shadow-2xl focus:outline-none sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:border-gray-200 dark:border-[#2a2a2a] sm:p-6 sm:pt-6 sm:pb-6">
          <div className="flex items-start gap-4">
            {danger ? (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-red-500/20 bg-red-500/10">
                <AlertTriangle className="h-5 w-5 text-red-400" />
              </div>
            ) : null}
            <div className="flex-1">
              <Dialog.Title className="mb-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">{title}</Dialog.Title>
              {description ? <Dialog.Description className="text-sm leading-relaxed text-gray-500 dark:text-[#888]">{description}</Dialog.Description> : null}
            </div>
          </div>

          <AnimatePresence>
            {requireTyping ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-4 space-y-1.5">
                  <p className="text-xs text-gray-500 dark:text-[#888]">
                    Type <span className="font-mono font-semibold text-gray-900 dark:text-[#f2f2f2]">{requireTyping}</span> to confirm:
                  </p>
                  <motion.div
                    animate={shake ? { x: [-6, 6, -5, 5, -3, 3, 0] } : { x: 0 }}
                    transition={{ duration: 0.4 }}
                  >
                    <input
                      ref={inputRef}
                      value={typedValue}
                      onChange={(event) => setTypedValue(event.target.value)}
                      placeholder={requireTyping}
                      className={cn(
                        "w-full rounded-lg border bg-white dark:bg-[#0d0d0d] px-3 py-2 text-sm font-mono text-gray-900 dark:text-[#f2f2f2] placeholder:text-gray-400 dark:placeholder:text-[#444] transition-colors focus:outline-none focus:ring-1 focus:ring-[#3b82f6]",
                        typedValue === ""
                          ? "border-gray-200 dark:border-[#2a2a2a] focus:border-[#3b82f6]"
                          : isTypingMatch
                            ? "border-emerald-500/40 focus:border-emerald-400"
                            : "border-red-500/40 focus:border-red-400",
                      )}
                    />
                  </motion.div>
                  {typedValue.length > 0 && !isTypingMatch ? <p className="text-xs text-red-400">Does not match — keep typing</p> : null}
                  {isTypingMatch && typedValue.length > 0 ? <p className="text-xs text-emerald-400">✓ Confirmed</p> : null}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
            <button
              onClick={onCancel}
              className="inline-flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-transparent px-4 text-sm text-gray-700 dark:text-[#d4d4d4] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] active:bg-gray-200 dark:active:bg-[#1f1f1f]"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmClick}
              disabled={!isTypingMatch}
              className={cn(
                "inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                danger
                  ? "border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20 active:bg-red-500/25"
                  : "bg-[#3b82f6] text-white hover:bg-[#2563eb] active:bg-[#1d4ed8]",
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
