"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { springs } from "@/lib/spring";

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  icon?: React.ElementType;
  title: string;
  description?: string;
  action?: EmptyStateAction | React.ReactNode;
  className?: string;
}

function isActionConfig(action: EmptyStateProps["action"]): action is EmptyStateAction {
  return !!action && typeof action === "object" && !React.isValidElement(action) && "label" in action && "onClick" in action;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  const renderedAction = React.isValidElement(action) ? (
    action
  ) : isActionConfig(action) ? (
    <motion.button
      type="button"
      onClick={action.onClick}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      transition={springs.snappy}
      className="mt-5 inline-flex h-9 cursor-pointer items-center rounded-lg border border-[#2a2a2a] bg-[#111] px-4 text-sm font-medium text-[#9e9e9e] hover:border-[#333] hover:text-[#f2f2f2] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111]"
    >
      {action.label}
    </motion.button>
  ) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.gentle}
      className={cn("flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#2a2a2a] bg-[#111] px-4 py-16 text-center", className)}
    >
      {Icon ? (
        <motion.div
          animate={{ y: [0, -5, 0] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
          className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] text-[#888]"
        >
          <Icon className="h-6 w-6" />
        </motion.div>
      ) : null}
      <h3 className="text-base font-medium text-[#f2f2f2]">{title}</h3>
      {description ? <p className="mt-2 max-w-sm text-sm leading-relaxed text-[#888]">{description}</p> : null}
      {renderedAction}
    </motion.div>
  );
}
