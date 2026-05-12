export interface QuickCommand {
  label: string;
  /** Preferred field for the command string (new eggs should use this) */
  cmd?: string;
  /** Legacy field - kept for backward compat; getQuickCommandStr prefers cmd */
  command?: string;
  color?: string;
  description?: string;
}

export function getQuickCommandStr(q: QuickCommand): string {
  return (q.cmd ?? q.command ?? "").trim();
}

export interface SavedCommand {
  id: string;
  label: string;
  cmd: string;
  color?: string;
  description?: string;
}

export interface GameEgg {
  id: string;
  name: string;
  description: string;
  dockerImage: string;
  startupCommand: string;
  stopCommand: string;
  queryPort?: number;
  gamePort: number;
  mountPath: string;
  environment: Array<{
    name: string;
    description: string;
    defaultValue: string;
    required: boolean;
  }>;
  quickCommands: QuickCommand[];
  commandAcl?: Record<string, string[]>;
  installScriptUrl?: string;
  protocol?: "TCP" | "UDP";
  ports?: Array<{ name: string; port: number; protocol: "TCP" | "UDP" }>;
  defaultMemory?: string;
  defaultCpu?: string;
  defaultStorage?: string;
  supportsModrinth?: boolean;
  connectionHint?: string;
}

function defaultCommandAcl(egg: Pick<GameEgg, "quickCommands">): Record<string, string[]> {
  const quick = egg.quickCommands.map((entry) => getQuickCommandStr(entry)).filter(Boolean);
  return {
    "game-server-viewer": [...new Set(["list", "players", "playing", ...quick.filter((command) => /^(list|players|playing)/.test(command))])],
    "game-server-operator": [...new Set(["list", "players", "playing", "time set day", "weather clear", ...quick])],
    "game-server-admin": ["*"],
  };
}

const minecraftJava: GameEgg = {
  id: "minecraft-java",
  name: "Minecraft Java Edition",
  description: "Vanilla Minecraft Java Edition server",
  dockerImage: "itzg/minecraft-server:latest",
  startupCommand: "java -Xmx{{MEMORY}} -Xms{{MEMORY}} -jar server.jar nogui",
  stopCommand: "stop",
  gamePort: 25565,
  queryPort: 25565,
  mountPath: "/data",
  protocol: "TCP",
  ports: [{ name: "game", port: 25565, protocol: "TCP" }],
  defaultMemory: "2Gi",
  defaultCpu: "1",
  defaultStorage: "10Gi",
  supportsModrinth: true,
  environment: [
    { name: "EULA", description: "Accept EULA", defaultValue: "TRUE", required: true },
    { name: "TYPE", description: "Server type (VANILLA, PAPER, SPIGOT)", defaultValue: "PAPER", required: false },
    { name: "VERSION", description: "Minecraft version", defaultValue: "LATEST", required: false },
    { name: "MEMORY", description: "Memory allocation", defaultValue: "2G", required: false },
    { name: "MOTD", description: "Message of the Day", defaultValue: "A Minecraft Server", required: false },
    { name: "MAX_PLAYERS", description: "Maximum players", defaultValue: "20", required: false },
    { name: "DIFFICULTY", description: "Difficulty (peaceful, easy, normal, hard)", defaultValue: "normal", required: false },
    { name: "GAMEMODE", description: "Game mode (survival, creative, adventure)", defaultValue: "survival", required: false },
    { name: "RCON_PASSWORD", description: "RCON password", defaultValue: "", required: false },
    { name: "ENABLE_RCON", description: "Enable RCON", defaultValue: "true", required: false },
  ],
  quickCommands: [
    { label: "Player List", command: "list", description: "Show online players" },
    { label: "Save World", command: "save-all", description: "Force save the world" },
    { label: "Set Day", command: "time set day", description: "Set time to day" },
    { label: "Set Weather Clear", command: "weather clear", description: "Clear weather" },
    { label: "Server Info", command: "version", description: "Show server version" },
  ],
};

