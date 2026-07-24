"use client";

/**
 * Client mutation hook for the Email panel's WRITE verbs. Every call POSTs a
 * `{ verb, params }` body to the dedicated signed route
 * (`/api/wordpress/sites/[site]/email`), which delegates to a signed `email.*`
 * op. On success it invalidates the site's Manage panel query so the merged probe
 * re-reads the connector snapshot + log (the server also drops its snapshot cache).
 *
 * SECURITY: the write-only SMTP password is a field of `EmailConfigSetParams` and
 * rides this POST once. Nothing here echoes it — the connector reply is already
 * stripped — and it is never written to any client store.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  EmailConfigSetParams,
  EmailConfigSetResult,
  EmailLogClearResult,
  EmailTestResult,
} from "../../../lib/manage/email";

type EmailWriteBody =
  | { verb: "config"; params: EmailConfigSetParams }
  | { verb: "test"; params: { to: string } }
  | { verb: "clear-log"; params: Record<string, never> };

async function postEmail<T>(site: string, body: EmailWriteBody): Promise<T> {
  const res = await fetch(`/api/wordpress/sites/${site}/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed && typeof parsed.error === "string") message = parsed.error;
    } catch {
      /* non-JSON body */
    }
    if (res.status === 401) message = "Sign in to manage email for this site.";
    if (res.status === 403) message = "You don't have permission to change email for this site.";
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export interface EmailActions {
  saveConfig(params: EmailConfigSetParams): Promise<EmailConfigSetResult>;
  sendTest(to: string): Promise<EmailTestResult>;
  clearLog(): Promise<EmailLogClearResult>;
  readonly pending: boolean;
}

export function useEmailActions(site: string): EmailActions {
  const queryClient = useQueryClient();
  const mutation = useMutation<Record<string, unknown>, Error, EmailWriteBody>({
    mutationFn: (body) => postEmail<Record<string, unknown>>(site, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wordpress-manage-panel", site] });
    },
  });

  // The route echoes the connector's verified, stripped result; narrow the generic
  // JSON to the per-verb result type (through `unknown` — shapes don't structurally
  // overlap with `Record<string, unknown>`). No secret is ever in any of these.
  return {
    saveConfig: async (params) =>
      (await mutation.mutateAsync({ verb: "config", params })) as unknown as EmailConfigSetResult,
    sendTest: async (to) =>
      (await mutation.mutateAsync({ verb: "test", params: { to } })) as unknown as EmailTestResult,
    clearLog: async () =>
      (await mutation.mutateAsync({ verb: "clear-log", params: {} })) as unknown as EmailLogClearResult,
    pending: mutation.isPending,
  };
}
