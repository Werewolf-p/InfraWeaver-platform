'use client'

import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn, fadeUpItem } from '@/lib/utils'

interface FormFieldProps {
  label: string
  htmlFor?: string
  hint?: ReactNode
  error?: string
  required?: boolean
  className?: string
  children: ReactNode
}

export function FormField({ label, htmlFor, hint, error, required, className, children }: FormFieldProps) {
  return (
    <motion.div variants={fadeUpItem} className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline gap-1.5">
        <label htmlFor={htmlFor} className="text-sm font-medium text-[var(--az-text)]">
          {label}
        </label>
        {required ? (
          <span className="text-xs font-semibold text-[var(--az-primary)]" aria-hidden="true">
            *
          </span>
        ) : null}
      </div>
      {children}
      {error ? (
        <p className="flex items-start gap-1.5 text-xs leading-5 text-[var(--az-danger)]" role="alert">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs leading-5 text-[var(--az-text-secondary)]">{hint}</p>
      ) : null}
    </motion.div>
  )
}
