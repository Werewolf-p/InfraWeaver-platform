## Game Eggs System

### What is a Game Egg?

A game egg is a normalized template for running a game server. It defines:

- Docker image
- startup command
- stop command
- environment variables and defaults
- default ports
- quick console commands
- default CPU, memory, and storage settings

## Built-in eggs

Built-in eggs live in `src/lib/game-eggs.ts`. They are curated because they represent the workloads the platform team wants to support directly.

Typical built-in eggs include:

- Minecraft Java
- Terraria
- Valheim
- Satisfactory
- V Rising
- Palworld
- Rust
- Factorio

## Pelican egg catalog

Remote eggs are fetched from the Pelican eggs repository and exposed through `/api/game-hub/eggs/catalog`. InfraWeaver normalizes these into the same shape used by built-in eggs so the UI can render one consistent wizard.

## Adding a new built-in egg

```typescript
const myGame: GameEgg = {
  id: "my-game",
  name: "My Game Server",
  description: "Description",
  dockerImage: "gameimage:latest",
  startupCommand: "./start.sh",
  stopCommand: "stop",
  gamePort: 25565,
  protocol: "TCP",
  mountPath: "/data",
  environment: [
    {
      name: "GAME_PASSWORD",
      description: "Server password",
      defaultValue: "",
      required: false
    }
  ],
  quickCommands: [{ label: "List Players", cmd: "players" }],
  defaultMemory: "2Gi",
  defaultCpu: "1",
  defaultStorage: "10Gi"
};
```

## Egg design guidelines

- choose the most stable upstream image you can
- provide safe defaults for memory, CPU, and storage
- make required environment variables obvious
- include useful quick commands for operators
- document any unusual ports, protocols, or world paths

## Why eggs matter operationally

Eggs keep the deployment workflow uniform. Operators can learn the Game Hub once, then apply the same mental model to many games instead of learning a new manifest layout every time.
