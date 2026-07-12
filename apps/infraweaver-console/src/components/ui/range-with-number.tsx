"use client";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { sliderTrackStyle, SLIDER_FILL_COLOR } from "@/lib/slider";

interface RangeWithNumberProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /** Fill color for the range track. Default console accent. */
  color?: string;
  /** Optional unit suffix rendered after the number input, e.g. "MiB". */
  unit?: string;
  /** Accessible name applied to both inputs. */
  label?: string;
  id?: string;
  className?: string;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Controlled range slider paired with a number input — shared copy of the
 * slider + numeric field combos in the settings and game-hub panels. The
 * number field tolerates intermediate text while typing and commits the
 * clamped value on blur.
 */
export function RangeWithNumber({
  value,
  onChange,
  min,
  max,
  step,
  disabled = false,
  color = SLIDER_FILL_COLOR,
  unit,
  label,
  id,
  className,
}: RangeWithNumberProps) {
  // Draft holds in-progress typing (e.g. "" or "1") so the field stays editable;
  // null means "mirror the controlled value".
  const [draft, setDraft] = useState<string | null>(null);

  const handleNumberChange = (raw: string) => {
    setDraft(raw);
    const parsed = Number(raw);
    if (raw !== "" && Number.isFinite(parsed)) {
      onChange(clampNumber(parsed, min, max));
    }
  };

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <input
        type="range"
        id={id}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(clampNumber(Number(event.target.value), min, max))}
        disabled={disabled}
        style={sliderTrackStyle(value, min, max, color)}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white dark:bg-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-60"
      />
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={draft ?? value}
        onChange={(event) => handleNumberChange(event.target.value)}
        onBlur={() => setDraft(null)}
        disabled={disabled}
        className="w-24 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]/50 disabled:cursor-not-allowed disabled:opacity-50"
      />
      {unit ? <span className="text-xs text-gray-500 dark:text-[#888]">{unit}</span> : null}
    </div>
  );
}
