/**
 * RBAC change notifications — SERVER ONLY.
 *
 * When a user's role assignments change (a grant, a revoke, or a swap of one grant
 * for another at the same scope), email the AFFECTED USER a plain-language summary of
 * what changed: what was granted, what was revoked, and — when a scope's role was
 * replaced — what it changed from and to.
 *
 * Best-effort by contract: an RBAC write is a security control and must not fail or
 * block on a mail bounce. Every entry point here swallows its own errors and simply
 * declines to send when mail is not configured or the user has no address on file.
 */
import "server-only";
import { getBuiltInRoles, isAssignmentExpired, STATIC_SCOPES, type RoleAssignment } from "@/lib/rbac";
import { isMailerConfigured, sendMail } from "@/lib/mailer";
import { loadUsersConfig } from "@/lib/users-config";

/** A scope whose role was swapped for another (e.g. jellyfin-user → jellyfin-admin). */
export interface ChangedAssignment {
  scope: string;
  from: RoleAssignment;
  to: RoleAssignment;
}

export interface RoleAssignmentDiff {
  granted: RoleAssignment[];
  revoked: RoleAssignment[];
  changed: ChangedAssignment[];
}

export function isEmptyDiff(diff: RoleAssignmentDiff): boolean {
  return diff.granted.length === 0 && diff.revoked.length === 0 && diff.changed.length === 0;
}

const effectOf = (a: RoleAssignment): "Allow" | "Deny" => a.effect ?? "Allow";

/** Two assignments describe the same grant when role, scope, effect and expiry match. */
function sameGrant(a: RoleAssignment, b: RoleAssignment): boolean {
  return a.roleId === b.roleId && a.scope === b.scope && effectOf(a) === effectOf(b) && (a.expiresAt ?? "") === (b.expiresAt ?? "");
}

/**
 * Compare a user's role assignments before and after a write. Matches first by the
 * stable `id` (a same-id change of role/scope/effect/expiry is a "changed"), then
 * pairs a leftover revoke and grant sharing a scope into a single "changed at scope
 * from X to Y" — how the UI models replacing one grant with another (delete + add).
 */
export function diffRoleAssignments(before: RoleAssignment[], after: RoleAssignment[]): RoleAssignmentDiff {
  const beforeById = new Map(before.map((a) => [a.id, a]));
  const afterById = new Map(after.map((a) => [a.id, a]));

  const grantedRaw: RoleAssignment[] = [];
  const revokedRaw: RoleAssignment[] = [];
  const changed: ChangedAssignment[] = [];

  for (const a of after) {
    const prev = beforeById.get(a.id);
    if (!prev) grantedRaw.push(a);
    else if (!sameGrant(prev, a)) changed.push({ scope: a.scope, from: prev, to: a });
  }
  for (const b of before) {
    if (!afterById.get(b.id)) revokedRaw.push(b);
  }

  // Pair a revoke and a grant on the same scope into one "changed" entry.
  const granted: RoleAssignment[] = [];
  const revoked = [...revokedRaw];
  for (const g of grantedRaw) {
    const idx = revoked.findIndex((r) => r.scope === g.scope);
    if (idx >= 0) {
      changed.push({ scope: g.scope, from: revoked[idx], to: g });
      revoked.splice(idx, 1);
    } else {
      granted.push(g);
    }
  }

  return { granted, revoked, changed };
}

function roleName(roleId: string): string {
  return getBuiltInRoles().find((r) => r.id === roleId)?.name ?? roleId;
}

function scopeLabel(scope: string): string {
  const known = STATIC_SCOPES.find((s) => s.value === scope);
  return known ? `${known.label} (${scope})` : scope;
}

/** One human line for a grant: role, where, and any effect/expiry caveats. */
function describe(a: RoleAssignment): string {
  const parts = [`${roleName(a.roleId)} at ${scopeLabel(a.scope)}`];
  if (effectOf(a) === "Deny") parts.push("(Deny)");
  if (a.expiresAt) parts.push(isAssignmentExpired(a) ? "(already expired)" : `(expires ${a.expiresAt})`);
  return parts.join(" ");
}

