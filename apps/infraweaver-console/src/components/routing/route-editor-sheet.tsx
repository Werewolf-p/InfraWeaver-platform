"use client";

import { useState } from "react";
import { AccessTierBadge } from "@/components/access-tier-badge";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Select } from "@/components/ui/select";
import { defaultTlsSecretForHost, type AccessTier } from "@/lib/access-tier";
import { BASE_DOMAIN, INTERNAL_DOMAIN } from "@/lib/domain";
import type { ExternalRouteItem, ExternalRouteTargetType } from "@/lib/external-routes";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { useDnsZones } from "@/hooks/use-dns-zones";

export interface RouteFormState {
  name: string;
  host: string;
  accessTier: AccessTier;
  targetType: ExternalRouteTargetType;
  targetService: string;
  targetNamespace: string;
  targetPort: string;
  targetIP: string;
  enableAuth: boolean;
  tlsSecret: string;
  scheme: "http" | "https";
  skipTlsVerify: boolean;
}

export const DEFAULT_ROUTE_FORM: RouteFormState = {
  name: "",
  host: "",
  accessTier: "internal",
  targetType: "k8s",
  targetService: "",
  targetNamespace: "default",
  targetPort: "80",
  targetIP: "",
  enableAuth: true,
  tlsSecret: "platform-int-wildcard-tls",
  scheme: "http",
  skipTlsVerify: false,
};

export function routeToFormState(route: ExternalRouteItem): RouteFormState {
  return {
    name: route.name,
    host: route.hosts[0] ?? "",
    accessTier: route.accessTier,
    targetType: route.targetType,
    targetService: route.targetService,
    targetNamespace: route.targetNamespace,
    targetPort: String(route.targetPort),
    targetIP: route.targetIP ?? "",
    enableAuth: route.enableAuth,
    tlsSecret: route.tlsSecretName ?? defaultTlsSecretForHost(route.hosts[0] ?? ""),
    scheme: route.scheme,
    skipTlsVerify: route.skipTlsVerify,
  };
}

const inputClass =
  "w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-[#3b82f6] dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]";

// The bare subdomain label of `host`, stripped of the internal/public domain suffix,
// so switching tiers keeps the chosen subdomain while swapping the domain.
function bareLabel(host: string, fallback: string): string {
  const normalized = host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.+$/, "");
  const intSuffix = `.${INTERNAL_DOMAIN}`.toLowerCase();
  const pubSuffix = `.${BASE_DOMAIN}`.toLowerCase();
  if (normalized.endsWith(intSuffix)) return normalized.slice(0, -intSuffix.length);
  if (normalized.endsWith(pubSuffix)) return normalized.slice(0, -pubSuffix.length);
  const dot = normalized.indexOf(".");
  const label = dot === -1 ? normalized : normalized.slice(0, dot);
  return label || fallback;
}

interface RouteEditorSheetProps {
  open: boolean;
  editingRoute: ExternalRouteItem | null;
  canWrite: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function validate(form: RouteFormState): string | null {
  if (!form.name.trim() || !form.host.trim()) return "Name and hostname are required";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(form.name.trim())) {
    return "Name must be lowercase letters, numbers and dashes (e.g. bitwarden)";
  }
  if (!form.targetPort.trim() || Number.isNaN(Number(form.targetPort))) return "Target port must be a valid number";
  const port = Number(form.targetPort);
  if (port < 1 || port > 65535) return "Target port must be between 1 and 65535";
  if (form.targetType === "k8s" && (!form.targetService.trim() || !form.targetNamespace.trim())) {
    return "Kubernetes routes need a service name and namespace";
  }
  if (form.targetType === "baremetal" && !form.targetIP.trim()) return "Bare-metal routes need a target IP";
  return null;
}

