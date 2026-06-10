'use client'

import type { LucideIcon } from 'lucide-react'
import { motion } from 'framer-motion'
import { fadeUpItem } from '@/lib/utils'

interface StepHeaderProps {
  icon: LucideIcon
  title: string
  description: string
  eyebrow?: string
}

export function StepHeader({ icon: Icon, title, description, eyebrow }: StepHeaderProps) {
  return (
    <motion.div variants={fadeUpItem} className="flex flex-col gap-3 pb-2">
      <div className="flex items-start gap-4">
        <div className="shrink-0 rounded-[var(--az-radius)] border border-[var(--az-primary-dim)] bg-[var(--az-primary-dim)] p-3 text-[var(--az-primary)] shadow-[0_0_24px_var(--az-primary-glow)]">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {eyebrow ? (
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--az-primary)] opacity-80">
              {eyebrow}
            </div>
          ) : null}
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--az-text)]">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-[var(--az-text-secondary)]">{description}</p>
        </div>
      </div>
      <div className="h-px bg-[var(--az-border)]" aria-hidden="true" />
    </motion.div>
  )
}
