"use client";
import { useState, useRef, ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { RefreshCw } from "lucide-react";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  className?: string;
}

export function PullToRefresh({ onRefresh, children, className }: PullToRefreshProps) {
  const [pullY, setPullY] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const pulling = useRef(false);

  const THRESHOLD = 60;

  const onTouchStart = (e: React.TouchEvent) => {
    startY.current = e.touches[0].clientY;
    pulling.current = true;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!pulling.current || refreshing) return;
    const delta = e.touches[0].clientY - startY.current;
    if (delta > 0) setPullY(Math.min(delta * 0.5, 80));
  };

  const onTouchEnd = async () => {
    pulling.current = false;
    if (pullY >= THRESHOLD && !refreshing) {
      setRefreshing(true);
      setPullY(THRESHOLD);
      await onRefresh();
      setRefreshing(false);
    }
    setPullY(0);
  };

  return (
    <div
      className={className}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <AnimatePresence>
        {pullY > 10 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: pullY }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center justify-center overflow-hidden"
          >
            <motion.div
              animate={{ rotate: refreshing ? 360 : pullY * 4 }}
              transition={refreshing ? { repeat: Infinity, duration: 0.8, ease: "linear" } : {}}
            >
              <RefreshCw className={`w-5 h-5 ${pullY >= THRESHOLD ? "text-indigo-400" : "text-slate-500"}`} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {children}
    </div>
  );
}
