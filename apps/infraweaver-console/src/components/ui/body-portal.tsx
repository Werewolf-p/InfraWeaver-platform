"use client";
import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface BodyPortalProps {
  children: ReactNode;
}

// Client-mount gate. Server snapshot is `false`, client snapshot is `true`, so
// children portal in only after hydration — same effect as a mount flag, but
// without a setState-in-effect (react-hooks/set-state-in-effect).
const subscribe = () => () => {};
const getMounted = () => true;
const getMountedServer = () => false;

/**
 * Renders children into `document.body` via a portal, gated on client mount so
 * server render and hydration stay consistent. Shared copy of the inline
 * BodyPortal helpers on the apps/gameservers pages.
 */
export function BodyPortal({ children }: BodyPortalProps) {
  const mounted = useSyncExternalStore(subscribe, getMounted, getMountedServer);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
