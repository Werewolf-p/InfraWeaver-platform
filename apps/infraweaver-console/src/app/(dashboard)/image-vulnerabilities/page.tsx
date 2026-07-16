"use client";
import { motion } from "framer-motion";
import { Package, ShieldAlert, ShieldCheck, Boxes } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { useApiQuery } from "@/hooks/use-api-query";
import type { PinStatus, SupplyChainFinding, SupplyChainSummary } from "@/lib/images/supply-chain";
import type { ImageMatrixRow, VulnRollup } from "@/lib/images/vuln-rollup";

interface ImageIntel {
  supplyChain: { findings: SupplyChainFinding[]; summary: SupplyChainSummary };
  cve: { available: boolean; matrix: ImageMatrixRow[]; rollup: VulnRollup };
}

const PIN_META: Record<PinStatus, { label: string; className: string }> = {
  "pinned-digest": { label: "digest-pinned", className: "bg-green-500/10 text-green-400 border-green-500/20" },
  tagged: { label: "version tag", className: "bg-sky-500/10 text-sky-300 border-sky-500/20" },
  "mutable-tag": { label: "mutable tag", className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20" },
  "floating-latest": { label: ":latest", className: "bg-red-500/10 text-red-400 border-red-500/20" },
  "no-tag": { label: "no tag", className: "bg-red-500/10 text-red-400 border-red-500/20" },
};

const GRADE_TONE: Record<string, string> = { A: "text-green-400", B: "text-green-400", C: "text-yellow-400", D: "text-orange-400", F: "text-red-400" };

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-slate-100 p-4 text-center backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className={cn("mt-1 text-3xl font-bold", color ?? "text-gray-900 dark:text-white")}>{value}</p>
    </div>
  );
}

export default function ImageVulnerabilitiesPage() {
  const { data, isLoading } = useApiQuery<ImageIntel>({
    queryKey: ["security", "image-intel"],
    path: "/api/security/image-intel",
    staleTime: 120_000,
  });

  if (isLoading) return <div className="space-y-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-gray-100 dark:bg-white/5" />)}</div>;

  const sc = data?.supplyChain;
  const cve = data?.cve;
  const findings = sc?.findings ?? [];

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={ShieldCheck} title="Image Supply Chain" description="Pin-status integrity and CVE exposure for every running image" />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Supply-chain grade" value={sc?.summary.grade ?? "—"} color={GRADE_TONE[sc?.summary.grade ?? "A"]} />
        <StatCard label="Digest-pinned" value={sc?.summary.pinnedDigest ?? 0} color="text-green-400" />
        <StatCard label="Mutable / :latest" value={sc?.summary.mutableOrFloating ?? 0} color={(sc?.summary.mutableOrFloating ?? 0) > 0 ? "text-yellow-400" : "text-green-400"} />
        <StatCard label="Untrusted registry" value={sc?.summary.untrustedRegistry ?? 0} color={(sc?.summary.untrustedRegistry ?? 0) > 0 ? "text-red-400" : "text-green-400"} />
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-slate-100 backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <Boxes className="h-4 w-4 text-slate-400" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">Pin-status matrix</span>
          <span className="text-xs text-slate-500">{findings.length} images</span>
        </div>
        <table className="w-full">
          <tbody>
            {findings.map((f) => (
              <tr key={f.image} className="border-b border-gray-200 transition-colors hover:bg-gray-100 dark:border-white/5 dark:hover:bg-white/5">
                <td className="max-w-md truncate px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-300">{f.image}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{f.registry}{!f.trustedRegistry && <ShieldAlert className="ml-1 inline h-3 w-3 text-red-400" />}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{f.pods} pod{f.pods > 1 ? "s" : ""}</td>
                <td className="px-4 py-3 text-right">
                  <span className={cn("rounded-full border px-2 py-0.5 text-xs", PIN_META[f.pinStatus].className)}>{PIN_META[f.pinStatus].label}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {findings.length === 0 && <div className="py-10 text-center text-sm text-slate-500">No running images found</div>}
      </div>

      <div className="rounded-xl border border-gray-200 bg-slate-100 p-4 backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
        <div className="mb-3 flex items-center gap-2">
          <Package className="h-4 w-4 text-slate-400" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">CVE exposure</span>
        </div>
        {!cve?.available ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Trivy Operator is not installed — CVE data unavailable. Install trivy-operator to populate VulnerabilityReports.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              <StatCard label="Critical" value={cve.rollup.totals.critical} color="text-red-400" />
              <StatCard label="High" value={cve.rollup.totals.high} color="text-orange-400" />
              <StatCard label="Medium" value={cve.rollup.totals.medium} color="text-yellow-400" />
              <StatCard label="Low" value={cve.rollup.totals.low} color="text-slate-400" />
              <StatCard label="Coverage" value={`${cve.rollup.coveragePct}%`} />
              <StatCard label="Grade" value={cve.rollup.grade} color={GRADE_TONE[cve.rollup.grade]} />
            </div>
            {cve.rollup.worstOffenders.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold text-slate-500">Worst offenders (severity × replicas)</p>
                <ul className="space-y-1 text-xs">
                  {cve.rollup.worstOffenders.map((row) => (
                    <li key={row.image} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-slate-600 dark:text-slate-300">{row.image}</span>
                      <span className="shrink-0 text-slate-500">C{row.counts.critical} · H{row.counts.high} · {row.pods}×</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
