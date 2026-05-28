"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Keyboard, X } from "lucide-react";

const SHORTCUTS = [
  { keys: ["r"], description: "Refresh data" },
  { keys: ["s"], description: "Start server (if stopped)" },
  { keys: ["x"], description: "Stop server (if running)" },
  { keys: ["1"], description: "Switch to Dashboard" },
  { keys: ["2"], description: "Switch to Console" },
  { keys: ["3"], description: "Switch to Players" },
  { keys: ["4"], description: "Switch to Files" },
  { keys: ["5"], description: "Switch to Settings" },
  { keys: ["?"], description: "Show keyboard shortcuts" },
  { keys: ["Ctrl", "K"], description: "Focus search (if available)" },
];

export function KeyboardShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[71] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] shadow-2xl focus:outline-none">
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-[#1e1e1e] px-5 py-4">
            <div className="flex items-center gap-2">
              <Keyboard className="h-4 w-4 text-[#4db3ff]" />
              <div>
                <Dialog.Title className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Keyboard Shortcuts</Dialog.Title>
                <Dialog.Description className="text-xs text-gray-500 dark:text-[#888]">Quick actions for the current server view.</Dialog.Description>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 dark:text-[#888] dark:hover:bg-[#1a1a1a] dark:hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto p-5">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-200 dark:divide-[#1e1e1e]">
                {SHORTCUTS.map((shortcut) => (
                  <tr key={`${shortcut.keys.join("-")}-${shortcut.description}`}>
                    <td className="py-3 pr-4 text-gray-600 dark:text-[#b3b3b3]">{shortcut.description}</td>
                    <td className="py-3 text-right">
                      <div className="flex justify-end gap-1">
                        {shortcut.keys.map((key) => (
                          <kbd key={`${shortcut.description}-${key}`} className="rounded border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#1a1a1a] px-2 py-1 font-mono text-xs text-gray-700 dark:text-[#d4d4d4]">
                            {key}
                          </kbd>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
