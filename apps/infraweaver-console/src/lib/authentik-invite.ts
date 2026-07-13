/**
 * Reusable Authentik enrollment-invitation helpers — SERVER ONLY.
 *
 * The interactive `POST /api/users/invite` route and the automated users
 * reconcile (`lib/users/reconcile.ts`) both need to mint a single-use enrollment
 * invitation and to tell whether one is already outstanding for an email. This is
 * the one place that logic lives so the two callers can never drift.
 *
 * An enrollment invitation is the ONLY way a person's Authentik login identity is
 * created from an admin action: the console cannot set someone's password for
 * them, so it emails a single-use link and the user completes enrollment. App
 * accounts (Jellyfin/Nextcloud) then provision from the users.yaml grants once
 * that identity exists.
 */
import "server-only";
import { authentikFetch } from "@/lib/authentik";
import { publicHost } from "@/lib/domain";

/**
 * Enrollment flow the invite link resolves to. Provisioned by the infra
 * `authentik-blueprint-invitation-flow` blueprint. Overridable for non-default
 * Authentik installs.
 */
const INVITATION_FLOW_SLUG = process.env.AUTHENTIK_INVITATION_FLOW_SLUG ?? "default-invitation-flow";

/** Resolve the invitation enrollment flow's pk by slug; null if it is absent. */
async function resolveInvitationFlowPk(): Promise<string | null> {
  const r = await authentikFetch(`/flows/instances/?slug=${encodeURIComponent(INVITATION_FLOW_SLUG)}`);
  if (!r.ok) return null;
  const data = (await r.json()) as { results?: Array<{ pk: string; slug: string }> };
  return data.results?.find((f) => f.slug === INVITATION_FLOW_SLUG)?.pk ?? null;
}

export interface EnrollmentInvitation {
  /** The link the user opens to enroll (set their own password). */
  url: string;
  /** The invitation token (itoken) — also the Authentik invitation pk. */
  token: string;
}

/**
 * Create a single-use Authentik enrollment invitation and return its link.
 *
 * `groups` (Authentik group NAMES) ride on the invitation's `fixed_data` and are
 * applied at enrollment by the bounded `default-invitation-group-grant` policy,
 * which only adds PRE-EXISTING groups (unknown names ignored; never creates
 * groups). Throws if the enrollment flow is not provisioned — the caller decides
 * whether that is fatal.
 */
export async function createEnrollmentInvitation(input: {
  email: string;
  groups?: string[];
  expiryHours?: number;
}): Promise<EnrollmentInvitation> {
  const { email, groups = [], expiryHours = 168 } = input;
  const flowPk = await resolveInvitationFlowPk();
  if (!flowPk) throw new Error("Authentik invitation flow is not configured");

  const fixedData: Record<string, unknown> = { email };
  if (groups.length > 0) fixedData.groups = groups;

  const expires = new Date(Date.now() + expiryHours * 3600 * 1000).toISOString();
  const r = await authentikFetch("/stages/invitation/invitations/", {
    method: "POST",
    body: JSON.stringify({
      // `name` is a required unique slug on Authentik's Invitation model.
      name: `invite-${globalThis.crypto.randomUUID()}`,
      expires,
      single_use: true,
      flow: flowPk,
      fixed_data: fixedData,
    }),
  });
  if (!r.ok) throw new Error(`Failed to create Authentik invitation: HTTP ${r.status}`);

  const inv = (await r.json()) as { pk?: string; invite_uuid?: string };
  const token = inv.pk ?? inv.invite_uuid ?? "";
  const authentikBaseUrl = process.env.AUTHENTIK_PUBLIC_URL ?? `https://${publicHost("auth")}`;
  const url = `${authentikBaseUrl}/if/flow/${INVITATION_FLOW_SLUG}/?itoken=${token}`;
  return { url, token };
}

/**
 * True when a still-valid (unexpired) enrollment invitation already exists for
 * this email. Lets the reconcile avoid re-inviting the same person on every tick
 * — the invite is only re-sent once the previous one has expired or been consumed
 * (a consumed single-use invitation no longer lists here).
 */
export async function hasLiveInvitationForEmail(email: string): Promise<boolean> {
  const r = await authentikFetch(`/stages/invitation/invitations/?ordering=-expires`);
  if (!r.ok) throw new Error(`Failed to list Authentik invitations: HTTP ${r.status}`);
  const data = (await r.json()) as {
    results?: Array<{ expires?: string; fixed_data?: { email?: string } }>;
  };
  const now = Date.now();
  return (data.results ?? []).some(
    (inv) => inv.fixed_data?.email === email && (!inv.expires || new Date(inv.expires).getTime() > now),
  );
}
