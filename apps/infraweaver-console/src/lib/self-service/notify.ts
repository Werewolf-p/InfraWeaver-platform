import "server-only";
import { isMailerConfigured, sendMail } from "@/lib/mailer";
import { brandedEmailHtml, escapeHtml } from "@/lib/email-logo";
import { loadUsersConfig } from "@/lib/users-config";
import { describeRequest } from "./describe";
import type { SelfServiceRequest } from "./types";

/**
 * Decision notifications — SERVER ONLY.
 *
 * Emails the requester when an admin approves or denies their request. This is a
 * SEAM: it emails today, and is the single place to reroute decision notices
 * through Subject 3's server notification inbox once that model lands. Best-effort
 * by contract — a self-service decision is a control action and must never fail or
 * block on a mail bounce, so every path swallows its own errors.
 */

/** Resolve the requester's email: use the identity directly when it is an address,
 *  else look it up in users.yaml by username. */
async function resolveRecipient(requestedBy: string): Promise<string | null> {
  if (requestedBy.includes("@")) return requestedBy;
  try {
    const cfg = await loadUsersConfig();
    const user = cfg.users[requestedBy];
    const email = (user?.email ?? "").trim();
    return email || null;
  } catch {
    return null;
  }
}

export async function notifyDecision(request: SelfServiceRequest): Promise<void> {
  try {
    if (request.status !== "approved" && request.status !== "denied") return;
    if (!isMailerConfigured()) {
      console.warn(`[self-service] mail not configured; skipped ${request.status} notice for '${request.requestedBy}'`);
      return;
    }
    const to = await resolveRecipient(request.requestedBy);
    if (!to) {
      console.warn(`[self-service] no email on file for '${request.requestedBy}'; decision notice skipped`);
      return;
    }

    const approved = request.status === "approved";
    const verb = approved ? "approved" : "denied";
    const subject = `Your InfraWeaver request was ${verb}`;
    const summary = escapeHtml(request.appliedSummary ?? describeRequest(request));
    const noteLine = request.decisionNote ? `<p>Note: ${escapeHtml(request.decisionNote)}</p>` : "";
    const html = brandedEmailHtml(
      [
        `<p>Your self-service request was <strong style="color:${approved ? "#16a34a" : "#dc2626"}">${verb}</strong>.</p>`,
        `<p>${summary}</p>`,
        noteLine,
      ].join(""),
      { preview: subject },
    );
    const text = [
      `Your self-service request was ${verb}.`,
      "",
      request.appliedSummary ?? describeRequest(request),
      request.decisionNote ? `Note: ${request.decisionNote}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await sendMail({ to, subject, text, html });
  } catch (error) {
    console.error(`[self-service] failed to send decision notice for '${request.requestedBy}':`, error instanceof Error ? error.message : error);
  }
}
