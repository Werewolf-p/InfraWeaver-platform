'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, Download, Settings2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { ActionButton } from '@/components/ui/ActionButton'
import { useWizardStore } from '@/lib/store'
import { downloadEnvFile, envPayloadToString, parseEnvText } from '@/lib/env'
import { textareaClassName } from '@/lib/utils'

interface ExpertEnvModalProps {
  open: boolean
  onClose: () => void
}

export function ExpertEnvModal({ open, onClose }: ExpertEnvModalProps) {
  const getEnvPayload = useWizardStore((state) => state.getEnvPayload)
  const loadFromEnv = useWizardStore((state) => state.loadFromEnv)
  const [value, setValue] = useState('')

  useEffect(() => {
    if (open) {
      setValue(envPayloadToString(getEnvPayload()))
    }
  }, [getEnvPayload, open])

  const handleApply = () => {
    loadFromEnv(parseEnvText(value))
    onClose()
  }

  const handleDownload = () => {
    downloadEnvFile(parseEnvText(value))
  }

  return (
    <AnimatePresence>
      {open ? (
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4 py-8 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 18, scale: 0.98 }} className="w-full max-w-5xl rounded-[28px] border border-white/10 bg-[var(--az-bg)] p-6 shadow-[0_35px_90px_rgba(0,0,0,0.45)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-3 text-white">
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-[var(--az-primary)]">
                    <Settings2 className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-lg font-semibold">Expert Mode — Raw .env Editor</div>
                    <div className="mt-1 text-sm text-[var(--az-text-secondary)]">Changes here directly modify the wizard state. Invalid values may break deployment.</div>
                  </div>
                </div>
              </div>
              <ActionButton variant="ghost" onClick={onClose} className="px-3 py-3">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>

            <div className="mt-5 rounded-2xl border border-[rgba(212,117,0,0.3)] bg-[rgba(212,117,0,0.08)] p-4 text-sm text-[var(--az-text-secondary)]">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--az-warning)]" />
                <span>Keep quoted multiline values intact when editing secrets such as <code>DEPLOYER_SSH_KEY</code>.</span>
              </div>
            </div>

            <textarea value={value} onChange={(event) => setValue(event.target.value)} className={`${textareaClassName} mt-5 min-h-[420px]`} />

            <div className="mt-5 flex flex-wrap justify-between gap-3">
              <ActionButton variant="secondary" onClick={handleDownload}>
                <Download className="h-4 w-4" />
                Download .env
              </ActionButton>
              <div className="flex flex-wrap gap-3">
                <ActionButton variant="ghost" onClick={onClose}>
                  Cancel
                </ActionButton>
                <ActionButton variant="primary" onClick={handleApply}>
                  Apply
                </ActionButton>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
