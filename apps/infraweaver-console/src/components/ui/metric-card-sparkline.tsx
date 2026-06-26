"use client";

import { Line, LineChart, ResponsiveContainer } from "recharts";

interface Props {
  data: Array<{ value: number }>;
  color: string;
  label: string;
}

export function MetricCardSparkline({ data, color, label }: Props) {
  return (
    <div role="img" aria-label={label} style={{ width: "100%", height: "100%" }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} aria-hidden="true">
          <Line
            dataKey="value"
            type="monotone"
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
