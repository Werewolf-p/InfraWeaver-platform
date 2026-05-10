"use client";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";

interface PieData {
  name: string;
  value: number;
  color: string;
}

interface StoragePieChartProps {
  data: PieData[];
  unit?: string;
  className?: string;
}

export function StoragePieChart({ data, unit = "Gi", className }: StoragePieChartProps) {
  const total = data.reduce((a, b) => a + b.value, 0);
  return (
    <div className={cn("bg-white/5 border border-white/10 rounded-xl p-4", className)}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-white">Storage by Class</span>
        <span className="text-xs text-slate-400">{Math.round(total * 10) / 10} {unit} total</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={55}
            outerRadius={85}
            paddingAngle={3}
            dataKey="value"
            isAnimationActive
            animationBegin={0}
            animationDuration={800}
          >
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.color} opacity={0.9} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", fontSize: "12px", color: "#e2e8f0" }}
            formatter={(v: unknown) => [`${Math.round((v as number) * 10) / 10} ${unit}`, ""]}
          />
          <Legend
            iconType="circle"
            iconSize={8}
            formatter={(value) => <span style={{ color: "#94a3b8", fontSize: "11px" }}>{value}</span>}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
