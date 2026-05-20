"use client";

import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
}

export function CopyButton({ text, label, className }: CopyButtonProps) {
  const { copy, isCopied } = useCopyToClipboard();
  const copied = isCopied(text);

  return (
    <button
      type="button"
      onClick={() => void copy(text, { successMessage: label ? `${label} copied` : "Copied to clipboard" })}
      className={cn(
        "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2.5 text-xs text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] active:bg-gray-200 dark:active:bg-[#1f1f1f] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111]",
        className,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {label ? <span>{label}</span> : null}
    </button>
  );
}
