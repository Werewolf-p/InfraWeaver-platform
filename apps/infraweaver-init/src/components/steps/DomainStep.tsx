'use client'

import { Globe, Mail, ShieldCheck, UserRound } from 'lucide-react'
import { motion } from 'framer-motion'
import { GlassCard } from '@/components/ui/GlassCard'
import { FormField } from '@/components/ui/FormField'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore } from '@/lib/store'
import { controlClassName, fadeUpItem, isDomain, isEmail, isIPv4, staggerContainer } from '@/lib/utils'

export function DomainStep() {
  const data = useWizardStore((state) => state.data)
  const setField = useWizardStore((state) => state.setField)
  const autofillIdentityFromEmail = useWizardStore((state) => state.autofillIdentityFromEmail)

  const emailPrefix = data.ADMIN_EMAIL.includes('@') ? data.ADMIN_EMAIL.split('@')[0] : 'admin'

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={Globe}
        eyebrow="Step 2 of 8"
        title="Domain and operator contact"
        description="Set the root domain for public services and the primary admin email used for bootstrap flows. On blur, the wizard derives your admin username, display name, and SMTP recipient defaults from the same identity."
      />

      <div className="grid gap-6 xl:grid-cols-[1.08fr_0.92fr]">
        <GlassCard className="p-6 md:p-8">
          <div className="grid gap-6 md:grid-cols-2">
            <FormField
              label="BASE_DOMAIN"
              htmlFor="BASE_DOMAIN"
              required
              error={data.BASE_DOMAIN && !isDomain(data.BASE_DOMAIN) ? 'Enter a valid domain such as example.com.' : undefined}
              hint={
                <>
                  All public services deploy at <code>*.yourdomain.com</code> and internal services at <code>*.int.yourdomain.com</code>.
                </>
              }
            >
              <input
                id="BASE_DOMAIN"
                value={data.BASE_DOMAIN}
                onChange={(event) => setField('BASE_DOMAIN', event.target.value)}
                placeholder="yourdomain.com"
                className={controlClassName}
              />
            </FormField>

            <FormField
              label="ADMIN_EMAIL"
              htmlFor="ADMIN_EMAIL"
              required
              error={data.ADMIN_EMAIL && !isEmail(data.ADMIN_EMAIL) ? 'Enter a valid operator email address.' : undefined}
              hint="Used for cert-manager ACME registration, Authentik bootstrap, admin access, and notification routing."
            >
              <input
                id="ADMIN_EMAIL"
                type="email"
                value={data.ADMIN_EMAIL}
                onChange={(event) => setField('ADMIN_EMAIL', event.target.value)}
                onBlur={autofillIdentityFromEmail}
                placeholder="admin@yourdomain.com"
                className={controlClassName}
              />
            </FormField>

            <FormField
              label="PUBLIC_INGRESS_IP"
              htmlFor="PUBLIC_INGRESS_IP"
              error={data.PUBLIC_INGRESS_IP && !isIPv4(data.PUBLIC_INGRESS_IP) ? 'Enter a valid public IPv4 address or leave blank.' : undefined}
              hint={
                <>
                  Optional. Public IPv4 of your home/office ingress — used as the DNS A-record target for <code>*.int.yourdomain.com</code> and remote-access endpoints. Leave blank for LAN-only deployments.
                </>
              }
              className="md:col-span-2"
            >
              <input
                id="PUBLIC_INGRESS_IP"
                value={data.PUBLIC_INGRESS_IP}
                onChange={(event) => setField('PUBLIC_INGRESS_IP', event.target.value)}
                placeholder="203.0.113.10"
                className={controlClassName}
              />
            </FormField>
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <motion.div variants={fadeUpItem} className="mb-5 flex items-center gap-3">
            <div className="rounded-xl border border-white/10 bg-white/5 p-2 text-[var(--az-primary)]">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-medium text-white">Identity preview</div>
              <div className="text-xs text-[var(--az-text-secondary)]">These values auto-fill on email blur and remain editable later.</div>
            </div>
          </motion.div>
          <div className="grid gap-4">
            <motion.div variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center gap-3 text-sm font-medium text-white">
                <UserRound className="h-4 w-4 text-[var(--az-primary)]" />
                Admin username
              </div>
              <div className="mt-2 text-lg font-semibold text-white">{data.ADMIN_USERNAME || emailPrefix.toLowerCase().replace(/[^a-z0-9_-]/g, '')}</div>
              <div className="mt-1 text-xs text-[var(--az-text-secondary)]">Lowercase login used by Authentik and ArgoCD.</div>
            </motion.div>
            <motion.div variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center gap-3 text-sm font-medium text-white">
                <Mail className="h-4 w-4 text-[var(--az-primary)]" />
                Notification target
              </div>
              <div className="mt-2 text-lg font-semibold text-white">{data.SMTP_TO || data.ADMIN_EMAIL || 'alerts@yourdomain.com'}</div>
              <div className="mt-1 text-xs text-[var(--az-text-secondary)]">SMTP_TO defaults to the same operator email unless you override it later.</div>
            </motion.div>
            <motion.div variants={fadeUpItem} className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="text-sm font-medium text-white">DNS expectations</div>
              <p className="mt-2 text-sm leading-6 text-[var(--az-text-secondary)]">
                Make sure the base domain is managed by your chosen DNS provider and that wildcard or service records can be created for ingress endpoints during deployment.
              </p>
            </motion.div>
          </div>
        </GlassCard>
      </div>
    </motion.div>
  )
}
