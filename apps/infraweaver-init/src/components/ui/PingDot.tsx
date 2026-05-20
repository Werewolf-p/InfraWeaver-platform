'use client'

import { LoaderCircle } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import type { PingState } from '@/lib/store'
import { cn } from '@/lib/utils'

interface PingDotProps {
  state: PingState
  title?: string
  className?: string
}

export function PingDot({ state, title, className }: PingDotProps) {
  return (
    <span className={cn('inline-flex h-4 w-4 items-center justify-center', className)} title={title}>
      <AnimatePresence mode="wait" initial={false}>
        {state === 'loading' ? (
          <motion.span
            key="loading"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="inline-flex"
          >
            <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[var(--az-primary)]" />
          </motion.span>
        ) : (
          <motion.span
            key={String(state)}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            className={cn(
              'h-2.5 w-2.5 rounded-full border border-white/10',
              state === true && 'bg-[var(--az-success)] shadow-[0_0_12px_rgba(87,163,0,0.85)]',
              state === false && 'red-pulse bg-[var(--az-danger)] shadow-[0_0_12px_rgba(209,52,56,0.65)]',
              state === null && 'bg-white/25',
            )}
          />
        )}
      </AnimatePresence>
    </span>
  )
}
