"use client";
import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDialogA11y } from "@/hooks/use-dialog-a11y";
import { useMotionSafe } from "@/lib/spring";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function BottomSheet({ open, onClose, title, children, className }: BottomSheetProps) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const motionSafe = useMotionSafe();
  // Shared body-scroll-lock + Escape + focus-trap + focus-restore.
  useDialogA11y({ open, onClose, ref: sheetRef });

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionSafe.transition({ duration: 0.2 })}
            className="fixed inset-0 z-overlay bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          {/* Sheet */}
          <motion.div
            ref={sheetRef}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={motionSafe.transition({ type: "spring", damping: 30, stiffness: 300 })}
            drag="y"
            dragConstraints={{ top: 0 }}
            dragElastic={0.1}
            onDragEnd={(_, info) => {
              if (info.offset.y > 80 || info.velocity.y > 500) onClose();
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={title ? undefined : "Dialog"}
            className={cn(
              "fixed bottom-0 left-0 right-0 z-modal bg-gray-50 dark:bg-[#141414] border-t border-gray-200 dark:border-[#2a2a2a] rounded-t-2xl max-h-[92dvh] flex flex-col shadow-2xl",
              className
            )}
            style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          >
            {/* Drag handle */}
            <div className="flex-shrink-0 flex justify-center pt-3 pb-1 cursor-grab active:cursor-grabbing">
              <div className="w-10 h-1 rounded-full bg-[#444]" />
            </div>

            {/* Header */}
            {title && (
              <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-[#2a2a2a]">
                <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="touch-target flex items-center justify-center rounded-lg text-gray-400 dark:text-[#9a9a9a] hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2a2a] transition-colors"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
              {children}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
