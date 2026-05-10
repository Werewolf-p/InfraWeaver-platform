"use client";
import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface CopyValueProps {
  value: string;
  label?: string;
  mono?: boolean;
  className?: string;
  truncate?: boolean;
}

export function CopyValue({ value, label, mono = true, className, truncate = true }: CopyValueProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success(label ? `${label} copied!` : "Copied!");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-white/10 bg-white/5",
        "hover:border-white/20 hover:bg-white/10 transition-all text-sm group",
        className
      )}
    >
      <span className={cn(truncate && "truncate max-w-[200px]", mono && "font-mono text-xs text-slate-300")}>
        {value}
      </span>
      {copied
        ? <Check className="w-3 h-3 text-green-400 flex-shrink-0" />
        : <Copy className="w-3 h-3 text-slate-500 group-hover:text-slate-300 flex-shrink-0 transition-colors" />
      }
    </button>
  );
}
