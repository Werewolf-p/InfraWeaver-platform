'use client'

import { useEffect, useState } from 'react'
import { Archive, Database, Key, Loader2, RotateCcw } from 'lucide-react'
import { motion } from 'framer-motion'
import { listBackups, type TlsBackupItem, type PvcVolumeItem } from '@/lib/api'
import { GlassCard } from '@/components/ui/GlassCard'
import { StepHeader } from '@/components/ui/StepHeader'
import { useWizardStore } from '@/lib/store'
import { staggerContainer } from '@/lib/utils'

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <div
      className={`h-5 w-5 flex-shrink-0 rounded border flex items-center justify-center transition ${
        checked
          ? 'border-[rgba(0,120,212,0.8)] bg-[rgba(0,120,212,0.6)]'
          : 'border-white/20 bg-white/5'
      }`}
    >
      {checked && <span className="text-white text-xs font-bold">✓</span>}
    </div>
  )
}

export function RestoreStep() {
  const data = useWizardStore((state) => state.data)
  const setField = useWizardStore((state) => state.setField)

  const [loadingBackups, setLoadingBackups] = useState(true)
  const [tlsBackups, setTlsBackups] = useState<TlsBackupItem[]>([])
  const [pvcVolumes, setPvcVolumes] = useState<PvcVolumeItem[]>([])
  const [fetchError, setFetchError] = useState('')

  useEffect(() => {
    listBackups()
      .then((res) => {
        if (res.ok) {
          setTlsBackups(res.tls_backups ?? [])
          setPvcVolumes(res.pvc_volumes ?? [])
        } else {
          setFetchError(res.error ?? 'Failed to load backup list')
        }
      })
      .catch((err) => {
        setFetchError(err instanceof Error ? err.message : 'Failed to load backup list')
      })
      .finally(() => setLoadingBackups(false))
  }, [])

  const restoreTls = data.RESTORE_TLS
  const restoreVolumes = data.RESTORE_VOLUMES ? data.RESTORE_VOLUMES.split(',').filter(Boolean) : []
  const hasTlsBackup = tlsBackups.length > 0

  const toggleVolume = (volumeName: string) => {
    const next = restoreVolumes.includes(volumeName)
      ? restoreVolumes.filter((v) => v !== volumeName)
      : [...restoreVolumes, volumeName]
    setField('RESTORE_VOLUMES', next.join(','))
  }

  const selectAll = () => {
    setField('RESTORE_VOLUMES', pvcVolumes.map((v) => v.name).join(','))
    if (hasTlsBackup) setField('RESTORE_TLS', true)
  }

  const deselectAll = () => {
    setField('RESTORE_VOLUMES', '')
    setField('RESTORE_TLS', false)
  }

  const totalSelected = (restoreTls ? 1 : 0) + restoreVolumes.length

  return (
    <motion.div className="space-y-6" variants={staggerContainer} initial="hidden" animate="visible">
      <StepHeader
        icon={RotateCcw}
        title="Restore from Backup"
        description="Select data to restore from TrueNAS NFS before new services start. Restores run right after Longhorn deploys, before app pods mount their volumes."
      />

      {loadingBackups && (
        <GlassCard className="flex items-center gap-3 p-6 text-[var(--az-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Scanning backup storage…
        </GlassCard>
      )}

      {fetchError && (
        <GlassCard className="border-red-500/20 bg-red-500/5 p-6">
          <p className="text-sm text-red-400">{fetchError}</p>
        </GlassCard>
      )}

      {!loadingBackups && !fetchError && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--az-text-secondary)]">
              {totalSelected === 0
                ? 'Nothing selected — deploy will start fresh'
                : `${totalSelected} item${totalSelected !== 1 ? 's' : ''} queued for restore`}
            </span>
            <div className="flex gap-3 text-xs">
              <button type="button" onClick={selectAll} className="text-[var(--az-primary)] hover:underline">
                Select all
              </button>
              <span className="text-[var(--az-text-secondary)]">·</span>
              <button type="button" onClick={deselectAll} className="text-[var(--az-text-secondary)] hover:underline">
                Clear
              </button>
            </div>
          </div>

          {/* TLS Certificates */}
          <GlassCard className="p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
              <Key className="h-4 w-4 text-[var(--az-primary)]" />
              TLS Certificates
            </div>
            {hasTlsBackup ? (
              <label
                className={`flex cursor-pointer items-center gap-4 rounded-2xl border p-4 transition ${
                  restoreTls
                    ? 'border-[rgba(0,120,212,0.5)] bg-[rgba(0,120,212,0.12)]'
                    : 'border-white/8 bg-black/20 hover:border-white/20'
                }`}
              >
                <input
                  type="checkbox"
                  checked={restoreTls}
                  onChange={() => setField('RESTORE_TLS', !restoreTls)}
                  className="sr-only"
                />
                <CheckBox checked={restoreTls} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white">🔐 Let&apos;s Encrypt Wildcard Certificates</div>
                  <p className="mt-1 text-xs text-[var(--az-text-secondary)]">
                    {tlsBackups.map((b) => b.name).join(' · ')} — Restores directly into the traefik namespace
                  </p>
                  <p className="mt-1 text-xs text-[rgba(87,163,0,0.9)]">
                    ✅ {tlsBackups.length} backup file{tlsBackups.length !== 1 ? 's' : ''} found — no new LE request needed
                  </p>
                </div>
              </label>
            ) : (
              <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                <p className="text-sm text-[var(--az-text-secondary)]">
                  ⚠ No TLS backups in{' '}
                  <code className="rounded bg-white/5 px-1 text-xs">/opt/platform-tls-backup/</code> — cert-manager will
                  request new certificates from Let&apos;s Encrypt.
                </p>
              </div>
            )}
          </GlassCard>

          {/* PVC Volumes */}
          <GlassCard className="p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
              <Database className="h-4 w-4 text-[var(--az-primary)]" />
              Application Data Volumes
              <span className="ml-auto text-xs font-normal text-[var(--az-text-secondary)]">
                Restored via Longhorn from TrueNAS NFS
              </span>
            </div>
            <div className="space-y-3">
              {pvcVolumes.map((vol) => {
                const checked = restoreVolumes.includes(vol.name)
                return (
                  <label
                    key={vol.name}
                    className={`flex cursor-pointer items-center gap-4 rounded-2xl border p-4 transition ${
                      checked
                        ? 'border-[rgba(0,120,212,0.5)] bg-[rgba(0,120,212,0.12)]'
                        : 'border-white/8 bg-black/20 hover:border-white/20'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleVolume(vol.name)}
                      className="sr-only"
                    />
                    <CheckBox checked={checked} />
                    <span className="text-2xl leading-none">{vol.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white">{vol.label}</div>
                      <p className="mt-0.5 text-xs text-[var(--az-text-secondary)]">{vol.name}</p>
                    </div>
                  </label>
                )
              })}
            </div>
          </GlassCard>

          {totalSelected > 0 && (
            <div className="flex items-start gap-3 rounded-2xl border border-[rgba(87,163,0,0.3)] bg-[rgba(87,163,0,0.08)] p-4">
              <Archive className="h-4 w-4 mt-0.5 flex-shrink-0 text-[rgba(87,163,0,0.9)]" />
              <p className="text-sm text-[rgba(87,163,0,0.9)]">
                <strong>{totalSelected} item{totalSelected !== 1 ? 's' : ''}</strong> will be restored during deploy — after
                Longhorn initialises but before any app pod mounts its volume.
              </p>
            </div>
          )}
        </>
      )}
    </motion.div>
  )
}
