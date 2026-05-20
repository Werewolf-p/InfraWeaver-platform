"use client";
import { useCallback, useRef } from "react";
import { toast } from "@/lib/notify";

interface UndoOptions<T> {
  message: string;
  undoMessage?: string;
  action: (data: T) => Promise<void>;
  onUndo?: (data: T) => Promise<void>;
  duration?: number;
}

export function useUndoToast<T>() {
  const undoRef = useRef<(() => void) | null>(null);

  const showWithUndo = useCallback(
    ({ message, undoMessage = "Undo", action, onUndo, duration = 5000 }: UndoOptions<T>, data: T) => {
      let undone = false;

      const handleUndo = async () => {
        undone = true;
        try {
          if (onUndo) await onUndo(data);
          toast.success("Action undone");
        } catch {
          toast.error("Failed to undo");
        }
      };

      undoRef.current = () => { void handleUndo(); };

      const execute = async () => {
        if (!undone) {
          try {
            await action(data);
          } catch {
            toast.error("Action failed");
          }
        }
      };

      toast(message, {
        duration,
        action: {
          label: undoMessage,
          onClick: () => { undone = true; void handleUndo(); },
        },
      });

      setTimeout(() => { void execute(); }, duration);
    },
    []
  );

  return { showWithUndo };
}
