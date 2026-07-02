/**
 * `ensureAppAccessGroup` / `syncAppAccessMembers` / `removeAppAccessGroup` — the
 * reusable capability that restricts an Authentik application to an explicit set
 * of users, with no manual Authentik steps.
 *
 * An Authentik application with no bindings admits every authenticated user; a
 * group PolicyBinding narrows it to that group's members. We therefore front any
 * gated host with a dedicated access Group bound to its application(s), and drive
 * the group's membership from the owning system's own authorization model. Like
 * `ensureSsoGate`, this is consumer-agnostic: WordPress and any future addon share it.
 */
import { AuthentikClient } from "./authentik-client";

export interface AppAccessInput {
  /** Stable, unique Authentik group name for this resource, e.g. `wordpress-blog-access`. */
  groupName: string;
  /** Application slugs to restrict to the group (e.g. the OIDC app and its `-gate`). */
  appSlugs: string[];
}

export interface AccessSyncResult {
  /** Usernames whose Authentik account was found and placed in the group. */
  applied: string[];
  /** Usernames with no matching Authentik account (never signed in); skipped, not fatal. */
  unknown: string[];
}

/**
 * Ensure the access group exists and is bound to every application in `appSlugs`
 * that currently exists. Binding an application to the group is what actually
 * restricts it, so a caller enables gating by calling this once SSO is provisioned.
 * Idempotent; slugs whose application does not yet exist are silently skipped
 * (bind on a later call once the app is created).
 */
export async function ensureAppAccessGroup(input: AppAccessInput): Promise<{ groupPk: string }> {
  const client = AuthentikClient.fromEnv();
  const groupPk = await client.ensureGroup(input.groupName);
  for (const slug of input.appSlugs) {
    const app = await client.findApplication(slug);
    if (app) await client.bindGroupToApplication(app.pk, groupPk);
  }
  return { groupPk };
}

/**
 * Reconcile the access group's membership to EXACTLY `usernames`. Removing a
 * username here revokes that person's access to every application bound to the
 * group. Unknown Authentik usernames are reported, not fatal.
 */
export async function syncAppAccessMembers(groupName: string, usernames: readonly string[]): Promise<AccessSyncResult> {
  const client = AuthentikClient.fromEnv();
  const groupPk = await client.ensureGroup(groupName);
  const { resolved, unknown } = await client.resolveUserPks(usernames);
  await client.setGroupUsers(groupPk, [...resolved.values()]);
  return { applied: [...resolved.keys()], unknown };
}

/** Delete the access group (and, with it, its application bindings). Idempotent. */
export async function removeAppAccessGroup(groupName: string): Promise<void> {
  const client = AuthentikClient.fromEnv();
  await client.deleteGroup(groupName);
}
