import { hasPermission, type Permission, type RoleAssignment } from "@/lib/rbac";
import { getEggForGameType, getQuickCommandStr, type GameEgg, type QuickCommand } from "./game-eggs";
// Core scoped-RBAC gate + access context now live in @/lib/logs-access.
// Re-export them here so existing gamehub importers keep working.
export {
  GAME_HUB_NAMESPACE,
  getGameHubAccessContext,
  gameHubScope,
  getScopedGameServerNames,
  canAccessLogsTarget,
} from "@/lib/logs-access";
import { gameHubScope } from "@/lib/logs-access";

export function hasGameHubPermission(
  groups: string[],
  username: string,
  roleAssignments: RoleAssignment[],
  permission: Permission,
  serverName: string,
) {
  return hasPermission(groups, permission, roleAssignments, gameHubScope(serverName), username);
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
