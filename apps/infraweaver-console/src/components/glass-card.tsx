"use client";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  glow?: boolean;
  onClick?: () => void;
}

export function GlassCard({ children, className, hover = true, glow = false, onClick }: GlassCardProps) {
  return (
    <motion.div
      whileHover={hover ? { scale: 1.005, y: -1 } : undefined}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      onClick={onClick}
      className={cn(
        "bg-gray-100 dark:bg-white/5 backdrop-blur-md border border-gray-200 dark:border-white/10 rounded-xl",
        "transition-all duration-200",
        hover && "hover:border-white/20 hover:shadow-lg hover:shadow-black/20",
        glow && "hover:shadow-[inset_0_0_20px_rgba(99,102,241,0.05),0_0_20px_rgba(99,102,241,0.1)]",
        onClick && "cursor-pointer",
        className
      )}
    >
      {children}
    </motion.div>
  );
}
