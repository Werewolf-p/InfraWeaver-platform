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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#2a2a2a] bg-[#111] p-6 text-[#f2f2f2] shadow-2xl focus:outline-none">
          <div className="flex items-start gap-4">
            {danger ? (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-red-500/20 bg-red-500/10">
                <AlertTriangle className="h-5 w-5 text-red-400" />
              </div>
            ) : null}
            <div className="flex-1">
              <Dialog.Title className="mb-1 text-base font-semibold text-[#f2f2f2]">{title}</Dialog.Title>
              {description ? <Dialog.Description className="text-sm leading-relaxed text-[#888]">{description}</Dialog.Description> : null}
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
                  <p className="text-xs text-[#888]">
                    Type <span className="font-mono font-semibold text-[#f2f2f2]">{requireTyping}</span> to confirm:
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
                        "w-full rounded-lg border bg-[#0d0d0d] px-3 py-2 text-sm font-mono text-[#f2f2f2] placeholder:text-[#444] transition-colors focus:outline-none focus:ring-1 focus:ring-[#3b82f6]",
                        typedValue === ""
                          ? "border-[#2a2a2a] focus:border-[#3b82f6]"
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

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button
              onClick={onCancel}
              className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-[#2a2a2a] bg-transparent px-4 text-sm text-[#d4d4d4] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2] active:bg-[#1f1f1f]"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmClick}
              disabled={!isTypingMatch}
              className={cn(
                "inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
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
