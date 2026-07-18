import type { Variants } from "framer-motion";

/** Exponential ease-out — no bounce, no elastic (matches the rest of the app). */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Staggered container: children animate in one after another. */
export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.05, delayChildren: 0.02 },
  },
};

/** A single card/tile rising into place. */
export const riseItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } },
};

/** A fainter fade for chart bodies (they carry their own internal animation). */
export const fadeItem: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.5, ease: EASE_OUT } },
};
