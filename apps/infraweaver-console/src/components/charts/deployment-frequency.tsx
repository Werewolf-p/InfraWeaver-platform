"use client";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface Event { appName: string; phase: string; startedAt: string; }
interface Props { events: Event[]; }

export function DeploymentFrequencyChart({ events }: Props) {
  const now = Date.now();
  const days: Record<string, number> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    days[d.toISOString().slice(0, 10)] = 0;
  }
  events.forEach(e => {
    const d = e.startedAt ? e.startedAt.slice(0, 10) : "";
    if (d in days) days[d]++;
  });
  const data = Object.entries(days).map(([date, count]) => ({ date: date.slice(5), count }));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
        <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 10 }} interval={6} />
        <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} />
        <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} />
        <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
