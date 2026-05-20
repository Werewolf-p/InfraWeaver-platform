"use client";
import { cn } from "@/lib/utils";

type SpinnerSize = "sm" | "md" | "lg" | "xl";
type SpinnerColor = "emerald" | "white" | "slate" | "red" | "amber";
type SpinnerVariant = "ring" | "dots" | "pulse";

interface LoadingSpinnerProps {
  size?: SpinnerSize;
  color?: SpinnerColor;
  variant?: SpinnerVariant;
  className?: string;
}

const SIZE_MAP: Record<SpinnerSize, number> = {
  sm: 16,
  md: 24,
  lg: 40,
  xl: 64,
};

const COLOR_MAP: Record<SpinnerColor, string> = {
  emerald: "border-emerald-500",
  white: "border-white",
  slate: "border-slate-400",
  red: "border-red-500",
  amber: "border-amber-500",
};

const DOT_COLOR_MAP: Record<SpinnerColor, string> = {
  emerald: "bg-emerald-500",
  white: "bg-white",
  slate: "bg-slate-400",
  red: "bg-red-500",
  amber: "bg-amber-500",
};

export function LoadingSpinner({
  size = "md",
  color = "emerald",
  variant = "ring",
  className,
}: LoadingSpinnerProps) {
  const px = SIZE_MAP[size];

  if (variant === "ring") {
    return (
      <div
        className={cn(
          "rounded-full border-2 border-transparent animate-spin",
          COLOR_MAP[color],
          className
        )}
        style={{ width: px, height: px, borderTopColor: "transparent", borderRightColor: "transparent" }}
      />
    );
  }

  if (variant === "dots") {
    const dotSize = Math.max(4, px / 4);
    return (
      <div className={cn("flex items-center gap-1", className)}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={cn("rounded-full animate-bounce", DOT_COLOR_MAP[color])}
            style={{ width: dotSize, height: dotSize, animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-full animate-ping",
        DOT_COLOR_MAP[color].replace("500", "500/50"),
        className
      )}
      style={{ width: px, height: px }}
    />
  );
}
