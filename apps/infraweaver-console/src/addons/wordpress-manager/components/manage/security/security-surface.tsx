"use client";

/**
 * The fused Site Security surface — ONE place to answer "is this site okay?".
 * It merges three sources into a single view (per the security-consent plan):
 *   1. wp-cli posture (the existing header-BLIND `probes/security.ts` checklist),
 *   2. signed connector telemetry (`security.scan` header grade + `protection.status`),
 *   3. signed connector configuration (`security.harden`, `consent.getConfig/setConfig`).
 *
 * `security.scan`'s live HTTP-header verdicts are merged OVER the wp-cli posture
 * list (`mergeSecurityPosture`) and folded into the score only when a live scan is
 * present; the surface degrades to posture-only when the connector is unreachable,
 * unlinked, or the tier doesn't grant `security_headers`. Connector-backed cards
 * gate through `TierGate` (never hide the upsell, never fake data).
 */

import type { ReactNode } from "react";
import { ShieldCheck, ShieldAlert, PlugZap } from "lucide-react";
import type { SecurityData } from "../../../lib/manage/probes/security";
import {
  mergeSecurityPosture,
  type HardeningConfig,
  type MergedPostureCheck,
} from "../../../lib/manage/security-consent";
import { HealthGauge, SectionCard } from "../../demo/widgets";
import { PostureCheck, PostureSummary } from "../../demo/manage/kit";
import { PanelState } from "../../demo/manage/panel-shell";
import { useManagePanel } from "../../demo/manage/use-manage";
import { useSiteEntitlements } from "../../../lib/manage/use-site-entitlements";
import { useConsentConfig, useProtectionStatus, useSecurityScan } from "../../../lib/manage/use-security";
import { TierGate } from "../kit/tier-gate";
import { HeaderGradeCard } from "./header-grade-card";
import { ConsentCard } from "./consent-card";
import { ProtectionStatusCard } from "./protection-status-card";

/** All-off hardening config used until the connector reports the stored one. */
const EMPTY_CONFIG: HardeningConfig = { hsts: false, nosniff: false, frame: "", referrer: "", permissions: false, csp: "off" };

/** Scary-first ordering for the fused checklist: critical → recommended → good. */
const STATE_ORDER: Readonly<Record<MergedPostureCheck["state"], number>> = { critical: 0, recommended: 1, good: 2 };

export function SecuritySurface({ site }: { site: string }): ReactNode {
  const posture = useManagePanel<SecurityData>(site, "security");
  const ent = useSiteEntitlements(site);

  const connectorReady = ent.connectorActive;
  const scan = useSecurityScan(site, connectorReady && ent.has("security_headers"));
  const status = useProtectionStatus(site, connectorReady);
  const consent = useConsentConfig(site, connectorReady && ent.has("cookie_consent"));

  const scanData = scan.data ?? null;
  const hardeningConfig = status.data?.security_headers.config ?? EMPTY_CONFIG;
  const detectedVendors = scanData && scanData.ok ? scanData.detected_vendors ?? [] : [];

  return (
    <div className="space-y-5">
      {/* Fused posture: wp-cli checklist + live header verdicts, one score. */}
      <PanelState state={posture}>
        {(data) => {
          const merged = mergeSecurityPosture(data, scanData);
          const sorted = [...merged.checks].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
          return (
            <div className="grid gap-5 lg:grid-cols-2">
              <SectionCard title="Security posture" description="Fuses server checks with live HTTP-header grades." icon={ShieldCheck}>
                <div className="flex items-center gap-5">
                  <HealthGauge score={merged.score} size={104} strokeWidth={9} label="posture" />
                  <PostureSummary good={merged.counts.good} recommended={merged.counts.recommended} critical={merged.counts.critical} />
                </div>
                {merged.headerGrade ? (
                  <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                    Live HTTP-header grade: <span className="font-semibold text-zinc-700 dark:text-zinc-200">{merged.headerGrade}</span>
                  </p>
                ) : null}
              </SectionCard>

              <SectionCard title="Administrator exposure" description="Full-access accounts on this site." icon={ShieldAlert}>
                <div className="flex h-full flex-col items-center justify-center gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <span className="text-4xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{data.adminCount}</span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    administrator account{data.adminCount === 1 ? "" : "s"}
                  </span>
                </div>
              </SectionCard>

              <SectionCard
                className="lg:col-span-2"
                title="Hardening checks"
                description={`${merged.checks.length} checks — server posture and live headers`}
                icon={ShieldCheck}
              >
                <ul className="grid gap-2 sm:grid-cols-2">
                  {sorted.map((check) => (
                    <PostureCheck
                      key={check.id}
                      state={check.state}
                      label={check.label}
                      detail={check.detail}
                      action={check.source === "headers" ? <span className="text-[10px] uppercase tracking-wide text-zinc-400">live</span> : undefined}
                    />
                  ))}
                </ul>
              </SectionCard>
            </div>
          );
        }}
      </PanelState>

      {/* Connector-backed surfaces — degrade honestly when the link isn't ready. */}
      {connectorReady ? (
        <div className="grid gap-5">
          <TierGate site={site} flag="security_headers">
            <HeaderGradeCard
              site={site}
              scan={scanData}
              scanLoading={scan.isPending}
              onRescan={() => void scan.refetch()}
              config={hardeningConfig}
            />
          </TierGate>

          <div className="grid gap-5 lg:grid-cols-2">
            <TierGate site={site} flag="cookie_consent">
              <ConsentCard site={site} consent={consent.data ?? null} loading={consent.isPending} detectedVendors={detectedVendors} />
            </TierGate>
            <ProtectionStatusCard site={site} status={status.data ?? null} loading={status.isPending} />
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
          <PlugZap className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden />
          <p className="text-zinc-600 dark:text-zinc-300">
            Connect this site&apos;s InfraWeaver connector to grade its HTTP security headers, one-click hardening, cookie consent, and
            content protection. The server-side posture checks above work without it.
          </p>
        </div>
      )}
    </div>
  );
}
