"use client";
// Email panel — SMTP delivery posture read live from the site's mail plugin (read-only).

import type { ReactNode } from "react";
import { Inbox, Lock, LockOpen, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EmailData } from "../../../lib/manage/probes/email";
import { SectionCard } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
      <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Value({ text, mono }: { text: string; mono?: boolean }) {
  return (
    <span className={cn("text-sm text-zinc-900 dark:text-zinc-100", mono && "font-mono text-[11px]")}>{text}</span>
  );
}

/** Encryption pill — encrypted transports (ssl/tls) read as healthy, "none" as a warning. */
function EncryptionPill({ encryption }: { encryption: string | null }) {
  if (!encryption) return <Value text="—" />;
  const secure = encryption.toLowerCase() !== "none";
  return (
    <span className={cn(PILL, secure ? TONE.good : TONE.warn, "uppercase")}>
      {secure ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <LockOpen className="h-3.5 w-3.5" aria-hidden />}
      {encryption}
    </span>
  );
}

function AuthPill({ auth }: { auth: boolean | null }) {
  if (auth === null) return <Value text="—" />;
  return <span className={cn(PILL, auth ? TONE.good : TONE.neutral)}>{auth ? "Enabled" : "Disabled"}</span>;
}

export function EmailPanel({ site }: { site: string }) {
  const state = useManagePanel<EmailData>(site, "email");

  return (
    <PanelState state={state}>
      {(data) => (
        <div className="grid gap-5 lg:grid-cols-2">
          <SectionCard title="SMTP delivery" description="How this site sends transactional email." icon={Mail}>
            {data.configured ? (
              <dl className="space-y-2">
                <Row label="Plugin">
                  <Value text={data.plugin ?? "—"} mono />
                </Row>
                <Row label="Mailer">
                  <Value text={data.mailer ?? "—"} />
                </Row>
                <Row label="SMTP host">
                  <Value text={data.host ?? "—"} mono />
                </Row>
                <Row label="Port">
                  <Value text={data.port != null ? String(data.port) : "—"} mono />
                </Row>
                <Row label="Encryption">
                  <EncryptionPill encryption={data.encryption} />
                </Row>
                <Row label="Authentication">
                  <AuthPill auth={data.auth} />
                </Row>
                <Row label="From address">
                  <Value text={data.fromEmail ?? "—"} mono />
                </Row>
                <Row label="From name">
                  <Value text={data.fromName ?? "—"} />
                </Row>
              </dl>
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                <p>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{data.plugin ?? "An SMTP plugin"}</span> is
                  active, but its delivery configuration isn&apos;t readable over this management channel. WP Mail SMTP and
                  Post SMTP expose a full posture here.
                </p>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Delivery log" description="Per-send outcomes." icon={Inbox}>
            <div className="rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
              <p>
                No per-send delivery log is exposed over the read-only management channel — WP Mail SMTP Lite records none.
                The configuration posture on the left reflects how mail is dispatched; enable a logging add-on in the plugin
                to retain individual send outcomes.
              </p>
            </div>
          </SectionCard>
        </div>
      )}
    </PanelState>
  );
}
