import { patchPelicanInstallScript } from "@/addons/gamehub/lib/game-hub-install-patches";

// The patch layer must be GENERAL: any egg whose upstream install script calls
// the sunset PaperMC v2 API gets rewritten to the working v3 API, driven by the
// PROJECT the script declares — not hardcoded to one game. Unaffected scripts
// pass through untouched.
describe("patchPelicanInstallScript", () => {
  const v2Paper = [
    "#!/bin/ash",
    "PROJECT=paper",
    'LATEST_VERSION=`curl -s https://api.papermc.io/v2/projects/${PROJECT} | jq -r ".versions" | jq -r ".[-1]"`',
    "DOWNLOAD_URL=https://api.papermc.io/v2/projects/${PROJECT}/versions/${MINECRAFT_VERSION}/builds/${BUILD_NUMBER}/downloads/${JAR_NAME}",
    "curl -o ${SERVER_JARFILE} ${DOWNLOAD_URL}",
  ].join("\n");

  it("rewrites the sunset v2 API to the v3 fill API", () => {
    const patched = patchPelicanInstallScript(v2Paper);
    expect(patched).toContain("https://fill.papermc.io/v3/projects/");
    expect(patched).not.toContain("api.papermc.io/v2");
  });

  it("preserves the declared PROJECT so it works for any paper-family egg", () => {
    for (const project of ["paper", "folia", "velocity", "waterfall"]) {
      const script = v2Paper.replace("PROJECT=paper", `PROJECT=${project}`);
      const patched = patchPelicanInstallScript(script);
      expect(patched).toContain(`PROJECT=${project}`);
    }
  });

  it("extracts the download URL from the build JSON (no null jar construction)", () => {
    const patched = patchPelicanInstallScript(v2Paper);
    // v3 gives the URL directly; the broken v2 path built paper-null-null.jar.
    expect(patched).toContain(".downloads");
    expect(patched).toContain("curl -fsSL -o");
    expect(patched).not.toContain("paper-null-null");
  });

  it("resolves latest STABLE by scanning versions (handles version-scheme changes)", () => {
    const patched = patchPelicanInstallScript(v2Paper);
    expect(patched).toContain('channel=="STABLE"');
    expect(patched).toContain("Resolving latest stable");
  });

  it("respects the runtime Java ceiling so 'latest' never picks an unrunnable build", () => {
    const patched = patchPelicanInstallScript(v2Paper);
    // Uses the per-version minimum Java from the v3 API and compares to the
    // image's Java so e.g. a Java 21 image resolves 1.21.x, not a Java 25 build.
    expect(patched).toContain("RUNTIME_JAVA_MAJOR");
    expect(patched).toContain(".version.java.version.minimum");
  });

  it("accepts the Mojang EULA so the minecraft server does not exit on first boot", () => {
    const patched = patchPelicanInstallScript(v2Paper);
    expect(patched).toContain("eula=true");
    expect(patched).toContain("eula.txt");
  });

  it("is a no-op for scripts that do not use the broken API", () => {
    const steam = "#!/bin/bash\nsteamcmd +login anonymous +app_update 896660 validate +quit";
    expect(patchPelicanInstallScript(steam)).toBe(steam);
  });

  it("handles empty/undefined script safely", () => {
    expect(patchPelicanInstallScript("")).toBe("");
  });
});
