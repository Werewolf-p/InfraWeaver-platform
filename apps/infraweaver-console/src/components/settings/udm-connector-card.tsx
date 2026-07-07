"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Router, XCircle } from "lucide-react";
import { SettingsCard } from "@/components/ui";
import { cn } from "@/lib/utils";

interface ConnectorStatus {
  configured: boolean;
  host?: string;
  wanIp?: string;
  isCgnat?: boolean;
}

const INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-slate-400 focus:border-indigo-500/50 focus:outline-none focus:ring-1 focus:ring-indigo-500/40";

/** Settings card: paste the UDM gateway IP + API key. Saving tests the key
 *  against the live gateway before it is persisted (server-side, to OpenBao). */
export function UdmConnectorCard() {
  const [host, setHost] = useState("10.10.0.1");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/udm/connector")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ConnectorStatus | null) => {
        if (!active || !data) return;
        setStatus(data);
        if (data.host) setHost(data.host.replace(/^https?:\/\//, ""));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/udm/connector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, apiKey }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        wanIp?: string;
        isCgnat?: boolean;
      };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? `Save failed (${res.status})` });
        return;
      }
      setApiKey("");
      setStatus({ configured: true, host, wanIp: data.wanIp, isCgnat: data.isCgnat });
      setMessage({
        ok: true,
        text: data.wanIp ? `Connected — WAN ${data.wanIp}${data.isCgnat ? " (CGNAT)" : ""}` : "Saved",
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  const canSave = Boolean(host) && (Boolean(apiKey) || Boolean(status?.configured)) && !saving;

  return (
    <SettingsCard
      title="UDM Connector"
      description="UniFi gateway address + API key for firewall / port-forward control"
      icon={Router}
    >
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs text-slate-500 dark:text-slate-400">Gateway IP / host</span>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="10.10.0.1"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
        </label>

        <label className="block">
          <span className="text-xs text-slate-500 dark:text-slate-400">API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={status?.configured ? "•••••• stored — leave blank to keep" : "paste UDM API key"}
            autoComplete="new-password"
            spellCheck={false}
            className={INPUT_CLASS}
          />
        </label>

        <div className="flex items-center gap-2 text-xs">
          {status?.configured ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-slate-500" />
          )}
          <span className={status?.configured ? "text-green-400" : "text-slate-500 dark:text-slate-400"}>
            {status?.configured
              ? status.wanIp
                ? `Configured — WAN ${status.wanIp}${status.isCgnat ? " (CGNAT)" : ""}`
                : "Configured"
              : "Not configured"}
          </span>
        </div>

        <button
          onClick={save}
          disabled={!canSave}
          className={cn(
            "flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors touch-manipulation",
            canSave
              ? "border border-indigo-500/30 bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30"
              : "border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-400",
          )}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save &amp; test
        </button>

        {message ? (
          <p className={cn("text-xs", message.ok ? "text-green-400" : "text-red-400")}>{message.text}</p>
        ) : null}
      </div>
    </SettingsCard>
  );
}
