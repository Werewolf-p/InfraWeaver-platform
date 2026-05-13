import type { Session } from "next-auth";
import { getRole, hasPermission, type Permission, type RoleAssignment } from "@/lib/rbac";
import { getEggForGameType, getQuickCommandStr, type GameEgg, type QuickCommand } from "@/lib/game-eggs";
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

export function hasGameHubPermission(
  groups: string[],
  username: string,
  roleAssignments: RoleAssignment[],
  permission: Permission,
  serverName: string,
) {
  return hasPermission(groups, permission, roleAssignments, gameHubScope(serverName), username);
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
) {
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

export function parseEggConfig(raw: string | undefined | null, gameType = ""): GameEgg {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as GameEgg;
      if (Array.isArray(parsed.quickCommands)) {
        parsed.quickCommands = parsed.quickCommands.map((q: QuickCommand) => ({
          ...q,
          cmd: getQuickCommandStr(q) || undefined,
        }));
      }
      return parsed;
    } catch {
      // fall through
    }
  }
  return getEggForGameType(gameType);
}
