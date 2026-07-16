"use client";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Package, ShieldAlert, ShieldCheck, Boxes } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { AsyncBoundary, FilterSelect, HelpTooltip, SearchInput, SortableHeader } from "@/components/ui";
import { useApiQuery } from "@/hooks/use-api-query";
import type { PinStatus, SupplyChainFinding, SupplyChainSummary } from "@/lib/images/supply-chain";
import type { ImageMatrixRow, ScanCoverage, VulnRollup } from "@/lib/images/vuln-rollup";

interface ImageIntel {
  supplyChain: { findings: SupplyChainFinding[]; summary: SupplyChainSummary };
  cve: { available: boolean; matrix: ImageMatrixRow[]; rollup: VulnRollup; coverage: ScanCoverage };
}

const PIN_META: Record<PinStatus, { label: string; className: string; rank: number }> = {
  "pinned-digest": { label: "digest-pinned", className: "bg-green-500/10 text-green-500 dark:text-green-400 border-green-500/20", rank: 0 },
  tagged: { label: "version tag", className: "bg-sky-500/10 text-sky-600 dark:text-sky-300 border-sky-500/20", rank: 1 },
  "mutable-tag": { label: "mutable tag", className: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20", rank: 4 },
  "floating-latest": { label: ":latest", className: "bg-red-500/10 text-red-500 dark:text-red-400 border-red-500/20", rank: 6 },
  "no-tag": { label: "no tag", className: "bg-red-500/10 text-red-500 dark:text-red-400 border-red-500/20", rank: 6 },
};

const GRADE_TONE: Record<string, string> = { A: "text-green-500 dark:text-green-400", B: "text-green-500 dark:text-green-400", C: "text-yellow-600 dark:text-yellow-400", D: "text-orange-500 dark:text-orange-400", F: "text-red-500 dark:text-red-400" };

const PIN_FILTER_OPTIONS = [
  { value: "all", label: "All pin statuses" },
  { value: "at-risk", label: "Mutable / untrusted only" },
  { value: "pinned-digest", label: "Digest-pinned" },
  { value: "mutable-tag", label: "Mutable tag" },
  { value: "floating-latest", label: ":latest" },
  { value: "untrusted", label: "Untrusted registry" },
];

type SortKey = "risk" | "image" | "registry" | "pods" | "pin";

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-slate-100 p-4 text-center backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className={cn("mt-1 text-3xl font-bold", color ?? "text-gray-900 dark:text-white")}>{value}</p>
    </div>
  );
}

/** Actionable fix text for an at-risk image, or null when it is already safe. */
function remediation(f: SupplyChainFinding): string | null {
  const concerns: string[] = [];
  if (!f.trustedRegistry) {
    concerns.push(`Registry "${f.registry}" is not trusted (expected ghcr.io or the in-cluster mirror). Mirror this image into Zot and re-pull from there.`);
  }
  if (f.pinStatus === "floating-latest" || f.pinStatus === "no-tag") {
    concerns.push("A floating/untagged reference drifts silently. Pin to an immutable digest — reference the image as name@sha256:…");
  } else if (f.pinStatus === "mutable-tag") {
    concerns.push("A mutable tag can change under the same reference. Pin to an immutable digest (name@sha256:…) or a released version tag.");
  }
  return concerns.length > 0 ? concerns.join(" ") : null;
}