export const GAME_EGGS: Record<string, GameEgg> = {
  "minecraft-java": minecraftJava,
  terraria: {
    id: "terraria",
    name: "Terraria",
    description: "Terraria dedicated server with TShock",
    dockerImage: "ryshe/terraria:latest",
    startupCommand: "/TShock/TShock.Server -port 7777 -world /world/world.wld -autocreate 2",
    stopCommand: "exit",
    gamePort: 7777,
    mountPath: "/world",
    protocol: "TCP",
    ports: [{ name: "game", port: 7777, protocol: "TCP" }],
    defaultMemory: "1Gi",
    defaultCpu: "500m",
    defaultStorage: "5Gi",
    environment: [
      { name: "WORLD_SIZE", description: "World size (1=Small, 2=Medium, 3=Large)", defaultValue: "2", required: false },
      { name: "WORLD_NAME", description: "World name", defaultValue: "World", required: false },
      { name: "MAX_PLAYERS", description: "Maximum players", defaultValue: "16", required: false },
      { name: "SERVER_PASSWORD", description: "Server password", defaultValue: "", required: false },
    ],
    quickCommands: [
      { label: "Players", command: "playing", description: "Show online players" },
      { label: "Save", command: "save", description: "Save the world" },
      { label: "Time (Dawn)", command: "time dawn", description: "Set time to dawn" },
      { label: "Server Info", command: "version", description: "Show server version" },
    ],
  },
  valheim: {
    id: "valheim",
    name: "Valheim",
    description: "Valheim dedicated server",
    dockerImage: "lloesche/valheim-server:latest",
    startupCommand: "/start_server.sh",
    stopCommand: "exit",
    gamePort: 2456,
    queryPort: 2457,
    mountPath: "/config",
    protocol: "UDP",
    ports: [
      { name: "game", port: 2456, protocol: "UDP" },
      { name: "query", port: 2457, protocol: "UDP" },
      { name: "rcon", port: 2458, protocol: "TCP" },
    ],
    defaultMemory: "4Gi",
    defaultCpu: "2",
    defaultStorage: "10Gi",
    environment: [
      { name: "SERVER_NAME", description: "Server name", defaultValue: "My Valheim Server", required: false },
      { name: "WORLD_NAME", description: "World name", defaultValue: "Dedicated", required: false },
      { name: "SERVER_PASS", description: "Server password", defaultValue: "", required: false },
      { name: "SERVER_PUBLIC", description: "Publicly visible", defaultValue: "false", required: false },
    ],
    quickCommands: [
      { label: "Players", command: "players", description: "Show online players" },
      { label: "Save", command: "save", description: "Save the world" },
    ],
  },
  satisfactory: {
    id: "satisfactory",
    name: "Satisfactory",
    description: "Satisfactory dedicated server",
    dockerImage: "wolveix/satisfactory-server:latest",
    startupCommand: "/usr/games/steamcmd/games/satisfactory/FactoryGame/Binaries/Linux/UnrealServer-Linux-Shipping FactoryGame -multihome=0.0.0.0 -ServerQueryPort=15777 -BeaconPort=15000 -Port=7777",
    stopCommand: "exit",
    gamePort: 7777,
    queryPort: 15777,
    mountPath: "/config",
    protocol: "UDP",
    ports: [
      { name: "game", port: 7777, protocol: "UDP" },
      { name: "beacon", port: 15000, protocol: "UDP" },
      { name: "query", port: 15777, protocol: "UDP" },
    ],
    defaultMemory: "12Gi",
    defaultCpu: "4",
    defaultStorage: "15Gi",
    environment: [
      { name: "STEAMBETA", description: "Use Steam beta", defaultValue: "false", required: false },
      { name: "MAXPLAYERS", description: "Max players", defaultValue: "4", required: false },
    ],
    quickCommands: [],
  },
  "v-rising": {
    id: "v-rising",
    name: "V Rising",
    description: "V Rising dedicated server",
    dockerImage: "trueosiris/vrising:latest",
    startupCommand: "/opt/vrising/VRisingServer",
    stopCommand: "exit",
    gamePort: 9876,
    queryPort: 9877,
    mountPath: "/config",
    protocol: "UDP",
    ports: [
      { name: "game", port: 9876, protocol: "UDP" },
      { name: "query", port: 9877, protocol: "UDP" },
    ],
    defaultMemory: "6Gi",
    defaultCpu: "2",
    defaultStorage: "10Gi",
    environment: [
      { name: "TZ", description: "Timezone", defaultValue: "UTC", required: false },
    ],
    quickCommands: [],
  },
  palworld: {
    id: "palworld",
    name: "Palworld",
    description: "Palworld dedicated server",
    dockerImage: "thijsvanloef/palworld-server-docker:latest",
    startupCommand: "/usr/local/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf",
    stopCommand: "exit",
    gamePort: 8211,
    mountPath: "/palworld",
    protocol: "UDP",
    ports: [
      { name: "game", port: 8211, protocol: "UDP" },
      { name: "query", port: 27015, protocol: "UDP" },
    ],
    defaultMemory: "16Gi",
    defaultCpu: "4",
    defaultStorage: "20Gi",
    environment: [
      { name: "PLAYERS", description: "Max players", defaultValue: "16", required: false },
      { name: "SERVER_NAME", description: "Server name", defaultValue: "worldofpals", required: false },
      { name: "SERVER_PASSWORD", description: "Server password", defaultValue: "", required: false },
      { name: "ADMIN_PASSWORD", description: "Admin password", defaultValue: "", required: false },
      { name: "MULTITHREADING", description: "Enable multithreading", defaultValue: "true", required: false },
    ],
    quickCommands: [],
  },
  rust: {
    id: "rust",
    name: "Rust",
    description: "Rust dedicated server",
    dockerImage: "didstopia/rust-server:latest",
    startupCommand: "/start.sh",
    stopCommand: "quit",
    gamePort: 28015,
    queryPort: 28017,
    mountPath: "/steamcmd/rust",
    protocol: "UDP",
    ports: [
      { name: "game", port: 28015, protocol: "UDP" },
      { name: "rcon", port: 28016, protocol: "TCP" },
      { name: "query", port: 28017, protocol: "TCP" },
    ],
    defaultMemory: "8Gi",
    defaultCpu: "4",
    defaultStorage: "20Gi",
    environment: [
      { name: "RUST_SERVER_STARTUP_ARGUMENTS", description: "Startup arguments", defaultValue: "-batchmode -load +server.secure 1", required: false },
      { name: "RUST_SERVER_IDENTITY", description: "Server identity", defaultValue: "docker", required: false },
      { name: "RUST_SERVER_SEED", description: "Map seed", defaultValue: "12345", required: false },
      { name: "RUST_SERVER_NAME", description: "Server name", defaultValue: "My Rust Server", required: false },
      { name: "RUST_SERVER_DESCRIPTION", description: "Server description", defaultValue: "", required: false },
    ],
    quickCommands: [
      { label: "Players", command: "global.status", description: "Show server status" },
      { label: "Save", command: "server.save", description: "Save game" },
    ],
  },
  ark: {
    id: "ark",
    name: "ARK: Survival Evolved",
    description: "ARK: Survival Evolved dedicated server",
    dockerImage: "hermsi1337/docker-ark-server:latest",
    startupCommand: "/home/steam/ark-server/ShooterGame/Binaries/Linux/ShooterGameServer TheIsland",
    stopCommand: "exit",
    gamePort: 7777,
    queryPort: 27015,
    mountPath: "/ark",
    protocol: "UDP",
    ports: [
      { name: "game", port: 7777, protocol: "UDP" },
      { name: "query", port: 27015, protocol: "UDP" },
    ],
    defaultMemory: "8Gi",
    defaultCpu: "4",
    defaultStorage: "30Gi",
    environment: [
      { name: "MAX_PLAYERS", description: "Max players", defaultValue: "70", required: false },
      { name: "SERVER_NAME", description: "Server name", defaultValue: "ARK Server", required: false },
      { name: "SERVER_PASSWORD", description: "Server password", defaultValue: "", required: false },
      { name: "ADMIN_PASSWORD", description: "Admin password", defaultValue: "", required: false },
      { name: "MAP", description: "Map name", defaultValue: "TheIsland", required: false },
    ],
    quickCommands: [
      { label: "Save", command: "saveworld", description: "Save the world" },
    ],
  },
  cs2: {
    id: "cs2",
    name: "Counter-Strike 2",
    description: "CS2 dedicated server",
    dockerImage: "joedwards32/cs2:latest",
    startupCommand: "/home/user/cs2/game/bin/linuxsteamrt64/cs2 -dedicated",
    stopCommand: "quit",
    gamePort: 27015,
    mountPath: "/home/user/cs2",
    protocol: "UDP",
    ports: [
      { name: "game", port: 27015, protocol: "UDP" },
      { name: "game-tcp", port: 27015, protocol: "TCP" },
    ],
    defaultMemory: "4Gi",
    defaultCpu: "2",
    defaultStorage: "40Gi",
    environment: [
      { name: "CS2_SERVERNAME", description: "Server name", defaultValue: "My CS2 Server", required: false },
      { name: "CS2_MAXPLAYERS", description: "Max players", defaultValue: "10", required: false },
      { name: "CS2_PORT", description: "Server port", defaultValue: "27015", required: false },
      { name: "CS2_RCON_PORT", description: "RCON port", defaultValue: "27015", required: false },
      { name: "CS2_RCONPW", description: "RCON password", defaultValue: "", required: false },
    ],
    quickCommands: [
      { label: "Status", command: "status", description: "Server status" },
    ],
  },
  factorio: {
    id: "factorio",
    name: "Factorio",
    description: "Factorio headless server",
    dockerImage: "factoriotools/factorio:latest",
    startupCommand: "/docker-entrypoint.sh",
    stopCommand: "exit",
    gamePort: 34197,
    mountPath: "/factorio",
    protocol: "UDP",
    ports: [{ name: "game", port: 34197, protocol: "UDP" }],
    defaultMemory: "2Gi",
    defaultCpu: "1",
    defaultStorage: "10Gi",
    environment: [
      { name: "TOKEN", description: "Factorio game token", defaultValue: "", required: false },
      { name: "GENERATE_NEW_SAVE", description: "Generate new save", defaultValue: "true", required: false },
      { name: "SAVE_NAME", description: "Save name", defaultValue: "default", required: false },
    ],
    quickCommands: [
      { label: "Players", command: "/players", description: "List players" },
      { label: "Save", command: "/server-save", description: "Save the game" },
    ],
  },
};

