'use client'

import { type ChangeEvent, useRef, useState } from 'react'
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  FileUp,
  Globe,
  LoaderCircle,
  Rocket,
  Server,
  Settings2,
  Upload,
  UserRound,
  WandSparkles,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { getStatus, saveEnv, type ValidateEnvIssue, validateEnv } from '@/lib/api'
import { readFileText, parseEnvText } from '@/lib/env'
import { ActionButton } from '@/components/ui/ActionButton'
import { GlassCard } from '@/components/ui/GlassCard'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore, type PresetType } from '@/lib/store'
import { fadeUpItem, isDomain, isIPv4, isPositiveInteger, isVipRange, staggerContainer, textareaClassName } from '@/lib/utils'

const logo = String.raw`
 ██╗███╗   ██╗███████╗██████╗  █████╗ ██╗    ██╗███████╗ █████╗ ██╗   ██╗███████╗██████╗
 ██║████╗  ██║██╔════╝██╔══██╗██╔══██╗██║    ██║██╔════╝██╔══██╗██║   ██║██╔════╝██╔══██╗
 ██║██╔██╗ ██║█████╗  ██████╔╝███████║██║ █╗ ██║█████╗  ███████║██║   ██║█████╗  ██████╔╝
 ██║██║╚██╗██║██╔══╝  ██╔══██╗██╔══██║██║███╗██║██╔══╝  ██╔══██║╚██╗ ██╔╝██╔══╝  ██╔══██╗
 ██║██║ ╚████║██║     ██║  ██║██║  ██║╚███╔███╔╝███████╗██║  ██║ ╚████╔╝ ███████╗██║  ██║
 ╚═╝╚═╝  ╚═══╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝`

const setupItems = [
  { icon: Globe, title: 'Domain & ingress', copy: 'Wire your public domain, admin email, and internal cluster DNS defaults.' },
  { icon: Server, title: 'Proxmox discovery', copy: 'Validate the API token, discover the node, storage pools, and next free VMIDs.' },
  { icon: Boxes, title: 'Cluster topology', copy: 'Shape the Talos control plane, MetalLB VIPs, and ping-check node addresses before deploy.' },
  { icon: UserRound, title: 'Identity & access', copy: 'Bootstrap your immutable admin identity, SSH key, DNS provider credentials, and SMTP credentials.' },
  { icon: Settings2, title: 'Feature flags', copy: 'Toggle NetBird, monitoring, external DNS, backups, and LAN or VPN-only access.' },
  { icon: Rocket, title: 'Review & deploy', copy: 'Save the .env file, run pre-flight checks, and stream deploy progress in a live terminal.' },
]

const presets: Array<{
  key: PresetType
  title: string
  accent: string
  summary: string
  specs: string[]
}> = [
  {
    key: 'dev',
    title: '🏠 Homelab Dev',
    accent: 'text-white',
    summary: 'Single control-plane node with the lightest footprint for local labs.',
    specs: ['1 node', '2C / 4 GB / 50 GB', 'Monitoring off', 'NetBird off', 'External DNS off'],
  },
  {
    key: 'standard',
    title: '⚡ Standard',
    accent: 'text-[var(--az-primary)]',
    summary: 'Balanced default: 3-node control plane with monitoring and secure remote access.',
    specs: ['3 control-plane nodes', '4C / 8 GB / 100 GB', 'Monitoring on', 'NetBird on', 'External DNS off'],
  },
  {
    key: 'power',
    title: '🏢 Power User',
    accent: 'text-[var(--az-success)]',
    summary: 'HA control plane plus 2 workers and every optional platform capability enabled.',
    specs: ['3 control-plane + 2 workers', 'CP: 4C / 8 GB / 100 GB', 'Workers: 2C / 4 GB / 80 GB', 'All optional features on'],
  },
]

const importFields = [
  'BASE_DOMAIN',
  'PROXMOX_HOST',
  'PROXMOX_API_TOKEN',
  'NODE_COUNT',
  'NODE_1_IP',
  'METALLB_VIP_RANGE',
] as const

const importFieldLabels: Record<(typeof importFields)[number], string> = {
  BASE_DOMAIN: 'Base domain',
  PROXMOX_HOST: 'Proxmox host',
  PROXMOX_API_TOKEN: 'Proxmox API token',
  NODE_COUNT: 'Node count',
  NODE_1_IP: 'Node 1 IP',
  METALLB_VIP_RANGE: 'MetalLB VIP range',
}

type ImportFieldKey = (typeof importFields)[number]
type ImportFieldStatus = { state: 'pending' | 'ok' | 'error'; message: string }