export default function ImageVulnerabilitiesPage() {
  const { data, isLoading, isError, refetch } = useApiQuery<ImageIntel>({
    queryKey: ["security", "image-intel"],
    path: "/api/security/image-intel",
    staleTime: 120_000,
  });

  const [query, setQuery] = useState("");
  const [pinFilter, setPinFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("risk");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sc = data?.supplyChain;
  const cve = data?.cve;
  const findings = useMemo(() => sc?.findings ?? [], [sc]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = findings.filter((f) => {
      if (needle && !f.image.toLowerCase().includes(needle) && !f.registry.toLowerCase().includes(needle)) return false;
      switch (pinFilter) {
        case "at-risk":
          return !f.trustedRegistry || f.pinStatus === "mutable-tag" || f.pinStatus === "floating-latest" || f.pinStatus === "no-tag";
        case "untrusted":
          return !f.trustedRegistry;
        case "all":
          return true;
        default:
          return f.pinStatus === pinFilter;
      }
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "image": return a.image.localeCompare(b.image) * dir;
        case "registry": return a.registry.localeCompare(b.registry) * dir;
        case "pods": return (a.pods - b.pods) * dir;
        case "pin": return (PIN_META[a.pinStatus].rank - PIN_META[b.pinStatus].rank) * dir;
        default: return (a.risk - b.risk) * dir;
      }
    });
  }, [findings, query, pinFilter, sortKey, sortDir]);

  const onSort = (key: string) => {
    const k = key as SortKey;
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(k === "image" || k === "registry" ? "asc" : "desc");
    }
  };

  const jumpToImage = (image: string) => {
    setQuery(image);
    setPinFilter("all");
    if (typeof document !== "undefined") {
      const prefersReduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("pin-status-matrix")?.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "start" });
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={ShieldCheck} title="Image Supply Chain" description="Pin-status integrity and CVE exposure for every running image" />

      <AsyncBoundary
        isLoading={isLoading}
        isError={isError}
        isEmpty={!isLoading && !isError && findings.length === 0}
        onRetry={() => refetch()}
        emptyTitle="No running images found"
      >
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Supply-chain grade" value={sc?.summary.grade ?? "—"} color={GRADE_TONE[sc?.summary.grade ?? "A"]} />
        <StatCard label="Digest-pinned" value={sc?.summary.pinnedDigest ?? 0} color="text-green-500 dark:text-green-400" />
        <StatCard label="Mutable / :latest" value={sc?.summary.mutableOrFloating ?? 0} color={(sc?.summary.mutableOrFloating ?? 0) > 0 ? "text-yellow-600 dark:text-yellow-400" : "text-green-500 dark:text-green-400"} />
        <StatCard label="Untrusted registry" value={sc?.summary.untrustedRegistry ?? 0} color={(sc?.summary.untrustedRegistry ?? 0) > 0 ? "text-red-500 dark:text-red-400" : "text-green-500 dark:text-green-400"} />
      </div>

      <div id="pin-status-matrix" className="scroll-mt-4 overflow-hidden rounded-xl border border-gray-200 bg-slate-100 backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <Boxes className="h-4 w-4 text-slate-400" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">Pin-status matrix</span>
          <span className="text-xs text-slate-500">{visible.length} of {findings.length} images</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search image or registry…" value={query} onChange={setQuery} className="w-full sm:w-56" />
            <FilterSelect label="Filter by pin status" value={pinFilter} options={PIN_FILTER_OPTIONS} onChange={setPinFilter} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 dark:border-white/10">
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400"><SortableHeader label="Image" sortKey="image" activeKey={sortKey} direction={sortDir} onSort={onSort} /></th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400"><SortableHeader label="Registry" sortKey="registry" activeKey={sortKey} direction={sortDir} onSort={onSort} /></th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400"><SortableHeader label="Pods" sortKey="pods" activeKey={sortKey} direction={sortDir} onSort={onSort} /></th>
                <th className="px-4 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400"><SortableHeader label="Pin status" sortKey="pin" activeKey={sortKey} direction={sortDir} onSort={onSort} className="justify-end" /></th>
                <th className="px-2 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400"><span className="sr-only">Remediation</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((f) => {
                const fix = remediation(f);
                return (
                  <tr key={f.image} className={cn("border-b border-gray-200 transition-colors hover:bg-gray-100 dark:border-white/5 dark:hover:bg-white/5", (f.pinStatus === "floating-latest" || f.pinStatus === "no-tag" || !f.trustedRegistry) && "bg-red-500/[0.03] dark:bg-red-500/5")}>
                    <td className="max-w-md truncate px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-300" title={f.image}>{f.image}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{f.registry}{!f.trustedRegistry && <ShieldAlert className="ml-1 inline h-3 w-3 text-red-500 dark:text-red-400" aria-label="untrusted registry" />}</td>
                    <td className="px-4 py-3 text-xs text-slate-500 tabular-nums">{f.pods} pod{f.pods > 1 ? "s" : ""}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={cn("rounded-full border px-2 py-0.5 text-xs", PIN_META[f.pinStatus].className)}>{PIN_META[f.pinStatus].label}</span>
                    </td>
                    <td className="px-2 py-3 text-right">{fix ? <HelpTooltip>{fix}</HelpTooltip> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && <div className="py-10 text-center text-sm text-slate-500">{findings.length === 0 ? "No running images found" : "No images match these filters"}</div>}
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
              <StatCard label="Critical" value={cve.rollup.totals.critical} color="text-red-500 dark:text-red-400" />
              <StatCard label="High" value={cve.rollup.totals.high} color="text-orange-500 dark:text-orange-400" />
              <StatCard label="Medium" value={cve.rollup.totals.medium} color="text-yellow-600 dark:text-yellow-400" />
              <StatCard label="Low" value={cve.rollup.totals.low} color="text-slate-400" />
              <StatCard label="Coverage" value={`${cve.rollup.coveragePct}%`} />
              <StatCard label="Grade" value={cve.rollup.grade} color={GRADE_TONE[cve.rollup.grade]} />
            </div>
            {(cve.coverage.unscanned.length > 0 || cve.coverage.staleScans.length > 0) && (
              <p className="text-xs text-slate-500">
                Scan blind spots: <span className="text-red-500 dark:text-red-400">{cve.coverage.unscanned.length} unscanned</span> · <span className="text-yellow-600 dark:text-yellow-400">{cve.coverage.staleScans.length} stale</span> (&gt;24h)
              </p>
            )}
            {cve.rollup.worstOffenders.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold text-slate-500">Worst offenders (severity × replicas)</p>
                <ul className="space-y-1 text-xs">
                  {cve.rollup.worstOffenders.map((row) => (
                    <li key={row.image} className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => jumpToImage(row.image)}
                        className="min-w-0 truncate rounded text-left font-mono text-slate-600 underline decoration-dotted underline-offset-2 hover:text-gray-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-[#3b82f6] dark:text-slate-300 dark:hover:text-white"
                        title={`Show ${row.image} in the pin-status matrix`}
                      >
                        {row.image}
                      </button>
                      <span className="flex shrink-0 items-center gap-2 text-slate-500">
                        {row.namespaces.length > 0 ? <span className="hidden sm:inline text-slate-400 dark:text-slate-500">{row.namespaces.slice(0, 2).join(", ")}{row.namespaces.length > 2 ? "…" : ""}</span> : null}
                        <span className="tabular-nums">C{row.counts.critical} · H{row.counts.high} · {row.pods}×</span>
                        <HelpTooltip>
                          {`Running in ${row.namespaces.length > 0 ? row.namespaces.join(", ") : "unknown namespace"}. ${row.counts.critical} critical / ${row.counts.high} high across ${row.pods} pod(s). Patch the base image or bump to a fixed version, then re-pin to an immutable digest.`}
                        </HelpTooltip>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
      </AsyncBoundary>
    </motion.div>
  );
}
