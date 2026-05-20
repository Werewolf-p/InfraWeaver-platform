'use client'

import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Globe,
  KeyRound,
  Rocket,
  Server,
  Settings2,
  UserRound,
  WandSparkles,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { ActionButton } from '@/components/ui/ActionButton'
import { GlassCard } from '@/components/ui/GlassCard'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore, type PresetType } from '@/lib/store'
import { fadeUpItem, staggerContainer } from '@/lib/utils'

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

export function WelcomeStep({ onStart }: { onStart: () => void }) {
  const preset = useWizardStore((state) => state.preset)
  const setPreset = useWizardStore((state) => state.setPreset)

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
        description="Choose a launch preset to pre-shape cluster size, resource budgets, and feature flags. You can still fine-tune every step before deployment."
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
              You will move from domain wiring to live deployment in eight focused steps. All API calls still go through the existing Python init server, so you keep the same backend behavior with a much smoother front-end.
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
