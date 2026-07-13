/**
 * Users reconcile — the controller loop that makes provisioning fully automated
 * from `users.yaml` + its RBAC grants alone. SERVER ONLY.
 *
 * Declarative convergence (the k8s-controller pattern): each tick reads the
 * desired state (`users.yaml`) and drives the world toward it, idempotently, with
 * no human step. Run it on a schedule (the `users-reconcile` CronJob) AND after an
 * RBAC change, so the two together give eventual consistency without a blocking
 * wait.
 *
 * Per user:
 *   - No Authentik login identity yet, and no live enrollment invitation out →
 *     auto-create + email an enrollment invite (this is what was missing: adding a
 *     user to the file now delivers their Authentik setup mail with zero operator
 *     action). A single-use invite already outstanding → leave it (avoid re-spam);
 *     it re-sends only once expired/consumed.
 *   - Identity exists (enrolled) → nothing to invite; their app access converges
 *     below.
 *
 * Then, once per tick, the app-account reconciles run for every distinct granted
 * scope. These are idempotent and self-heal the dependency ordering: a user who
 * only just enrolled (so wasn't in an Authentik group when their grant was first
 * applied) gets their storage group membership attached on THIS tick — which is
 * how "continue provisioning once the Authentik account is made" happens without
 * an enrollment webhook. Nextcloud users are JIT-provisioned over OIDC on first
 * login into the groups set here, so no NC write is forced.
 */
import "server-only";
import { auditLog } from "@/lib/audit-log";
import { loadUsersConfig } from "@/lib/users-config";
import { findUserByUsername } from "@/lib/authentik";
import { createEnrollmentInvitation, hasLiveInvitationForEmail } from "@/lib/authentik-invite";
import { isMailerConfigured, sendInviteEmail } from "@/lib/mailer";
import { isNasScope } from "@/lib/nas/scope";
import { syncStorageScopesUnder } from "@/lib/nas/access";
import { isJellyfinScope, JELLYFIN_SCOPE, reconcileJellyfinAccessWithRetry } from "@/lib/jellyfin/access";
import { errorMessage } from "@/lib/utils";

export interface UsersReconcileSummary {
  /** Users who had an enrollment invite auto-sent this run. */
  invited: string[];
  /** Users with an outstanding invite, awaiting the person to enroll. */
  pendingEnrollment: string[];
  /** Users whose Authentik identity already exists (enrolled). */
  enrolled: string[];
  /** Storage scopes whose access groups were reconciled. */
  storageScopesReconciled: string[];
  /** Whether the Jellyfin scope was reconciled this run. */
  jellyfinReconciled: boolean;
  /** Users skipped because they have no email (cannot invite/notify). */
  skippedNoEmail: string[];
  /** Non-fatal per-item failures; the run still completes. */
  errors: Array<{ subject: string; error: string }>;
}

/**
 * Converge every user in `users.yaml` toward its desired state. Best-effort per
 * user: one user's failure is recorded and never aborts the rest.
 */
export async function reconcileUsers(): Promise<UsersReconcileSummary> {
  const cfg = await loadUsersConfig();
  const summary: UsersReconcileSummary = {
    invited: [],
    pendingEnrollment: [],
    enrolled: [],
    storageScopesReconciled: [],
    jellyfinReconciled: false,
    skippedNoEmail: [],
    errors: [],
  };

  const storageScopes = new Set<string>();
  let anyJellyfinGrant = false;

  for (const [username, user] of Object.entries(cfg.users)) {
    // Collect granted app scopes for the convergence pass below, regardless of
    // enrollment state (Jellyfin is username-keyed and provisions even pre-enroll;
    // storage group membership no-ops for a not-yet-existing identity and attaches
    // on the tick after the user enrolls).
    for (const grant of user.role_assignments ?? []) {
      if (isNasScope(grant.scope)) storageScopes.add(grant.scope);
      if (isJellyfinScope(grant.scope)) anyJellyfinGrant = true;
    }

    if (!user.email) {
      summary.skippedNoEmail.push(username);
      continue;
    }

    try {
      const identity = await findUserByUsername(username);
      if (identity) {
        summary.enrolled.push(username);
        continue;
      }
      // No Authentik login yet — ensure exactly one enrollment invite is out.
      if (await hasLiveInvitationForEmail(user.email)) {
        summary.pendingEnrollment.push(username);
        continue;
      }
      if (!isMailerConfigured()) {
        summary.errors.push({ subject: username, error: "SMTP not configured; cannot auto-send enrollment invite" });
        continue;
      }
      const groups = Array.isArray(user.authentik_groups)
        ? user.authentik_groups.filter((g): g is string => typeof g === "string")
        : [];
      const { url } = await createEnrollmentInvitation({ email: user.email, groups, expiryHours: 168 });
      await sendInviteEmail(user.email, url);
      await auditLog(
        "users:auto-invite",
        "infraweaver",
        `Auto-sent enrollment invite to ${user.email} for '${username}' (no Authentik identity yet)`,
        { resource: username, result: "success" },
      );
      summary.invited.push(username);
    } catch (e) {
      summary.errors.push({ subject: username, error: errorMessage(e) });
    }
  }

  // Convergence pass: idempotent app-account reconciles for every granted scope.
  // Reconciles the Authentik access-group membership (and thus Nextcloud folder
  // visibility on next login) and materializes Jellyfin accounts.
  for (const scope of storageScopes) {
    try {
      await syncStorageScopesUnder(scope);
      summary.storageScopesReconciled.push(scope);
    } catch (e) {
      summary.errors.push({ subject: `storage:${scope}`, error: errorMessage(e) });
    }
  }
  if (anyJellyfinGrant) {
    try {
      await reconcileJellyfinAccessWithRetry(JELLYFIN_SCOPE);
      summary.jellyfinReconciled = true;
    } catch (e) {
      summary.errors.push({ subject: "jellyfin", error: errorMessage(e) });
    }
  }

  return summary;
}

/**
 * Ensure a single user has an enrollment invite out if they have no Authentik
 * identity yet. Called right after an RBAC grant so adding access to a brand-new
 * person delivers their setup mail immediately, without waiting for the next cron
 * tick. Never throws — a delivery failure is audited and swallowed so it cannot
 * fail the grant that triggered it. Returns true iff an invite was sent.
 */
export async function ensureEnrollmentInviteFor(username: string): Promise<boolean> {
  try {
    const cfg = await loadUsersConfig();
    const user = cfg.users[username];
    if (!user?.email) return false;
    if (await findUserByUsername(username)) return false; // already enrolled
    if (await hasLiveInvitationForEmail(user.email)) return false; // invite already out
    if (!isMailerConfigured()) return false;
    const groups = Array.isArray(user.authentik_groups)
      ? user.authentik_groups.filter((g): g is string => typeof g === "string")
      : [];
    const { url } = await createEnrollmentInvitation({ email: user.email, groups, expiryHours: 168 });
    await sendInviteEmail(user.email, url);
    await auditLog(
      "users:auto-invite",
      "infraweaver",
      `Auto-sent enrollment invite to ${user.email} for '${username}' after RBAC change`,
      { resource: username, result: "success" },
    );
    return true;
  } catch (e) {
    await auditLog(
      "users:auto-invite",
      "infraweaver",
      `Auto-invite for '${username}' failed: ${errorMessage(e)}`,
      { resource: username, result: "failure" },
    ).catch(() => {});
    return false;
  }
}
