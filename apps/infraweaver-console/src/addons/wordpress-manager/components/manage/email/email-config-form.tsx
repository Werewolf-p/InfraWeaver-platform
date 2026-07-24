"use client";

/**
 * Provider setup form for connector-managed SMTP delivery. Renders the eight
 * engine-owned settings plus a WRITE-ONLY password, driven by provider presets
 * (Office 365 / Google Workspace / custom). Saves over the signed `email.config.set`
 * route; the connector's `save_settings()` stays the authoritative validator.
 *
 * SECURITY: the password value is NEVER pre-filled or displayed. The field starts
 * empty; a blank submit keeps the prior secret, a typed value replaces it, and a
 * "clear stored password" toggle drops it. The stored state is shown ONLY as a
 * source badge (constant | option | none) read from the connector snapshot — the
 * secret itself never crosses back to the browser.
 */

import { useId, useState } from "react";
import { KeyRound, Lock, Send } from "lucide-react";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  emailReasonText,
  SECURE_MODES,
  type EmailConnectorConfig,
  type EmailSettings,
  type SecureMode,
} from "../../../lib/manage/email";
import {
  applyPreset,
  detectPreset,
  EMAIL_PRESETS,
  findPreset,
  fromIdentityWarning,
  type EmailPresetId,
} from "../../../lib/manage/email-presets";
import { ActionError, BTN_PRIMARY, Field, INPUT } from "../../demo/manage/manage-ui";
import { Spinner } from "../../demo/manage/panel-shell";
import { useEmailActions } from "./use-email-actions";

const BLANK_SETTINGS: EmailSettings = {
  host: "",
  port: 587,
  auth: true,
  username: "",
  from_email: "",
  from_name: "",
  secure: "tls",
  allow_option_password: false,
};

const SECURE_LABEL: Record<SecureMode, string> = { "": "None", ssl: "SSL", tls: "TLS / STARTTLS" };

function passwordSourceNote(config: EmailConnectorConfig): { text: string; constant: boolean } {
  const source = config.password_source ?? "none";
  if (source === "constant") {
    return {
      constant: true,
      text: "Using the IWSL_SMTP_PASS constant from wp-config.php — database passwords are ignored while it is defined.",
    };
  }
  if (source === "option" && config.has_password) {
    return { constant: false, text: "A password is stored (encrypted at rest). Leave blank to keep it." };
  }
  return { constant: false, text: "No password is stored." };
}

