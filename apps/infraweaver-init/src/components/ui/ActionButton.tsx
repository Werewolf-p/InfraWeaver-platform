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
    'border border-[var(--az-primary)] bg-[var(--az-primary)] text-white hover:opacity-90 shadow-[0_2px_16px_var(--az-primary-glow)] focus-visible:ring-2 focus-visible:ring-[var(--az-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--az-bg)]',
  secondary:
    'border border-[var(--az-border)] bg-[var(--az-surface-raised)] text-[var(--az-text)] hover:border-[var(--az-border-hover)] hover:bg-[var(--az-card-hover)]',
  danger:
    'border border-[var(--az-danger)] bg-[var(--az-danger-dim)] text-[var(--az-danger)] hover:bg-[var(--az-danger)] hover:text-white',
  ghost: 'border border-transparent bg-transparent text-[var(--az-text-secondary)] hover:bg-[var(--az-surface-raised)] hover:text-[var(--az-text)]',
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
          'inline-flex items-center justify-center gap-2 rounded-[var(--az-radius-sm)] px-4 py-2.5 text-sm font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none',
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
