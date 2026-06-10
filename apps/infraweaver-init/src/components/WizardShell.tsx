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

  const progressPct = steps.length > 1 ? Math.round((currentStep / (steps.length - 1)) * 100) : 0

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-6 md:px-8 lg:px-12">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-[var(--az-radius-sm)] bg-[var(--az-primary)] shadow-[0_0_20px_var(--az-primary-glow)]">
            <span className="text-sm font-bold text-white">IW</span>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--az-primary)] opacity-80">
              InfraWeaver Init
            </div>
            <h2 className="text-base font-semibold leading-tight tracking-tight text-[var(--az-text)]">
              Cluster bootstrap wizard
            </h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden rounded-full border border-[var(--az-border)] bg-[var(--az-surface-raised)] px-3 py-1.5 text-xs text-[var(--az-text-secondary)] md:block">
            Auto-saved locally
          </div>
          {headerActions}
        </div>
      </header>

      {/* ── Step indicator ─────────────────────────────────────────── */}
      <nav aria-label="Wizard progress" className="mb-6">
        {/* Linear progress bar */}
        <div className="mb-4 h-1 w-full overflow-hidden rounded-full bg-[var(--az-border)]" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
          <motion.div
            className="h-full rounded-full bg-[var(--az-primary)]"
            initial={false}
            animate={{ width: `${progressPct}%` }}
            transition={{ type: 'spring', stiffness: 200, damping: 28 }}
          />
        </div>

        {/* Step pills — scrollable on small screens */}
        <div className="overflow-x-auto pb-1">
          <ol className="flex min-w-max items-center gap-1">
            {steps.map((step, index) => {
              const complete = index < currentStep
              const active = index === currentStep
              const clickable = Boolean(onStepClick) && index <= currentStep
              return (
                <li key={step.title} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-current={active ? 'step' : undefined}
                    aria-label={`Step ${index + 1}: ${step.title}${complete ? ' (complete)' : ''}`}
                    onClick={() => clickable && onStepClick?.(index)}
                    className={cn(
                      'group flex items-center gap-2 rounded-[var(--az-radius-sm)] px-2.5 py-1.5 text-left transition-all duration-150',
                      clickable ? 'cursor-pointer hover:bg-[var(--az-surface-raised)]' : 'cursor-default',
                      active && 'bg-[var(--az-primary-dim)]',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-all duration-150',
                        complete && 'border-[var(--az-success)] bg-[var(--az-success-dim)] text-[var(--az-success)]',
                        active && 'border-[var(--az-primary)] bg-[var(--az-primary)] text-white shadow-[0_0_12px_var(--az-primary-glow)]',
                        !active && !complete && 'border-[var(--az-border)] bg-[var(--az-surface-raised)] text-[var(--az-text-secondary)]',
                      )}
                    >
                      {complete ? <Check className="h-3.5 w-3.5" /> : index + 1}
                    </span>
                    <span className="hidden md:block">
                      <span className={cn('block text-xs font-medium', active ? 'text-[var(--az-text)]' : 'text-[var(--az-text-secondary)]')}>
                        {step.shortTitle ?? step.title}
                      </span>
                    </span>
                  </button>
                  {index < steps.length - 1 ? (
                    <div className={cn('mx-0.5 h-px w-6 shrink-0 transition-colors duration-300', complete ? 'bg-[var(--az-success)]' : 'bg-[var(--az-border)]')} />
                  ) : null}
                </li>
              )
            })}
          </ol>
        </div>
      </nav>

      {/* ── Step content card ──────────────────────────────────────── */}
      <div className="relative flex-1 overflow-hidden rounded-[var(--az-radius-xl)] border border-[var(--az-border)] bg-[var(--az-bg-secondary)] p-4 shadow-[0_8px_40px_rgba(0,0,0,0.25)] md:p-6 lg:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_center,var(--az-primary-dim),transparent_55%)]" />
        <AnimatePresence custom={direction} initial={false} mode="wait">
          <motion.div
            key={currentStep}
            custom={direction}
            variants={stepVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={springTransition}
            className="relative flex min-h-[640px] flex-col"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      {!hideFooter ? (
        <footer className="mt-4 flex flex-col gap-3 rounded-[var(--az-radius-lg)] border border-[var(--az-border)] bg-[var(--az-surface)] p-3 md:flex-row md:items-center md:justify-between">
          {footer ?? (
            <>
              <div className="flex items-center gap-2">
                <ActionButton
                  variant="ghost"
                  onClick={onPrev}
                  disabled={currentStep === 0}
                  className="px-3 py-2"
                  aria-label="Go to previous step"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </ActionButton>
                <span className="hidden text-xs text-[var(--az-text-tertiary)] md:block">
                  Enter advances · Esc goes back
                </span>
              </div>
              {!hideNext ? (
                <ActionButton
                  variant="primary"
                  onClick={onNext}
                  disabled={!canGoNext}
                  className="min-w-36 px-5 py-2.5"
                  aria-label={nextLabel}
                >
                  {nextLabel}
                  <ChevronRight className="h-4 w-4" />
                </ActionButton>
              ) : null}
            </>
          )}
        </footer>
      ) : null}
    </div>
  )
}
