import { getEggForGameType } from "@/addons/gamehub/lib/game-eggs";

// Built-in eggs (terraria/valheim/palworld/…) must also get the primary-artifact
// success guard, so a trailing-echo install script can't set .installed on a
// broken download. getEggForGameType is the single access point where it's applied.
describe("getEggForGameType — install guard", () => {
  it("appends the TShock.Server artifact guard to the terraria (TShock) install script", () => {
    const egg = getEggForGameType("terraria");
    const script = egg.installScript?.script ?? "";
    expect(script).toContain('if [ ! -s "TShock.Server" ]; then');
    expect(script).toContain("is missing or empty");
    // guard sits after the masking trailing echo
    expect(script.indexOf("TShock install complete")).toBeLessThan(script.indexOf("[ ! -s"));
  });

  it("does not add a guard when the egg has no install script", () => {
    const egg = getEggForGameType("does-not-exist-generic");
    expect(egg.installScript).toBeUndefined();
  });
});