export function EmailConfigForm({ site, connector }: { site: string; connector: EmailConnectorConfig }) {
  const initial = connector.settings ?? BLANK_SETTINGS;
  const [settings, setSettings] = useState<EmailSettings>(initial);
  const [preset, setPreset] = useState<EmailPresetId>(detectPreset({ host: initial.host }));
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { saveConfig, pending } = useEmailActions(site);

  const ids = {
    preset: useId(),
    host: useId(),
    port: useId(),
    secure: useId(),
    username: useId(),
    fromEmail: useId(),
    fromName: useId(),
    password: useId(),
  };

  const source = passwordSourceNote(connector);
  const activePreset = findPreset(preset);
  const fromWarning = activePreset ? fromIdentityWarning(activePreset, settings) : null;

  function patch(next: Partial<EmailSettings>): void {
    setSettings((prev) => ({ ...prev, ...next }));
  }

  function choosePreset(id: EmailPresetId): void {
    setPreset(id);
    const p = findPreset(id);
    if (p) setSettings((prev) => applyPreset(p, prev));
  }

  async function save(): Promise<void> {
    setError(null);
    if (settings.host.trim() === "") {
      setError("Enter the SMTP host (your provider's mail server).");
      return;
    }
    if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
      setError("The SMTP port must be between 1 and 65535.");
      return;
    }
    // Write-only secret: clear wins; else only send a typed value; else omit (keep prior).
    const params = {
      settings,
      ...(clearPassword ? { clear_password: true } : password !== "" ? { password } : {}),
    };
    try {
      const result = await saveConfig(params);
      if (result.ok) {
        toast.success("Email settings saved.");
        setPassword("");
        setClearPassword(false);
      } else {
        const reason = result.locked ? "entitlement-locked" : result.reason;
        setError(emailReasonText(reason) || "The settings couldn't be saved.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The settings couldn't be saved.");
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Provider preset" htmlFor={ids.preset} hint="Pre-fills sensible defaults; override any field below.">
        <select
          id={ids.preset}
          className={INPUT}
          value={preset}
          onChange={(e) => choosePreset(e.target.value as EmailPresetId)}
        >
          {EMAIL_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="SMTP host" htmlFor={ids.host} required>
          <input
            id={ids.host}
            type="text"
            autoComplete="off"
            className={INPUT}
            value={settings.host}
            onChange={(e) => patch({ host: e.target.value })}
            placeholder="smtp.office365.com"
          />
        </Field>
        <Field label="Port" htmlFor={ids.port} required>
          <input
            id={ids.port}
            type="number"
            min={1}
            max={65535}
            className={INPUT}
            value={settings.port}
            onChange={(e) => patch({ port: Number(e.target.value) })}
          />
        </Field>
        <Field label="Encryption" htmlFor={ids.secure}>
          <select
            id={ids.secure}
            className={INPUT}
            value={settings.secure}
            onChange={(e) => patch({ secure: e.target.value as SecureMode })}
          >
            {SECURE_MODES.map((mode) => (
              <option key={mode || "none"} value={mode}>
                {SECURE_LABEL[mode]}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-end pb-1">
          <label className="inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={settings.auth}
              onChange={(e) => patch({ auth: e.target.checked })}
              className="h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500/40 dark:border-zinc-600"
            />
            Use SMTP authentication
          </label>
        </div>
      </div>

      {settings.auth ? (
        <Field label="Username" htmlFor={ids.username} hint="Usually the full mailbox address.">
          <input
            id={ids.username}
            type="text"
            autoComplete="off"
            className={INPUT}
            value={settings.username}
            onChange={(e) => patch({ username: e.target.value })}
            placeholder="postmaster@example.com"
          />
        </Field>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="From address"
          htmlFor={ids.fromEmail}
          hint="Leave blank to fall back to the username at send time."
        >
          <input
            id={ids.fromEmail}
            type="email"
            autoComplete="off"
            className={INPUT}
            value={settings.from_email}
            onChange={(e) => patch({ from_email: e.target.value })}
            placeholder="hello@example.com"
          />
        </Field>
        <Field label="From name" htmlFor={ids.fromName}>
          <input
            id={ids.fromName}
            type="text"
            autoComplete="off"
            className={INPUT}
            value={settings.from_name}
            onChange={(e) => patch({ from_name: e.target.value })}
            placeholder="Example"
          />
        </Field>
      </div>

      {fromWarning ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {fromWarning}
        </p>
      ) : null}

      {/* Write-only password. Never shows a stored secret — only its source. */}
      <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
          <KeyRound className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" aria-hidden />
          SMTP password
        </div>
        <p
          className={cn(
            "mb-2 flex items-start gap-1.5 text-xs",
            source.constant ? "text-sky-700 dark:text-sky-300" : "text-zinc-500 dark:text-zinc-400",
          )}
        >
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {source.text}
        </p>
        <Field
          label="Set / replace password"
          htmlFor={ids.password}
          hint={
            source.constant
              ? "Managed by the wp-config constant — nothing to enter here."
              : "Write-only: the stored value is never shown. Leave blank to keep the current one."
          }
        >
          <input
            id={ids.password}
            type="password"
            autoComplete="new-password"
            className={INPUT}
            value={password}
            disabled={source.constant || clearPassword}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={connector.has_password ? "••••••••" : "Not set"}
          />
        </Field>
        {!source.constant ? (
          <div className="mt-2 space-y-2">
            <label className="inline-flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={settings.allow_option_password}
                onChange={(e) => patch({ allow_option_password: e.target.checked })}
                className="h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500/40 dark:border-zinc-600"
              />
              Store the password in the database (encrypted at rest)
            </label>
            {connector.has_password ? (
              <label className="inline-flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={clearPassword}
                  onChange={(e) => setClearPassword(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 text-red-600 focus:ring-red-500/40 dark:border-zinc-600"
                />
                Clear the stored password
              </label>
            ) : null}
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              For strict providers, the safest option is the{" "}
              <span className="font-mono">IWSL_SMTP_PASS</span> constant in wp-config.php (keeps the secret out of the
              database entirely).
            </p>
          </div>
        ) : null}
      </div>

      {error ? <ActionError message={error} onDismiss={() => setError(null)} /> : null}

      <div className="flex justify-end">
        <button type="button" className={BTN_PRIMARY} onClick={save} disabled={pending}>
          {pending ? <Spinner /> : <Send className="h-4 w-4" aria-hidden />}
          Save email settings
        </button>
      </div>
    </div>
  );
}
