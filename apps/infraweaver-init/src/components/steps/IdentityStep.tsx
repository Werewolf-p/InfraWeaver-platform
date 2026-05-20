'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, ShieldAlert, Sparkles, UserRound } from 'lucide-react'
import { motion } from 'framer-motion'
import { ActionButton } from '@/components/ui/ActionButton'
import { FormField } from '@/components/ui/FormField'
import { GlassCard } from '@/components/ui/GlassCard'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore } from '@/lib/store'
import { controlClassName, fadeUpItem, staggerContainer } from '@/lib/utils'

export function IdentityStep() {
  const data = useWizardStore((state) => state.data)
  const setField = useWizardStore((state) => state.setField)
  const autofillIdentityFromEmail = useWizardStore((state) => state.autofillIdentityFromEmail)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={UserRound}
        eyebrow="Step 5 of 8"
        title="Primary platform identity"
        description="This account becomes the first platform administrator across Authentik, ArgoCD, and NetBird. The wizard starts with values derived from the admin email, but you can still adjust them before deployment."
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
        <GlassCard className="p-6 md:p-8">
          <div className="grid gap-6 md:grid-cols-2">
            <FormField
              label="ADMIN_USERNAME"
              htmlFor="ADMIN_USERNAME"
              required
              error={data.ADMIN_USERNAME && !/^[a-z0-9_-]+$/.test(data.ADMIN_USERNAME) ? 'Use lowercase letters, numbers, underscores, or dashes only.' : undefined}
              hint="Immutable login after first deploy. Keep it short and stable."
            >
              <input
                id="ADMIN_USERNAME"
                value={data.ADMIN_USERNAME}
                onChange={(event) => setField('ADMIN_USERNAME', event.target.value)}
                placeholder="admin"
                className={controlClassName}
              />
            </FormField>

            <FormField label="ADMIN_NAME" htmlFor="ADMIN_NAME" hint="Display name shown inside dashboards and identity providers.">
              <input
                id="ADMIN_NAME"
                value={data.ADMIN_NAME}
                onChange={(event) => setField('ADMIN_NAME', event.target.value)}
                placeholder="Platform Admin"
                className={controlClassName}
              />
            </FormField>
          </div>

          <motion.div variants={fadeUpItem} className="mt-6 flex flex-wrap gap-3">
            <ActionButton variant="secondary" onClick={autofillIdentityFromEmail}>
              <Sparkles className="h-4 w-4" />
              Refill from admin email
            </ActionButton>
          </motion.div>

          <button
            type="button"
            onClick={() => setAdvancedOpen((current) => !current)}
            className="mt-6 flex items-center gap-1.5 text-xs text-[var(--az-text-secondary)] transition hover:text-white"
          >
            {advancedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            ⚙ Advanced
          </button>

          {advancedOpen ? (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-4 grid gap-4 md:grid-cols-2">
              <FormField label="ENV_NAME" htmlFor="ENV_NAME" hint="Target environment overlay used by deploy scripts.">
                <select id="ENV_NAME" value={data.ENV_NAME} onChange={(event) => setField('ENV_NAME', event.target.value)} className={controlClassName}>
                  <option value="productie">productie (production)</option>
                  <option value="ontwikkel">ontwikkel (development)</option>
                </select>
              </FormField>
              <FormField label="LETSENCRYPT_ENV" htmlFor="LETSENCRYPT_ENV" hint="Use staging to avoid certificate rate limits while testing.">
                <select id="LETSENCRYPT_ENV" value={data.LETSENCRYPT_ENV} onChange={(event) => setField('LETSENCRYPT_ENV', event.target.value)} className={controlClassName}>
                  <option value="production">production</option>
                  <option value="staging">staging</option>
                </select>
              </FormField>
            </motion.div>
          ) : null}
        </GlassCard>

        <GlassCard className="p-6">
          <motion.div variants={fadeUpItem} className="space-y-4">
            <div className="rounded-2xl border border-[rgba(212,117,0,0.24)] bg-[rgba(212,117,0,0.08)] p-4 text-sm text-[var(--az-warning)]">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium text-white">Username lock reminder</div>
                  <p className="mt-2 leading-6 text-[var(--az-text-secondary)]">
                    The admin username is written into multiple platform services. Changing it later is intentionally difficult, so confirm the login you want before moving on.
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--az-text-secondary)]">Current identity</div>
              <div className="mt-3 space-y-2">
                <div className="text-lg font-semibold text-white">{data.ADMIN_USERNAME || 'admin'}</div>
                <div className="text-sm text-[var(--az-text-secondary)]">{data.ADMIN_NAME || 'Platform Admin'}</div>
                <div className="text-sm text-[var(--az-text-secondary)]">{data.ADMIN_EMAIL || 'admin@yourdomain.com'}</div>
                <div className="text-sm text-[var(--az-text-secondary)]">Env: {data.ENV_NAME} · Let's Encrypt: {data.LETSENCRYPT_ENV}</div>
              </div>
            </div>
          </motion.div>
        </GlassCard>
      </div>
    </motion.div>
  )
}