const createInitialImportStatus = (): Record<ImportFieldKey, ImportFieldStatus> => ({
  BASE_DOMAIN: { state: 'pending', message: 'Waiting for import.' },
  PROXMOX_HOST: { state: 'pending', message: 'Waiting for import.' },
  PROXMOX_API_TOKEN: { state: 'pending', message: 'Waiting for import.' },
  NODE_COUNT: { state: 'pending', message: 'Waiting for import.' },
  NODE_1_IP: { state: 'pending', message: 'Waiting for import.' },
  METALLB_VIP_RANGE: { state: 'pending', message: 'Waiting for import.' },
})

function firstIssueForField(issues: ValidateEnvIssue[], field: string) {
  return issues.find((issue) => issue.field === field)?.message
}

function fieldSuccessMessage(field: ImportFieldKey, value: string) {
  if (field === 'BASE_DOMAIN') return `Loaded ${value}`
  if (field === 'PROXMOX_HOST') return `Targeting ${value}`
  if (field === 'PROXMOX_API_TOKEN') return 'Token loaded and ready for validation.'
  if (field === 'NODE_COUNT') return `${value} node${value === '1' ? '' : 's'} configured.`
  if (field === 'NODE_1_IP') return `Primary node ${value}`
  return `VIP range ${value}`
}

function buildClientIssues(env: Record<string, string>) {
  const errors: ValidateEnvIssue[] = []
  for (const field of importFields) {
    if (!env[field]?.trim()) {
      errors.push({ field, message: 'Missing required field.' })
    }
  }

  if (env.BASE_DOMAIN?.trim() && !isDomain(env.BASE_DOMAIN)) {
    errors.push({ field: 'BASE_DOMAIN', message: 'Expected a valid base domain.' })
  }
  if (env.PROXMOX_HOST?.trim() && !isIPv4(env.PROXMOX_HOST)) {
    errors.push({ field: 'PROXMOX_HOST', message: 'Expected an IPv4 address.' })
  }
  if (env.NODE_COUNT?.trim() && !isPositiveInteger(env.NODE_COUNT)) {
    errors.push({ field: 'NODE_COUNT', message: 'Expected a positive integer.' })
  }
  if (env.NODE_1_IP?.trim() && !isIPv4(env.NODE_1_IP)) {
    errors.push({ field: 'NODE_1_IP', message: 'Expected an IPv4 address.' })
  }
  if (env.METALLB_VIP_RANGE?.trim() && !isVipRange(env.METALLB_VIP_RANGE)) {
    errors.push({ field: 'METALLB_VIP_RANGE', message: 'Expected x.x.x.x-x.x.x.x.' })
  }

  return errors
}

function buildFieldStatuses(
  env: Record<string, string>,
  errors: ValidateEnvIssue[],
  warnings: ValidateEnvIssue[],
): Record<ImportFieldKey, ImportFieldStatus> {
  const next = createInitialImportStatus()
  for (const field of importFields) {
    const value = env[field]?.trim() ?? ''
    const error = firstIssueForField(errors, field)
    const warning = firstIssueForField(warnings, field)
    if (error) {
      next[field] = { state: 'error', message: error }
      continue
    }
    if (!value) {
      next[field] = { state: 'error', message: 'Missing required field.' }
      continue
    }
    next[field] = {
      state: 'ok',
      message: warning ? `${fieldSuccessMessage(field, value)} Warning: ${warning}` : fieldSuccessMessage(field, value),
    }
  }
  return next
}

