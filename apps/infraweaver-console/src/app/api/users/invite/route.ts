import { NextRequest, NextResponse } from "next/server";
import { hasSessionPermission } from "@/lib/session-rbac";
import { authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";
import { z } from "zod";
import { publicHost } from "@/lib/domain";
import { sendInviteEmail } from "@/lib/mailer";
import { withRoute } from "@/lib/route-utils";
import { sessionActor } from "@/lib/user-guards";
import { safeError } from "@/lib/utils";

const InviteBody = z.object({
  email: z.string().email().max(254),
  groups: z.array(z.string().max(64)).max(20).optional().default([]),
  expiryHours: z.number().int().min(1).max(168).optional().default(24),
});

// Enrollment flow the invite link resolves to. Provisioned by the infra
// `authentik-blueprint-invitation-flow` blueprint. Overridable for non-default
// Authentik installs.
const INVITATION_FLOW_SLUG = process.env.AUTHENTIK_INVITATION_FLOW_SLUG ?? "default-invitation-flow";

/** Resolve the invitation enrollment flow's pk by slug; null if it is absent. */
async function resolveInvitationFlowPk(): Promise<string | null> {
  const r = await authentikFetch(`/flows/instances/?slug=${encodeURIComponent(INVITATION_FLOW_SLUG)}`);
  if (!r.ok) return null;
  const data = (await r.json()) as { results?: Array<{ pk: string; slug: string }> };
  return data.results?.find((f) => f.slug === INVITATION_FLOW_SLUG)?.pk ?? null;
}

// C4: raise the gate — issuing invitations requires users:write / rbac:admin.
export const POST = withRoute(["users:write", "rbac:admin"], async (req: NextRequest, session, access) => {
  const parsed = InviteBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { email, groups, expiryHours } = parsed.data;

  // C4: assigning groups on an invite can grant privileges — gate it behind
  // rbac:admin so a users:write operator cannot escalate via group membership.
  if (groups.length > 0 && !hasSessionPermission(access, "rbac:admin")) {
    return NextResponse.json({ error: "Forbidden: group assignment requires rbac:admin" }, { status: 403 });
  }

  // The invitation must be bound to a real enrollment flow, otherwise the link
  // 404s. Resolve the flow's pk up front and fail clearly if the blueprint that
  // provisions it has not synced yet.
  const flowPk = await resolveInvitationFlowPk();
  if (!flowPk) {
    return NextResponse.json({ error: "Invitation flow is not configured" }, { status: 502 });
  }

  // `groups` (rbac:admin only) ride along on the invitation's fixed_data. The
  // enrollment flow's bounded `default-invitation-group-grant` policy reads them
  // at user-write and adds the new account to each PRE-EXISTING Authentik group
  // (unknown names are ignored; it never creates groups). Membership is thus
  // applied in-band by the flow, so no separate post-enrollment grant is needed.
  const fixedData: Record<string, unknown> = { email };
  if (groups.length > 0) fixedData.groups = groups;

  const expires = new Date(Date.now() + expiryHours * 3600 * 1000).toISOString();
  const r = await authentikFetch("/stages/invitation/invitations/", {
    method: "POST",
    body: JSON.stringify({
      // `name` is a required unique slug on Authentik's Invitation model.
      name: `invite-${crypto.randomUUID()}`,
      expires,
      single_use: true,
      flow: flowPk,
      fixed_data: fixedData,
    }),
  });

  if (!r.ok) {
    // Do not reflect Authentik's raw error body to the client.
    return NextResponse.json({ error: "Failed to create invitation" }, { status: 502 });
  }

  const inv = await r.json();
  const token = inv.pk ?? inv.invite_uuid ?? "";
  const authentikBaseUrl = process.env.AUTHENTIK_PUBLIC_URL ?? `https://${publicHost("auth")}`;
  const url = `${authentikBaseUrl}/if/flow/${INVITATION_FLOW_SLUG}/?itoken=${token}`;

  // Deliver the link by email — the whole point of an invite. A bounce (SMTP down,
  // O365 rejecting the From, mail not yet wired) must NOT fail the invite: the token
  // is already minted, so we still return `url` for a manual hand-off and surface the
  // delivery outcome via `emailed`/`emailError` for the caller to act on.
  let emailed = false;
  let emailError: string | undefined;
  try {
    await sendInviteEmail(email, url);
    emailed = true;
  } catch (e) {
    emailError = safeError(e);
    console.error(`[users:invite] enrollment email to ${email} failed; the link is still returned for manual hand-off:`, emailError);
  }

  await auditLog(
    "users:invite",
    sessionActor(session),
    `Invited ${email}${emailed ? " (emailed)" : ` (email failed: ${emailError})`}`,
    { result: emailed ? "success" : "failure" },
  );
  return NextResponse.json({ url, emailed, ...(emailError ? { emailError } : {}) });
});