export function RouteEditorSheet({ open, editingRoute, canWrite, onClose, onSaved }: RouteEditorSheetProps) {
  const [form, setForm] = useState<RouteFormState>(DEFAULT_ROUTE_FORM);
  const [saving, setSaving] = useState(false);
  const { zones } = useDnsZones();

  // The subdomain label of `host` after stripping whichever managed zone it ends
  // with (so swapping the domain keeps the user's chosen subdomain).
  function subdomainOf(host: string): string {
    const normalized = host.trim().toLowerCase().replace(/\.+$/, "");
    for (const zone of zones) {
      const domain = zone.name.toLowerCase();
      if (normalized === domain) return "";
      if (normalized.endsWith(`.${domain}`)) return normalized.slice(0, -(domain.length + 1));
    }
    const dot = normalized.indexOf(".");
    return dot === -1 ? normalized : normalized.slice(0, dot);
  }

  function selectedDomain(host: string): string {
    const normalized = host.trim().toLowerCase().replace(/\.+$/, "");
    const match = zones.find((zone) => {
      const domain = zone.name.toLowerCase();
      return normalized === domain || normalized.endsWith(`.${domain}`);
    });
    return match?.name ?? "";
  }

  function applyZoneDomain(domain: string) {
    const sub = subdomainOf(form.host) || form.name;
    updateHost(sub ? `${sub}.${domain}` : domain);
  }

  // Reset the form whenever the sheet opens for a different target. Done during
  // render (the documented React pattern for prop-derived resets) rather than in
  // an effect, which would trigger an extra cascading render.
  const formKey = open ? editingRoute?.name ?? "__new__" : "__closed__";
  const [activeKey, setActiveKey] = useState(formKey);
  if (formKey !== activeKey) {
    setActiveKey(formKey);
    if (open) setForm(editingRoute ? routeToFormState(editingRoute) : DEFAULT_ROUTE_FORM);
  }

  function updateForm<K extends keyof RouteFormState>(key: K, value: RouteFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateHost(host: string) {
    setForm((current) => {
      const nextHost = host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
      const currentDefault = defaultTlsSecretForHost(current.host);
      const nextDefault = defaultTlsSecretForHost(nextHost);
      return {
        ...current,
        host: nextHost,
        tlsSecret: !current.tlsSecret || current.tlsSecret === currentDefault ? nextDefault : current.tlsSecret,
      };
    });
  }

  // Internal is always served on `*.${INTERNAL_DOMAIN}` and always gated by
  // Authentik, so switching to it forces the host onto the internal domain (+ its
  // wildcard TLS) and pins the login toggle on. The server enforces the same, so a
  // manual host edit can never save an internal route off-domain. Public keeps its
  // host — it may live on a custom domain — and is only rebased onto the public
  // domain when leaving an internal host.
  function selectAccessTier(tier: AccessTier) {
    setForm((current) => {
      if (tier === "internal") {
        const host = `${bareLabel(current.host, current.name)}.${INTERNAL_DOMAIN}`;
        return { ...current, accessTier: tier, host, tlsSecret: defaultTlsSecretForHost(host), enableAuth: true };
      }
      const normalized = current.host.trim().toLowerCase().replace(/\.+$/, "");
      const wasInternal = normalized.endsWith(`.${INTERNAL_DOMAIN}`.toLowerCase());
      const host = wasInternal ? `${bareLabel(current.host, current.name)}.${BASE_DOMAIN}` : current.host;
      return {
        ...current,
        accessTier: tier,
        host,
        tlsSecret: host ? defaultTlsSecretForHost(host) : current.tlsSecret,
      };
    });
  }

  async function saveRoute() {
    if (!canWrite) {
      toast.error("You do not have permission to manage routes");
      return;
    }
    const validationError = validate(form);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(
        editingRoute ? `/api/routes/external/${encodeURIComponent(editingRoute.name)}` : "/api/routes/external",
        {
          method: editingRoute ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name.trim(),
            host: form.host.trim(),
            accessTier: form.accessTier,
            targetType: form.targetType,
            targetService: form.targetService.trim(),
            targetNamespace: form.targetNamespace.trim(),
            targetPort: Number(form.targetPort),
            targetIP: form.targetIP.trim(),
            enableAuth: form.enableAuth,
            tlsSecret: form.tlsSecret.trim() || null,
            scheme: form.scheme,
            skipTlsVerify: form.skipTlsVerify,
          }),
        },
      );
      const payload = (await response.json()) as { error?: string; gateWarning?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to save route");
      toast.success(editingRoute ? `Updated ${editingRoute.name}` : `Created ${form.name}`);
      // The route committed, but its Authentik gate could not be ensured (e.g.
      // Authentik was momentarily down). Tell the operator to save again to retry.
      if (payload.gateWarning) toast.warning(payload.gateWarning);
      onClose();
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save route");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onClose={() => !saving && onClose()}
      title={editingRoute ? `Edit ${editingRoute.name}` : "Add route"}
      description={
        editingRoute
          ? "Update the route manifest and backend target."
          : "Create a managed Traefik route. InfraWeaver commits it to git and ArgoCD applies it within ~30-60s."
      }
      size="lg"
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => !saving && onClose()}
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-gray-200 dark:border-[#2a2a2a] px-4 text-sm text-gray-700 transition hover:bg-gray-100 dark:text-[#d4d4d4] dark:hover:bg-[#1a1a1a]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void saveRoute()}
            disabled={saving || !canWrite}
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-[#3b82f6] px-4 text-sm font-medium text-white transition hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : editingRoute ? "Save changes" : "Create route"}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Name</label>
            <input
              value={form.name}
              onChange={(event) => updateForm("name", event.target.value.toLowerCase())}
              disabled={Boolean(editingRoute)}
              placeholder="bitwarden"
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Hostname</label>
            <input
              value={form.host}
              onChange={(event) => updateHost(event.target.value)}
              placeholder="bitwarden.rlservers.com"
              className={inputClass}
            />
            {zones.length > 0 ? (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400">Domain</span>
                <Select
                  selectSize="sm"
                  value={selectedDomain(form.host)}
                  onChange={(event) => applyZoneDomain(event.target.value)}
                  className="w-auto min-w-[180px]"
                  title="Cloudflare zone for this hostname"
                >
                  <option value="">Custom…</option>
                  {zones.map((zone) => (
                    <option key={zone.id} value={zone.name}>{zone.name}</option>
                  ))}
                </Select>
              </div>
            ) : null}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-gray-900 dark:text-white">Access tier</label>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["internal", "public"] as AccessTier[]).map((tier) => (
              <button
                key={tier}
                type="button"
                onClick={() => selectAccessTier(tier)}
                className={cn(
                  "flex items-center justify-between rounded-2xl border px-4 py-3 text-left transition",
                  form.accessTier === tier
                    ? "border-sky-500/30 bg-sky-500/10"
                    : "border-gray-200 bg-white hover:bg-slate-50 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:hover:bg-[#141414]",
                )}
              >
                <AccessTierBadge tier={tier} />
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {tier === "internal" ? `${INTERNAL_DOMAIN} · Authentik` : `${BASE_DOMAIN} · Internet`}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-gray-900 dark:text-white">Target</label>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => updateForm("targetType", "k8s")}
              className={cn(
                "rounded-2xl border px-4 py-3 text-left transition",
                form.targetType === "k8s"
                  ? "border-sky-500/30 bg-sky-500/10"
                  : "border-gray-200 bg-white hover:bg-slate-50 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:hover:bg-[#141414]",
              )}
            >
              <p className="font-medium text-gray-900 dark:text-white">K8s Service</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Route to an in-cluster service.</p>
            </button>
            <button
              type="button"
              onClick={() => updateForm("targetType", "baremetal")}
              className={cn(
                "rounded-2xl border px-4 py-3 text-left transition",
                form.targetType === "baremetal"
                  ? "border-sky-500/30 bg-sky-500/10"
                  : "border-gray-200 bg-white hover:bg-slate-50 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:hover:bg-[#141414]",
              )}
            >
              <p className="font-medium text-gray-900 dark:text-white">Bare-metal / external IP</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Route to an IP:port (e.g. 10.25.0.135:30032).</p>
            </button>
          </div>
        </div>

        {form.targetType === "k8s" ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Service name</label>
              <input value={form.targetService} onChange={(event) => updateForm("targetService", event.target.value)} className={inputClass} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Namespace</label>
              <input value={form.targetNamespace} onChange={(event) => updateForm("targetNamespace", event.target.value)} className={inputClass} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Port</label>
              <input value={form.targetPort} onChange={(event) => updateForm("targetPort", event.target.value)} inputMode="numeric" className={inputClass} />
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Target IP</label>
              <input value={form.targetIP} onChange={(event) => updateForm("targetIP", event.target.value)} placeholder="10.25.0.135" className={inputClass} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Port</label>
              <input value={form.targetPort} onChange={(event) => updateForm("targetPort", event.target.value)} inputMode="numeric" placeholder="30032" className={inputClass} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Scheme</label>
              <Select value={form.scheme} onChange={(event) => updateForm("scheme", event.target.value as "http" | "https")}>
                <option value="http">http</option>
                <option value="https">https</option>
              </Select>
            </div>
          </div>
        )}

        {form.targetType === "baremetal" && form.scheme === "https" ? (
          <label className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]">
            <input type="checkbox" checked={form.skipTlsVerify} onChange={(event) => updateForm("skipTlsVerify", event.target.checked)} />
            Skip TLS verify (self-signed backend)
          </label>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <label
            className={cn(
              "flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]",
              form.accessTier === "internal" && "opacity-70",
            )}
            title={form.accessTier === "internal" ? "Internal routes are always gated by Authentik" : undefined}
          >
            <input
              type="checkbox"
              checked={form.accessTier === "internal" ? true : form.enableAuth}
              disabled={form.accessTier === "internal"}
              onChange={(event) => updateForm("enableAuth", event.target.checked)}
            />
            {form.accessTier === "internal"
              ? "Authentik login — always required for internal"
              : "Require Authentik login (forward-auth)"}
          </label>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">TLS Secret</label>
            <input value={form.tlsSecret} onChange={(event) => updateForm("tlsSecret", event.target.value)} className={inputClass} />
          </div>
        </div>
      </div>
    </ResponsiveSheet>
  );
}
