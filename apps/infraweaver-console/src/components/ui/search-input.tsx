"use client";

import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchInputProps {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function SearchInput({ placeholder = "Search...", value, onChange, className }: SearchInputProps) {
  return (
    <label className={cn("flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus-within:border-sky-300 dark:border-[#333] dark:bg-[#0f0f0f] dark:text-[#f2f2f2] dark:focus-within:border-[#0078D4]/50", className)}>
      <Search className="h-4 w-4 shrink-0 text-slate-400 dark:text-[#666]" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm text-inherit outline-none placeholder:text-slate-400 dark:placeholder:text-[#555]"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-[#666] dark:hover:bg-[#1a1a1a] dark:hover:text-[#f2f2f2]"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </label>
  );
}
