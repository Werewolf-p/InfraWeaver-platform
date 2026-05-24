"use client";

import { Line, LineChart, ResponsiveContainer } from "recharts";

interface Props {
  data: Array<{ value: number }>;
  color: string;
}

export function MetricCardSparkline({ data, color }: Props) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
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
  );
}
