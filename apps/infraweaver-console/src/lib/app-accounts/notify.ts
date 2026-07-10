/**
 * Credential delivery — SERVER ONLY.
 *
 * The finding that shapes this file: InfraWeaver has NO first-party SMTP sender.
 * Authentik is configured to send its OWN templated mail (recovery/invite) via
 * `secret/platform/authentik` SMTP creds, but there is no path to send an arbitrary
 * "here is your Jellyfin password" body, and the console has no mailer dependency.
 * See docs/app-account-provisioning.md.
 *
 * So the default notifier does NOT invent an SMTP client. It:
 *   1. relies on the credential already being in OpenBao (the reconcile wrote it),
 *      so an admin can reveal it in the console for an out-of-band hand-off; and
 *   2. writes an audit line recording the hand-off — WITHOUT the password — so the
 *      event is visible and attributable.
 *
 * The {@link AccountNotifier} contract is the seam: dropping in an SMTP- or
 * Authentik-invitation-backed notifier is a new file wired at the call site, with
 * no change to the engine. That notifier is where a real email would be sent.
 */
import "server-only";
import { auditLog } from "@/lib/audit-log";
import type { AccountNotifier, ProvisionedCredential } from "@/lib/app-accounts/types";

/**
 * Default notifier. Never logs or transmits the plaintext password — it is already
 * safely at rest in OpenBao and is surfaced only through the authenticated console
 * reveal. This records that a credential is ready for `email` to be handed off.
 */
export const consoleAccountNotifier: AccountNotifier = {
  async notifyProvisioned(credential: ProvisionedCredential): Promise<void> {
    await auditLog(
      "app-account:provisioned",
      "infraweaver",
      // Deliberately excludes the password. The credential lives in OpenBao at
      // secret/platform/app-accounts/<app>/users/<username>; deliver it from the
      // console's reveal flow, not from this log line.
      `Provisioned ${credential.appLabel} account '${credential.username}' for ${credential.email}; credential stored for hand-off (${credential.launchUrl})`,
      { resource: `${credential.appId}/${credential.username}` },
    );
  },
};
