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

  it("resolves aliases (csgo -> cs2) to the steam script", () => {
    const egg = getEggForGameType("csgo");
    expect(egg.installScript?.script).toContain(`+app_update ${STEAM_INSTALL_EGGS.cs2.appId}`);
  });
});
