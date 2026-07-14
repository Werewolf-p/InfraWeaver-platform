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
import type { PresetGrant } from "@/lib/users/access-presets";

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
 * Create a single-use Authentik enrollment invitation and return its link. This is
 * the ONE place an enrollment invitation is minted — both the interactive
 * `POST /api/users/invite` route and the automated reconcile call it, so the
 * fixed_data shape and the (no-)flow binding can never drift between them.
 *
 * `groups` (Authentik group NAMES) ride on the invitation's `fixed_data` and are
 * applied at enrollment by the bounded `default-invitation-group-grant` policy,
 * which only adds PRE-EXISTING groups (unknown names ignored; never creates
 * groups). `presetGrants` ride on `fixed_data.iw_roles` → prompt_data → and, since
 * the user-write stage persists unrecognized prompt keys as user attributes, land
 * on the enrolled account as `attributes.iw_roles`, which the reconcile bridges
 * into users.yaml grants keyed by the actual chosen username.
 *
 * The invitation is deliberately created with NO `flow`. On Authentik 2026.5.4 an
 * invitation with a `flow` set is NOT matched by the InvitationStage when the link
 * is opened via that same flow's URL — the stage answers "Invalid invite/invite not
 * found" and denies enrollment. The flow is already selected by the link PATH
 * (/if/flow/<slug>/), so the field is redundant; the flow pk is still resolved as an
 * existence gate. Throws if the enrollment flow is not provisioned — the caller
 * decides whether that is fatal.
 */
export async function createEnrollmentInvitation(input: {
  email: string;
  groups?: string[];
  presetGrants?: PresetGrant[];
  expiryHours?: number;
}): Promise<EnrollmentInvitation> {
  const { email, groups = [], presetGrants = [], expiryHours = 168 } = input;
  const flowPk = await resolveInvitationFlowPk();
  if (!flowPk) throw new Error("Authentik invitation flow is not configured");

  const fixedData: Record<string, unknown> = { email };
  if (groups.length > 0) fixedData.groups = groups;
  // Stash the preset grants under the DOTTED key `attributes.iw_roles`, not a bare
  // `iw_roles`. Authentik's user-write stage only persists a prompt/fixed_data key to
  // the account when it is a real User field or is prefixed `attributes.` — any other
  // key (a bare `iw_roles`) hits the stage's final branch and is silently DROPPED, so
  // the grants never reach the enrolled account and the reconcile bridge can't see
  // them. `attributes.iw_roles` makes user-write write `user.attributes.iw_roles`,
  // which is exactly what bridgeEnrollmentGrants reads.
  if (presetGrants.length > 0) fixedData["attributes.iw_roles"] = presetGrants;

  const expires = new Date(Date.now() + expiryHours * 3600 * 1000).toISOString();
  const r = await authentikFetch("/stages/invitation/invitations/", {
    method: "POST",
    body: JSON.stringify({
      // `name` is a required unique slug on Authentik's Invitation model.
      name: `invite-${globalThis.crypto.randomUUID()}`,
      expires,
      single_use: true,
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
