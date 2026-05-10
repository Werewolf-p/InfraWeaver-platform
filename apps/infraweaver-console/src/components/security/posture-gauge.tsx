"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface PostureGaugeProps {
  score: number;
  grade: string;
  trend?: "improving" | "declining" | "stable";
  previousScore?: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZES = {
  sm: { width: 120, height: 120, radius: 45, stroke: 8, fontSize: "text-2xl", subFontSize: "text-xs" },
  md: { width: 180, height: 180, radius: 70, stroke: 12, fontSize: "text-4xl", subFontSize: "text-sm" },
  lg: { width: 240, height: 240, radius: 95, stroke: 16, fontSize: "text-5xl", subFontSize: "text-base" },
};

function scoreColor(score: number): string {
  if (score < 40) return "#ef4444"; // red-500
  if (score < 70) return "#f97316"; // orange-500
  return "#22c55e"; // green-500
}

function scoreTrackColor(score: number): string {
  if (score < 40) return "rgba(239,68,68,0.15)";
  if (score < 70) return "rgba(249,115,22,0.15)";
  return "rgba(34,197,94,0.15)";
}

export function PostureGauge({
  score,
  grade,
  trend = "stable",
  previousScore,
  size = "md",
  className,
}: PostureGaugeProps) {
  const [animatedScore, setAnimatedScore] = useState(0);
  const cfg = SIZES[size];
  
  useEffect(() => {
    const timer = setTimeout(() => setAnimatedScore(score), 100);
    return () => clearTimeout(timer);
  }, [score]);
  
  const cx = cfg.width / 2;
  const cy = cfg.height / 2;
  const r = cfg.radius;
  
  // 240° arc: starts at 150° (bottom-left), ends at 30° (bottom-right)
  const startAngle = 150;
  const totalAngle = 240;
  const endAngle = startAngle + totalAngle;
  
  function polarToCart(angle: number) {
    const rad = (angle * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    };
  }
  
  function describeArc(startDeg: number, endDeg: number) {
    const s = polarToCart(startDeg);
    const e = polarToCart(endDeg);
    const largeArc = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e.x} ${e.y}`;
  }
  
  const trackPath = describeArc(startAngle, endAngle);
  const progressAngle = startAngle + (animatedScore / 100) * totalAngle;
  const progressPath = animatedScore > 0 ? describeArc(startAngle, Math.min(progressAngle, endAngle - 0.01)) : "";
  
  const trendIcon = trend === "improving" ? "↑" : trend === "declining" ? "↓" : "→";
  const trendColor = trend === "improving" ? "text-green-400" : trend === "declining" ? "text-red-400" : "text-slate-400";
  
  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <div className="relative" style={{ width: cfg.width, height: cfg.height }}>
        <svg width={cfg.width} height={cfg.height} viewBox={`0 0 ${cfg.width} ${cfg.height}`}>
          {/* Track */}
          <path
            d={trackPath}
            fill="none"
            stroke={scoreTrackColor(score)}
            strokeWidth={cfg.stroke}
            strokeLinecap="round"
          />
          {/* Progress */}
          {progressPath && (
            <motion.path
              d={progressPath}
              fill="none"
              stroke={scoreColor(score)}
              strokeWidth={cfg.stroke}
              strokeLinecap="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 1.2, ease: "easeOut" }}
            />
          )}
        </svg>
        {/* Center text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <motion.span
            className={cn("font-black tabular-nums", cfg.fontSize, score < 40 ? "text-red-400" : score < 70 ? "text-orange-400" : "text-green-400")}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3, duration: 0.5 }}
          >
            {grade}
          </motion.span>
          <motion.span
            className={cn("text-slate-400 tabular-nums font-mono", cfg.subFontSize)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            {Math.round(animatedScore)}/100
          </motion.span>
          {previousScore !== undefined && (
            <span className={cn("text-xs font-semibold", trendColor)}>
              {trendIcon} {Math.abs(score - previousScore)}pts
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <span className={cn("font-semibold", trendColor)}>{trendIcon}</span>
        <span className="text-slate-400">
          {trend === "improving" ? "Improving" : trend === "declining" ? "Declining" : "Stable"}
        </span>
      </div>
    </div>
  );
}
