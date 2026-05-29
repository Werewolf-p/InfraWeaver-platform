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
  secondaryAction?: EmptyStateAction | React.ReactNode;
  className?: string;
}

function isActionConfig(action: EmptyStateProps["action"]): action is EmptyStateAction {
  return !!action && typeof action === "object" && !React.isValidElement(action) && "label" in action && "onClick" in action;
}

export function EmptyState({ icon: Icon, title, description, action, secondaryAction, className }: EmptyStateProps) {
  const renderedAction = React.isValidElement(action) ? (
    action
  ) : isActionConfig(action) ? (
    <motion.button
      type="button"
      onClick={action.onClick}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      transition={springs.snappy}
      className="inline-flex min-h-[40px] cursor-pointer items-center rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#2f72e0] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#111] touch-manipulation"
    >
      {action.label}
    </motion.button>
  ) : null;

  const renderedSecondaryAction = React.isValidElement(secondaryAction) ? (
    secondaryAction
  ) : isActionConfig(secondaryAction) ? (
    <motion.button
      type="button"
      onClick={secondaryAction.onClick}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      transition={springs.snappy}
      className="inline-flex min-h-[40px] cursor-pointer items-center rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 text-sm font-medium text-gray-500 dark:text-[#9e9e9e] hover:border-[#333] hover:text-gray-900 dark:hover:text-[#f2f2f2] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111] touch-manipulation"
    >
      {secondaryAction.label}
    </motion.button>
  ) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.gentle}
      role="status"
      className={cn("flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-16 text-center", className)}
    >
      {Icon ? (
        <motion.div
          animate={{ y: [0, -5, 0] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
          className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0f0f0f] text-gray-500 dark:text-[#888]"
          aria-hidden="true"
        >
          <Icon className="h-6 w-6" />
        </motion.div>
      ) : null}
      <h3 className="text-base font-medium text-gray-900 dark:text-[#f2f2f2]">{title}</h3>
      {description ? <p className="mt-2 max-w-sm text-sm leading-relaxed text-gray-500 dark:text-[#888]">{description}</p> : null}
      {(renderedAction || renderedSecondaryAction) ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {renderedAction}
          {renderedSecondaryAction}
        </div>
      ) : null}
    </motion.div>
  );
}
