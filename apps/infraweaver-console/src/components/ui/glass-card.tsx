"use client";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  glow?: boolean;
  rainbow?: boolean;
  interactive?: boolean;
  hover?: boolean;
  onClick?: () => void;
}

export function GlassCard({
  children,
  className,
  glow = false,
  rainbow = false,
  interactive = false,
  hover = true,
  onClick,
}: GlassCardProps) {
  const isClickable = onClick || interactive;

  return (
    <motion.div
      whileHover={interactive || hover ? { scale: 1.005, y: -1 } : undefined}
      whileTap={isClickable ? { scale: 0.995 } : undefined}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      onClick={onClick}
      className={cn(
        "relative rounded-xl border transition-all duration-200",
        "bg-white/[0.03] backdrop-blur-[16px]",
        "border-white/[0.08]",
        !rainbow && "hover:border-white/[0.16]",
        hover && "hover:shadow-lg hover:shadow-black/20",
        glow && "hover:shadow-[0_0_30px_rgba(16,185,129,0.15)] hover:border-emerald-500/20",
        rainbow && "rainbow-border",
        isClickable && "cursor-pointer",
        className
      )}
    >
      {children}
    </motion.div>
  );
}
