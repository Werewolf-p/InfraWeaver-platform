// game-hub-server transitively imports @kubernetes/client-node (ESM); mock it so
// jest can load the module for the pure helper under test.
jest.mock("@kubernetes/client-node", () => {
  class DummyApi {}
  class DummyExec { exec() { return Promise.resolve({ on: jest.fn() }); } }
  class DummyKubeConfig {
    loadFromString() {}
    loadFromCluster() {}
    loadFromFile() {}
    loadFromDefault() {}
    getCurrentCluster() { return { server: "https://cluster.example.test" }; }
  }
  return {
    Exec: DummyExec,
    KubeConfig: DummyKubeConfig,
    AppsV1Api: DummyApi,
    AutoscalingV2Api: DummyApi,
    BatchV1Api: DummyApi,
    CoreV1Api: DummyApi,
    CustomObjectsApi: DummyApi,
    ServerConfiguration: class {},
    createConfiguration: jest.fn(() => ({})),
  };
});

import { GAME_EGGS, getSaveCommands, getEggForGameType } from "@/lib/game-eggs";
import { pelicanToGameEgg, type PelicanEgg } from "@/lib/pelican-eggs";
import { isCommandAllowedByAcl } from "@/lib/game-hub-server";

// F1 — save/quiesce command metadata. Backups bracket the tar with
// off → flush → on so the archive captures a consistent world snapshot; these
// tests pin the per-game commands so a wrong/missing command is caught early.
describe("getSaveCommands", () => {
  it("returns off/flush/on in order for Minecraft (has hold semantics)", () => {
    // Arrange
    const egg = GAME_EGGS["minecraft-java"];

    // Act
    const saves = getSaveCommands(egg);

    // Assert
    expect(saves).toEqual({ off: "save-off", flush: "save-all flush", on: "save-on" });
  });

  it("returns only a flush command for games without hold semantics", () => {
    expect(getSaveCommands(GAME_EGGS.factorio)).toEqual({ off: undefined, flush: "/server-save", on: undefined });
    expect(getSaveCommands(GAME_EGGS.ark)).toEqual({ off: undefined, flush: "saveworld", on: undefined });
    expect(getSaveCommands(GAME_EGGS.valheim)).toEqual({ off: undefined, flush: "save", on: undefined });
  });

  it("returns all-undefined for eggs with no save capability", () => {
    expect(getSaveCommands(GAME_EGGS.satisfactory)).toEqual({ off: undefined, flush: undefined, on: undefined });
    expect(getSaveCommands(GAME_EGGS["v-rising"])).toEqual({ off: undefined, flush: undefined, on: undefined });
  });
});

describe("built-in egg save metadata", () => {
  it("flags stopSavesWorld only where the stop command itself persists", () => {
    expect(GAME_EGGS["minecraft-java"].stopSavesWorld).toBe(true); // "stop" saves
    expect(GAME_EGGS.terraria.stopSavesWorld).toBe(true); // "exit" saves in TShock
    expect(GAME_EGGS.factorio.stopSavesWorld).toBeUndefined();
    expect(GAME_EGGS.cs2.stopSavesWorld).toBeUndefined();
  });

  it.each([
    ["rust", "server.save"],
    ["palworld", "Save"],
    ["terraria", "save"],
  ])("populates saveCommand for %s", (id, expected) => {
    expect(GAME_EGGS[id].saveCommand).toBe(expected);
  });

  it("leaves save commands undefined for the generic fallback egg", () => {
    const generic = getEggForGameType("something-unknown");
    expect(generic.saveCommand).toBeUndefined();
    expect(generic.saveOffCommand).toBeUndefined();
  });
});

// F1 — Pelican catalog eggs get save commands derived from their label.
describe("pelicanToGameEgg save inference", () => {
  function makePelican(name: string, stop: string): PelicanEgg {
    return { name, docker_image: "ghcr.io/example/img:latest", startup: "./run", config: { stop } };
  }

  it("derives Minecraft save/hold commands and stopSavesWorld from a Paper egg", () => {
    const egg = pelicanToGameEgg(makePelican("Paper", "stop"), "paper");
    expect(egg.saveCommand).toBe("save-all flush");
    expect(egg.saveOffCommand).toBe("save-off");
    expect(egg.saveOnCommand).toBe("save-on");
    expect(egg.stopSavesWorld).toBe(true);
  });

  it("does not treat a proxy (velocity) as a savable world", () => {
    const egg = pelicanToGameEgg(makePelican("Velocity Proxy", "end"), "velocity");
    expect(egg.saveCommand).toBeUndefined();
  });

  it("derives a flush-only save command for Factorio", () => {
    const egg = pelicanToGameEgg(makePelican("Factorio", "/quit"), "factorio");
    expect(egg.saveCommand).toBe("/server-save");
    expect(egg.saveOffCommand).toBeUndefined();
  });

  it("leaves save commands undefined for an unknown game", () => {
    const egg = pelicanToGameEgg(makePelican("Some Obscure Game", "^C"), "obscure");
    expect(egg.saveCommand).toBeUndefined();
  });
});

// M1 — the per-role command ACL predicate shared by /command, /rcon and /exec.
describe("isCommandAllowedByAcl", () => {
  it("permits everything when the wildcard is present (admin role)", () => {
    expect(isCommandAllowedByAcl("stop", ["*"])).toBe(true);
    expect(isCommandAllowedByAcl("anything at all", ["*"])).toBe(true);
  });

  it("matches an exact command or a command with args by prefix", () => {
    expect(isCommandAllowedByAcl("list", ["list", "help"])).toBe(true);
    expect(isCommandAllowedByAcl("time set day", ["time set", "weather"])).toBe(true);
  });

  it("rejects commands not covered by the allow-list", () => {
    expect(isCommandAllowedByAcl("op someone", ["list", "help"])).toBe(false);
    // "listbans" must not be allowed by the "list" entry (prefix requires a space)
    expect(isCommandAllowedByAcl("listbans", ["list"])).toBe(false);
    expect(isCommandAllowedByAcl("stop", [])).toBe(false);
  });
});
