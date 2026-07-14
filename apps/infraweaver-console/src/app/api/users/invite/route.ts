import { NextRequest, NextResponse } from "next/server";
import { hasSessionPermission } from "@/lib/session-rbac";
import { auditLog } from "@/lib/audit-log";
import { z } from "zod";
import { sendInviteEmail } from "@/lib/mailer";
import { createEnrollmentInvitation } from "@/lib/authentik-invite";
import { withRoute } from "@/lib/route-utils";
import { sessionActor } from "@/lib/user-guards";
import { safeError } from "@/lib/utils";
import { expandPresetGrants, isAccessPresetId, isPrivilegedPresetId } from "@/lib/users/access-presets";

const InviteBody = z.object({
  email: z.string().email().max(254),
  // Trim each group name and drop empties so a padded " platform-admins" can't
  // ride onto the invitation's fixed_data (and matches how session groups are
  // canonicalized everywhere else).
  groups: z
    .array(z.string().max(64))
    .max(20)
    .optional()
    .default([])
    .transform((names) => names.map((name) => name.trim()).filter(Boolean)),
  // Access presets ("all" | "jellyfin" | "storage") expand to RBAC grants and ride
  // along on the invitation so the enrolled user is auto-provisioned. Unknown ids
  // are dropped rather than rejected so a future preset can be added client-first.
  access: z
    .array(z.string().max(32))
    .max(10)
    .optional()
    .default([])
    .transform((ids) => ids.filter(isAccessPresetId)),
  expiryHours: z.number().int().min(1).max(168).optional().default(24),
});

// C4: raise the gate — issuing invitations requires users:write / rbac:admin.
export const POST = withRoute(["users:write", "rbac:admin"], async (req: NextRequest, session, access) => {
  const parsed = InviteBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { email, groups, access: presets, expiryHours } = parsed.data;

  // C4: assigning groups on an invite can grant privileges — gate it behind
  // rbac:admin so a users:write operator cannot escalate via group membership.
  if (groups.length > 0 && !hasSessionPermission(access, "rbac:admin")) {
    return NextResponse.json({ error: "Forbidden: group assignment requires rbac:admin" }, { status: 403 });
  }

  // Admin-tier presets (e.g. Jellyfin administrator) confer elevated privileges
  // inside the app, so gate them behind rbac:admin — the same ceiling as group
  // grants — rather than letting a users:write operator hand out app admin.
  const privilegedPresets = presets.filter(isPrivilegedPresetId);
  if (privilegedPresets.length > 0 && !hasSessionPermission(access, "rbac:admin")) {
    return NextResponse.json(
      { error: `Forbidden: admin-tier access requires rbac:admin (${privilegedPresets.join(", ")})` },
      { status: 403 },
    );
  }

  // The remaining presets expand to app-level RBAC grants (Jellyfin user, Nextcloud
  // storage) — low-privilege app access, so the invite gate (users:write/rbac:admin)
  // suffices; they never confer platform admin the way an arbitrary group could.
  // `groups` (rbac:admin only) and these presets ride on the invitation's fixed_data;
  // the shared helper owns that shape and the no-flow binding (see createEnrollmentInvitation).
  const presetGrants = expandPresetGrants(presets);

  let url: string;
  try {
    ({ url } = await createEnrollmentInvitation({ email, groups, presetGrants, expiryHours }));
  } catch (e) {
    // Flow not provisioned yet, or Authentik rejected the invitation. Do not reflect
    // Authentik's raw error to the client.
    console.error(`[users:invite] could not create enrollment invitation for ${email}:`, safeError(e));
    return NextResponse.json({ error: "Failed to create invitation" }, { status: 502 });
  }

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

  const accessNote = presets.length > 0 ? ` [access: ${presets.join(", ")}]` : "";
  await auditLog(
    "users:invite",
    sessionActor(session),
    `Invited ${email}${accessNote}${emailed ? " (emailed)" : ` (email failed: ${emailError})`}`,
    { result: emailed ? "success" : "failure" },
  );
  return NextResponse.json({ url, emailed, ...(emailError ? { emailError } : {}) });
});
