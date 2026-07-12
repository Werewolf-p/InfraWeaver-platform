'use client'

import { useState } from 'react'
import { Check, Copy, Globe, LoaderCircle, Mail, RadioTower, ShieldCheck, UserRound } from 'lucide-react'
import { motion } from 'framer-motion'
import { detectPublicIp } from '@/lib/api'
import { ActionButton } from '@/components/ui/ActionButton'
import { GlassCard } from '@/components/ui/GlassCard'
import { FormField } from '@/components/ui/FormField'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore } from '@/lib/store'
import { controlClassName, errMessage, fadeUpItem, isDomain, isEmail, isIPv4, isPrivateIPv4, staggerContainer } from '@/lib/utils'

export function DomainStep() {
  const data = useWizardStore((state) => state.data)
  const setField = useWizardStore((state) => state.setField)
  const autofillIdentityFromEmail = useWizardStore((state) => state.autofillIdentityFromEmail)
  const loading = useWizardStore((state) => state.loading)
  const setLoading = useWizardStore((state) => state.setLoading)

  const [publicIpError, setPublicIpError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const handleDetectPublicIp = async () => {
    setPublicIpError(null)
    setLoading('detectPublicIp', true)
    try {
      const result = await detectPublicIp()
      if (result.ok && result.ip) {
        setField('PUBLIC_INGRESS_IP', result.ip)
      } else {
        setPublicIpError(result.error ?? 'Could not detect a public IP.')
      }
    } catch (error) {
      setPublicIpError(errMessage(error, 'Could not detect a public IP.'))
    } finally {
      setLoading('detectPublicIp', false)
    }
  }

  const handleCopyPublicIp = async () => {
    const ip = data.PUBLIC_INGRESS_IP.trim()
    if (!ip) return
    await navigator.clipboard.writeText(ip)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

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
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="PUBLIC_INGRESS_IP"
                    value={data.PUBLIC_INGRESS_IP}
                    onChange={(event) => setField('PUBLIC_INGRESS_IP', event.target.value)}
                    placeholder="203.0.113.10"
                    className={`${controlClassName} min-w-48 flex-1`}
                  />
                  <ActionButton variant="secondary" onClick={() => void handleDetectPublicIp()} disabled={loading.detectPublicIp}>
                    {loading.detectPublicIp ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RadioTower className="h-4 w-4" />}
                    Detect public IP
                  </ActionButton>
                  <ActionButton
                    variant="ghost"
                    onClick={() => void handleCopyPublicIp()}
                    disabled={!data.PUBLIC_INGRESS_IP.trim()}
                    className="px-3 py-2.5"
                    title="Copy to clipboard"
                  >
                    {copied ? <Check className="h-4 w-4 text-[var(--az-success)]" /> : <Copy className="h-4 w-4" />}
                  </ActionButton>
                </div>
                {publicIpError ? <p className="text-xs text-[var(--az-danger)]">{publicIpError}</p> : null}
                {data.PUBLIC_INGRESS_IP.trim() && isPrivateIPv4(data.PUBLIC_INGRESS_IP) ? (
                  <p className="text-xs text-[var(--az-warning)]">
                    ⚠ This looks like a private/LAN address, not a public IP — internet ingress and public DNS A-records won&apos;t be reachable.
                  </p>
                ) : null}
              </div>
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
