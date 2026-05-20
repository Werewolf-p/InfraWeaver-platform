'use client'

import { forwardRef } from 'react'
import { motion, type HTMLMotionProps } from 'framer-motion'
import { cn } from '@/lib/utils'

type ActionButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

interface ActionButtonProps extends HTMLMotionProps<'button'> {
  variant?: ActionButtonVariant
}

const variantClassNames: Record<ActionButtonVariant, string> = {
  primary:
    'border border-[rgba(0,120,212,0.45)] bg-[rgba(0,120,212,0.16)] text-white hover:border-[rgba(0,120,212,0.8)] hover:bg-[rgba(0,120,212,0.26)] shadow-[0_0_24px_rgba(0,120,212,0.15)]',
  secondary:
    'border border-white/10 bg-white/5 text-[var(--az-text)] hover:border-white/20 hover:bg-white/10',
  danger:
    'border border-[rgba(209,52,56,0.45)] bg-[rgba(209,52,56,0.12)] text-white hover:border-[rgba(209,52,56,0.75)] hover:bg-[rgba(209,52,56,0.2)]',
  ghost: 'border border-transparent bg-transparent text-[var(--az-text-secondary)] hover:bg-white/6 hover:text-white',
}

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(
  ({ className, variant = 'secondary', type = 'button', children, disabled, ...props }, ref) => {
    return (
      <motion.button
        ref={ref}
        type={type}
        disabled={disabled}
        whileHover={disabled ? undefined : { scale: 1.02 }}
        whileTap={disabled ? undefined : { scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
          variantClassNames[variant],
          className,
        )}
        {...props}
      >
        {children}
      </motion.button>
    )
  },
)

ActionButton.displayName = 'ActionButton'
