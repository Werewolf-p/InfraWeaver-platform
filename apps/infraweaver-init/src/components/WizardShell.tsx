'use client'

import { useEffect } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { ActionButton } from '@/components/ui/ActionButton'
import { cn, springTransition } from '@/lib/utils'

const stepVariants = {
  enter: (direction: number) => ({ x: direction > 0 ? 300 : -300, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction > 0 ? -300 : 300, opacity: 0 }),
}

export interface WizardStepMeta {
  title: string
  shortTitle?: string
}

interface WizardShellProps {
  steps: WizardStepMeta[]
  currentStep: number
  direction: number
  canGoNext: boolean
  hideFooter?: boolean
  hideNext?: boolean
  nextLabel?: string
  onPrev: () => void
  onNext: () => void
  onStepClick?: (index: number) => void
  children: React.ReactNode
  footer?: React.ReactNode
  headerActions?: React.ReactNode
}

export function WizardShell({
  steps,
  currentStep,
  direction,
  canGoNext,
  hideFooter,
  hideNext,
  nextLabel = 'Continue',
  onPrev,
  onNext,
  onStepClick,
  children,
  footer,
  headerActions,
}: WizardShellProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName
      if (tagName === 'TEXTAREA') return

      if (event.key === 'Escape' && currentStep > 0) {
        event.preventDefault()
        onPrev()
      }

      if (event.key === 'Enter' && !event.shiftKey && canGoNext && !hideNext) {
        event.preventDefault()
        onNext()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canGoNext, currentStep, hideNext, onNext, onPrev])

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-8 md:px-10 lg:px-12">
      <div className="mb-8 flex items-center justify-between gap-6">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.32em] text-[var(--az-primary)]">InfraWeaver Init</div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Cluster bootstrap wizard</h2>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-[var(--az-text-secondary)] md:block">
            Progress auto-saves locally
          </div>
          {headerActions}
        </div>
      </div>

      <div className="mb-8 overflow-x-auto pb-2">
        <div className="flex min-w-max items-center gap-3">
          {steps.map((step, index) => {
            const complete = index < currentStep
            const active = index === currentStep
            const clickable = Boolean(onStepClick) && index <= currentStep
            return (
              <div key={step.title} className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => clickable && onStepClick?.(index)}
                  className={cn(
                    'group flex items-center gap-3 rounded-2xl px-3 py-2 text-left transition',
                    clickable ? 'cursor-pointer' : 'cursor-default',
                    active && 'bg-[rgba(0,120,212,0.12)]',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-full border text-sm font-semibold transition',
                      complete && 'border-[rgba(87,163,0,0.55)] bg-[rgba(87,163,0,0.16)] text-[var(--az-success)]',
                      active && 'border-[rgba(0,120,212,0.7)] bg-[rgba(0,120,212,0.18)] text-white shadow-[0_0_18px_rgba(0,120,212,0.35)]',
                      !active && !complete && 'border-white/10 bg-white/5 text-[var(--az-text-secondary)]',
                    )}
                  >
                    {complete ? <Check className="h-4 w-4" /> : index + 1}
                  </span>
                  <span className="hidden md:block">
                    <span className="block text-xs uppercase tracking-[0.24em] text-[var(--az-text-secondary)]">Step {index + 1}</span>
                    <span className={cn('block text-sm font-medium', active ? 'text-white' : 'text-[var(--az-text-secondary)]')}>
                      {step.shortTitle ?? step.title}
                    </span>
                  </span>
                </button>
                {index < steps.length - 1 ? (
                  <div className={cn('h-px w-8 bg-white/10', complete && 'bg-[rgba(87,163,0,0.4)] md:w-12')} />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))] p-4 shadow-[0_30px_80px_rgba(0,0,0,0.35)] md:p-6 lg:p-8">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(0,120,212,0.12),transparent_34%)]" />
        <AnimatePresence custom={direction} initial={false} mode="wait">
          <motion.div
            key={currentStep}
            custom={direction}
            variants={stepVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={springTransition}
            className="relative flex min-h-[680px] flex-col"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>

      {!hideFooter ? (
        <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-white/8 bg-white/4 p-4 md:flex-row md:items-center md:justify-between">
          {footer ?? (
            <>
              <div className="flex items-center gap-3">
                <ActionButton variant="ghost" onClick={onPrev} disabled={currentStep === 0} className="px-3 py-2">
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </ActionButton>
                <div className="text-xs text-[var(--az-text-secondary)]">Enter advances • Esc goes back</div>
              </div>
              {!hideNext ? (
                <ActionButton onClick={onNext} disabled={!canGoNext} className="min-w-40">
                  {nextLabel}
                  <ChevronRight className="h-4 w-4" />
                </ActionButton>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
