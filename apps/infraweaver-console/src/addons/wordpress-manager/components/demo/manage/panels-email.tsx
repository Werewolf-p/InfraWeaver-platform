"use client";

/**
 * Email panel — one surface that answers "how does this site send mail?" and lets
 * an operator set it up, prove it, and watch it. Primary source is the connector's
 * OWN SMTP delivery (read over the signed channel); a third-party SMTP plugin's
 * posture is the fallback and the conflict signal. This replaces the old panel
 * that only read a competitor plugin and recommended installing wp-mail-smtp.
 *
 * Narrative, top to bottom: how mail leaves this site (source + conflict) → set it
 * up / change it (presets, from-identity, write-only secret) → prove it (test send)
 * → watch it (log + failures) → land it (SPF/DMARC). No secret ever renders here.
 */

import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Lock, Mail, PlugZap, Send, ServerCog, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  connectorDelivering,
  type EmailConnectorConfig,
  type EmailData,
  type EmailGate,
  type EmailPluginPosture,
} from "../../../lib/manage/email";
import { SectionCard } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";
import { EmailConfigForm } from "../../manage/email/email-config-form";
import { EmailDeliverabilityCard } from "../../manage/email/email-deliverability";
import { EmailLogTable, EmailTestBox } from "../../manage/email/email-log";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

