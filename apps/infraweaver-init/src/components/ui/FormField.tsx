'use client'

import type { ReactNode } from 'react'
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
    <motion.div variants={fadeUpItem} className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2 text-sm font-medium text-white">
        <label htmlFor={htmlFor}>{label}</label>
        {required ? <span className="text-[var(--az-primary)]">*</span> : null}
      </div>
      {children}
      {error ? <p className="text-xs text-[var(--az-danger)]">{error}</p> : null}
      {!error && hint ? <p className="text-xs leading-5 text-[var(--az-text-secondary)]">{hint}</p> : null}
    </motion.div>
  )
}
