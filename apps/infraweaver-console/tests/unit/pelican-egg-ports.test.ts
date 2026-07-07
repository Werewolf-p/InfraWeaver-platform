import { pelicanToGameEgg, type PelicanEgg } from "@/lib/pelican-eggs";

// Port/protocol inference for steamcmd eggs that expose NO game-port variable.
// Palworld is the canonical gap: its egg carries SRCDS_APPID (2394010) + RCON_PORT
// but no SERVER_PORT, so the old `?? 25565` TCP fallback pinned 25565/TCP even
// though the game listens on 8211/UDP. The SRCDS_APPID/egg-id lookup fixes both
// the port and the protocol; SERVER_PORT is later derived from gamePort, so the
// server's -port flag follows the corrected value.
describe("extractPorts — steamcmd game-port lookup", () => {
  // Minimal shape mirroring pelican-eggs game_eggs/steamcmd_servers/palworld:
  // no SERVER_PORT var, RCON_PORT present, SRCDS_APPID identifies the game, and
  // the startup templates -port={{SERVER_PORT}} so no literal port is parseable.
  const palworldEgg: PelicanEgg = {
    name: "Palworld",
    docker_image: "ghcr.io/parkervcp/yolks:steamcmd_debian",
    startup:
      './PalworldServerConfigParser; Pal -port={{SERVER_PORT}} -publicport={{SERVER_PORT}}',
    config: { stop: "^C" },
    variables: [
      { name: "App ID", env_variable: "SRCDS_APPID", default_value: "2394010", user_viewable: false },
      { name: "RCON Port", env_variable: "RCON_PORT", default_value: "25575", user_viewable: true },
      { name: "Max Players", env_variable: "MAX_PLAYERS", default_value: "32" },
    ],
  };

  it("resolves gamePort 8211 / UDP for the palworld egg via SRCDS_APPID", () => {
    // Act
    const egg = pelicanToGameEgg(palworldEgg, "steamcmd_servers/palworld");

    // Assert — game port + protocol come from the SRCDS_APPID lookup, not 25565/TCP
    expect(egg.gamePort).toBe(8211);
    expect(egg.protocol).toBe("UDP");
    const gamePortEntry = egg.ports?.find((p) => p.name === "game");
    expect(gamePortEntry).toEqual({ name: "game", port: 8211, protocol: "UDP" });
    // RCON stays TCP on its own declared port
    expect(egg.ports?.find((p) => p.name === "rcon")).toEqual({
      name: "rcon",
      port: 25575,
      protocol: "TCP",
    });
  });

  it("resolves via the egg-id slug when SRCDS_APPID is absent", () => {
    const noAppId: PelicanEgg = {
      ...palworldEgg,
      variables: palworldEgg.variables?.filter((v) => v.env_variable !== "SRCDS_APPID"),
    };

    const egg = pelicanToGameEgg(noAppId, "steamcmd_servers/palworld");

    expect(egg.gamePort).toBe(8211);
    expect(egg.protocol).toBe("UDP");
  });

  it("keeps the 25565 last resort for an unknown steamcmd game", () => {
    const unknown: PelicanEgg = {
      name: "Mystery Server",
      docker_image: "ghcr.io/parkervcp/yolks:steamcmd_debian",
      startup: "./run -port={{SERVER_PORT}}",
      variables: [{ name: "App ID", env_variable: "SRCDS_APPID", default_value: "999999999" }],
    };

    const egg = pelicanToGameEgg(unknown, "steamcmd_servers/mystery");

    expect(egg.gamePort).toBe(25565);
  });

  it("still prefers an explicit game-port variable over the lookup", () => {
    const withPortVar: PelicanEgg = {
      name: "Palworld",
      docker_image: "ghcr.io/parkervcp/yolks:steamcmd_debian",
      startup: "./run",
      variables: [
        { name: "App ID", env_variable: "SRCDS_APPID", default_value: "2394010" },
        { name: "Server Port", env_variable: "SERVER_PORT", default_value: "8888" },
      ],
    };

    const egg = pelicanToGameEgg(withPortVar, "steamcmd_servers/palworld");

    expect(egg.gamePort).toBe(8888);
  });
});
