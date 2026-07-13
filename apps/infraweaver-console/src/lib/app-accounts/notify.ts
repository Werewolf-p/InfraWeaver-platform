/**
 * Credential delivery — SERVER ONLY.
 *
 * Delivery is two-tier:
 *   1. PUSH — when a first-party SMTP sender is configured (`isMailerConfigured`),
 *      the notifier emails the username+password straight to the user so a granted
 *      Jellyfin account is usable without an operator touching it. A send failure is
 *      NOT swallowed: it propagates so the engine records `pendingHandoff` and the
 *      pull path below takes over.
 *   2. PULL (fallback) — the credential is already at rest in OpenBao (the reconcile
 *      wrote it), so an admin reveals it in the console for an out-of-band hand-off.
 *      Used when SMTP is unconfigured, or after a push failure.
 *
 * Either way an audit line is written for attributability — the pull line never
 * carries the password.
 *
 * The {@link AccountNotifier} contract remains the seam: a different transport is a
 * drop-in with no change to the engine.
 */
import "server-only";
import { auditLog } from "@/lib/audit-log";
import { isMailerConfigured, sendCredentialEmail } from "@/lib/mailer";
import type { AccountNotifier, ProvisionedCredential } from "@/lib/app-accounts/types";

export const consoleAccountNotifier: AccountNotifier = {
  async notifyProvisioned(credential: ProvisionedCredential): Promise<void> {
    if (isMailerConfigured()) {
      try {
        await sendCredentialEmail({
          to: credential.email,
          appLabel: credential.appLabel,
          launchUrl: credential.launchUrl,
          username: credential.username,
          password: credential.password,
        });
      } catch (err) {
        // Push failed — record it and rethrow so the engine flags pendingHandoff and
        // an operator completes delivery via the OpenBao-backed console reveal.
        await auditLog(
          "app-account:handoff-failed",
          "infraweaver",
          `Failed to email ${credential.appLabel} credentials for '${credential.username}' to ${credential.email}; credential stored for console reveal (${credential.launchUrl})`,
          { resource: `${credential.appId}/${credential.username}` },
        );
        throw err;
      }
      await auditLog(
        "app-account:provisioned",
        "infraweaver",
        // The password went to the user over SMTP, never into this log line.
        `Provisioned ${credential.appLabel} account '${credential.username}' for ${credential.email}; credentials emailed (${credential.launchUrl})`,
        { resource: `${credential.appId}/${credential.username}` },
      );
      return;
    }

    // No SMTP sender wired: fall back to pull-based hand-off. The credential lives in
    // OpenBao at secret/platform/app-accounts/<app>/users/<username>; deliver it from
    // the console's reveal flow, not from this log line (password excluded).
    await auditLog(
      "app-account:provisioned",
      "infraweaver",
      `Provisioned ${credential.appLabel} account '${credential.username}' for ${credential.email}; credential stored for hand-off (${credential.launchUrl})`,
      { resource: `${credential.appId}/${credential.username}` },
    );
  },
};
