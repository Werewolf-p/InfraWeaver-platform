"use client";

import { motion } from "framer-motion";
import { Bug, ScanSearch, ShieldCheck, ShieldX } from "lucide-react";
import { cn } from "@/lib/utils";
import { DummyBadge } from "./DummyBadge";
import { riseItem, staggerContainer } from "./motion";
import { AnimatedNumber, SectionCard, SeverityBadge, StatTile, healthTone } from "./widgets";
import { CveSeverityBar, MalwareDonut, WafAreaChart } from "./charts";
import { MALWARE_SCAN, SEVERITY_COUNTS, VULNERABILITIES, WAF_TREND } from "./dummy-data";

export function FleetSecurity() {
  const wafTotal = WAF_TREND.reduce((n, p) => n + p.blocked, 0);
  const openCves = VULNERABILITIES.length;
  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      <motion.div variants={riseItem} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Clean scans" value={MALWARE_SCAN.clean} suffix={`/${MALWARE_SCAN.clean + MALWARE_SCAN.flagged}`} icon={ShieldCheck} tone={healthTone(92)} />
        <StatTile label="Flagged sites" value={MALWARE_SCAN.flagged} icon={ShieldX} tone={healthTone(40)} positiveIsGood={false} delta={0} />
        <StatTile label="Requests blocked (24h)" value={wafTotal} icon={Bug} tone={healthTone(70)} delta={12} positiveIsGood />
        <StatTile label="Open CVEs" value={openCves} icon={ScanSearch} tone={healthTone(55)} delta={-2} positiveIsGood />
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <motion.div variants={riseItem}>
          <SectionCard title="Malware scan" description="Latest full-fleet scan result." icon={ScanSearch} action={<DummyBadge />}>
            <MalwareDonut clean={MALWARE_SCAN.clean} flagged={MALWARE_SCAN.flagged} />
            <div className="mt-3 flex justify-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden /> {MALWARE_SCAN.clean} clean
              </span>
              <span className="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden /> {MALWARE_SCAN.flagged} flagged
              </span>
            </div>
          </SectionCard>
        </motion.div>

        <motion.div variants={riseItem}>
          <SectionCard title="Firewall activity" description="Malicious requests blocked at the edge over the last 24 hours." icon={ShieldCheck} action={<DummyBadge />}>
            <div className="mb-3 flex items-baseline gap-2">
              <AnimatedNumber value={wafTotal} className="text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100" />
              <span className="text-sm text-zinc-600 dark:text-zinc-400">requests blocked</span>
            </div>
            <WafAreaChart data={WAF_TREND} />
          </SectionCard>
        </motion.div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.6fr]">
        <motion.div variants={riseItem}>
          <SectionCard title="Vulnerabilities by severity" description="Open advisories across all managed components." icon={Bug} action={<DummyBadge />}>
            <CveSeverityBar counts={SEVERITY_COUNTS} />
            <div className="mt-3 grid grid-cols-2 gap-2">
              {(["critical", "high", "medium", "low"] as const).map((severity) => (
                <div key={severity} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <SeverityBadge severity={severity} />
                  <span className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{SEVERITY_COUNTS[severity]}</span>
                </div>
              ))}
            </div>
          </SectionCard>
        </motion.div>

        <motion.div variants={riseItem}>
          <SectionCard title="Vulnerability feed" description="Component-level CVEs detected across the fleet." icon={ScanSearch} action={<DummyBadge />}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead>
                  <tr className="text-xs text-zinc-500 dark:text-zinc-400">
                    <th className="pb-2 font-medium">Component</th>
                    <th className="pb-2 font-medium">Severity</th>
                    <th className="pb-2 font-medium">CVE</th>
                    <th className="pb-2 font-medium">Site</th>
                    <th className="pb-2 font-medium">Fix</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {VULNERABILITIES.map((v) => (
                    <tr key={v.id} className="text-zinc-800 dark:text-zinc-200">
                      <td className="py-2.5">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">{v.component}</span>
                        <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-400">v{v.version}</span>
                      </td>
                      <td className="py-2.5"><SeverityBadge severity={v.severity} /></td>
                      <td className="py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">{v.cve}</td>
                      <td className="py-2.5 text-xs">{v.site}</td>
                      <td className="py-2.5">
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", v.patchAvailable ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300")}>
                          {v.patchAvailable ? "Patch ready" : "No fix yet"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </motion.div>
      </div>
    </motion.div>
  );
}
