"use client";

/**
 * Test-send box + delivery log for the Email panel. Both ride signed methods:
 * `email.test` (connector-side rate-limited to 1/30s so the channel can't be
 * scripted into a spam cannon) and `email.log.get` (bounded, redacted at write
 * time — only `to`+`subject`+a redacted error are ever stored, never bodies or
 * headers). Clearing the log is a confirmed `email.log.clear`.
 */

import { useState } from "react";
import { CheckCircle2, Inbox, Send, Trash2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { emailReasonText, type EmailConnectorConfig, type EmailLogEntry, type EmailLogResponse } from "../../../lib/manage/email";
import { BTN, BTN_DANGER_GHOST, INPUT } from "../../demo/manage/manage-ui";
import { Spinner } from "../../demo/manage/panel-shell";
import { useEmailActions } from "./use-email-actions";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";

function formatTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return "—";
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function StatusPill({ status }: { status: EmailLogEntry["status"] }) {
  const ok = status === "sent";
  return (
    <span
      className={cn(
        PILL,
        ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
      )}
    >
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <XCircle className="h-3.5 w-3.5" aria-hidden />}
      {ok ? "Sent" : "Failed"}
    </span>
  );
}

/** Test-send: a recipient + a button; the result renders inline (honest about the switch). */
export function EmailTestBox({ site, connector }: { site: string; connector: EmailConnectorConfig }) {
  const defaultTo = connector.settings?.from_email || connector.settings?.username || "";
  const [to, setTo] = useState(defaultTo);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { sendTest, pending } = useEmailActions(site);

  async function run(): Promise<void> {
    setResult(null);
    try {
      const res = await sendTest(to);
      if (res.sent) {
        setResult({ ok: true, text: `Test email sent to ${to}.` });
        toast.success("Test email sent.");
      } else {
        const reason = res.locked ? "entitlement-locked" : res.reason ?? "send-failed";
        const suffix = res.retry_after_s ? ` (retry in ${res.retry_after_s}s)` : "";
        setResult({ ok: false, text: (emailReasonText(reason) || "The test send failed.") + suffix });
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "The test send failed." });
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          autoComplete="off"
          className={INPUT}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="you@example.com"
          aria-label="Test recipient"
        />
        <button type="button" className={BTN} onClick={run} disabled={pending || to.trim() === ""}>
          {pending ? <Spinner /> : <Send className="h-4 w-4" aria-hidden />}
          Send test
        </button>
      </div>
      {result ? (
        <p
          className={cn(
            "text-xs",
            result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
          )}
        >
          {result.text}
        </p>
      ) : null}
    </div>
  );
}

/** Delivery log table + summary strip + clear action. Rows render newest-first. */
export function EmailLogTable({ site, log }: { site: string; log: EmailLogResponse | null }) {
  const { clearLog, pending } = useEmailActions(site);
  const entries = log ? [...log.entries].reverse() : [];
  const failures = entries.filter((e) => e.status === "failed").length;
  const last = entries[0];

  async function clear(): Promise<void> {
    try {
      const res = await clearLog();
      if (res.ok) toast.success("Delivery log cleared.");
      else toast.error(emailReasonText(res.reason ?? "") || "Couldn't clear the log.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't clear the log.");
    }
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
        No sends recorded yet. Send a test above, or trigger a site email (a password reset, order receipt, …) to
        populate the log.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3 text-zinc-600 dark:text-zinc-400">
          <span>
            Last: {last ? <StatusPill status={last.status} /> : "—"}
          </span>
          <span className={failures > 0 ? "text-red-600 dark:text-red-400" : ""}>
            {failures > 0 ? `${failures} recent failure${failures === 1 ? "" : "s"}` : "No recent failures"}
          </span>
          <span>
            {entries.length} of max {log?.count ?? entries.length}
          </span>
        </div>
        <button type="button" className={BTN_DANGER_GHOST} onClick={clear} disabled={pending}>
          {pending ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
          Clear log
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-950/40 dark:text-zinc-400">
            <tr>
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">To</th>
              <th className="px-3 py-2 font-medium">Subject</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {entries.map((entry, idx) => (
              <tr key={`${entry.time}-${idx}`} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  {formatTime(entry.time)}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                  {entry.to.join(", ") || "—"}
                </td>
                <td className="px-3 py-2 text-zinc-800 dark:text-zinc-200">
                  <div>{entry.subject || "—"}</div>
                  {entry.status === "failed" && entry.error ? (
                    <div className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{entry.error}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={entry.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { Inbox as EmailLogIcon };
