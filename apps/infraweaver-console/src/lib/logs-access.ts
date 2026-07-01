/**
 * @/lib/logs-access — Core scoped-RBAC gate for logs/metrics targets.
 *
 * These helpers answer "can this user see pods in this namespace?" and build
 * the per-user access context. They gate CORE logs/metrics routes, so they
 * live in core (not the gamehub addon) and depend only on @/lib/rbac and
 * @/lib/users-config. The gamehub addon re-exports these from here.
 */
import type { Session } from "next-auth";
import { getRole, hasPermission, type RoleAssignment } from "@/lib/rbac";
import { getRoleAssignmentsForSession } from "@/lib/users-config";

export const GAME_HUB_NAMESPACE = "game-hub";

export async function getGameHubAccessContext(session: Session | null, revalidateSeconds = 60) {
  const groups: string[] = (session?.user as { groups?: string[] } | undefined)?.groups ?? [];
  const { username, roleAssignments } = await getRoleAssignmentsForSession(session, revalidateSeconds);
  return {
    groups,
    username,
    roleAssignments,
    isAdmin: getRole(groups) === "admin",
  };
}

export function gameHubScope(serverName: string): string {
  return `/game-hub/servers/${serverName}`;
}

export function getScopedGameServerNames(roleAssignments: RoleAssignment[]): string[] {
  const scoped = new Set<string>();
  for (const assignment of roleAssignments) {
    const match = assignment.scope.match(/^\/game-hub\/servers\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
    if (match) scoped.add(match[1]);
  }
  return [...scoped];
}

export function canAccessLogsTarget(
  groups: string[],
  username: string,
  roleAssignments: RoleAssignment[],
  namespace: string,
  pod: string,
): boolean {
  if (getRole(groups) === "admin") return true;
  if (
    hasPermission(groups, "cluster:read", roleAssignments, "/", username)
    || hasPermission(groups, "infra:read", roleAssignments, "/", username)
  ) {
    return true;
  }
  if (namespace !== GAME_HUB_NAMESPACE) return false;
  if (hasPermission(groups, "game-hub:read", roleAssignments, "/game-hub/", username)) {
    return true;
  }
  return getScopedGameServerNames(roleAssignments).some((serverName) => {
    if (pod !== serverName && !pod.startsWith(`${serverName}-`)) return false;
    return hasPermission(groups, "game-hub:read", roleAssignments, gameHubScope(serverName), username);
  });
}
