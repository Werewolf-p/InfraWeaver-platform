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
    <motion.div variants={fadeUpItem} className="space-y-3">
      {eyebrow ? (
        <div className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--az-primary)]">{eyebrow}</div>
      ) : null}
      <div className="flex items-start gap-4">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-[var(--az-primary)] shadow-[0_0_20px_rgba(0,120,212,0.12)]">
          <Icon className="h-6 w-6" />
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-white">{title}</h1>
          <p className="max-w-3xl text-sm leading-7 text-[var(--az-text-secondary)]">{description}</p>
        </div>
      </div>
    </motion.div>
  )
}
