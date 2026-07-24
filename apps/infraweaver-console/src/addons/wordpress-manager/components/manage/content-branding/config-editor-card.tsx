"use client";

/**
 * Config editor (Epic B) — FUSED into the Resources panel, not a new tab. Shows the
 * effective PHP limits + wp-config flags the panel already talks about, each with an
 * "Adjust" affordance. Before a change lands it renders (1) the exact target file and
 * managed-block line, (2) a per-key risk label, and (3) — for a live WP_DEBUG_DISPLAY
 * enable — a confirm checkbox. Applies over the signed `config.set` and renders the
 * result verbatim: configured-vs-effective, skipped reasons, and `manual_step`
 * guidance when a target is unwritable (never faked as success). RBAC-only, no tier.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, FileWarning, Pencil, RotateCcw, SlidersHorizontal } from "lucide-react";
import { toast } from "@/lib/notify";
import { SectionCard } from "../../demo/widgets";
import { Spinner } from "../../demo/manage/panel-shell";
import { ActionError, BTN, BTN_PRIMARY, BTN_SM, ConfirmDialog, Field, INPUT } from "../../demo/manage/manage-ui";
import { Pill } from "../../demo/manage/kit";
import {
  CONFIG_ALLOWLIST,
  CONFIG_CONFIRM_ON_ENABLE,
  CONFIG_RISK,
  type ConfigAllowlistEntry,
  type ConfigApplyResult,
  type ConfigGetResponse,
  type ConfigSetParams,
} from "../../../lib/manage/content-branding";
import { useConfig, useConfigWriter } from "./use-content-branding";

type ConfigValue = string | boolean;

function displayValue(v: ConfigValue | undefined): string {
  if (v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "on" : "off";
  return v;
}

/** The file + managed-block line a pending change writes — the diff preview (B1). */
function previewLine(key: string, entry: ConfigAllowlistEntry, value: ConfigValue, mechanism: string): { file: string; line: string } {
  if (entry.group === "wpconfig") {
    const literal = typeof value === "boolean" ? (value ? "true" : "false") : JSON.stringify(value);
    return { file: "wp-config.php", line: `define( '${key}', ${literal} );` };
  }
  if (mechanism === "htaccess") return { file: ".htaccess", line: `php_value ${key} ${value}` };
  return { file: ".user.ini", line: `${key} = ${value}` };
}

