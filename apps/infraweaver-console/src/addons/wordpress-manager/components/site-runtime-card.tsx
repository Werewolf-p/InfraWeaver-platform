"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Database, FileText, Flame, Globe2, Loader2, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRBAC } from "@/hooks/useRBAC";
import { AppFirewallPanel } from "@/app/(dashboard)/network/firewall/_components/app-firewall-panel";
import type { SiteComponent, SitePod } from "../lib/site-pods";

interface SitePodsResponse {
  site: string;
  namespace: string;
  pods: SitePod[];
}

const COMPONENT_LABEL: Record<SiteComponent, string> = {
  wordpress: "WordPress",
  db: "Database",
  other: "Other",
};

const COMPONENT_ICON: Record<SiteComponent, typeof Server> = {
  wordpress: Globe2,
  db: Database,
  other: Server,
};

async function fetchSitePods(site: string): Promise<SitePodsResponse> {
  const res = await fetch(`/api/wordpress/sites/${site}/pods`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to load site pods");
  return res.json();
}

/**
 * The site as an app: every pod behind it (WordPress + MariaDB) with a
 * zoom-in to logs, plus the same per-pod firewall surface the fleet-wide
 * /network/firewall page offers — blocked traffic, one-click allows, and
 * active exceptions — scoped to just this site's pods.
 */
export function SiteRuntimeCard({ site }: { site: string }) {
  const { can } = useRBAC();
  // The firewall APIs are cluster-scoped (Hubble denials + CiliumNetworkPolicy),
  // so only render the panel for users who can actually read that data.
  const canSeeFirewall = can("cluster:read");

  const { data, isLoading, error } = useQuery({
    queryKey: ["wordpress-site-pods", site],
    queryFn: () => fetchSitePods(site),
    refetchInterval: 15_000,
  });

  const pods = data?.pods ?? [];

  return (
    <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-center gap-2 text-zinc-200">
        <Server className="h-5 w-5 text-sky-400" aria-hidden />
        <h2 className="text-lg font-medium">Pods & firewall</h2>
      </div>
      <p className="mt-1 text-sm text-zinc-400">
        Everything this site runs on — its WordPress and database pods — and what the pod firewall is blocking for
        them.
      </p>

      {isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading pods…
        </div>
      ) : error ? (
        <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          Could not load this site&apos;s pods: {error instanceof Error ? error.message : "unknown error"}
        </p>
      ) : pods.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">No pods are running for this site yet.</p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                <th className="px-3 py-2 text-left font-medium">Pod</th>
                <th className="px-3 py-2 text-left font-medium">Component</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Restarts</th>
                <th className="px-3 py-2 text-right font-medium">Logs</th>
              </tr>
            </thead>
            <tbody>
              {pods.map((pod) => {
                const Icon = COMPONENT_ICON[pod.component];
                return (
                  <tr key={pod.name} className="border-b border-zinc-800/60 last:border-0">
                    <td className="max-w-[260px] truncate px-3 py-2 font-mono text-zinc-200">{pod.name}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 text-zinc-300">
                        <Icon className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
                        {COMPONENT_LABEL[pod.component]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-xs",
                          pod.ready
                            ? "border-green-500/30 bg-green-500/15 text-green-300"
                            : "border-amber-500/30 bg-amber-500/15 text-amber-300",
                        )}
                      >
                        {pod.status}
                      </span>
                    </td>
                    <td className={cn("px-3 py-2", pod.restarts > 5 ? "text-amber-300" : "text-zinc-400")}>
                      {pod.restarts}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/logs?namespace=${encodeURIComponent(data?.namespace ?? "wordpress")}&pod=${encodeURIComponent(pod.name)}`}
                        className="inline-flex items-center gap-1 rounded-md border border-sky-500/20 bg-sky-500/10 px-2 py-1 text-xs text-sky-200 transition hover:bg-sky-500/20"
                      >
                        <FileText className="h-3 w-3" aria-hidden />
                        Logs
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pods.length > 0 && (
        <div className="mt-5">
          <div className="mb-3 flex items-center gap-2 text-zinc-200">
            <Flame className="h-4 w-4 text-orange-400" aria-hidden />
            <h3 className="text-sm font-medium">Firewall — blocked traffic & exceptions</h3>
          </div>
          {canSeeFirewall ? (
            <AppFirewallPanel namespace={data?.namespace ?? "wordpress"} podNames={pods.map((pod) => pod.name)} />
          ) : (
            <p className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-sm text-zinc-500">
              Viewing blocked traffic needs cluster read access — ask an operator to grant it if you need the
              firewall view for this site.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
