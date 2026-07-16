"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ExternalLink,
  Globe,
  Minus,
  Plus,
  Server,
  Shield,
  X,
} from "lucide-react";
import { toast } from "@/lib/notify";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import {
  INTERNAL_DNS_DOMAIN,
  MANAGED_RECORD_TYPES,
  ROOT_DNS_DOMAIN,
  type ManagedDnsRecord,
  type ManagedRecordType,
} from "@/lib/dns";
import type { DnsZoneSummary } from "@/hooks/use-dns-zones";
import { cn } from "@/lib/utils";

interface TemplateTarget {
  label: string;
  value: string;
  name?: string;
  description?: string;
  href?: string;
}

interface FormState {
  name: string;
  value: string;
  type: ManagedRecordType;
  internal: boolean;
  ttl: number;
  zoneId: string;
}

export type DnsRecordDefaults = Partial<FormState>;

interface DnsRecordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record?: ManagedDnsRecord | null;
  defaultValues?: DnsRecordDefaults;
  draftKey?: string;
  currentMachineTargets?: TemplateTarget[];
  gameServerTargets?: TemplateTarget[];
  onSubmitted?: () => void | Promise<void>;
  canWrite: boolean;
  /** Manageable Cloudflare zones; when more than one, the user can pick a domain. */
  zones?: DnsZoneSummary[];
  /** Currently selected zone id (from the DNS page) — the dialog's default. */
  selectedZoneId?: string;
  /** Env default zone id — when the selection equals this, keep internal/public. */
  defaultZoneId?: string | null;
}

const DEFAULT_FORM: FormState = {
  name: "",
  value: "",
  type: "A",
  internal: true,
  ttl: 120,
  zoneId: "",
};

function readDraft(draftKey?: string): Partial<FormState> {
  if (!draftKey || typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(draftKey) ?? "{}") as Partial<FormState>;
  } catch {
    return {};
  }
}

