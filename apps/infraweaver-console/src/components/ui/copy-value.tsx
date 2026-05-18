"use client";

import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

interface CopyValueProps {
  value: string;
  label?: string;
  mono?: boolean;
  className?: string;
  truncate?: boolean;
}

export function CopyValue({ value, label, mono = true, className, truncate = true }: CopyValueProps) {
  const { copy, isCopied } = useCopyToClipboard();
  const copied = isCopied(value);

  return (
    <button
      type="button"
      onClick={() => void copy(value, { successMessage: label ? `${label} copied` : "Copied" })}
      className={cn(
        "group inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2.5 text-sm transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111]",
        className,
      )}
    >
      <span className={cn(truncate && "max-w-[200px] truncate", mono ? "font-mono text-xs text-gray-700 dark:text-[#d4d4d4]" : "text-sm text-gray-700 dark:text-[#d4d4d4]")}>
        {value}
      </span>
      {copied ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-[#666] opacity-0 transition-all group-hover:opacity-100 group-hover:text-[#f2f2f2] group-focus-visible:opacity-100" />
      )}
    </button>
  );
}
