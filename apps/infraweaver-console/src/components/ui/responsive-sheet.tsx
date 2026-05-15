"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ResponsiveSheetProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
  bodyClassName?: string;
  hideHandle?: boolean;
}

const sizeClassMap: Record<NonNullable<ResponsiveSheetProps["size"]>, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-xl",
  lg: "sm:max-w-3xl",
};

export function ResponsiveSheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
  bodyClassName,
  hideHandle = false,
}: ResponsiveSheetProps) {
  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.button
            type="button"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70"
            onClick={onClose}
            aria-label="Close"
          />
          <motion.div
            initial={{ y: "100%", opacity: 0.96 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: "100%", opacity: 0.96 }}
            transition={{ type: "spring", stiffness: 360, damping: 34 }}
            drag="y"
            dragConstraints={{ top: 0 }}
            dragElastic={0.04}
            dragMomentum={false}
            onDragEnd={(_, info) => {
              if (info.offset.y > 96 || info.velocity.y > 600) onClose();
            }}
            className={cn(
              "fixed inset-x-0 bottom-0 top-0 z-[51] flex flex-col bg-[#111] text-[#f2f2f2] shadow-2xl sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:max-h-[90vh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:overflow-hidden sm:rounded-[28px] sm:border sm:border-[#222]",
              sizeClassMap[size],
              className,
            )}
            style={{ touchAction: "pan-y" }}
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="px-4 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] sm:px-5 sm:pt-5">
                {hideHandle ? null : <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-[#2a2a2a] sm:hidden" />}
                <div className="flex items-start justify-between gap-3 border-b border-[#1e1e1e] pb-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold leading-tight text-white">{title}</h2>
                    {description ? <p className="mt-1 text-sm text-[#b3b3b3]">{description}</p> : null}
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-2xl border border-[#2a2a2a] bg-[#161616] text-[#9e9e9e] transition-colors hover:border-[#3a3a3a] hover:text-white"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div
                className={cn(
                  "min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:px-5 sm:py-5 sm:pb-5 [-webkit-overflow-scrolling:touch]",
                  bodyClassName,
                )}
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                {children}
              </div>

              {footer ? (
                <div className="border-t border-[#1e1e1e] px-4 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:px-5 sm:py-5 sm:pb-5">
                  {footer}
                </div>
              ) : null}
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}
