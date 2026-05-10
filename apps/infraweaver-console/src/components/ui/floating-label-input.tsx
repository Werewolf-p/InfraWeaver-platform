"use client";
import { useState, useId } from "react";
import { cn } from "@/lib/utils";

interface FloatingLabelInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

export function FloatingLabelInput({ label, error, className, ...props }: FloatingLabelInputProps) {
  const [focused, setFocused] = useState(false);
  const id = useId();
  const hasValue = Boolean(props.value ?? props.defaultValue);
  const floated = focused || hasValue;

  return (
    <div className="relative">
      <input
        id={id}
        {...props}
        onFocus={e => { setFocused(true); props.onFocus?.(e); }}
        onBlur={e => { setFocused(false); props.onBlur?.(e); }}
        className={cn(
          "peer w-full bg-slate-800/60 border rounded-lg px-3 pt-5 pb-2 text-sm text-white placeholder-transparent",
          "focus:outline-none transition-colors",
          error ? "border-red-500/60 focus:border-red-500" : "border-white/10 focus:border-indigo-500",
          className
        )}
        placeholder={label}
      />
      <label
        htmlFor={id}
        className={cn(
          "absolute left-3 transition-all duration-150 pointer-events-none text-slate-400",
          floated ? "top-1.5 text-[10px] font-medium" : "top-3.5 text-sm"
        )}
      >
        {label}
      </label>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
