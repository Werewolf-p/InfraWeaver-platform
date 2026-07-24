"use client";

/**
 * The HTTP security-header grade card + one-click hardening controls. Grades come
 * from the signed `security.scan` (a loopback fetch of the site's OWN home URL);
 * the hardening config is the CLOSED enum set the connector's `security.harden`
 * accepts — the console only ever sends allow-listed tokens, never a free-form
 * header name or value. CSP defaults to REPORT-ONLY; enforcing (and reverting) is
 * a deliberate, confirmed second step.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldAlert, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "@/lib/notify";
import { SectionCard } from "../../demo/widgets";
import { Pill, type PillTone } from "../../demo/manage/kit/pill";
import { BTN, BTN_PRIMARY, BTN_DANGER_GHOST, ConfirmDialog } from "../../demo/manage/manage-ui";
import { Spinner } from "../../demo/manage/panel-shell";
import {
  CSP_VALUES,
  FRAME_VALUES,
  REFERRER_VALUES,
  hardeningConfigToParams,
  type CspValue,
  type HardeningConfig,
  type HeaderState,
  type SecurityGrade,
  type SecurityScanResult,
} from "../../../lib/manage/security-consent";
import { applyHardening, securityKeys } from "../../../lib/manage/use-security";

/** The one-click recommended config: every safe header on, CSP report-only first. */
const RECOMMENDED: HardeningConfig = {
  hsts: true,
  nosniff: true,
  frame: "sameorigin",
  referrer: "strict-origin-when-cross-origin",
  permissions: true,
  csp: "report-only",
};

const HEADER_STATE_TONE: Readonly<Record<HeaderState, PillTone>> = {
  good: "good",
  weak: "warn",
  missing: "critical",
};

const GRADE_TONE: Readonly<Record<SecurityGrade, PillTone>> = {
  A: "good",
  B: "good",
  C: "warn",
  D: "warn",
  F: "critical",
};

const SELECT =
  "rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 focus-visible:border-sky-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-100";

/** The big A–F chip. */
function GradeBadge({ grade }: { grade: SecurityGrade }): ReactNode {
  return (
    <Pill tone={GRADE_TONE[grade]} className="!h-14 !w-14 !justify-center !rounded-2xl !px-0 !text-3xl !font-bold">
      {grade}
    </Pill>
  );
}

interface ToggleProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly hint?: string;
}

function Toggle({ label, checked, onChange, hint }: ToggleProps): ReactNode {
  return (
    <label className="flex items-start gap-2.5 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-950/40">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 text-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
      />
      <span className="min-w-0">
        <span className="font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
        {hint ? <span className="block text-xs text-zinc-500 dark:text-zinc-400">{hint}</span> : null}
      </span>
    </label>
  );
}

export interface HeaderGradeCardProps {
  readonly site: string;
  /** Live scan (grade + header rows), or null while loading / unavailable. */
  readonly scan: SecurityScanResult | null;
  readonly scanLoading: boolean;
  readonly onRescan: () => void;
  /** The connector's currently-persisted hardening config. */
  readonly config: HardeningConfig;
}

/** A hardening config equals another when every closed field matches. */
function sameConfig(a: HardeningConfig, b: HardeningConfig): boolean {
  return (
    a.hsts === b.hsts &&
    a.nosniff === b.nosniff &&
    a.frame === b.frame &&
    a.referrer === b.referrer &&
    a.permissions === b.permissions &&
    a.csp === b.csp
  );
}