function Banner({ tone, icon: Icon, children }: { tone: "warn" | "info"; icon: React.ElementType; children: ReactNode }) {
  const cls =
    tone === "warn"
      ? "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-200"
      : "border-sky-500/30 bg-sky-500/5 text-sky-800 dark:text-sky-200";
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border px-3 py-2 text-sm", cls)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Gate reasons (array or single) as a small list. */
function gateReasons(gate: EmailGate): string[] {
  if (Array.isArray(gate.reasons)) return gate.reasons.filter((r): r is string => typeof r === "string");
  if (typeof gate.reason === "string" && gate.reason !== "") return [gate.reason];
  return [];
}

/** Locked (unentitled) connector state — a doorway, not a wall: reasons + tier, no fields. */
function LockedCard({ connector }: { connector: EmailConnectorConfig }) {
  const reasons = gateReasons(connector.gate);
  const tier = typeof connector.gate.tier === "string" ? connector.gate.tier : null;
  return (
    <SectionCard title="Email delivery is a Pro feature" description="Built-in SMTP with test sends and a delivery log." icon={Lock}>
      <div className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
        <p>
          Upgrade this site to Pro or Ultimate to configure SMTP delivery from the console — provider presets, a
          write-only encrypted password, one-click test sends, and a redacted delivery log.
        </p>
        {tier ? (
          <p>
            Current plan: <span className="font-medium text-zinc-800 dark:text-zinc-200">{tier}</span>
          </p>
        ) : null}
        {reasons.length > 0 ? (
          <ul className="list-inside list-disc text-xs">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </SectionCard>
  );
}

/** Third-party SMTP plugin posture (fallback for non-connector sites). */
function PluginPostureCard({ plugin }: { plugin: EmailPluginPosture }) {
  const encSecure = plugin.encryption ? plugin.encryption.toLowerCase() !== "none" : null;
  return (
    <SectionCard title="SMTP delivery (plugin)" description="Read live from the active mail plugin." icon={PlugZap}>
      {plugin.configured ? (
        <dl className="grid gap-2 sm:grid-cols-2">
          <Row label="Plugin">
            <span className="font-mono text-[11px]">{plugin.plugin ?? "—"}</span>
          </Row>
          <Row label="Mailer">{plugin.mailer ?? "—"}</Row>
          <Row label="Host">
            <span className="font-mono text-[11px]">{plugin.host ?? "—"}</span>
          </Row>
          <Row label="Port">
            <span className="font-mono text-[11px]">{plugin.port != null ? String(plugin.port) : "—"}</span>
          </Row>
          <Row label="Encryption">
            {plugin.encryption ? (
              <span className={cn(PILL, encSecure ? TONE.good : TONE.warn, "uppercase")}>{plugin.encryption}</span>
            ) : (
              "—"
            )}
          </Row>
          <Row label="From">
            <span className="font-mono text-[11px]">{plugin.fromEmail ?? "—"}</span>
          </Row>
        </dl>
      ) : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {plugin.plugin ? (
            <>
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{plugin.plugin}</span> is active, but its
              configuration isn&apos;t readable over this channel.
            </>
          ) : (
            "No SMTP plugin configuration was detected."
          )}
        </p>
      )}
      <div className="mt-4">
        <Banner tone="info" icon={ServerCog}>
          Enroll the InfraWeaver Connector (Pro plan) to configure SMTP, run test sends and keep a delivery log directly
          from the console — no wp-admin round-trip.
        </Banner>
      </div>
    </SectionCard>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
      <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm text-zinc-900 dark:text-zinc-100">{children}</dd>
    </div>
  );
}

/** The delivery-source summary badge + the state sentence. */
function SourceHeader({ data }: { data: EmailData }) {
  const c = data.connector;
  const delivering = connectorDelivering(c);
  let badge: { tone: keyof typeof TONE; text: string };
  let line: string;
  if (data.source === "connector") {
    badge = delivering
      ? { tone: "good", text: "Connector SMTP · active" }
      : { tone: "neutral", text: "Connector SMTP" };
    line = c?.locked
      ? "This site can use InfraWeaver's built-in SMTP once it's on a Pro plan."
      : delivering
        ? "Mail is delivered through the connector's configured SMTP transport."
        : c?.configured
          ? "SMTP is configured but delivery is switched off — WordPress would fall back to PHP mail()."
          : "The connector can deliver mail; configure an SMTP host below to route it.";
  } else if (data.source === "plugin") {
    badge = { tone: "neutral", text: "Third-party plugin" };
    line = "Mail is handled by a third-party SMTP plugin.";
  } else {
    badge = { tone: "warn", text: "Not configured" };
    line = "This site has no SMTP delivery configured — WordPress uses PHP mail(), which is unavailable here.";
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className={cn(PILL, TONE[badge.tone])}>
        <Mail className="h-3.5 w-3.5" aria-hidden />
        {badge.text}
      </span>
      <p className="min-w-0 flex-1 text-sm text-zinc-600 dark:text-zinc-400">{line}</p>
    </div>
  );
}

/** The full connector surface (unlocked): setup → test → log → deliverability. */
function ConnectorSurface({ site, data }: { site: string; data: EmailData }) {
  const connector = data.connector!;
  const switchOff = connector.switch_on === false;
  return (
    <div className="space-y-5">
      {switchOff ? (
        <Banner tone="warn" icon={AlertTriangle}>
          Email delivery is <span className="font-medium">switched off</span> for this site. Settings save, but real
          mail falls back to PHP mail() until the delivery switch is turned back on.
        </Banner>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-2">
        <SectionCard title="Provider setup" description="Configure how this site sends mail." icon={ServerCog}>
          <EmailConfigForm site={site} connector={connector} />
        </SectionCard>

        <div className="space-y-5">
          <SectionCard title="Send a test" description="Verify delivery end to end." icon={Send}>
            <EmailTestBox site={site} connector={connector} />
          </SectionCard>
          <SectionCard title="Deliverability" description="SPF · DKIM · DMARC guidance." icon={ShieldCheck}>
            <EmailDeliverabilityCard settings={connector.settings} />
          </SectionCard>
        </div>
      </div>

      <SectionCard title="Delivery log" description="Recent sends and failures (bodies are never stored)." icon={Inbox}>
        <EmailLogTable site={site} log={data.log} />
      </SectionCard>
    </div>
  );
}

export function EmailPanel({ site }: { site: string }) {
  const state = useManagePanel<EmailData>(site, "email");

  return (
    <PanelState state={state}>
      {(data) => (
        <div className="space-y-5">
          <SectionCard title="How mail leaves this site" description="The delivery path in effect right now." icon={Mail}>
            <div className="space-y-3">
              <SourceHeader data={data} />
              {data.conflict ? (
                <Banner tone="warn" icon={AlertTriangle}>
                  Both the connector&apos;s SMTP and a third-party SMTP plugin
                  {data.plugin?.plugin ? ` (${data.plugin.plugin})` : ""} are active. The connector hooks{" "}
                  <span className="font-mono text-[11px]">phpmailer_init</span> at priority 1000 and wins — deactivate
                  the plugin or turn off connector email to avoid confusion.
                </Banner>
              ) : null}
            </div>
          </SectionCard>

          {data.connectorAvailable && data.connector ? (
            data.connector.locked ? (
              <LockedCard connector={data.connector} />
            ) : (
              <ConnectorSurface site={site} data={data} />
            )
          ) : data.plugin ? (
            <PluginPostureCard plugin={data.plugin} />
          ) : (
            <SectionCard title="No SMTP configured" icon={AlertTriangle}>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Enroll the InfraWeaver Connector (Pro plan) for built-in SMTP, or activate an SMTP plugin, to send
                reliable transactional email.
              </p>
            </SectionCard>
          )}
        </div>
      )}
    </PanelState>
  );
}