/** Pick the subject verb from the shape of the change. */
function subjectFor(diff: RoleAssignmentDiff): string {
  const onlyGranted = diff.revoked.length === 0 && diff.changed.length === 0;
  const onlyRevoked = diff.granted.length === 0 && diff.changed.length === 0;
  if (onlyGranted) return "Your InfraWeaver access was granted";
  if (onlyRevoked) return "Your InfraWeaver access was revoked";
  return "Your InfraWeaver access was changed";
}

export function buildRbacChangeEmail(displayName: string, diff: RoleAssignmentDiff): { subject: string; text: string; html: string } {
  const subject = subjectFor(diff);

  const textLines: string[] = [`Hi ${displayName},`, "", "Your access on InfraWeaver was updated:", ""];
  const htmlSections: string[] = [];

  if (diff.granted.length) {
    textLines.push("Granted:");
    for (const a of diff.granted) textLines.push(`  • ${describe(a)}`);
    textLines.push("");
    htmlSections.push(section("Granted", diff.granted.map(describe), "#16a34a"));
  }
  if (diff.revoked.length) {
    textLines.push("Revoked:");
    for (const a of diff.revoked) textLines.push(`  • ${describe(a)}`);
    textLines.push("");
    htmlSections.push(section("Revoked", diff.revoked.map(describe), "#dc2626"));
  }
  if (diff.changed.length) {
    textLines.push("Changed:");
    for (const c of diff.changed) textLines.push(`  • At ${scopeLabel(c.scope)}: ${roleName(c.from.roleId)} → ${roleName(c.to.roleId)}`);
    textLines.push("");
    htmlSections.push(
      section("Changed", diff.changed.map((c) => `At ${scopeLabel(c.scope)}: <strong>${roleName(c.from.roleId)}</strong> → <strong>${roleName(c.to.roleId)}</strong>`), "#d97706"),
    );
  }

  textLines.push("If you did not expect this change, contact your platform administrator.");
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#0f172a">`,
    `<p>Hi ${displayName},</p>`,
    `<p>Your access on <strong>InfraWeaver</strong> was updated:</p>`,
    htmlSections.join(""),
    `<p style="font-size:12px;color:#94a3b8">If you did not expect this change, contact your platform administrator.</p>`,
    `</div>`,
  ].join("");

  return { subject, text: textLines.join("\n"), html };
}

function section(title: string, items: string[], color: string): string {
  const lis = items.map((i) => `<li>${i}</li>`).join("");
  return `<p style="margin:0 0 4px"><strong style="color:${color}">${title}</strong></p><ul style="margin:0 0 12px">${lis}</ul>`;
}

/**
 * Email the affected user a summary of how their role assignments changed. Resolves
 * their address from users.yaml; a no-op (not an error) when the diff is empty, mail
 * is unconfigured, or the user has no address. Never throws — safe to fire-and-forget
 * from an RBAC write path.
 */
export async function notifyRoleAssignmentChangeByEmail(input: {
  username: string;
  before: RoleAssignment[];
  after: RoleAssignment[];
}): Promise<void> {
  try {
    const diff = diffRoleAssignments(input.before, input.after);
    if (isEmptyDiff(diff)) return;
    if (!isMailerConfigured()) {
      console.warn(`[rbac-email] mail not configured; skipped change notice for '${input.username}'`);
      return;
    }
    const cfg = await loadUsersConfig();
    const user = cfg.users[input.username];
    const to = (user?.email ?? "").trim();
    if (!to) {
      console.warn(`[rbac-email] no email on file for '${input.username}'; change notice skipped`);
      return;
    }
    const { subject, text, html } = buildRbacChangeEmail(user?.name ?? input.username, diff);
    await sendMail({ to, subject, text, html });
  } catch (err) {
    console.error(`[rbac-email] failed to send change notice for '${input.username}':`, err instanceof Error ? err.message : err);
  }
}
