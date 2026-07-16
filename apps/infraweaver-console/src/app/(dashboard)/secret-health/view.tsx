"use client";

import { useState } from "react";
import { AlertTriangle, KeyRound, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ConfirmDialog,
  KubeOfflineBanner,
  PageScaffold,
  RefreshButton,
  SingleClusterGuard,
} from "@/components/ui";
import { useApiMutation, useApiQuery } from "@/hooks/use-api-query";
import { useRBAC } from "@/hooks/use-rbac";
import { queryKeys } from "@/lib/query-keys";
import { SEVERITY_META, type SecretLifecycleReport } from "@/lib/secrets/lifecycle-types";
import { SecretHealthSummary } from "@/components/secrets/secret-health-summary";
import { TokenExpiryCard } from "@/components/secrets/token-expiry-card";
import { EsLifecycleTable } from "@/components/secrets/eso-lifecycle-table";
import { CatalogCoverageTable } from "@/components/secrets/catalog-coverage-table";
import { PublicMirrorCard } from "@/components/secrets/public-mirror-card";

const REMINT_CONFIRM_WORD = "remint";

function SectionTitle({ icon: Icon, title, subtitle }: { icon: typeof KeyRound; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
      <div>
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
        {subtitle ? <p className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</p> : null}
      </div>
    </div>
  );
}

export function SecretHealthView() {
  const { can } = useRBAC();
  const canRemediate = can("cluster:admin");
  const [remintOpen, setRemintOpen] = useState(false);

  const { data, isLoading, isFetching, refetch, isError, error } = useApiQuery<SecretLifecycleReport>({
    queryKey: queryKeys.secrets.lifecycle(),
    path: "/api/secrets/lifecycle",
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const remint = useApiMutation<{ ok: boolean }, void>({
    path: "/api/secrets/lifecycle/remint-token",
    successMessage: "ESO token re-minted and written to the secret",
    invalidateQueryKeys: [queryKeys.secrets.lifecycle()],
    onSuccess: () => setRemintOpen(false),
  });

  const writeEnabled = data?.remediationWriteEnabled ?? false;

  return (
    <SingleClusterGuard>
      <PageScaffold
        icon={ShieldAlert}
        title="Secret Health"
        description="OpenBao token TTL, ExternalSecret sync and Retain traps, catalog key coverage, ArgoCD correlation, and public-mirror status — with gated remediation."
        actions={<RefreshButton onClick={() => void refetch()} refreshing={isFetching} />}
        loading={isLoading}
        isError={isError}
        errorDetail={error?.message}
      >
        {data ? (
          <div className="space-y-6">
            {/* Severity banner */}
            <div className={cn("flex items-center gap-3 rounded-2xl border px-4 py-3", SEVERITY_META[data.severity].badgeClass)}>
              <span className={cn("h-2.5 w-2.5 rounded-full", SEVERITY_META[data.severity].dotClass)} aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold">Secret &amp; GitOps lifecycle: {SEVERITY_META[data.severity].label}</p>
                <p className="text-xs opacity-80">
                  {data.externalSecrets.notReady} not-ready · {data.externalSecrets.retainTraps} retain trap(s) · {data.catalogCoverage.totalMissing} missing key(s)
                </p>
              </div>
            </div>

            <KubeOfflineBanner
              show={data.externalSecrets.available === false}
              resource="ExternalSecret data"
              hint="Check cluster connectivity and the external-secrets.io CRDs."
            />

            <SecretHealthSummary showLink={false} />

            <div className="grid gap-6 lg:grid-cols-2">
              <TokenExpiryCard token={data.token} canRemediate={canRemediate} />
              <PublicMirrorCard status={data.publicMirror} canRemediate={canRemediate} />
            </div>

            {/* OpenBao seal */}
            <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-5">
              <SectionTitle icon={KeyRound} title="OpenBao Status" />
              {data.openbao.available ? (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-4">
                  <div><dt className="text-slate-500">Sealed</dt><dd className={data.openbao.sealed ? "text-red-400 font-semibold" : "text-green-400"}>{data.openbao.sealed ? "Yes" : "No"}</dd></div>
                  <div><dt className="text-slate-500">Initialized</dt><dd>{data.openbao.initialized ? "Yes" : "No"}</dd></div>
                  <div><dt className="text-slate-500">Standby</dt><dd>{data.openbao.standby ? "Yes" : "No"}</dd></div>
                  <div><dt className="text-slate-500">Version</dt><dd className="font-mono">{data.openbao.version}</dd></div>
                </dl>
              ) : (
                <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">OpenBao seal status unavailable.</p>
              )}
            </div>

            {/* ArgoCD correlation */}
            {data.argoCorrelations.length > 0 ? (
              <div className="space-y-3">
                <SectionTitle icon={AlertTriangle} title="ArgoCD is red because of secrets" subtitle="Degraded / OutOfSync apps with not-Ready ExternalSecrets in their namespace" />
                <div className="space-y-2">
                  {data.argoCorrelations.map((corr) => (
                    <div key={corr.app} className="rounded-xl border border-orange-500/20 bg-orange-500/5 px-4 py-3 text-sm">
                      <p className="font-medium text-gray-900 dark:text-white">{corr.app} <span className="text-xs text-slate-500">({corr.namespace})</span></p>
                      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{corr.health} / {corr.sync} — not ready: {corr.notReadyExternalSecrets.join(", ")}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* ExternalSecret lifecycle */}
            <div className="space-y-3">
              <SectionTitle icon={KeyRound} title="ExternalSecrets" subtitle="Readiness, deletionPolicy, Retain traps, and missing keys" />
              <EsLifecycleTable items={data.externalSecrets.items} canRemediate={canRemediate} />
            </div>

            {/* Catalog coverage */}
            <div className="space-y-3">
              <SectionTitle icon={KeyRound} title="Catalog key coverage" subtitle="Declared vs seeded vs referenced per enabled catalog app" />
              <CatalogCoverageTable items={data.catalogCoverage.items} canRemediate={canRemediate} writeEnabled={writeEnabled} />
            </div>

            {/* Danger zone: gated re-mint */}
            {canRemediate ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5">
                <SectionTitle icon={AlertTriangle} title="Danger zone" subtitle="High-risk remediation, disabled unless SECRET_REMEDIATION_WRITE_ENABLED=true" />
                <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
                  Re-mint the ESO token: mints a new periodic OpenBao token and writes it straight into the ExternalSecrets token secret server-side. The token value is never shown.
                </p>
                <button
                  type="button"
                  onClick={() => setRemintOpen(true)}
                  disabled={!writeEnabled || remint.isPending}
                  className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
                  title={writeEnabled ? "Re-mint the ESO token" : "Set SECRET_REMEDIATION_WRITE_ENABLED=true to enable"}
                >
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  {writeEnabled ? "Re-mint ESO token" : "Re-mint (disabled)"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </PageScaffold>

      <ConfirmDialog
        open={remintOpen}
        onConfirm={() => remint.mutate()}
        onCancel={() => setRemintOpen(false)}
        title="Re-mint the ESO OpenBao token?"
        description="This creates a new periodic token and overwrites the ExternalSecrets token secret. ExternalSecrets re-authenticate on their next sync. Irreversible."
        confirmText={remint.isPending ? "Re-minting…" : "Re-mint token"}
        danger
        requireTyping={REMINT_CONFIRM_WORD}
      />
    </SingleClusterGuard>
  );
}
