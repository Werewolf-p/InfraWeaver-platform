import "server-only";
import type { FeedbackEntry } from "@/lib/feedback-store";

/**
 * One-flow dispatch: when an admin approves an entry on the /feedback page, the
 * console hands it straight to Claude via the n8n "dev-feedback-fix-flow"
 * webhook. No second approval gate — the console Approve button IS the gate.
 *
 * The trigger is env-driven and FAIL-SAFE: if the webhook URL/token are not
 * configured, the approval still succeeds and we report `skipped` instead of
 * throwing, so triage is never blocked by integration wiring.
 *
 *   FEEDBACK_N8N_WEBHOOK_URL  e.g. https://n8n.rlservers.com/webhook/dev-feedback-fix-flow
 *   FEEDBACK_WEBHOOK_TOKEN    matches the n8n "feedback-webhook-token" header credential
 */
const WEBHOOK_URL = process.env.FEEDBACK_N8N_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.FEEDBACK_WEBHOOK_TOKEN;
// Second-stage webhook: drives promote-to-PR / discard+re-dispatch after the
// reviewer has tested the preview on the cluster. Reuses FEEDBACK_WEBHOOK_TOKEN.
//   FEEDBACK_VALIDATE_WEBHOOK_URL  e.g. https://n8n.rlservers.com/webhook/dev-feedback-validate-flow
const VALIDATE_WEBHOOK_URL = process.env.FEEDBACK_VALIDATE_WEBHOOK_URL;
const DISPATCH_TIMEOUT_MS = 8_000;

export interface DispatchResult {
  ok: boolean;
  /** True when the webhook is not configured — the status change succeeded, the webhook call was skipped. */
  skipped?: boolean;
  error?: string;
}

/** Outcome the reviewer picks after testing the preview on the cluster. */
export type ValidationAction = "validated" | "not_fixed";

/**
 * Fail-safe POST to an n8n webhook. When the URL/token are not configured we
 * report `skipped` instead of throwing, so triage is never blocked by wiring.
 */
async function postWebhook(
  url: string | undefined,
  token: string | undefined,
  body: Record<string, unknown>,
  missingMessage: string,
): Promise<DispatchResult> {
  if (!url || !token) return { ok: false, skipped: true, error: missingMessage };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Feedback-Token": token },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `n8n responded ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "webhook call failed" };
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchApprovedFeedback(entry: FeedbackEntry): Promise<DispatchResult> {
  // Field names match what the n8n workflow reads from $json.body.*
  return postWebhook(
    WEBHOOK_URL,
    WEBHOOK_TOKEN,
    {
      status: entry.status,
      id: entry.id,
      description: entry.description,
      pagePath: entry.pagePath,
      type: entry.type,
      severity: entry.severity,
    },
    "n8n webhook not configured (FEEDBACK_N8N_WEBHOOK_URL / FEEDBACK_WEBHOOK_TOKEN)",
  );
}

/**
 * After the reviewer tests the cluster preview, hand the verdict to the n8n
 * dev-feedback-validate-flow: `validated` promotes the preview into a draft PR;
 * `not_fixed` discards the preview and re-dispatches Claude with `note`.
 */
export async function validateFeedback(
  entry: FeedbackEntry,
  action: ValidationAction,
  note?: string,
): Promise<DispatchResult> {
  return postWebhook(
    VALIDATE_WEBHOOK_URL,
    WEBHOOK_TOKEN,
    {
      action,
      note: note ?? "",
      id: entry.id,
      description: entry.description,
      pagePath: entry.pagePath,
      type: entry.type,
      severity: entry.severity,
    },
    "n8n validate webhook not configured (FEEDBACK_VALIDATE_WEBHOOK_URL / FEEDBACK_WEBHOOK_TOKEN)",
  );
}
