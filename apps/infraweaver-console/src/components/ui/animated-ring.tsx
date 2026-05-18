"use client";
import { motion } from "framer-motion";

interface AnimatedRingProps {
  value: number; // 0-100
  size?: number;
  strokeWidth?: number;
  color?: string;
  label?: string;
  sublabel?: string;
}

export function AnimatedRing({
  value,
  size = 80,
  strokeWidth = 6,
  color = "#0078D4",
  label,
  sublabel,
}: AnimatedRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.05)"
          strokeWidth={strokeWidth}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference - (value / 100) * circumference }}
          transition={{ type: "spring", stiffness: 260, damping: 24, mass: 1, duration: 1.2 }}
        />
      </svg>
      {label && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-gray-900 dark:text-[#f2f2f2]">{label}</span>
          {sublabel && <span className="text-[10px] text-gray-400 dark:text-[#666]">{sublabel}</span>}
        </div>
      )}
    </div>
  );
}
