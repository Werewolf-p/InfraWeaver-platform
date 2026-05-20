'use client'

import { useState } from 'react'
import {
  Cloud,
  Copy,
  Eye,
  EyeOff,
  Github,
  KeyRound,
  LoaderCircle,
  Mail,
  ShieldCheck,
  WandSparkles,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { checkDnsProvider, generateSshKey } from '@/lib/api'
import { ActionButton } from '@/components/ui/ActionButton'
import { FormField } from '@/components/ui/FormField'
import { GlassCard } from '@/components/ui/GlassCard'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore, type DnsProvider } from '@/lib/store'
import { controlClassName, fadeUpItem, isEmail, staggerContainer, textareaClassName } from '@/lib/utils'

function SecretInput({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`${controlClassName} pr-12`}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        className="absolute inset-y-0 right-0 inline-flex w-12 items-center justify-center text-[var(--az-text-secondary)] transition hover:text-white"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

export function CredentialsStep() {
  const data = useWizardStore((state) => state.data)
  const loading = useWizardStore((state) => state.loading)
  const generatedPublicKey = useWizardStore((state) => state.generatedPublicKey)
  const dnsProviderCheck = useWizardStore((state) => state.dnsProviderCheck)
  const setField = useWizardStore((state) => state.setField)
  const setLoading = useWizardStore((state) => state.setLoading)
  const setGeneratedPublicKey = useWizardStore((state) => state.setGeneratedPublicKey)
  const setDnsProviderCheck = useWizardStore((state) => state.setDnsProviderCheck)
  const autofillRepoUrl = useWizardStore((state) => state.autofillRepoUrl)

  const handleGenerateKey = async () => {
    setLoading('generateSshKey', true)
    try {
      const result = await generateSshKey()
      if (result.ok) {
        setField('DEPLOYER_SSH_KEY', result.private_key ?? '')
        setGeneratedPublicKey(result.public_key ?? '')
      }
    } finally {
      setLoading('generateSshKey', false)
    }
  }

  const handleCopyKey = async () => {
    if (!generatedPublicKey) return
    await navigator.clipboard.writeText(generatedPublicKey)
  }

  const handleCheckDnsProvider = async () => {
    const provider = data.DNS_PROVIDER
    if (provider === 'none') return

    const credentials: Record<string, string> = {}
    if (provider === 'cloudflare') {
      credentials.CLOUDFLARE_API_TOKEN = data.CLOUDFLARE_API_TOKEN.trim()
    } else if (provider === 'route53') {
      credentials.AWS_ACCESS_KEY_ID = data.AWS_ACCESS_KEY_ID.trim()
      credentials.AWS_SECRET_ACCESS_KEY = data.AWS_SECRET_ACCESS_KEY.trim()
      if (data.AWS_HOSTED_ZONE_ID.trim()) credentials.AWS_HOSTED_ZONE_ID = data.AWS_HOSTED_ZONE_ID.trim()
      credentials.AWS_REGION = data.AWS_REGION.trim() || 'us-east-1'
    } else if (provider === 'azure') {
      credentials.AZURE_CLIENT_ID = data.AZURE_CLIENT_ID.trim()
      credentials.AZURE_CLIENT_SECRET = data.AZURE_CLIENT_SECRET.trim()
      credentials.AZURE_SUBSCRIPTION_ID = data.AZURE_SUBSCRIPTION_ID.trim()
      credentials.AZURE_TENANT_ID = data.AZURE_TENANT_ID.trim()
      credentials.AZURE_RESOURCE_GROUP = data.AZURE_RESOURCE_GROUP.trim()
    } else if (provider === 'digitalocean') {
      credentials.DIGITALOCEAN_TOKEN = data.DIGITALOCEAN_TOKEN.trim()
    } else if (provider === 'hetzner') {
      credentials.HETZNER_DNS_API_KEY = data.HETZNER_DNS_API_KEY.trim()
    }

    setLoading('checkDnsProvider', true)
    try {
      const result = await checkDnsProvider(provider, credentials)
      setDnsProviderCheck(result)
    } finally {
      setLoading('checkDnsProvider', false)
    }
  }

  const handleProviderChange = (value: DnsProvider) => {
    setField('DNS_PROVIDER', value)
    setDnsProviderCheck(null)
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={KeyRound}
        eyebrow="Step 6 of 8"
        title="Credentials, repository metadata, and delivery channels"
        description="Collect the secrets and metadata required to bootstrap InfraWeaver. The SSH key is used for Proxmox host access, the DNS provider manages TLS certificate challenges, SMTP handles alerts, and repository settings wire the cluster back to GitOps automation."
      />

      <div className="grid gap-6 2xl:grid-cols-2">
        <GlassCard className="p-6">
          <motion.div variants={fadeUpItem} className="mb-5 flex items-center gap-3">
            <div className="rounded-xl border border-white/10 bg-white/5 p-2 text-[var(--az-primary)]">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <div className="text-lg font-semibold text-white">SSH keypair</div>
              <div className="text-sm text-[var(--az-text-secondary)]">Generate a fresh ed25519 keypair or paste an existing deployer private key.</div>
            </div>
          </motion.div>

          <FormField label="DEPLOYER_SSH_KEY" htmlFor="DEPLOYER_SSH_KEY" required hint="Paste the private key that should be used for SSH access to the Proxmox host during provisioning.">
            <textarea
              id="DEPLOYER_SSH_KEY"
              value={data.DEPLOYER_SSH_KEY}
              onChange={(event) => setField('DEPLOYER_SSH_KEY', event.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className={textareaClassName}
            />
          </FormField>

          <motion.div variants={fadeUpItem} className="mt-4 flex flex-wrap gap-3">
            <ActionButton variant="primary" onClick={handleGenerateKey} disabled={loading.generateSshKey}>
              {loading.generateSshKey ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
              🔑 Generate keypair
            </ActionButton>
            {generatedPublicKey ? (
              <ActionButton variant="secondary" onClick={() => void handleCopyKey()}>
                <Copy className="h-4 w-4" />
                Copy public key
              </ActionButton>
            ) : null}
          </motion.div>

          {generatedPublicKey ? (
            <motion.div variants={fadeUpItem} className="mt-4 rounded-2xl border border-[rgba(87,163,0,0.2)] bg-[rgba(87,163,0,0.08)] p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--az-success)]">Generated public key</div>
              <p className="mt-2 break-all font-mono text-xs leading-6 text-white">{generatedPublicKey}</p>
            </motion.div>
          ) : null}
        </GlassCard>

        <GlassCard className="p-6">
          <motion.div variants={fadeUpItem} className="mb-5 flex items-center gap-3">
            <div className="rounded-xl border border-white/10 bg-white/5 p-2 text-[var(--az-primary)]">
              <Cloud className="h-5 w-5" />
            </div>
            <div>
              <div className="text-lg font-semibold text-white">DNS provider</div>
              <div className="text-sm text-[var(--az-text-secondary)]">Select the provider used for cert-manager DNS-01 challenges and wildcard TLS certificates.</div>
            </div>
          </motion.div>

          <FormField label="DNS_PROVIDER" htmlFor="DNS_PROVIDER" required hint="The DNS provider that manages your base domain. Used by cert-manager for ACME DNS-01 certificate issuance.">
            <select
              id="DNS_PROVIDER"
              value={data.DNS_PROVIDER}
              onChange={(event) => handleProviderChange(event.target.value as DnsProvider)}
              className={controlClassName}
            >
              <option value="cloudflare">Cloudflare</option>
              <option value="route53">AWS Route 53</option>
              <option value="azure">Azure DNS</option>
              <option value="digitalocean">DigitalOcean DNS</option>
              <option value="hetzner">Hetzner DNS</option>
              <option value="none">None (skip DNS automation)</option>
            </select>
          </FormField>

          {data.DNS_PROVIDER === 'cloudflare' && (
            <motion.div variants={fadeUpItem} className="mt-4">
              <FormField label="CLOUDFLARE_API_TOKEN" htmlFor="CLOUDFLARE_API_TOKEN" required hint="Required permission: Zone:DNS:Edit.">
                <SecretInput
                  id="CLOUDFLARE_API_TOKEN"
                  value={data.CLOUDFLARE_API_TOKEN}
                  onChange={(value) => setField('CLOUDFLARE_API_TOKEN', value)}
                  placeholder="cloudflare api token"
                />
              </FormField>
            </motion.div>
          )}

          {data.DNS_PROVIDER === 'route53' && (
            <motion.div variants={fadeUpItem} className="mt-4 grid gap-4">
              <FormField label="AWS_ACCESS_KEY_ID" htmlFor="AWS_ACCESS_KEY_ID" required hint="IAM access key with Route 53 record management permissions.">
                <input
                  id="AWS_ACCESS_KEY_ID"
                  value={data.AWS_ACCESS_KEY_ID}
                  onChange={(event) => setField('AWS_ACCESS_KEY_ID', event.target.value)}
                  placeholder="AKIAIOSFODNN7EXAMPLE"
                  className={controlClassName}
                />
              </FormField>
              <FormField label="AWS_SECRET_ACCESS_KEY" htmlFor="AWS_SECRET_ACCESS_KEY" required>
                <SecretInput
                  id="AWS_SECRET_ACCESS_KEY"
                  value={data.AWS_SECRET_ACCESS_KEY}
                  onChange={(value) => setField('AWS_SECRET_ACCESS_KEY', value)}
                  placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                />
              </FormField>
              <FormField label="AWS_HOSTED_ZONE_ID" htmlFor="AWS_HOSTED_ZONE_ID" hint="Optional. If omitted, cert-manager will auto-discover the hosted zone.">
                <input
                  id="AWS_HOSTED_ZONE_ID"
                  value={data.AWS_HOSTED_ZONE_ID}
                  onChange={(event) => setField('AWS_HOSTED_ZONE_ID', event.target.value)}
                  placeholder="Z2FDTNDATAQYW2"
                  className={controlClassName}
                />
              </FormField>
              <FormField label="AWS_REGION" htmlFor="AWS_REGION" hint="AWS region for the Route 53 API endpoint. Defaults to us-east-1.">
                <input
                  id="AWS_REGION"
                  value={data.AWS_REGION}
                  onChange={(event) => setField('AWS_REGION', event.target.value)}
                  placeholder="us-east-1"
                  className={controlClassName}
                />
              </FormField>
            </motion.div>
          )}

          {data.DNS_PROVIDER === 'azure' && (
            <motion.div variants={fadeUpItem} className="mt-4 grid gap-4">
              <FormField label="AZURE_CLIENT_ID" htmlFor="AZURE_CLIENT_ID" required hint="Service principal client ID with DNS Zone Contributor permissions.">
                <input
                  id="AZURE_CLIENT_ID"
                  value={data.AZURE_CLIENT_ID}
                  onChange={(event) => setField('AZURE_CLIENT_ID', event.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className={controlClassName}
                />
              </FormField>
              <FormField label="AZURE_CLIENT_SECRET" htmlFor="AZURE_CLIENT_SECRET" required>
                <SecretInput
                  id="AZURE_CLIENT_SECRET"
                  value={data.AZURE_CLIENT_SECRET}
                  onChange={(value) => setField('AZURE_CLIENT_SECRET', value)}
                  placeholder="service principal secret"
                />
              </FormField>
              <div className="grid gap-4 md:grid-cols-2">
                <FormField label="AZURE_SUBSCRIPTION_ID" htmlFor="AZURE_SUBSCRIPTION_ID" required>
                  <input
                    id="AZURE_SUBSCRIPTION_ID"
                    value={data.AZURE_SUBSCRIPTION_ID}
                    onChange={(event) => setField('AZURE_SUBSCRIPTION_ID', event.target.value)}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className={controlClassName}
                  />
                </FormField>
                <FormField label="AZURE_TENANT_ID" htmlFor="AZURE_TENANT_ID" required>
                  <input
                    id="AZURE_TENANT_ID"
                    value={data.AZURE_TENANT_ID}
                    onChange={(event) => setField('AZURE_TENANT_ID', event.target.value)}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className={controlClassName}
                  />
                </FormField>
              </div>
              <FormField label="AZURE_RESOURCE_GROUP" htmlFor="AZURE_RESOURCE_GROUP" required hint="Resource group that contains the Azure DNS zone.">
                <input
                  id="AZURE_RESOURCE_GROUP"
                  value={data.AZURE_RESOURCE_GROUP}
                  onChange={(event) => setField('AZURE_RESOURCE_GROUP', event.target.value)}
                  placeholder="my-dns-resource-group"
                  className={controlClassName}
                />
              </FormField>
            </motion.div>
          )}

          {data.DNS_PROVIDER === 'digitalocean' && (
            <motion.div variants={fadeUpItem} className="mt-4">
              <FormField label="DIGITALOCEAN_TOKEN" htmlFor="DIGITALOCEAN_TOKEN" required hint="DigitalOcean personal access token with DNS write permissions.">
                <SecretInput
                  id="DIGITALOCEAN_TOKEN"
                  value={data.DIGITALOCEAN_TOKEN}
                  onChange={(value) => setField('DIGITALOCEAN_TOKEN', value)}
                  placeholder="dop_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                />
              </FormField>
            </motion.div>
          )}

          {data.DNS_PROVIDER === 'hetzner' && (
            <motion.div variants={fadeUpItem} className="mt-4">
              <FormField label="HETZNER_DNS_API_KEY" htmlFor="HETZNER_DNS_API_KEY" required hint="Hetzner DNS API key from dns.hetzner.com.">
                <SecretInput
                  id="HETZNER_DNS_API_KEY"
                  value={data.HETZNER_DNS_API_KEY}
                  onChange={(value) => setField('HETZNER_DNS_API_KEY', value)}
                  placeholder="hetzner dns api key"
                />
              </FormField>
            </motion.div>
          )}

          {data.DNS_PROVIDER === 'none' && (
            <motion.div variants={fadeUpItem} className="mt-4 rounded-2xl border border-white/8 bg-black/20 p-4">
              <p className="text-sm leading-6 text-[var(--az-text-secondary)]">No DNS provider selected. cert-manager DNS-01 challenges will not be configured. TLS certificates must be managed manually or via HTTP-01 challenges.</p>
            </motion.div>
          )}

          {data.DNS_PROVIDER !== 'none' && (
            <motion.div variants={fadeUpItem} className="mt-4 flex flex-wrap items-center gap-3">
              <ActionButton variant="primary" onClick={() => void handleCheckDnsProvider()} disabled={loading.checkDnsProvider}>
                {loading.checkDnsProvider ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                ✅ Verify
              </ActionButton>
              {dnsProviderCheck ? (
                <div className={`rounded-xl border px-3 py-2 text-sm ${dnsProviderCheck.ok ? 'border-[rgba(87,163,0,0.25)] bg-[rgba(87,163,0,0.08)] text-[var(--az-success)]' : 'border-[rgba(209,52,56,0.25)] bg-[rgba(209,52,56,0.08)] text-[var(--az-danger)]'}`}>
                  {dnsProviderCheck.ok ? `Valid credentials · ${dnsProviderCheck.status ?? 'active'}` : dnsProviderCheck.error ?? 'Validation failed'}
                </div>
              ) : null}
            </motion.div>
          )}
        </GlassCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <GlassCard className="p-6">
          <motion.div variants={fadeUpItem} className="mb-5 flex items-center gap-3">
            <div className="rounded-xl border border-white/10 bg-white/5 p-2 text-[var(--az-primary)]">
              <Mail className="h-5 w-5" />
            </div>
            <div>
              <div className="text-lg font-semibold text-white">SMTP</div>
              <div className="text-sm text-[var(--az-text-secondary)]">Delivery credentials for alerts and bootstrap summaries.</div>
            </div>
          </motion.div>

          <div className="grid gap-5">
            <FormField label="SMTP_USERNAME" htmlFor="SMTP_USERNAME" required error={data.SMTP_USERNAME && !isEmail(data.SMTP_USERNAME) ? 'Use a valid sender email address.' : undefined}>
              <input
                id="SMTP_USERNAME"
                type="email"
                value={data.SMTP_USERNAME}
                onChange={(event) => setField('SMTP_USERNAME', event.target.value)}
                placeholder="you@outlook.com"
                className={controlClassName}
              />
            </FormField>
            <FormField label="SMTP_PASSWORD" htmlFor="SMTP_PASSWORD" required>
              <SecretInput
                id="SMTP_PASSWORD"
                value={data.SMTP_PASSWORD}
                onChange={(value) => setField('SMTP_PASSWORD', value)}
                placeholder="app password"
              />
            </FormField>
            <FormField label="SMTP_TO" htmlFor="SMTP_TO" error={data.SMTP_TO && !isEmail(data.SMTP_TO) ? 'Use a valid destination email address.' : undefined} hint="Alert and deployment summary emails land here. Defaults to the admin email.">
              <input
                id="SMTP_TO"
                type="email"
                value={data.SMTP_TO}
                onChange={(event) => setField('SMTP_TO', event.target.value)}
                placeholder="alerts@yourdomain.com"
                className={controlClassName}
              />
            </FormField>
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <motion.div variants={fadeUpItem} className="mb-5 flex items-center gap-3">
            <div className="rounded-xl border border-white/10 bg-white/5 p-2 text-[var(--az-primary)]">
              <Github className="h-5 w-5" />
            </div>
            <div>
              <div className="text-lg font-semibold text-white">Repository and deploy context</div>
              <div className="text-sm text-[var(--az-text-secondary)]">GitOps metadata plus optional automation tokens from the legacy wizard.</div>
            </div>
          </motion.div>

          <div className="grid gap-5 md:grid-cols-2">
            <FormField label="GITHUB_REPO" htmlFor="GITHUB_REPO" required hint="Repository slug used for GitHub links and API lookups.">
              <input
                id="GITHUB_REPO"
                value={data.GITHUB_REPO}
                onChange={(event) => setField('GITHUB_REPO', event.target.value)}
                onBlur={autofillRepoUrl}
                placeholder="owner/repo"
                className={controlClassName}
              />
            </FormField>
            <FormField label="GIT_REPO_URL" htmlFor="GIT_REPO_URL" required hint="HTTPS URL for the Git repository.">
              <input
                id="GIT_REPO_URL"
                value={data.GIT_REPO_URL}
                onChange={(event) => setField('GIT_REPO_URL', event.target.value)}
                placeholder="https://github.com/owner/repo"
                className={controlClassName}
              />
            </FormField>
            <FormField label="ENV_NAME" htmlFor="ENV_NAME" hint="Select the target environment overlay used by the deploy scripts.">
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
            <FormField label="NETBIRD_API_TOKEN" htmlFor="NETBIRD_API_TOKEN" hint="Optional. Useful when ENABLE_NETBIRD is turned on for peer cleanup and automation.">
              <SecretInput
                id="NETBIRD_API_TOKEN"
                value={data.NETBIRD_API_TOKEN}
                onChange={(value) => setField('NETBIRD_API_TOKEN', value)}
                placeholder="nbp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              />
            </FormField>
            <FormField label="GITHUB_PAT" htmlFor="GITHUB_PAT" hint="Optional personal access token for GitHub Actions integration.">
              <SecretInput
                id="GITHUB_PAT"
                value={data.GITHUB_PAT}
                onChange={(value) => setField('GITHUB_PAT', value)}
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              />
            </FormField>
            <FormField label="RUNNER_REGISTRATION_TOKEN" htmlFor="RUNNER_REGISTRATION_TOKEN" className="md:col-span-2" hint="Optional self-hosted GitHub Actions runner registration token.">
              <input
                id="RUNNER_REGISTRATION_TOKEN"
                value={data.RUNNER_REGISTRATION_TOKEN}
                onChange={(event) => setField('RUNNER_REGISTRATION_TOKEN', event.target.value)}
                placeholder="AXXXXXXXXXXXXXXXXXXXXXXXXXX"
                className={controlClassName}
              />
            </FormField>
          </div>
        </GlassCard>
      </div>
    </motion.div>
  )
}
