import { getEggForGameType } from "@/addons/gamehub/lib/game-eggs";
import { STEAM_INSTALL_EGGS, STEAM_INSTALL_IMAGE } from "@/addons/gamehub/lib/steam-install";
import { INSTALL_MOUNT } from "@/addons/gamehub/lib/install-wrapper";

// SteamCMD built-in eggs ship no installScript (they install at boot via the
// image entrypoint), so PR#137's marker/verify never covered them. getEggForGameType
// is the single access point where built-in eggs are finalized; it now synthesizes a
// verifying steam boot-install script for those eggs so route.ts builds an installer
// init container and wrapInstallScript gates the .installed marker fail-closed.

describe("getEggForGameType — steam boot-install synthesis", () => {
  it.each(Object.keys(STEAM_INSTALL_EGGS))(
    "synthesizes a verifying steam installScript for %s",
    (eggId) => {
      const egg = getEggForGameType(eggId);
      expect(egg.installScript).toBeDefined();
      const spec = STEAM_INSTALL_EGGS[eggId];
      expect(egg.installScript?.container).toBe(STEAM_INSTALL_IMAGE);
      expect(egg.installScript?.entrypoint).toBe("/bin/sh");
      // the real dedicated-server appid is baked into the script
      expect(egg.installScript?.script).toContain(`+app_update ${spec.appId}`);
      // and the manifest + size verification the gap fix is about
      expect(egg.installScript?.script).toContain(`appmanifest_${spec.appId}.acf`);
      expect(egg.installScript?.script).toMatch(/du\s+-sb/);
    },
  );

  it("writes files to the shared install mount so the runtime PVC sees them", () => {
    const egg = getEggForGameType("palworld");
    expect(egg.installScript?.script).toContain(`+force_install_dir "${INSTALL_MOUNT}"`);
  });

  it("does not synthesize a steam script for non-steam eggs", () => {
    // minecraft installs via its own image, terraria has its own (hardened) script
    expect(getEggForGameType("minecraft-java").installScript).toBeUndefined();
  });

  it("leaves the terraria egg's own (hardened) install script intact", () => {
    // steam synthesis must not clobber an egg that already ships an installScript
    const egg = getEggForGameType("terraria");
    expect(egg.installScript?.script).toContain("TShock");
    expect(egg.installScript?.container).toBe("ghcr.io/parkervcp/installers:debian");
    expect(egg.installScript?.script).not.toContain("app_update");
  });

  it("does NOT synthesize a steam script for excluded eggs (valheim/cs2)", () => {
    // These images keep binaries in the image or ignore the marker — validated
    // on-cluster (PR #139). ark is no longer excluded: it was rewired to read the
    // pre-installed tree from /app/server (see steam-install STEAM_INSTALL_EGGS).
    for (const eggId of ["valheim", "cs2"]) {
      expect(getEggForGameType(eggId).installScript).toBeUndefined();
    }
    // …including via the csgo -> cs2 alias.
    expect(getEggForGameType("csgo").installScript).toBeUndefined();
  });

  it("synthesizes a verifying steam script for the rewired ark egg", () => {
    const egg = getEggForGameType("ark");
    expect(egg.dockerImage).toBe("hermsi/ark-server:latest");
    expect(egg.mountPath).toBe("/app/server");
    expect(egg.installScript?.script).toContain("+app_update 376030");
    // startupCommand launches the binary from the PVC mount, not the image's path.
    expect(egg.startupCommand).toContain("/app/server/ShooterGame/Binaries/Linux/ShooterGameServer");
  });
});
