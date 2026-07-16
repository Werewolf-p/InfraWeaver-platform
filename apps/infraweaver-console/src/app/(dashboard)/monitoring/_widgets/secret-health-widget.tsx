"use client";

import { SecretHealthSummary } from "@/components/secrets/secret-health-summary";

/**
 * Secret & Cert health tile. This delegates ENTIRELY to Subject 5's shared
 * `SecretHealthSummary` (backed by `/api/secrets/lifecycle`) — the board does NOT
 * rebuild any token/ESO/Retain-trap widget, it renders the single owned summary
 * and links out to `/secret-health`. See the coordination contract.
 */
export function SecretHealthWidget() {
  return <SecretHealthSummary className="h-full" showLink />;
}
