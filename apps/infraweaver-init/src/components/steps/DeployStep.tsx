'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, LoaderCircle, RefreshCw, Rocket, Save } from 'lucide-react'
import { motion } from 'framer-motion'
import { deployStream, getStatus, saveEnv } from '@/lib/api'
import { ActionButton } from '@/components/ui/ActionButton'
import { GlassCard } from '@/components/ui/GlassCard'
import { StepHeader } from '@/components/ui/StepHeader'
import { classifyLog, staggerContainer } from '@/lib/utils'
import { useWizardStore } from '@/lib/store'

export function DeployStep() {
  const data = useWizardStore((state) => state.data)
  const status = useWizardStore((state) => state.status)
  const loading = useWizardStore((state) => state.loading)
  const proxmoxDiscovery = useWizardStore((state) => state.proxmoxDiscovery)
  const proxmoxValidation = useWizardStore((state) => state.proxmoxValidation)
  const deployLogs = useWizardStore((state) => state.deployLogs)
  const deployProgress = useWizardStore((state) => state.deployProgress)
  const deployStepText = useWizardStore((state) => state.deployStepText)
  const deploySummary = useWizardStore((state) => state.deploySummary)
  const deployError = useWizardStore((state) => state.deployError)
  const deployRunning = useWizardStore((state) => state.deployRunning)
  const setStatus = useWizardStore((state) => state.setStatus)
  const getEnvPayload = useWizardStore((state) => state.getEnvPayload)
  const setLoading = useWizardStore((state) => state.setLoading)
  const resetDeploy = useWizardStore((state) => state.resetDeploy)
  const appendDeployLog = useWizardStore((state) => state.appendDeployLog)
  const setDeployState = useWizardStore((state) => state.setDeployState)
  const [saveMessage, setSaveMessage] = useState<string>('')
  const logRef = useRef<HTMLDivElement>(null)

  const effectiveChecklist = useMemo(
    () => [
      { label: '.env file saved', ok: Boolean(status?.env_saved) },
      { label: 'SSH key configured', ok: Boolean(status?.ssh_key || data.DEPLOYER_SSH_KEY.trim()) },
      { label: 'Domain configured', ok: Boolean(status?.domain || data.BASE_DOMAIN.trim()) },
      {
        label: 'DNS provider configured',
        ok: Boolean(
          status?.dns_provider_configured ||
          (data.DNS_PROVIDER === 'none') ||
          (data.DNS_PROVIDER === 'cloudflare' && data.CLOUDFLARE_API_TOKEN.trim()) ||
          (data.DNS_PROVIDER === 'route53' && data.AWS_ACCESS_KEY_ID.trim() && data.AWS_SECRET_ACCESS_KEY.trim()) ||
          (data.DNS_PROVIDER === 'azure' && data.AZURE_CLIENT_ID.trim() && data.AZURE_CLIENT_SECRET.trim()) ||
          (data.DNS_PROVIDER === 'digitalocean' && data.DIGITALOCEAN_TOKEN.trim()) ||
          (data.DNS_PROVIDER === 'hetzner' && data.HETZNER_DNS_API_KEY.trim()),
        ),
      },
      { label: 'Proxmox API checked', ok: Boolean(status?.proxmox || proxmoxValidation?.ok || proxmoxDiscovery?.ok) },
      { label: 'Deploy currently idle', ok: !status?.deploy_running },
    ],
    [
      data.AWS_ACCESS_KEY_ID,
      data.AWS_SECRET_ACCESS_KEY,
      data.AZURE_CLIENT_ID,
      data.AZURE_CLIENT_SECRET,
      data.BASE_DOMAIN,
      data.CLOUDFLARE_API_TOKEN,
      data.DEPLOYER_SSH_KEY,
      data.DIGITALOCEAN_TOKEN,
      data.DNS_PROVIDER,
      data.HETZNER_DNS_API_KEY,
      proxmoxDiscovery?.ok,
      proxmoxValidation?.ok,
      status,
    ],
  )

  useEffect(() => {
    void refreshStatus()
  }, [])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [deployLogs])

  const refreshStatus = async () => {
    const nextStatus = await getStatus()
    setStatus(nextStatus)
    return nextStatus
  }

  const handleSaveEnv = async (silent = false) => {
    setLoading('saveEnv', true)
    try {
      const result = await saveEnv(getEnvPayload())
      if (result.ok) {
        const nextStatus = await refreshStatus()
        if (!silent) setSaveMessage(nextStatus.env_saved ? '.env saved and ready for deploy.' : '.env saved.')
        return true
      }
      if (!silent) setSaveMessage(result.error ?? 'Unable to save .env')
      return false
    } catch (error) {
      if (!silent) setSaveMessage(error instanceof Error ? error.message : 'Unable to save .env')
      return false
    } finally {
      setLoading('saveEnv', false)
    }
  }

  const handleDeploy = async () => {
    const saved = await handleSaveEnv(true)
    if (!saved) {
      setSaveMessage('Save failed. Fix the form and try again.')
      return
    }

    resetDeploy()
    setDeployState({ deployRunning: true, deployProgress: 0, deployStepText: 'Starting deploy…', deploySummary: '', deployError: '' })
    setLoading('deploy', true)
    appendDeployLog(`==> Deploying ${data.K8S_CLUSTER_NAME} from ${data.PROXMOX_HOST}`, 'step')

    try {
      await deployStream('deploy', (event) => {
        if (event.type === 'log') {
          appendDeployLog(event.text, classifyLog(event.text))
          return
        }

        if (event.type === 'progress') {
          setDeployState({ deployProgress: event.pct, deployStepText: event.step })
          return
        }

        if (event.type === 'done') {
          appendDeployLog('✅ Deployment complete!', 'ok')
          if (event.summary) appendDeployLog(event.summary, 'ok')
          setDeployState({ deployRunning: false, deployProgress: 100, deployStepText: 'Complete!', deploySummary: event.summary ?? 'Platform deployed successfully!', deployError: '' })
          return
        }

        if (event.type === 'error') {
          appendDeployLog(`✗ ${event.text}`, 'err')
          setDeployState({ deployRunning: false, deployError: event.text, deploySummary: '', deployStepText: 'Deploy failed' })
        }
      })
      await refreshStatus()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deploy failed'
      appendDeployLog(`✗ ${message}`, 'err')
      setDeployState({ deployRunning: false, deployError: message, deploySummary: '', deployStepText: 'Deploy failed' })
    } finally {
      setLoading('deploy', false)
    }
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex h-full flex-col gap-6">
      <StepHeader
        icon={Rocket}
        eyebrow="Step 8 of 8"
        title="Review, save, and deploy"
        description="Run one last pre-flight pass against the init server, write the current wizard state to the repository .env file, and stream deploy progress directly from the existing server-side SSE endpoint."
      />

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <GlassCard className="p-6">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-white">Pre-flight checklist</div>
              <div className="text-sm text-[var(--az-text-secondary)]">Powered by <code>/api/status</code> plus the checks you ran earlier in this session.</div>
            </div>
            <ActionButton variant="secondary" onClick={() => void refreshStatus()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </ActionButton>
          </div>

          <div className="space-y-3">
            {effectiveChecklist.map((item) => (
              <div key={item.label} className={`flex items-center justify-between rounded-2xl border px-4 py-3 ${item.ok ? 'border-[rgba(87,163,0,0.18)] bg-[rgba(87,163,0,0.08)]' : 'border-white/8 bg-black/20'}`}>
                <span className="text-sm text-white">{item.label}</span>
                <span className={`text-sm font-medium ${item.ok ? 'text-[var(--az-success)]' : 'text-[var(--az-text-secondary)]'}`}>
                  {item.ok ? 'Ready' : 'Pending'}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <ActionButton variant="secondary" onClick={() => void handleSaveEnv()} disabled={loading.saveEnv || deployRunning}>
              {loading.saveEnv ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              💾 Save .env
            </ActionButton>
            <ActionButton variant="primary" onClick={() => void handleDeploy()} disabled={loading.deploy || deployRunning}>
              {loading.deploy || deployRunning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              🚀 Deploy Cluster
            </ActionButton>
          </div>

          {saveMessage ? (
            <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm text-[var(--az-text-secondary)]">{saveMessage}</div>
          ) : null}
          {deploySummary ? (
            <div className="mt-4 rounded-2xl border border-[rgba(87,163,0,0.22)] bg-[rgba(87,163,0,0.08)] px-4 py-3 text-sm text-[var(--az-success)]">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{deploySummary}</span>
              </div>
            </div>
          ) : null}
          {deployError ? (
            <div className="mt-4 rounded-2xl border border-[rgba(209,52,56,0.22)] bg-[rgba(209,52,56,0.08)] px-4 py-3 text-sm text-[var(--az-danger)]">
              {deployError}
            </div>
          ) : null}
        </GlassCard>

        <GlassCard className="p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-white">Live deploy terminal</div>
              <div className="text-sm text-[var(--az-text-secondary)]">Streaming <code>/api/deploy</code> output with progress markers.</div>
            </div>
            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-[var(--az-text-secondary)]">
              {deployStepText}
            </div>
          </div>

          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between text-xs text-[var(--az-text-secondary)]">
              <span>Deployment progress</span>
              <span>{deployProgress}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full border border-white/8 bg-black/25">
              <div
                className="progress-shine relative h-full rounded-full bg-[linear-gradient(90deg,#0078D4,#3ea6ff)] transition-[width] duration-500"
                style={{ width: `${deployProgress}%` }}
              />
            </div>
          </div>

          <div ref={logRef} className="terminal-surface custom-scrollbar h-[420px] overflow-y-auto rounded-2xl border border-white/8 px-4 py-4 font-mono text-xs leading-6 text-[#b7f397] shadow-[inset_0_0_40px_rgba(0,0,0,0.35)]">
            {deployLogs.length ? (
              deployLogs.map((line) => (
                <div
                  key={line.id}
                  className={`whitespace-pre-wrap ${line.level === 'ok' ? 'text-[#8be26e]' : ''} ${line.level === 'warn' ? 'text-[#f0c96b]' : ''} ${line.level === 'err' ? 'text-[#ff7b7b]' : ''} ${line.level === 'step' ? 'text-[#8fc9ff]' : ''}`}
                >
                  {line.text}
                </div>
              ))
            ) : (
              <div className="text-[var(--az-text-secondary)]">Waiting for deployment to start…</div>
            )}
          </div>
        </GlassCard>
      </div>
    </motion.div>
  )
}
