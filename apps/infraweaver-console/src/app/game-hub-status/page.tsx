"use client";

import { useEffect, useMemo, useState } from "react";

type PublicServerStatus = {
  name: string;
  status: "running" | "stopped" | "starting";
  uptimeSeconds: number | null;
};

type PublicStatusPayload = {
  overall: { total: number; healthy: number; degraded: number };
  servers: PublicServerStatus[];
  generatedAt: string;
};

function formatUptime(seconds: number | null) {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export default function PublicStatusPage() {
  const [data, setData] = useState<PublicStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const res = await fetch("/api/game-hub/public-status", { cache: "no-store" });
        const payload = await res.json() as PublicStatusPayload | { error?: string };
        if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to load status");
        if (mounted) {
          setData(payload as PublicStatusPayload);
          setError(null);
        }
      } catch (loadError) {
        if (mounted) setError(String(loadError));
      }
    };
    void load();
    const interval = setInterval(() => void load(), 30000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const summary = useMemo(() => data?.overall ?? { total: 0, healthy: 0, degraded: 0 }, [data]);

  return (
    <main className="min-h-screen bg-[#070b11] text-white">
      <div className="mx-auto max-w-5xl px-6 py-12 space-y-8">
        <div className="space-y-2">
          <p className="text-sm uppercase tracking-[0.3em] text-sky-300/70">InfraWeaver</p>
          <h1 className="text-4xl font-semibold">Public Status</h1>
          <p className="text-sm text-slate-400">Live platform health and public game server availability.</p>
        </div>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-5">
            <p className="text-xs uppercase tracking-widest text-emerald-200/70">Healthy apps</p>
            <p className="mt-2 text-3xl font-semibold text-emerald-100">{summary.healthy}</p>
          </div>
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-5">
            <p className="text-xs uppercase tracking-widest text-amber-200/70">Degraded apps</p>
            <p className="mt-2 text-3xl font-semibold text-amber-100">{summary.degraded}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-xs uppercase tracking-widest text-slate-400">Tracked apps</p>
            <p className="mt-2 text-3xl font-semibold text-white">{summary.total}</p>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <div>
              <h2 className="text-lg font-medium">Game Servers</h2>
              <p className="text-xs text-slate-400">Name, runtime status, and uptime only.</p>
            </div>
            {data?.generatedAt && (
              <span className="text-xs text-slate-500">Updated {new Date(data.generatedAt).toLocaleTimeString()}</span>
            )}
          </div>
          {error ? (
            <div className="px-5 py-10 text-sm text-red-300">{error}</div>
          ) : !data ? (
            <div className="px-5 py-10 text-sm text-slate-400">Loading status…</div>
          ) : data.servers.length === 0 ? (
            <div className="px-5 py-10 text-sm text-slate-400">No public game servers found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-black/20 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-5 py-3 text-left">Server</th>
                    <th className="px-5 py-3 text-left">Status</th>
                    <th className="px-5 py-3 text-left">Uptime</th>
                  </tr>
                </thead>
                <tbody>
                  {data.servers.map((server) => (
                    <tr key={server.name} className="border-t border-white/5">
                      <td className="px-5 py-3 font-mono text-slate-200">{server.name}</td>
                      <td className="px-5 py-3">
                        <span className={[
                          "inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize border",
                          server.status === "running"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                            : server.status === "starting"
                              ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                              : "border-slate-500/30 bg-slate-500/10 text-slate-300",
                        ].join(" ")}>
                          {server.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-300">{formatUptime(server.uptimeSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
