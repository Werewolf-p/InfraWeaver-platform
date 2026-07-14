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
import { resolveAuthentikIdentity } from "@/lib/users/resolve-identity";
import { createEnrollmentInvitation, hasLiveInvitationForEmail } from "@/lib/authentik-invite";
import { isMailerConfigured, sendInviteEmail } from "@/lib/mailer";
import { isNasScope } from "@/lib/nas/scope";
import { computeStorageGroupsByUser, syncStorageScopesUnder } from "@/lib/nas/access";
import { isJellyfinScope, JELLYFIN_SCOPE, reconcileJellyfinAccessWithRetry } from "@/lib/jellyfin/access";
import { isNextcloudConfigured } from "@/lib/nextcloud/config";
import { ensureNextcloudUserProvisioned } from "@/lib/nextcloud/provision";
import { bridgeEnrollmentGrants } from "@/lib/users/enrollment-grants";
import { errorMessage } from "@/lib/utils";

export interface UsersReconcileSummary {
  /** Users whose invite-chosen access presets were materialized into users.yaml this run. */
  enrollmentGrantsSeeded: string[];
  /** Users who had an enrollment invite auto-sent this run. */
  invited: string[];
  /** Users with an outstanding invite, awaiting the person to enroll. */
  pendingEnrollment: string[];
  /** Users whose Authentik identity already exists (enrolled). */
  enrolled: string[];
  /** Storage scopes whose access groups were reconciled. */
  storageScopesReconciled: string[];
  /** Enrolled users whose Nextcloud account was proactively created this run. */
  nextcloudProvisioned: string[];
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
  // First, bridge any invite-chosen access presets that landed on freshly enrolled
  // accounts (as `attributes.iw_roles`) into users.yaml grants, keyed by the actual
  // username. Runs BEFORE the config is read so the seeded grants converge THIS tick.
  // Best-effort — a bridge failure must never abort the reconcile.
  let enrollmentGrantsSeeded: string[] = [];
  try {
    enrollmentGrantsSeeded = await bridgeEnrollmentGrants();
  } catch {
    // swallowed; grants re-seed next tick (idempotent)
  }

  const cfg = await loadUsersConfig();
  const summary: UsersReconcileSummary = {
    enrollmentGrantsSeeded,
    invited: [],
    pendingEnrollment: [],
    enrolled: [],
    storageScopesReconciled: [],
    nextcloudProvisioned: [],
    jellyfinReconciled: false,
    skippedNoEmail: [],
    errors: [],
  };

  const storageScopes = new Set<string>();
  let anyJellyfinGrant = false;
  // Enrolled users (Authentik identity exists) with an email — candidates for
  // proactive Nextcloud provisioning once the storage access groups are reconciled.
  // The storage-group lookup below filters this to those who actually hold storage
  // access (directly or via a group grant), so no per-user grant flag is needed here.
  // `username` is the canonical Authentik username (used to create app accounts);
  // `yamlKey` is the users.yaml key the grants/storage-groups are computed under (equal
  // in the normal case; differ only when a hand-entered key drifted from the real one).
  const enrolledUsers: Array<{ username: string; yamlKey: string; email: string; displayName?: string }> = [];

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
      // Enrollment identity: match by the users.yaml key first, then fall back to the
      // EMAIL. Authentik is the source of truth for the username (the person chooses it
      // at enrollment); resolving by email yields their real account even if the
      // users.yaml key was hand-entered differently. The canonical Authentik username is
      // then what downstream provisioning uses, so Nextcloud + Jellyfin accounts are
      // created under the SAME username as the SSO identity — never a drifted key.
      const identity = await resolveAuthentikIdentity(username, user.email);
      if (identity) {
        const canonical = typeof identity.username === "string" && identity.username ? identity.username : username;
        summary.enrolled.push(canonical);
        enrolledUsers.push({ username: canonical, yamlKey: username, email: user.email, ...(user.name ? { displayName: user.name } : {}) });
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

  // Proactive Nextcloud provisioning. The access groups are now reconciled, so an
  // enrolled user's grant-derived storage groups are known; materialize their
  // Nextcloud account (Database backend) in exactly those groups so WebDAV/native
  // clients and credential reveal work immediately — without waiting for the person
  // to complete a browser OIDC login (which is all the JIT path would otherwise give
  // them). Idempotent: an already-present account (JIT or a prior tick) is only
  // re-checked for group membership; its password is never reset. Gated on NC being
  // configured so a dev/test env without OCS creds simply skips this.
  if (isNextcloudConfigured() && enrolledUsers.length > 0 && summary.storageScopesReconciled.length > 0) {
    let groupsByUser: Map<string, string[]>;
    try {
      groupsByUser = await computeStorageGroupsByUser();
    } catch (e) {
      groupsByUser = new Map();
      summary.errors.push({ subject: "nextcloud:groups", error: errorMessage(e) });
    }
    for (const { username, yamlKey, email, displayName } of enrolledUsers) {
      // Groups are computed under the users.yaml key; the NC account is created under the
      // canonical Authentik username. They match in the normal case; the fallback keeps a
      // drifted key working.
      const groups = groupsByUser.get(yamlKey) ?? groupsByUser.get(username);
      if (!groups || groups.length === 0) continue; // no storage access → no NC account needed
      try {
        const result = await ensureNextcloudUserProvisioned({ username, email, displayName, groups });
        if (result.created) {
          summary.nextcloudProvisioned.push(username);
          await auditLog(
            "users:nextcloud-provision",
            "infraweaver",
            `Provisioned Nextcloud account '${username}' in ${result.groups.length} storage group(s)`,
            { resource: username, result: "success" },
          );
        }
      } catch (e) {
        summary.errors.push({ subject: `nextcloud:${username}`, error: errorMessage(e) });
      }
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
