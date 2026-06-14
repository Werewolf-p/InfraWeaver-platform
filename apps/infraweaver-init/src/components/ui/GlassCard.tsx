'use client'

import { motion, type HTMLMotionProps } from 'framer-motion'
import { cn } from '@/lib/utils'

export function GlassCard({ className, children, ...props }: HTMLMotionProps<'div'>) {
  return (
    <motion.div
      className={cn(
        'rounded-[var(--az-radius-lg)] border border-[var(--az-border)] bg-[var(--az-surface)] shadow-sm transition-colors duration-200 hover:border-[var(--az-border-hover)]',
        className,
      )}
      {...props}
    >
      {children}
    </motion.div>
  )
}
