"use client";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface BodyPortalProps {
  children: ReactNode;
}

/**
 * Renders children into `document.body` via a portal, gated on client mount so
 * server render and hydration stay consistent. Shared copy of the inline
 * BodyPortal helpers on the apps/gameservers pages.
 */
export function BodyPortal({ children }: BodyPortalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
