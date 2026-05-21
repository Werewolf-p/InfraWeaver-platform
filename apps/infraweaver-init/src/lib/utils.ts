import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const springTransition = {
  type: 'spring' as const,
  stiffness: 260,
  damping: 24,
  mass: 1,
}

export const staggerContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.04, delayChildren: 0.05 },
  },
}

export const fadeUpItem = {
  hidden: { opacity: 0, y: 18 },
  show: {
    opacity: 1,
    y: 0,
    transition: springTransition,
  },
}

export const controlClassName =
  'w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-[var(--az-text)] placeholder:text-[var(--az-text-secondary)] shadow-inner shadow-black/20 outline-none transition focus:border-[var(--az-primary)] focus:ring-2 focus:ring-[rgba(0,120,212,0.25)] disabled:cursor-not-allowed disabled:opacity-50'

export const textareaClassName = cn(controlClassName, 'min-h-32 resize-y font-mono text-xs leading-6')

export const smallMutedTextClassName = 'text-xs leading-5 text-[var(--az-text-secondary)]'

const ipv4Segment = '(25[0-5]|2[0-4]\\d|1?\\d?\\d)'
const ipv4Regex = new RegExp(`^${ipv4Segment}(\\.${ipv4Segment}){3}$`)
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const usernameRegex = /^[a-z0-9_-]+$/

export function isEmail(value: string) {
  return emailRegex.test(value.trim())
}

export function isIPv4(value: string) {
  return ipv4Regex.test(value.trim())
}

export function isDomain(value: string) {
  return /^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/.test(value.trim())
}

export function isPositiveInteger(value: string) {
  return /^\d+$/.test(value.trim()) && Number(value.trim()) > 0
}

export function isCIDR(value: string) {
  const trimmed = value.trim()
  const [ip, prefix] = trimmed.split('/')
  if (!ip || !prefix || !isIPv4(ip) || !/^\d+$/.test(prefix)) return false
  const prefixNumber = Number(prefix)
  return prefixNumber >= 0 && prefixNumber <= 32
}

export function isVipRange(value: string) {
  const trimmed = value.trim()
  const [start, end] = trimmed.split('-')
  if (!start || !end || !isIPv4(start) || !isIPv4(end)) return false
  const startParts = start.split('.').map(Number)
  const endParts = end.split('.').map(Number)
  for (let index = 0; index < 4; index += 1) {
    if (startParts[index] < endParts[index]) return true
    if (startParts[index] > endParts[index]) return false
  }
  return true
}

export function sanitizeUsername(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

export function deriveAdminName(value: string) {
  return value
    .replace(/[._-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function parseBoolean(value?: string) {
  return value === 'true'
}

export function classifyLog(text: string) {
  if (/✅|✓|SUCCESS|complete/i.test(text)) return 'ok' as const
  if (/⚠|warn/i.test(text)) return 'warn' as const
  if (/✗|error|fail|FAIL/i.test(text)) return 'err' as const
  if (/^==>|^\[|Step \d/i.test(text)) return 'step' as const
  return 'info' as const
}
