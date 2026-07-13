"use client";

// Hooks for a person's Nextcloud LOCAL password: reveal the stored one, or reset
// it. Backed by /api/nextcloud/credential and deliberately mirroring the Jellyfin
// credential hooks — same "explicit click, never prefetched, audited server-side"
// contract, because a local password is the one thing SSO cannot deliver to a
// native/WebDAV client.

import { useMutation } from "@tanstack/react-query";

export interface NextcloudCredential {
  username: string;
  password: string;
  launchUrl: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof data.error === "string" ? data.error : fallback;
}

/**
 * Reveal a stored Nextcloud local password. A mutation, not a query: it must
 * never be prefetched, cached, or refetched — only fetched on an explicit human
 * click, and it is audited server-side. Self-reveal is allowed; revealing
 * someone else's requires `users:write`/`rbac:admin`.
 */
export function useRevealNextcloudCredential() {
  return useMutation({
    mutationFn: async (username?: string) => {
      const query = username ? `?username=${encodeURIComponent(username)}` : "";
      const res = await fetch(`/api/nextcloud/credential${query}`);
      if (!res.ok) throw new Error(await readError(res, "Failed to reveal credential"));
      return await res.json() as NextcloudCredential;
    },
  });
}

/**
 * Reset a managed Nextcloud account's local password and get the new one back.
 * Admin-only recovery — it mints a fresh password, sets it on the server over
 * OCS, persists it for reveal, and disrupts existing native-client logins. Driven
 * by an explicit click for the same reason reveal is.
 */
export function useResetNextcloudCredential() {
  return useMutation({
    mutationFn: async (username: string) => {
      const res = await fetch("/api/nextcloud/credential", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to reset credential"));
      return await res.json() as NextcloudCredential;
    },
  });
}