export function WelcomeStep({ onStart, onImportSuccess }: { onStart: () => void; onImportSuccess: () => void }) {
  const preset = useWizardStore((state) => state.preset)
  const setPreset = useWizardStore((state) => state.setPreset)
  const loadFromEnv = useWizardStore((state) => state.loadFromEnv)
  const setStatus = useWizardStore((state) => state.setStatus)
  const [importText, setImportText] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const [importErrors, setImportErrors] = useState<ValidateEnvIssue[]>([])
  const [importWarnings, setImportWarnings] = useState<ValidateEnvIssue[]>([])
  const [fieldStatus, setFieldStatus] = useState<Record<ImportFieldKey, ImportFieldStatus>>(createInitialImportStatus)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const content = await readFileText(file)
    setImportText(content)
    setImportMessage(`Loaded ${file.name}. Review or import it below.`)
    event.target.value = ''
  }

  const runImport = async () => {
    const parsed = parseEnvText(importText)
    if (!Object.keys(parsed).length) {
      setFieldStatus(createInitialImportStatus())
      setImportErrors([{ field: 'IMPORT', message: 'No KEY=value pairs were found in the imported .env.' }])
      setImportWarnings([])
      setImportMessage('Paste a valid .env file first.')
      return
    }

    const clientErrors = buildClientIssues(parsed)
    setFieldStatus(buildFieldStatuses(parsed, clientErrors, []))
    setImportErrors(clientErrors)
    setImportWarnings([])

    if (clientErrors.length) {
      setImportMessage('Fix the highlighted fields before importing.')
      return
    }

    setImportBusy(true)
    try {
      const result = await validateEnv(parsed)
      setFieldStatus(buildFieldStatuses(parsed, result.errors, result.warnings))
      setImportErrors(result.errors)
      setImportWarnings(result.warnings)

      if (!result.valid) {
        setImportMessage('Server-side validation failed. Fix the fields marked with ❌.')
        return
      }

      loadFromEnv(parsed)
      const normalizedPayload = useWizardStore.getState().getEnvPayload()
      const saveResult = await saveEnv(normalizedPayload)
      if (saveResult.ok) {
        setStatus(await getStatus())
        setImportMessage('Imported .env, saved it to the init server, and opened Deployment status.')
      } else {
        setImportMessage(`Imported .env and opened Deployment status. Save on Step 8 failed: ${saveResult.error ?? 'unknown error'}`)
      }
      onImportSuccess()
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : 'Unable to validate the imported .env.')
    } finally {
      setImportBusy(false)
    }
  }

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="flex h-full flex-1 flex-col gap-6"
    >
      <StepHeader
        icon={WandSparkles}
        eyebrow="Step 1 of 8"
        title="Spin up your InfraWeaver cluster"
        description="Choose a launch preset to pre-shape cluster size, resource budgets, and feature flags. Or import an existing .env to validate it and jump straight to Deployment status."
      />

      <div className="grid gap-4 xl:grid-cols-3">
        {presets.map((card) => {
          const active = (preset ?? 'standard') === card.key
          return (
            <motion.button
              key={card.key}
              type="button"
              variants={fadeUpItem}
              onClick={() => setPreset(card.key)}
              className={`rounded-[24px] border p-5 text-left transition ${active ? 'border-[rgba(0,120,212,0.55)] bg-[rgba(0,120,212,0.14)] shadow-[0_0_28px_rgba(0,120,212,0.18)]' : 'border-white/8 bg-black/20 hover:border-white/20 hover:bg-black/30'}`}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className={`text-lg font-semibold ${card.accent}`}>{card.title}</div>
                  <p className="mt-2 text-sm leading-6 text-[var(--az-text-secondary)]">{card.summary}</p>
                </div>
                {active ? <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--az-success)]" /> : null}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {card.specs.map((spec) => (
                  <span key={spec} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-[var(--az-text-secondary)]">
                    {spec}
                  </span>
                ))}
              </div>
              {card.key === 'standard' ? (
                <div className="mt-4 inline-flex rounded-full border border-[rgba(0,120,212,0.3)] bg-[rgba(0,120,212,0.12)] px-3 py-1 text-xs font-medium text-[var(--az-primary)]">
                  Recommended default
                </div>
              ) : null}
            </motion.button>
          )
        })}
      </div>

      <GlassCard className="p-6 md:p-8">
        <motion.div variants={fadeUpItem} className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--az-primary)]">Import existing configuration</div>
            <h3 className="mt-3 text-2xl font-semibold text-white">Import a ready-made .env and skip to Deployment</h3>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--az-text-secondary)]">
              Upload a file or paste the raw .env content. InfraWeaver validates the required fields locally and on the init server, shows per-field status, then jumps you straight to Step 8 when everything checks out.
            </p>

            <div className="mt-5 flex flex-wrap gap-3">
              <ActionButton variant="secondary" onClick={() => fileInputRef.current?.click()}>
                <FileUp className="h-4 w-4" />
                Choose .env file
              </ActionButton>
              <ActionButton variant="primary" onClick={() => void runImport()} disabled={importBusy || !importText.trim()}>
                {importBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Validate & import
              </ActionButton>
            </div>
            <input ref={fileInputRef} type="file" accept=".env,text/plain" className="hidden" onChange={(event) => void handleImportFile(event)} />

            <div className="mt-5">
              <textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder="BASE_DOMAIN=example.com\nPROXMOX_HOST=10.0.0.10\nPROXMOX_API_TOKEN=infraweaver@pve!wizard=...\nNODE_COUNT=3\nNODE_1_IP=10.10.0.90\nMETALLB_VIP_RANGE=10.10.0.200-10.10.0.210"
                className={textareaClassName}
              />
            </div>

            {importMessage ? (
              <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm text-[var(--az-text-secondary)]">
                {importMessage}
              </div>
            ) : null}

            {importErrors.length ? (
              <div className="mt-4 rounded-2xl border border-[rgba(209,52,56,0.22)] bg-[rgba(209,52,56,0.08)] px-4 py-3 text-sm text-[var(--az-danger)]">
                <div className="font-medium text-white">Import errors</div>
                <ul className="mt-2 space-y-1">
                  {importErrors.map((issue) => (
                    <li key={`${issue.field}-${issue.message}`}>• {issue.field}: {issue.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {importWarnings.length ? (
              <div className="mt-4 rounded-2xl border border-[rgba(212,117,0,0.22)] bg-[rgba(212,117,0,0.08)] px-4 py-3 text-sm text-[var(--az-warning)]">
                <div className="font-medium text-white">Warnings</div>
                <ul className="mt-2 space-y-1">
                  {importWarnings.map((issue) => (
                    <li key={`${issue.field}-${issue.message}`}>• {issue.field}: {issue.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div className="rounded-[24px] border border-white/8 bg-black/20 p-5">
            <div className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--az-success)]">Required field status</div>
            <div className="mt-5 space-y-3">
              {importFields.map((field) => {
                const status = fieldStatus[field]
                return (
                  <div key={field} className={`rounded-2xl border px-4 py-3 ${status.state === 'ok' ? 'border-[rgba(87,163,0,0.18)] bg-[rgba(87,163,0,0.08)]' : status.state === 'error' ? 'border-[rgba(209,52,56,0.22)] bg-[rgba(209,52,56,0.08)]' : 'border-white/8 bg-black/20'}`}>
                    <div className="flex items-start gap-3">
                      {status.state === 'ok' ? (
                        <span className="text-lg">✅</span>
                      ) : status.state === 'error' ? (
                        <span className="text-lg">❌</span>
                      ) : (
                        <span className="text-lg text-[var(--az-text-secondary)]">•</span>
                      )}
                      <div>
                        <div className="text-sm font-medium text-white">{importFieldLabels[field]}</div>
                        <div className="mt-1 text-sm leading-6 text-[var(--az-text-secondary)]">{status.message}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </motion.div>
      </GlassCard>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <GlassCard className="p-6 md:p-8">
          <motion.pre
            variants={fadeUpItem}
            className="logo-flicker overflow-x-auto whitespace-pre rounded-2xl border border-[rgba(87,163,0,0.18)] bg-black/30 px-4 py-5 font-mono text-[10px] leading-relaxed text-[var(--az-success)] shadow-[inset_0_0_40px_rgba(87,163,0,0.05)] md:text-[12px]"
          >
            {logo}
          </motion.pre>

          <motion.div variants={fadeUpItem} className="mt-6 space-y-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--az-success)]">Platform setup wizard</div>
              <h3 className="mt-3 text-2xl font-semibold text-white">Configure and deploy your Talos cluster on Proxmox VE</h3>
            </div>
            <p className="max-w-2xl text-sm leading-7 text-[var(--az-text-secondary)]">
              You can move from domain wiring to live deployment in eight focused steps, or fast-track an existing environment straight into the deployment dashboard. All API calls still go through the existing Python init server.
            </p>
            <div className="flex flex-wrap gap-3">
              <ActionButton variant="primary" onClick={onStart} className="min-w-44 px-5 py-3">
                Get started
                <ArrowRight className="h-4 w-4" />
              </ActionButton>
              <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-[var(--az-text-secondary)]">
                Enter advances • Escape goes back • Progress is persisted automatically
              </div>
            </div>
          </motion.div>
        </GlassCard>

        <GlassCard className="p-6">
          <motion.div variants={fadeUpItem} className="mb-5">
            <div className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--az-primary)]">What this wizard covers</div>
            <h3 className="mt-3 text-xl font-semibold text-white">A complete init experience</h3>
          </motion.div>
          <div className="space-y-4">
            {setupItems.map(({ icon: Icon, title, copy }) => (
              <motion.div
                key={title}
                variants={fadeUpItem}
                className="rounded-2xl border border-white/8 bg-black/20 p-4"
              >
                <div className="flex items-start gap-4">
                  <div className="rounded-xl border border-white/10 bg-white/5 p-2 text-[var(--az-primary)]">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white">{title}</div>
                    <p className="mt-1 text-sm leading-6 text-[var(--az-text-secondary)]">{copy}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </GlassCard>
      </div>

      <GlassCard className="p-6">
        <motion.div variants={fadeUpItem} className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
            <div className="text-sm font-medium text-white">Reusable API backend</div>
            <p className="mt-2 text-sm leading-6 text-[var(--az-text-secondary)]">Every action still targets the current Python handlers under <code>scripts/init/server.py</code>.</p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
            <div className="text-sm font-medium text-white">Console-matched visuals</div>
            <p className="mt-2 text-sm leading-6 text-[var(--az-text-secondary)]">Glass cards, blue accent glow, Framer Motion springs, and the same dark InfraWeaver console palette.</p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
            <div className="text-sm font-medium text-white">Safe iteration loop</div>
            <p className="mt-2 text-sm leading-6 text-[var(--az-text-secondary)]">Refresh-safe progress, ping checks before commit, and a terminal view for live deployment telemetry.</p>
          </div>
        </motion.div>
      </GlassCard>
    </motion.div>
  )
}