export function HeaderGradeCard({ site, scan, scanLoading, onRescan, config }: HeaderGradeCardProps): ReactNode {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<HardeningConfig>(config);
  const [saving, setSaving] = useState(false);
  const [enforceOpen, setEnforceOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);

  // Re-seed the editable draft whenever the persisted config changes (after a save).
  const configKey = JSON.stringify(config);
  useEffect(() => {
    setDraft(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialized config
  }, [configKey]);

  const dirty = useMemo(() => !sameConfig(draft, config), [draft, config]);
  const scanned = scan && scan.ok;
  const scanFailed = scan && scan.ok === false && scan.locked !== true;

  function patch(next: Partial<HardeningConfig>): void {
    setDraft((prev) => ({ ...prev, ...next }));
  }

  async function persist(target: HardeningConfig | { revert: true }): Promise<void> {
    setSaving(true);
    try {
      const params = "revert" in target ? { revert: true as const } : { config: hardeningConfigToParams(target) };
      const res = await applyHardening(site, params);
      if (res.locked) {
        toast.error("Security hardening is locked on this site's plan.");
        return;
      }
      toast.success("revert" in target ? "Security headers reverted" : "Hardening applied");
      void queryClient.invalidateQueries({ queryKey: securityKeys.scan(site) });
      void queryClient.invalidateQueries({ queryKey: securityKeys.status(site) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not apply hardening");
    } finally {
      setSaving(false);
      setEnforceOpen(false);
      setRevertOpen(false);
    }
  }

  function onSave(): void {
    // Enforcing CSP can break a theme — make it a deliberate, confirmed step.
    if (draft.csp === "enforce" && config.csp !== "enforce") {
      setEnforceOpen(true);
      return;
    }
    void persist(draft);
  }

  return (
    <SectionCard
      title="HTTP security headers"
      description="Graded from a loopback fetch of this site's own home page. One-click hardening applies only allow-listed values."
      icon={ShieldCheck}
      className="lg:col-span-2"
      action={
        <button type="button" className={BTN} onClick={onRescan} disabled={scanLoading}>
          {scanLoading ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />} Re-scan
        </button>
      }
    >
      <div className="space-y-5">
        {/* grade + summary */}
        {scanned && scan?.grade ? (
          <div className="flex items-center gap-4">
            <GradeBadge grade={scan.grade} />
            <div>
              <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                Header grade {scan.grade}
                {typeof scan.score === "number" ? ` · ${scan.score}/100` : ""}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {scan.scanned_at ? `Scanned ${new Date(scan.scanned_at * 1000).toLocaleString()}` : "Live header scan"}
              </p>
            </div>
          </div>
        ) : scanFailed ? (
          <p className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
            The site couldn&apos;t be reached for a header scan ({scan?.reason ?? "no response"}). You can still apply hardening below.
          </p>
        ) : scanLoading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Spinner /> Scanning headers…
          </div>
        ) : null}

        {/* per-header verdicts */}
        {scanned && scan?.headers && scan.headers.length > 0 ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {scan.headers.map((row) => (
              <li
                key={row.name}
                className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40"
              >
                <Pill tone={HEADER_STATE_TONE[row.state]}>{row.state}</Pill>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.name}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{row.why}</p>
                  {row.value_hint ? (
                    <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-500">{row.value_hint}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {/* information-disclosure leaks */}
        {scanned && scan?.leaks && scan.leaks.length > 0 ? (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Information disclosure</p>
            <ul className="space-y-1 text-sm text-amber-800 dark:text-amber-200">
              {scan.leaks.map((leak) => (
                <li key={leak.name}>
                  <span className="font-medium">{leak.name}</span> — {leak.why}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* detected trackers (feeds the consent card) */}
        {scanned && scan?.detected_vendors && scan.detected_vendors.length > 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950/40">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Trackers detected on your pages</p>
            <div className="flex flex-wrap gap-1.5">
              {scan.detected_vendors.map((v) => (
                <Pill key={v.vendor} tone="info">
                  {v.label} · {v.category}
                  {v.count > 1 ? ` ×${v.count}` : ""}
                </Pill>
              ))}
            </div>
          </div>
        ) : null}

        {/* hardening controls (closed enum set only) */}
        <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Hardening</p>
            <button
              type="button"
              className={BTN}
              onClick={() => setDraft(RECOMMENDED)}
              disabled={saving}
            >
              <Sparkles className="h-4 w-4" aria-hidden /> Recommended (CSP report-only)
            </button>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <Toggle label="Strict-Transport-Security (HSTS)" hint="Pins HTTPS for a year" checked={draft.hsts} onChange={(v) => patch({ hsts: v })} />
            <Toggle label="X-Content-Type-Options: nosniff" hint="Blocks MIME sniffing" checked={draft.nosniff} onChange={(v) => patch({ nosniff: v })} />
            <Toggle
              label="Permissions-Policy"
              hint="Restricts camera / geolocation / mic / payment"
              checked={draft.permissions}
              onChange={(v) => patch({ permissions: v })}
            />
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-950/40">
              <label className="mb-1 block font-medium text-zinc-800 dark:text-zinc-200">X-Frame-Options</label>
              <select className={SELECT} value={draft.frame} onChange={(e) => patch({ frame: e.target.value as HardeningConfig["frame"] })}>
                <option value="">Off</option>
                {FRAME_VALUES.map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-950/40 sm:col-span-2">
              <label className="mb-1 block font-medium text-zinc-800 dark:text-zinc-200">Referrer-Policy</label>
              <select
                className={SELECT}
                value={draft.referrer}
                onChange={(e) => patch({ referrer: e.target.value as HardeningConfig["referrer"] })}
              >
                <option value="">Off</option>
                {REFERRER_VALUES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* CSP mode — report-only first, enforce is a deliberate step */}
          <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-zinc-950/40">
            <p className="mb-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">Content-Security-Policy</p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="CSP mode">
              {CSP_VALUES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={draft.csp === mode}
                  onClick={() => patch({ csp: mode as CspValue })}
                  className={
                    draft.csp === mode
                      ? "rounded-lg border border-sky-500 bg-sky-500/10 px-3 py-1.5 text-sm font-medium text-sky-700 dark:text-sky-300"
                      : "rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                  }
                >
                  {mode === "off" ? "Off" : mode === "report-only" ? "Report-only" : "Enforce"}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
              Start with report-only — violations are logged, nothing is blocked. Enforce once the report is clean.
            </p>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={onSave} disabled={saving || !dirty}>
              {saving ? <Spinner /> : <ShieldCheck className="h-4 w-4" aria-hidden />} Save hardening
            </button>
            <button type="button" className={BTN_DANGER_GHOST} onClick={() => setRevertOpen(true)} disabled={saving}>
              Revert all headers
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={enforceOpen}
        onClose={() => setEnforceOpen(false)}
        onConfirm={() => void persist(draft)}
        title="Enforce Content-Security-Policy?"
        tone="danger"
        confirmLabel="Enforce CSP"
        confirmPhrase="ENFORCE"
        pending={saving}
        body={
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Enforcing CSP blocks any script, style or frame the policy does not allow. If the report-only phase still shows violations,
            enforcing can break parts of the site. Confirm you have reviewed the report.
          </p>
        }
      />
      <ConfirmDialog
        open={revertOpen}
        onClose={() => setRevertOpen(false)}
        onConfirm={() => void persist({ revert: true })}
        title="Revert all security headers?"
        tone="danger"
        confirmLabel="Revert"
        pending={saving}
        body={
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            This clears every header this connector emits (HSTS, CSP, frame, referrer, permissions, nosniff). Headers set upstream by the
            platform are unaffected.
          </p>
        }
      />
    </SectionCard>
  );
}