/** The inline "Adjust one key" editor. */
function AdjustRow({
  site,
  keyName,
  entry,
  current,
  mechanism,
  onApplied,
}: {
  site: string;
  keyName: string;
  entry: ConfigAllowlistEntry;
  current: ConfigValue | undefined;
  mechanism: string;
  onApplied: () => void;
}) {
  const writer = useConfigWriter(site);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(typeof current === "boolean" ? "" : String(current ?? ""));
  const [boolVal, setBoolVal] = useState<boolean>(current === true);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value: ConfigValue = entry.type === "bool" ? boolVal : text.trim();
  const risk = CONFIG_RISK[keyName];
  // A live-site enable of a confirm-on-enable key (e.g. WP_DEBUG_DISPLAY) needs a checkbox.
  const needsConfirm =
    entry.type === "bool" && boolVal === true && (CONFIG_CONFIRM_ON_ENABLE as readonly string[]).includes(keyName);
  const empty = entry.type !== "bool" && text.trim() === "";
  const canApply = !writer.pending && !empty && (!needsConfirm || confirmed);
  const preview = previewLine(keyName, entry, value, mechanism);

  async function apply() {
    setError(null);
    try {
      const values = { [keyName]: value } as ConfigSetParams["values"];
      const result = await writer.apply(values);
      if (result.skipped[keyName]) {
        setError(`Not applied: ${result.skipped[keyName]}`);
        return;
      }
      toast.success(`${entry.label} updated`);
      setOpen(false);
      setConfirmed(false);
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed");
    }
  }

  if (!open) {
    return (
      <button type="button" className={BTN_SM} onClick={() => setOpen(true)}>
        <Pencil className="h-3.5 w-3.5" aria-hidden /> Adjust
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      {entry.type === "bool" ? (
        <Field label={entry.label} htmlFor={`cfg-${keyName}`}>
          <select id={`cfg-${keyName}`} className={INPUT} value={boolVal ? "true" : "false"} onChange={(e) => setBoolVal(e.target.value === "true")}>
            <option value="false">Off</option>
            <option value="true">On</option>
          </select>
        </Field>
      ) : (
        <Field
          label={entry.label}
          htmlFor={`cfg-${keyName}`}
          hint={entry.type === "size" ? "A size like 256M or 64M." : entry.min !== undefined ? `A whole number (min ${entry.min}).` : "A whole number."}
        >
          <input id={`cfg-${keyName}`} className={INPUT} value={text} onChange={(e) => setText(e.target.value)} placeholder={String(current ?? "")} />
        </Field>
      )}

      {risk ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {risk}
        </p>
      ) : null}

      {/* Diff preview — the exact file + managed line that will be written. */}
      <div className="rounded-md border border-zinc-200 bg-white p-2 font-mono text-[11px] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        <span className="text-zinc-400">{preview.file}</span>
        <br />
        {preview.line}
      </div>

      {needsConfirm ? (
        <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="h-4 w-4" />
          I understand this exposes PHP errors to visitors on a live site.
        </label>
      ) : null}

      {error ? <ActionError message={error} onDismiss={() => setError(null)} /> : null}
      <div className="flex gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={!canApply} onClick={apply}>
          {writer.pending ? <Spinner /> : null} Apply
        </button>
        <button type="button" className={BTN} onClick={() => { setOpen(false); setError(null); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Honest configured-vs-effective render for one userini key. */
function ConfiguredNote({ configured, effective }: { configured: string | undefined; effective: ConfigValue | undefined }) {
  if (!configured || configured === "") return null;
  const eff = typeof effective === "string" ? effective : "";
  if (eff === configured) return null;
  return (
    <span className="text-[11px] text-amber-600 dark:text-amber-400">
      configured {configured}, effective still {eff || "—"} (applies next request)
    </span>
  );
}

function ConfigTable({ site, data }: { site: string; data: ConfigGetResponse }) {
  const mechanism = data.mechanism || "user.ini";
  const keys = Object.keys(CONFIG_ALLOWLIST);
  return (
    <div className="space-y-2">
      {keys.map((key) => {
        const entry = CONFIG_ALLOWLIST[key];
        const current = data.current[key];
        return (
          <div key={key} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {entry.label} <span className="font-mono text-[11px] text-zinc-400">{key}</span>
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Effective: <span className="tabular-nums">{displayValue(current)}</span>{" "}
                  {entry.group === "userini" ? <ConfiguredNote configured={data.configured[key]} effective={current} /> : null}
                </p>
              </div>
              <AdjustRow site={site} keyName={key} entry={entry} current={current} mechanism={mechanism} onApplied={() => undefined} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RestoreDefaults({ site, onDone }: { site: string; onDone: () => void }) {
  const writer = useConfigWriter(site);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ConfigApplyResult | null>(null);

  async function restore() {
    try {
      // Empty-value apply path — strips the managed blocks, touching nothing outside them.
      const res = await writer.apply({} as ConfigSetParams["values"]);
      setResult(res);
      if (res.manual_step) toast.warning("Some limits need a manual step — see the note below.");
      else toast.success("Managed config blocks cleared");
      setOpen(false);
      onDone();
    } catch {
      toast.error("Restore failed");
    }
  }

  return (
    <>
      <button type="button" className={BTN} onClick={() => setOpen(true)}>
        <RotateCcw className="h-4 w-4" aria-hidden /> Restore defaults
      </button>
      {result?.manual_step ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {result.manual_step}
        </p>
      ) : null}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={restore}
        title="Restore InfraWeaver-managed config to defaults"
        description="Removes only the InfraWeaver-managed blocks from wp-config / the PHP-limits file. Your own lines are untouched, and a .iwsl.bak backup remains."
        confirmLabel="Restore defaults"
        pending={writer.pending}
      />
    </>
  );
}

/** The Config editor card — RBAC-only (no tier gate), fused into Resources. */
export function ConfigEditorCard({ site }: { site: string }) {
  const state = useConfig(site);

  const backup = useMemo(() => {
    if (!state.data) return null;
    const { wp_config, php_limits } = state.data.writable;
    return { wp_config, php_limits };
  }, [state.data]);

  return (
    <SectionCard
      className="lg:col-span-2"
      title="Advanced configuration"
      description="Memory, upload limits and debug flags — applied to wp-config or the PHP-limits file, with a preview before it lands."
      icon={SlidersHorizontal}
    >
      {state.loading && !state.data ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner /> Loading configuration…
        </div>
      ) : state.error && !state.data ? (
        <ActionError message={state.error} />
      ) : state.data ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Pill tone="warn" icon={AlertTriangle}>
              Advanced — a bad value can take the site offline
            </Pill>
            {backup && !backup.wp_config ? <Pill tone="neutral">wp-config read-only</Pill> : null}
            {backup && !backup.php_limits ? <Pill tone="neutral">PHP-limits file read-only</Pill> : null}
          </div>
          <ConfigTable site={site} data={state.data} />
          <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <RestoreDefaults site={site} onDone={state.reload} />
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
