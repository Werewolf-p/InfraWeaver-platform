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
    fieldType?: "text" | "boolean" | "integer";
    userViewable?: boolean;
    userEditable?: boolean;
    rules?: string;
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
  const readOnlyQuick = quick.filter((command) => /^(list|players|playing|status|help|showplayers|info|\/players|\/help)$/i.test(command));
  return {
    "game-server-viewer": [...new Set(["list", "players", "playing", "status", "help", "ShowPlayers", "Info", "/players", "/help", ...readOnlyQuick])],
    "game-server-operator": [...new Set(["list", "players", "playing", "status", "help", "time set day", "weather clear", ...quick])],
    "game-server-admin": ["*"],
  };
}

function standardQuickCommands(options?: {
  status?: string;
  list?: string;
  help?: string;
}): QuickCommand[] {
  const statusCmd = options?.status ?? "status";
  const listCmd = options?.list ?? "list";
  const helpCmd = options?.help ?? "help";
  const statusLabel = /^(list|players|playing|showplayers|\/players)$/i.test(statusCmd)
    ? "List Players"
    : "Status";

  return [
    {
      label: statusLabel,
      cmd: statusCmd,
      description:
        statusLabel === "List Players"
          ? "List connected players"
          : "Show the current server state",
    },
    ...(statusCmd === listCmd
      ? []
      : [{ label: "List Players", cmd: listCmd, description: "List connected players" }]),
    ...(helpCmd === statusCmd || helpCmd === listCmd
      ? []
      : [{ label: "Help", cmd: helpCmd, description: "Show supported console commands" }]),
  ];
}

const minecraftJava: GameEgg = {
  id: "minecraft-java",
  name: "Minecraft Java Edition",
  description: "Paper-ready Minecraft Java server powered by itzg/minecraft-server",
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
  connectionHint: "Join with the listed host and port in the Minecraft multiplayer browser.",
  environment: [
    { name: "EULA", description: "Accept Mojang's EULA", defaultValue: "TRUE", required: true },
    { name: "TYPE", description: "Server type (VANILLA, PAPER, SPIGOT)", defaultValue: "PAPER", required: false },
    { name: "VERSION", description: "Minecraft version", defaultValue: "LATEST", required: false },
    { name: "MEMORY", description: "Heap size passed to the server JVM", defaultValue: "2G", required: false },
    { name: "MOTD", description: "Message of the Day", defaultValue: "A Minecraft Server", required: false },
    { name: "MAX_PLAYERS", description: "Maximum players", defaultValue: "20", required: false },
    { name: "DIFFICULTY", description: "Difficulty (peaceful, easy, normal, hard)", defaultValue: "normal", required: false },
    { name: "GAMEMODE", description: "Game mode (survival, creative, adventure)", defaultValue: "survival", required: false },
    { name: "ENABLE_RCON", description: "Enable RCON support", defaultValue: "true", required: false },
    { name: "RCON_PASSWORD", description: "RCON password", defaultValue: "", required: false },
  ],
  quickCommands: [
    ...standardQuickCommands({ status: "list", list: "list", help: "help" }),
    { label: "Save World", cmd: "save-all", description: "Force save the world" },
  ],
};