export const BUILT_IN_EGGS = Object.values(GAME_EGGS);

const EGG_ALIASES: Record<string, string> = {
  minecraft: "minecraft-java",
  vrising: "v-rising",
};

export function getEggForGameType(gameType: string): GameEgg {
  const normalized = (gameType || "").toLowerCase();
  const alias = EGG_ALIASES[normalized] ?? normalized;
  const egg = GAME_EGGS[alias] ?? {
    id: "generic",
    name: gameType || "Game Server",
    description: "Generic game server",
    dockerImage: "ubuntu:22.04",
    startupCommand: "/start.sh",
    stopCommand: "exit",
    gamePort: 25565,
    mountPath: "/data",
    environment: [],
    quickCommands: [],
    protocol: "TCP",
    ports: [{ name: "game", port: 25565, protocol: "TCP" }],
    defaultMemory: "1Gi",
    defaultCpu: "500m",
    defaultStorage: "10Gi",
  };

  return {
    ...egg,
    commandAcl: egg.commandAcl ?? defaultCommandAcl(egg),
  };
}

export function getEggPorts(egg: GameEgg): Array<{ name: string; port: number; protocol: "TCP" | "UDP" }> {
  if (egg.ports?.length) return egg.ports;
  const ports = [{ name: "game", port: egg.gamePort, protocol: egg.protocol ?? "TCP" }];
  if (egg.queryPort && egg.queryPort !== egg.gamePort) {
    ports.push({ name: "query", port: egg.queryPort, protocol: egg.protocol ?? "TCP" });
  }
  return ports;
}

export function getEggEnvironmentDefaults(egg: GameEgg): Record<string, string> {
  return Object.fromEntries(egg.environment.map((entry) => [entry.name, entry.defaultValue]));
}

export function buildEggConfigMap(
  namespace: string,
  serverName: string,
  egg: GameEgg,
  customEnv: Record<string, string> = {}
): object {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `gameserver-${serverName}-egg`,
      namespace,
      labels: {
        "infraweaver.io/type": "game-egg",
        "infraweaver.io/game-type": egg.id,
        "infraweaver.io/server-name": serverName,
      },
    },
    data: {
      "egg.json": JSON.stringify(
        {
          ...egg,
          commandAcl: egg.commandAcl ?? defaultCommandAcl(egg),
          environment: egg.environment.map((entry) => ({
            ...entry,
            defaultValue: customEnv[entry.name] ?? entry.defaultValue,
          })),
        },
        null,
        2
      ),
    },
  };
}
