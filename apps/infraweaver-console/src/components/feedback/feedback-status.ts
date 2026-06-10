import { Bug, Lightbulb, StickyNote } from "lucide-react";

import { internalHost } from "@/lib/domain";

/**
 * Shared status/type vocabulary for the Developer Feedback review surface.
 *
 * Extracted from `feedback-review.tsx` so the board, the legend/stepper, and the
 * status pill all speak the same plain-language dialect. UI-only: these mirror
 * the backend `FeedbackStatus`/`FeedbackType` in `@/lib/feedback-store` and must
 * stay in sync with it (read-only contract — this file never changes the state
 * machine).
 */

export type FeedbackType = "bug" | "feature-request" | "note";
export type FeedbackStatus = "new" | "approved" | "dispatched" | "accepted" | "done" | "rejected";

/**
 * Fallback "test it here" target. Fixes now ship straight to the LIVE console
 * (the dispatch /approve bumps the prod image pin and ArgoCD rolls it out), so
 * this points at the live console rather than a separate preview/staging env.
 */
export const STAGING_ENV_URL = `https://${internalHost("infraweaver")}`;

export const TYPE_ICON: Record<FeedbackType, typeof Bug> = {
  bug: Bug,
  "feature-request": Lightbulb,
  note: StickyNote,
};

export const STATUS_STYLE: Record<FeedbackStatus, string> = {
  new: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
  approved: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  dispatched: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  accepted: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  done: "bg-gray-100 text-gray-600 dark:bg-[#222] dark:text-[#aaa]",
  rejected: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
};

export interface StatusCopy {
  /** Short plain-language label shown on the pill. */
  label: string;
  /** One-line explanation of what this status means for the reviewer. */
  hint: string;
}

/** Plain-language wording so a non-expert sees where each entry is. */
export const STATUS_COPY: Record<FeedbackStatus, StatusCopy> = {
  new: { label: "Awaiting review", hint: "Submitted — an admin needs to approve it." },
  approved: { label: "Claude is fixing this…", hint: "Claude is planning and implementing the change." },
  dispatched: { label: "Ready to test", hint: "Built and deployed to the live console — test it, then Accept or Retry." },
  accepted: { label: "Staged for the next publish", hint: "Accepted — waiting on the next Publish to go live." },
  done: { label: "Live", hint: "Published to the live console." },
  rejected: { label: "Denied", hint: "Won't be worked on." },
};

/**
 * Ordered happy-path journey for the legend/stepper. `rejected` is a terminal
 * off-ramp and is intentionally excluded from the linear steps.
 */
export const STATUS_STEPS: readonly FeedbackStatus[] = ["new", "approved", "dispatched", "accepted", "done"];
