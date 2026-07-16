"use client";
// Spring animation presets — use these everywhere, never raw numbers
import { useReducedMotion } from "framer-motion";
import type { SpringOptions, Transition, Variants } from "framer-motion";

export const springs = {
  // Snappy: UI responses, button presses, dropdown opens
  snappy: { type: "spring", stiffness: 400, damping: 28, mass: 0.8 } as const,
  // Gentle: cards, panels, page elements
  gentle: { type: "spring", stiffness: 260, damping: 24, mass: 1 } as const,
  // Bouncy: active indicators, pills, tab highlights
  bouncy: { type: "spring", stiffness: 500, damping: 22, mass: 0.6 } as const,
  // Fluid: large layout shifts, sidebar collapse
  fluid: { type: "spring", stiffness: 200, damping: 26, mass: 1.2 } as const,
  // Micro: tiny elements, dots, icons
  micro: { type: "spring", stiffness: 600, damping: 30, mass: 0.5 } as const,
} satisfies Record<string, SpringOptions & { type: "spring" }>;

export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.04, delayChildren: 0.05 },
  },
};

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 260, damping: 24, mass: 1 } },
};

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 260, damping: 24, mass: 1 } },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.2 } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  show: { opacity: 1, scale: 1, transition: { type: "spring" as const, stiffness: 400, damping: 28, mass: 0.8 } },
};

// ── Reduced-motion support ───────────────────────────────────────────
// framer-motion animations are JS-driven and ignore the CSS
// `prefers-reduced-motion` rule in globals.css. These helpers collapse
// motion to an instant transition (WCAG 2.3.3) while keeping the same
// start/end states, so components stay declarative.

/** A transition that snaps to the final state with no perceptible motion. */
export const instant: Transition = { duration: 0 };

/** Rewrite every variant's transition to `instant` (preserving its end state). */
function toInstantVariants(variants: Variants): Variants {
  return Object.fromEntries(
    Object.entries(variants).map(([state, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return [state, { ...(value as Record<string, unknown>), transition: instant }];
      }
      return [state, value];
    }),
  ) as Variants;
}

export interface MotionSafe {
  /** True when the user has requested reduced motion. */
  reduced: boolean;
  /** Returns the given transition, or `instant` under reduced motion. */
  transition: (preferred: Transition) => Transition;
  /** Returns the given variants, or snap-to-final variants under reduced motion. */
  variants: (preferred: Variants) => Variants;
}

/**
 * Reduced-motion-aware accessor for the spring presets. Wrap any framer
 * transition / variants through the returned helpers so they degrade to an
 * instant change when the user prefers reduced motion.
 *
 * @example
 *   const motion = useMotionSafe();
 *   <motion.div variants={motion.variants(fadeUp)} transition={motion.transition(springs.gentle)} />
 */
export function useMotionSafe(): MotionSafe {
  const reduced = useReducedMotion() ?? false;
  return {
    reduced,
    transition: (preferred) => (reduced ? instant : preferred),
    variants: (preferred) => (reduced ? toInstantVariants(preferred) : preferred),
  };
}