export const GAME_EGGS: Record<string, GameEgg> = {
  "minecraft-java": minecraftJava,
  terraria: {
    id: "terraria",
    name: "Terraria",
    description: "Terraria dedicated server using the terrariad image",
    dockerImage: "ryshe/terrariad:latest",
    startupCommand: "TerrariaServer -world /world/{{WORLD_NAME}}.wld -autocreate {{WORLD_SIZE}} -worldname {{WORLD_NAME}} -port 7777 -maxplayers {{MAX_PLAYERS}}",
    stopCommand: "exit",
    gamePort: 7777,
    mountPath: "/world",
    protocol: "TCP",
    ports: [{ name: "game", port: 7777, protocol: "TCP" }],
    defaultMemory: "1Gi",
    defaultCpu: "500m",
    defaultStorage: "5Gi",
    connectionHint: "Connect from Terraria using the listed host and port.",
    environment: [
      { name: "WORLD_SIZE", description: "World size (1=Small, 2=Medium, 3=Large)", defaultValue: "2", required: false },
      { name: "WORLD_NAME", description: "World name", defaultValue: "World", required: false },
      { name: "WORLD_FILENAME", description: "World file name", defaultValue: "World.wld", required: false },
      { name: "MAX_PLAYERS", description: "Maximum players", defaultValue: "16", required: false },
      { name: "SERVER_PASSWORD", description: "Optional join password", defaultValue: "", required: false },
      { name: "TZ", description: "Container timezone", defaultValue: "UTC", required: false },
    ],
    quickCommands: [
      ...standardQuickCommands({ status: "playing", list: "playing", help: "help" }),
      { label: "Save World", cmd: "save", description: "Save the current world" },
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
    connectionHint: "Use the listed host and UDP game port in the Valheim server browser.",
    environment: [
      { name: "SERVER_NAME", description: "Server name", defaultValue: "My Valheim Server", required: false },
      { name: "WORLD_NAME", description: "World save name", defaultValue: "Dedicated", required: false },
      { name: "SERVER_PASS", description: "Server password", defaultValue: "changeme123", required: false },
      { name: "SERVER_PUBLIC", description: "Advertise to the public server list", defaultValue: "false", required: false },
      { name: "TZ", description: "Container timezone", defaultValue: "UTC", required: false },
    ],
    quickCommands: [
      ...standardQuickCommands({ status: "players", list: "players", help: "help" }),
      { label: "Save World", cmd: "save", description: "Persist the current world state" },
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
    dockerImage: "jammsen/palworld-dedicated-server:latest",
    startupCommand: "./PalServer.sh -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS",
    stopCommand: "DoExit",
    gamePort: 8211,
    queryPort: 27015,
    mountPath: "/palworld",
    protocol: "UDP",
    ports: [
      { name: "game", port: 8211, protocol: "UDP" },
      { name: "query", port: 27015, protocol: "UDP" },
    ],
    defaultMemory: "16Gi",
    defaultCpu: "4",
    defaultStorage: "20Gi",
    connectionHint: "Connect from Palworld with the listed host and game port.",
    environment: [
      { name: "SERVER_NAME", description: "Server name", defaultValue: "InfraWeaver Palworld", required: false },
      { name: "SERVER_DESCRIPTION", description: "Server description", defaultValue: "Managed by InfraWeaver", required: false },
      { name: "SERVER_PASSWORD", description: "Join password", defaultValue: "", required: false },
      { name: "ADMIN_PASSWORD", description: "Admin password", defaultValue: "", required: false },
      { name: "PLAYERS", description: "Maximum players", defaultValue: "16", required: false },
      { name: "PORT", description: "Game port", defaultValue: "8211", required: false },
    ],
    quickCommands: [
      { label: "Status", cmd: "Info", description: "Show server status information" },
      { label: "List Players", cmd: "ShowPlayers", description: "List connected players" },
      { label: "Save World", cmd: "Save", description: "Save the current world" },
    ],
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
    name: "Counter-Strike 2 / CS:GO",
    description: "Counter-Strike dedicated server using the cm2network image",
    dockerImage: "cm2network/csgo:latest",
    startupCommand: "srcds_run -game csgo -console -usercon +game_type 0 +game_mode 1 +mapgroup mg_active +map de_dust2",
    stopCommand: "quit",
    gamePort: 27015,
    queryPort: 27020,
    mountPath: "/home/steam/csgo-dedicated",
    protocol: "UDP",
    ports: [
      { name: "game", port: 27015, protocol: "UDP" },
      { name: "query", port: 27020, protocol: "UDP" },
      { name: "rcon", port: 27015, protocol: "TCP" },
    ],
    defaultMemory: "4Gi",
    defaultCpu: "2",
    defaultStorage: "40Gi",
    connectionHint: "Use the listed address in the Counter-Strike server browser or via connect command.",
    environment: [
      { name: "SRCDS_HOSTNAME", description: "Server name", defaultValue: "InfraWeaver Counter-Strike", required: false },
      { name: "SRCDS_STARTMAP", description: "Initial map", defaultValue: "de_dust2", required: false },
      { name: "SRCDS_MAXPLAYERS", description: "Maximum players", defaultValue: "10", required: false },
      { name: "SRCDS_PORT", description: "Game port", defaultValue: "27015", required: false },
      { name: "SRCDS_TOKEN", description: "Steam game server login token", defaultValue: "", required: false },
      { name: "SRCDS_RCONPW", description: "RCON password", defaultValue: "", required: false },
    ],
    quickCommands: [
      ...standardQuickCommands({ status: "status", list: "status", help: "help" }),
      { label: "Change Map", cmd: "changelevel de_dust2", description: "Switch to de_dust2" },
    ],
  },
  factorio: {
    id: "factorio",
    name: "Factorio",
    description: "Factorio headless server",
    dockerImage: "factoriotools/factorio:stable",
    startupCommand: "/docker-entrypoint.sh",
    stopCommand: "/quit",
    gamePort: 34197,
    queryPort: 27015,
    mountPath: "/factorio",
    protocol: "UDP",
    ports: [
      { name: "game", port: 34197, protocol: "UDP" },
      { name: "rcon", port: 27015, protocol: "TCP" },
    ],
    defaultMemory: "2Gi",
    defaultCpu: "1",
    defaultStorage: "10Gi",
    connectionHint: "Point the Factorio client at the listed host and UDP game port.",
    environment: [
      { name: "GENERATE_NEW_SAVE", description: "Generate a new save on first boot", defaultValue: "true", required: false },
      { name: "SAVE_NAME", description: "Save name to create or load", defaultValue: "infraweaver", required: false },
      { name: "LOAD_LATEST_SAVE", description: "Load the most recent save automatically", defaultValue: "true", required: false },
      { name: "PORT", description: "Game port", defaultValue: "34197", required: false },
      { name: "RCON_PORT", description: "RCON port", defaultValue: "27015", required: false },
      { name: "TOKEN", description: "Factorio account token", defaultValue: "", required: false },
    ],
    quickCommands: [
      { label: "Status", cmd: "/players", description: "Show connected players" },
      { label: "List Players", cmd: "/players", description: "List connected players" },
      { label: "Help", cmd: "/help", description: "Show available console commands" },
      { label: "Save World", cmd: "/server-save", description: "Save the current game" },
    ],
  },
};

export const BUILT_IN_EGGS = Object.values(GAME_EGGS);

const EGG_ALIASES: Record<string, string> = {
  minecraft: "minecraft-java",
  csgo: "cs2",
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
