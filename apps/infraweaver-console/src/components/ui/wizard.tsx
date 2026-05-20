"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface WizardStep {
  label: string;
  description?: string;
  validate?: () => boolean | Promise<boolean>;
}

interface WizardProps {
  steps: WizardStep[];
  children: ReactNode[];
  onComplete?: () => void;
  completeLabel?: string;
  className?: string;
}

export function Wizard({ steps, children, onComplete, completeLabel = "Complete", className }: WizardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [validating, setValidating] = useState(false);

  const childArray = Array.isArray(children) ? children : [children];

  const handleNext = async () => {
    const step = steps[currentStep];
    if (step?.validate) {
      setValidating(true);
      try {
        const valid = await step.validate();
        if (!valid) return;
      } finally {
        setValidating(false);
      }
    }

    if (currentStep < steps.length - 1) {
      setCurrentStep((stepIndex) => stepIndex + 1);
    } else {
      onComplete?.();
    }
  };

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <nav aria-label="Progress steps" className="flex items-center gap-2">
        {steps.map((step, index) => (
          <div key={step.label} className="flex flex-1 items-center gap-2 last:flex-none">
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium transition-colors",
                index < currentStep
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : index === currentStep
                    ? "border-[#3b82f6]/40 bg-[#3b82f6]/10 text-[#3b82f6]"
                    : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] text-gray-400 dark:text-[#555]",
              )}
              aria-current={index === currentStep ? "step" : undefined}
            >
              {index < currentStep ? <Check className="h-4 w-4" /> : index + 1}
            </div>
            <div className="hidden sm:block">
              <p className={cn("text-xs font-medium", index === currentStep ? "text-gray-900 dark:text-[#f2f2f2]" : index < currentStep ? "text-emerald-400" : "text-gray-400 dark:text-[#555]")}>{step.label}</p>
              {step.description ? <p className="text-[10px] text-gray-400 dark:text-[#555]">{step.description}</p> : null}
            </div>
            {index < steps.length - 1 ? (
              <ChevronRight className={cn("h-4 w-4 flex-1", index < currentStep ? "text-emerald-500/40" : "text-[#2a2a2a]")} />
            ) : null}
          </div>
        ))}
      </nav>

      <div className="flex-1">{childArray[currentStep]}</div>

      <div className="flex items-center justify-between border-t border-gray-200 dark:border-[#2a2a2a] pt-4">
        <button
          type="button"
          onClick={() => setCurrentStep((stepIndex) => Math.max(0, stepIndex - 1))}
          disabled={currentStep === 0}
          className="inline-flex h-9 items-center justify-center rounded-lg border border-gray-200 dark:border-[#2a2a2a] px-4 text-sm text-gray-700 dark:text-[#d4d4d4] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => void handleNext()}
          disabled={validating}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] disabled:opacity-50"
        >
          {validating ? "Validating…" : currentStep === steps.length - 1 ? completeLabel : "Next"}
        </button>
      </div>
    </div>
  );
}
