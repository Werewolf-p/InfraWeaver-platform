import { patchPelicanInstallScript, patchPelicanInstallContainer } from "@/addons/gamehub/lib/game-hub-install-patches";

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

// The non-PaperMC Minecraft families must ALSO get EULA + a runtime-Java-safe
// version, generally — same problem class, different upstream scripts.
describe("patchPelicanInstallScript — non-PaperMC Minecraft families", () => {
  it("replaces the dead-Jenkins VanillaCord egg with a clean Mojang installer", () => {
    const vanillacord = "#!/bin/ash\ncurl -o vanillacord.jar https://src.me1312.net/jenkins/job/VanillaCord/...\njava -jar vanillacord.jar $INSTALLING_VERSION";
    const patched = patchPelicanInstallScript(vanillacord);
    expect(patched).not.toContain("src.me1312.net");
    expect(patched).toContain("version_manifest_v2.json");
    expect(patched).toContain("downloads.server.url");
    expect(patched).toContain("eula=true");
    expect(patched).toContain("RUNTIME_JAVA_MAJOR");
  });

  it("caps Fabric MC_VERSION to a Java-compatible release and accepts the EULA", () => {
    const fabric = "#!/bin/bash\nMC_VERSION=$(curl -sSL https://meta.fabricmc.net/v2/versions/game | jq -r '.version')\njava -jar fabric-installer.jar server";
    const patched = patchPelicanInstallScript(fabric);
    expect(patched).toContain("meta.fabricmc.net"); // upstream logic preserved
    expect(patched).toContain("version_manifest_v2.json"); // cap prepended
    expect(patched).toContain("eula=true");
    // cap runs before fabric's own resolution
    expect(patched.indexOf("version_manifest")).toBeLessThan(patched.indexOf("fabric-installer"));
  });

  it("caps Spigot build version to a BuildTools-compilable release + EULA", () => {
    const spigot = "#!/bin/bash\ncurl -L https://hub.spigotmc.org/jenkins/.../BuildTools.jar -o BuildTools.jar\njava -jar BuildTools.jar --rev ${DL_VERSION}";
    const patched = patchPelicanInstallScript(spigot);
    expect(patched).toContain("BuildTools.jar"); // upstream logic preserved
    expect(patched).toContain('MC_JAVA_CEIL="17"'); // BuildTools JDK ceiling
    expect(patched).toContain("eula=true");
  });

  it("caps Forge MC_VERSION + accepts EULA", () => {
    const forge = "#!/bin/bash\nJSON_DATA=$(curl -sSL https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json)\n";
    const patched = patchPelicanInstallScript(forge);
    expect(patched).toContain("minecraftforge"); // upstream preserved
    expect(patched).toContain("RUNTIME_JAVA_MAJOR");
    expect(patched).toContain("eula=true");
  });

  it("does not double-add EULA when a family script already handles it", () => {
    const withEula = "#!/bin/bash\ncurl https://meta.fabricmc.net/x\necho eula=true > eula.txt";
    const patched = patchPelicanInstallScript(withEula);
    expect(patched.match(/eula=true/g)?.length).toBe(1);
  });
});

describe("patchPelicanInstallContainer", () => {
  it("bumps Forge's Java 8 install container to a modern JDK", () => {
    const forge = "apt update\ncurl https://files.minecraftforge.net/... ";
    expect(patchPelicanInstallContainer("openjdk:8-jdk-slim", forge)).toBe("eclipse-temurin:21-jdk");
  });

  it("bumps Fabric's Java 11 install container to a modern JDK", () => {
    const fabric = "curl https://meta.fabricmc.net/v2/versions/game";
    expect(patchPelicanInstallContainer("openjdk:11-jdk-slim", fabric)).toBe("eclipse-temurin:21-jdk");
  });

  it("leaves non-minecraft install containers untouched", () => {
    expect(patchPelicanInstallContainer("openjdk:8-jdk-slim", "steamcmd stuff")).toBe("openjdk:8-jdk-slim");
  });

  it("leaves already-modern / non-openjdk containers untouched", () => {
    const mc = "curl https://meta.fabricmc.net/x";
    expect(patchPelicanInstallContainer("ghcr.io/parkervcp/installers:debian", mc)).toBe("ghcr.io/parkervcp/installers:debian");
  });

  it("replaces the dead vanilla installer image with a pullable ghcr alpine image", () => {
    const vanilla = "curl -o vanillacord.jar https://src.me1312.net/jenkins/...";
    expect(patchPelicanInstallContainer("openjdk:8-jre-alpine", vanilla)).toBe("ghcr.io/parkervcp/installers:alpine");
  });
});

describe("version-cap snippet self-sufficiency", () => {
  it("bootstraps curl+jq so the cap works even before the egg installs them", () => {
    // Fabric installs curl/jq itself AFTER the prepended cap ran, so the cap
    // must not depend on them being present. Regression for MC_VERSION=latest
    // silently falling through to a Java-25 build.
    const fabric = "#!/bin/bash\napt install -y curl jq\ncurl https://meta.fabricmc.net/v2/versions/game";
    const patched = patchPelicanInstallScript(fabric);
    expect(patched).toContain("command -v jq");
    expect(patched).toContain("apk add --no-cache curl jq");
  });
});
