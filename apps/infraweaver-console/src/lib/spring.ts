// Spring animation presets — use these everywhere, never raw numbers
import type { SpringOptions, Variants } from "framer-motion";

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
