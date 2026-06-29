// Shared motion vocabulary for the firewall surface. Exponential ease-out, no
// bounce — matches the calm, deliberate feel of a security console. Reduced
// motion is handled per-component via framer-motion's useReducedMotion().

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export const springSoft = { type: "spring", stiffness: 420, damping: 30 } as const;

export const listItem = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, x: 24, transition: { duration: 0.2, ease: EASE_OUT } },
  transition: { duration: 0.28, ease: EASE_OUT },
};