function clearDraft(draftKey?: string) {
  if (!draftKey || typeof window === "undefined") return;
  localStorage.removeItem(draftKey);
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isHostname(value: string): boolean {
  // Reject anything carrying a scheme, port, path, or whitespace — CNAME targets
  // are bare hostnames, and these are the mistakes /api/dns rejects after a round-trip.
  if (/[\s/:@]/.test(value)) return false;
  const host = value.replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return false;
  return host.split(".").every((label) => HOSTNAME_LABEL.test(label));
}

// Type-keyed format validation so obvious mistakes surface inline instead of failing
// server-side. Returns an error string, or null when the value is well-formed.
function validateRecordValue(type: ManagedRecordType, rawValue: string): string | null {
  const value = rawValue.trim();
  if (type === "A") {
    return isIpv4(value) ? null : "Enter a valid IPv4 address (e.g. 10.25.0.10)";
  }
  if (type === "CNAME") {
    return isHostname(value) ? null : "Enter a hostname without scheme, port, or path (e.g. target.example.com)";
  }
  if (type === "TXT" && value.length > 512) {
    return "TXT value must be 512 characters or fewer";
  }
  return null;
}

export function DnsRecordDialog({
  open,
  onOpenChange,
  record,
  defaultValues,
  draftKey,
  currentMachineTargets = [],
  gameServerTargets = [],
  onSubmitted,
  canWrite,
  zones = [],
  selectedZoneId,
  defaultZoneId = null,
}: DnsRecordDialogProps) {
  const isEditing = Boolean(record);
  const initialState = useMemo<FormState>(() => {
    if (record) {
      return {
        name: record.shortName,
        value: record.value,
        type: (MANAGED_RECORD_TYPES.includes(record.type as ManagedRecordType) ? record.type : "A") as ManagedRecordType,
        internal: record.internal,
        ttl: record.ttl || 120,
        zoneId: selectedZoneId ?? "",
      };
    }

    return {
      ...DEFAULT_FORM,
      zoneId: selectedZoneId ?? "",
      ...readDraft(draftKey),
      ...defaultValues,
    };
  }, [defaultValues, draftKey, record, selectedZoneId]);

  // A non-default zone has no internal/public split — records go under its domain.
  const hasMultipleZones = zones.length > 1;

  const [form, setForm] = useState<FormState>(initialState);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [showSavedState, setShowSavedState] = useState(false);

  useEffect(() => {
    if (!open || isEditing || !draftKey) return;
    const timer = window.setInterval(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify(form));
      } catch {
        // Ignore storage errors.
      }
    }, 30000);
    return () => window.clearInterval(timer);
  }, [draftKey, form, isEditing, open]);

  useEffect(() => {
    if (!open) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(form) === JSON.stringify(initialState)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [form, initialState, open]);

  const isDirty = JSON.stringify(form) !== JSON.stringify(initialState);

  const isDefaultZone = !form.zoneId || form.zoneId === defaultZoneId;
  const selectedZoneName = zones.find((zone) => zone.id === form.zoneId)?.name ?? null;
  const zoneIdPayload = !isDefaultZone && form.zoneId ? { zoneId: form.zoneId } : {};

  function updateField<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function applyTemplate(target: TemplateTarget) {
    setForm((current) => ({
      ...current,
      name: target.name ?? current.name,
      value: target.value,
      type: target.value.match(/^[0-9.]+$/) ? "A" : current.type === "TXT" ? "TXT" : "CNAME",
    }));
  }

  function validate() {
    const nextErrors: Partial<Record<keyof FormState, string>> = {};
    if (!isEditing && !form.name.trim()) nextErrors.name = "Name is required";
    if (!form.value.trim()) {
      nextErrors.value = "Value is required";
    } else {
      const valueError = validateRecordValue(form.type, form.value);
      if (valueError) nextErrors.value = valueError;
    }
    if (form.ttl < 1 || form.ttl > 86400) nextErrors.ttl = "TTL must be between 1 and 86400";
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function handleSubmit() {
    if (!canWrite) {
      toast.error("You do not have permission to manage DNS records");
      return;
    }
    if (!validate()) return;
    setSubmitting(true);

    try {
      const response = await fetch(isEditing ? `/api/dns/${record?.id}` : "/api/dns", {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEditing
            ? { value: form.value.trim(), ttl: form.ttl, ...zoneIdPayload }
            : {
                name: form.name.trim(),
                value: form.value.trim(),
                type: form.type,
                internal: form.internal,
                ttl: form.ttl,
                ...zoneIdPayload,
              },
        ),
      });

      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to save DNS record");
      }

      if (!isEditing) clearDraft(draftKey);
      setShowSavedState(true);
      toast.success(isEditing ? "DNS record updated" : "DNS record created");
      await onSubmitted?.();
      window.setTimeout(() => {
        setShowSavedState(false);
        onOpenChange(false);
      }, 600);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save DNS record");
    } finally {
      setSubmitting(false);
    }
  }

  function requestClose() {
    if (isDirty && !submitting) {
      setShowDiscardConfirm(true);
      return;
    }
    onOpenChange(false);
  }

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : requestClose())}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-overlay bg-black/70 backdrop-blur-sm" />
          <Dialog.Content className="fixed inset-x-0 bottom-0 top-0 z-modal flex w-full flex-col overflow-hidden bg-white dark:bg-[#111] text-gray-900 dark:text-[#f2f2f2] shadow-2xl focus:outline-none sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[calc(100vw-2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:border-gray-200 dark:border-[#2a2a2a]">
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 dark:border-[#2a2a2a] px-4 py-4 pt-[calc(env(safe-area-inset-top,0px)+1rem)] sm:px-6 sm:py-5 sm:pt-5">
              <div>
                <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-[#f2f2f2]">
                  {isEditing ? "Edit DNS Record" : "Add DNS Record"}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-[#888]">
                  Manage internal (Authentik-gated) hostnames and public Cloudflare DNS records without leaving InfraWeaver.
                </Dialog.Description>
              </div>
              <button
                onClick={requestClose}
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-gray-500 dark:text-[#888] transition hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
                aria-label="Close DNS dialog"
                title="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:max-h-[75vh] sm:px-6 sm:py-5">
              {!isEditing && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-cyan-300">
                      <Server className="h-4 w-4" />
                      Add for current machine
                    </div>
                    <p className="mt-1 text-xs text-cyan-100/70">
                      Detected node IPs can be applied as smart defaults for internal or public records.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {currentMachineTargets.length > 0 ? currentMachineTargets.map((target) => (
                        <button
                          key={`${target.label}-${target.value}`}
                          onClick={() => applyTemplate(target)}
                          className="rounded-lg border border-cyan-500/20 bg-white dark:bg-[#0d0d0d] px-3 py-2 text-left text-xs text-gray-900 dark:text-[#f2f2f2] transition hover:border-cyan-400/40 hover:bg-cyan-500/10"
                          title={target.description ?? target.value}
                        >
                          <div className="font-medium">{target.label}</div>
                          <div className="font-mono text-cyan-200/80">{target.value}</div>
                        </button>
                      )) : <p className="text-xs text-gray-500 dark:text-[#888]">No node IPs detected yet.</p>}
                    </div>
                  </div>

                  <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-violet-300">
                      <Shield className="h-4 w-4" />
                      Add for game server
                    </div>
                    <p className="mt-1 text-xs text-violet-100/70">
                      Jump from a game server to create DNS with its current node IP pre-filled.
                    </p>
                    <div className="mt-3 space-y-2">
                      {gameServerTargets.length > 0 ? gameServerTargets.slice(0, 3).map((target) => (
                        <div key={`${target.label}-${target.value}`} className="flex items-center justify-between gap-3 rounded-lg border border-violet-500/15 bg-white dark:bg-[#0d0d0d] px-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">{target.label}</div>
                            <div className="truncate font-mono text-xs text-violet-200/80">{target.value}</div>
                          </div>
                          <button
                            onClick={() => applyTemplate(target)}
                            className="rounded-lg border border-violet-500/20 px-2.5 py-1.5 text-xs text-violet-200 transition hover:bg-violet-500/10"
                          >
                            Use
                          </button>
                        </div>
                      )) : <p className="text-xs text-gray-500 dark:text-[#888]">No game servers detected.</p>}
                    </div>
                    <Link href="/game-hub" className="mt-3 inline-flex items-center gap-1.5 text-xs text-violet-200 hover:text-gray-900 dark:hover:text-white">
                      View Game Hub servers
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              )}

              {!isEditing && hasMultipleZones ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">Domain (Cloudflare zone)</label>
                  <Select
                    value={form.zoneId}
                    onChange={(event) => updateField("zoneId", event.target.value)}
                  >
                    {zones.map((zone) => (
                      <option key={zone.id} value={zone.id}>{zone.name}</option>
                    ))}
                  </Select>
                  <p className="mt-1 text-xs text-gray-500 dark:text-[#888]">
                    Records are created in the selected zone&apos;s domain.
                  </p>
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">Record name</label>
                  <input
                    value={form.name}
                    onChange={(event) => updateField("name", event.target.value.toLowerCase())}
                    disabled={isEditing}
                    placeholder="minecraft"
                    className={cn(
                      "w-full rounded-xl border bg-white dark:bg-[#0d0d0d] px-3 py-2.5 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition placeholder:text-gray-400 dark:placeholder:text-[#8a8a8a] focus:ring-1 focus:ring-[#3b82f6]",
                      errors.name ? "border-red-500/50" : "border-gray-200 dark:border-[#2a2a2a] focus:border-[#3b82f6]",
                      isEditing && "cursor-not-allowed opacity-70",
                    )}
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-[#888]">
                    {!isDefaultZone && selectedZoneName
                      ? `Creates ${form.name.trim() || "<name>"}.${selectedZoneName} in the selected zone`
                      : form.internal
                        ? `Creates *.${INTERNAL_DNS_DOMAIN} for internal (Authentik) access`
                        : `Creates *.${ROOT_DNS_DOMAIN} for public access`}
                  </p>
                  {errors.name ? <p className="mt-1 text-xs text-red-400">{errors.name}</p> : null}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">Value</label>
                  <input
                    value={form.value}
                    onChange={(event) => updateField("value", event.target.value)}
                    onBlur={() => {
                      if (!form.value.trim()) return;
                      const valueError = validateRecordValue(form.type, form.value);
                      setErrors((current) => ({ ...current, value: valueError ?? undefined }));
                    }}
                    placeholder={form.type === "A" ? "10.25.0.10" : form.type === "TXT" ? "verification-token" : "target.example.com"}
                    className={cn(
                      "w-full rounded-xl border bg-white dark:bg-[#0d0d0d] px-3 py-2.5 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition placeholder:text-gray-400 dark:placeholder:text-[#8a8a8a] focus:ring-1 focus:ring-[#3b82f6]",
                      errors.value ? "border-red-500/50" : "border-gray-200 dark:border-[#2a2a2a] focus:border-[#3b82f6]",
                    )}
                  />
                  <div className="mt-1 flex items-center justify-between text-xs text-gray-500 dark:text-[#888]">
                    <span>{form.type === "A" ? "IPv4 address or node IP" : form.type === "CNAME" ? "Hostname target" : "TXT value"}</span>
                    <span>{form.value.length}/512 characters</span>
                  </div>
                  {errors.value ? <p className="mt-1 text-xs text-red-400">{errors.value}</p> : null}
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-[1.1fr_1.1fr_0.8fr]">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">Scope</label>
                  {!isDefaultZone ? (
                    <div className="flex h-[44px] items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 text-sm text-emerald-700 dark:text-emerald-200">
                      <Globe className="h-4 w-4" /> Public ({selectedZoneName})
                    </div>
                  ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => updateField("internal", true)}
                      disabled={isEditing}
                      className={cn(
                        "flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm transition",
                        form.internal ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200" : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] text-gray-500 dark:text-[#888]",
                        isEditing && "cursor-not-allowed opacity-70",
                      )}
                    >
                      <Shield className="h-4 w-4" /> Internal
                    </button>
                    <button
                      onClick={() => updateField("internal", false)}
                      disabled={isEditing}
                      className={cn(
                        "flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm transition",
                        !form.internal ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] text-gray-500 dark:text-[#888]",
                        isEditing && "cursor-not-allowed opacity-70",
                      )}
                    >
                      <Globe className="h-4 w-4" /> Public
                    </button>
                  </div>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">Type</label>
                  <select
                    value={form.type}
                    onChange={(event) => updateField("type", event.target.value as ManagedRecordType)}
                    disabled={isEditing}
                    className={cn(
                      "w-full rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 py-2.5 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]",
                      isEditing && "cursor-not-allowed opacity-70",
                    )}
                  >
                    {MANAGED_RECORD_TYPES.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">TTL</label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateField("ttl", Math.max(1, form.ttl - 60))}
                      className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-2.5 text-gray-700 dark:text-[#d4d4d4] transition hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
                      title="Decrease TTL"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={86400}
                      step={60}
                      value={form.ttl}
                      onChange={(event) => updateField("ttl", Number(event.target.value) || 1)}
                      className={cn(
                        "w-full rounded-xl border bg-white dark:bg-[#0d0d0d] px-3 py-2.5 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none transition focus:ring-1 focus:ring-[#3b82f6]",
                        errors.ttl ? "border-red-500/50" : "border-gray-200 dark:border-[#2a2a2a] focus:border-[#3b82f6]",
                      )}
                    />
                    <button
                      onClick={() => updateField("ttl", Math.min(86400, form.ttl + 60))}
                      className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-2.5 text-gray-700 dark:text-[#d4d4d4] transition hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
                      title="Increase TTL"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  {errors.ttl ? <p className="mt-1 text-xs text-red-400">{errors.ttl}</p> : <p className="mt-1 text-xs text-gray-500 dark:text-[#888]">Short TTLs propagate faster during changes.</p>}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-gray-200 dark:border-[#2a2a2a] px-4 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pb-4">
              <div className="text-xs text-gray-500 dark:text-[#888]">
                {isEditing ? "Editing updates value + TTL on the existing Cloudflare record." : "Drafts auto-save every 30 seconds while you edit."}
              </div>
              <div className="flex w-full flex-col-reverse gap-3 sm:w-auto sm:flex-row sm:items-center">
                {showSavedState ? (
                  <div className="inline-flex items-center gap-2 text-sm text-emerald-400">
                    <CheckCircle2 className="h-4 w-4 animate-pulse" /> Saved
                  </div>
                ) : null}
                <button
                  onClick={requestClose}
                  className="min-h-[44px] rounded-xl border border-gray-200 dark:border-[#2a2a2a] px-4 py-2.5 text-sm text-gray-700 dark:text-[#d4d4d4] transition hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleSubmit()}
                  disabled={submitting}
                  className="min-h-[44px] rounded-xl bg-[#3b82f6] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? "Saving…" : isEditing ? "Save changes" : "Create record"}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={showDiscardConfirm}
        onCancel={() => setShowDiscardConfirm(false)}
        onConfirm={() => {
          setShowDiscardConfirm(false);
          onOpenChange(false);
        }}
        title="Discard DNS changes?"
        description="You have unsaved DNS form changes. Close the form and discard them?"
        confirmText="Discard changes"
        danger
      />
    </>
  );
}
