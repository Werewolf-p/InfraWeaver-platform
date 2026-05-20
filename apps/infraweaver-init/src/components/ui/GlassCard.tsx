'use client'

import { motion, type HTMLMotionProps } from 'framer-motion'
import { cn } from '@/lib/utils'

export function GlassCard({ className, children, ...props }: HTMLMotionProps<'div'>) {
  return (
    <motion.div
      whileHover={{ scale: 1.005, y: -1 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      className={cn(
        'rounded-xl border border-white/10 bg-white/5 backdrop-blur-md transition-all duration-200 hover:border-white/20 hover:shadow-lg hover:shadow-black/20',
        className,
      )}
      {...props}
    >
      {children}
    </motion.div>
  )
}
