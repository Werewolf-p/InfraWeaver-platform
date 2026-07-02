import { hasPermission, type Permission, type RoleAssignment } from "@/lib/rbac";
import { getEggForGameType, getQuickCommandStr, inferSaveCommands, type GameEgg, type QuickCommand } from "./game-eggs";
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

/**
 * Per-server egg ConfigMaps written before save-command metadata existed have
 * no save/quiesce fields, so backups silently skipped the world flush.
 * Re-infer any missing fields on every read so legacy ConfigMaps behave like
 * freshly imported eggs; explicitly stored values always win.
 */
function withInferredSaveCommands(egg: GameEgg, gameType: string): GameEgg {
  const inferred = inferSaveCommands(
    `${egg.name ?? ""} ${egg.id ?? ""} ${gameType}`,
    egg.stopCommand ?? "",
  );
  return {
    ...egg,
    saveCommand: egg.saveCommand ?? inferred.saveCommand,
    saveOffCommand: egg.saveOffCommand ?? inferred.saveOffCommand,
    saveOnCommand: egg.saveOnCommand ?? inferred.saveOnCommand,
    stopSavesWorld: egg.stopSavesWorld ?? inferred.stopSavesWorld,
  };
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
      return withInferredSaveCommands(parsed, gameType);
    } catch {
      // fall through
    }
  }
  return getEggForGameType(gameType);
}
