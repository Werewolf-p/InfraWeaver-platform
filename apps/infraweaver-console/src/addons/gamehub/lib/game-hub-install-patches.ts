// Patches for upstream Pelican egg installation scripts that have rotted against
// third-party APIs or ship broken defaults. Applied when an egg is imported
// (pelicanToGameEgg) so the generated install init-container runs a working
// script.
//
// Design: a small registry of detectors. Each detector fires only when its
// signature is present in the upstream script, so unaffected eggs pass through
// untouched. Every Minecraft-family patch guarantees three things:
//   1. the Mojang EULA is accepted (servers exit on first boot otherwise);
//   2. "latest" resolves to a version the runtime Java can actually run
//      (RUNTIME_JAVA_MAJOR is injected from the chosen image — see route.ts);
//   3. no dependency on dead third-party infrastructure.
//
// This keeps the fixes general: any egg in a covered family benefits, and the
// same mechanism handles future "new Minecraft needs newer Java" breakage.

/**
 * Shell snippet (ash/bash) that accepts the Mojang EULA in the current
 * directory. Idempotent. Minecraft servers refuse to start without it.
 */
const EULA_SNIPPET = `if [ ! -f eula.txt ] || ! grep -q '^eula=true' eula.txt 2>/dev/null; then echo "eula=true" > eula.txt; echo "Accepted Mojang EULA (eula.txt)"; fi`;

/**
 * Shell snippet that resolves the newest official Minecraft release whose
 * required Java (from the Mojang manifest's javaVersion.majorVersion) does not
 * exceed a ceiling, and assigns it to the named variable — but only when that
 * variable is empty or "latest". Writes /tmp/mc_manifest.json once.
 *
 * @param varName  env/shell variable the target script reads for the version
 * @param javaCeilExpr shell expression giving the max Java major (e.g.
 *   "\${RUNTIME_JAVA_MAJOR}" or a literal like "17")
 */
function mojangVersionCapSnippet(varName: string, javaCeilExpr: string): string {
  return `MC_JAVA_CEIL="${javaCeilExpr}"
if [ -z "\${${varName}}" ] || [ "\${${varName}}" = "latest" ]; then
    curl -s "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json" > /tmp/mc_manifest.json
    for _v in \`jq -r '.versions[] | select(.type=="release") | .id' /tmp/mc_manifest.json | head -40\`; do
        if [ -z "\${MC_JAVA_CEIL}" ]; then ${varName}="\${_v}"; break; fi
        _url=\`jq -r --arg v "\${_v}" '.versions[] | select(.id==$v) | .url' /tmp/mc_manifest.json\`
        _jv=\`curl -s "\${_url}" | jq -r '.javaVersion.majorVersion // 0'\`
        if [ -n "\${_jv}" ] && [ "\${_jv}" -le "\${MC_JAVA_CEIL}" ] 2>/dev/null; then
            ${varName}="\${_v}"
            echo "Selected Minecraft \${${varName}} (needs Java \${_jv} <= \${MC_JAVA_CEIL})"
            break
        fi
    done
fi`;
}

/**
 * PaperMC sunset the v2 API (api.papermc.io/v2 now returns {"error":"sunset"}),
 * breaking every paper-family egg (paper, folia, velocity, waterfall): the
 * version/build lookup returns null and the installer downloads a tiny error
 * page as server.jar. Replacement uses the v3 "fill" API (fill.papermc.io/v3),
 * which returns the download URL directly in the build JSON. PROJECT is read
 * from the original script so one template serves all paper-family projects.
 */
function paperV3Script(project: string): string {
  return `#!/bin/ash
# Paper-family install script — patched by InfraWeaver to PaperMC v3
# (fill.papermc.io/v3); upstream v2 api.papermc.io was sunset.
# Server Files: /mnt/server
PROJECT=${project}
API=https://fill.papermc.io/v3/projects/\${PROJECT}

if [ -n "\${DL_PATH}" ]; then
    echo -e "Using supplied download url: \${DL_PATH}"
    DOWNLOAD_URL=\`eval echo \$(echo \${DL_PATH} | sed -e 's/{{/\${/g' -e 's/}}/}/g')\`
else
    ALL_VERSIONS=\`curl -s \${API} | jq -r '[.versions | to_entries[] | .value[]]'\`

    if [ -z "\${MINECRAFT_VERSION}" ] || [ "\${MINECRAFT_VERSION}" = "latest" ]; then
        VALID=""
    else
        VALID=\`echo "\${ALL_VERSIONS}" | jq -r --arg V "\${MINECRAFT_VERSION}" 'index($V) // empty'\`
    fi

    BUILD_JSON=""
    if [ -z "\${VALID}" ]; then
        echo -e "Resolving latest stable \${PROJECT} version compatible with Java \${RUNTIME_JAVA_MAJOR:-any}"
        for V in \`echo "\${ALL_VERSIONS}" | jq -r '.[0:25][]'\`; do
            if [ -n "\${RUNTIME_JAVA_MAJOR}" ]; then
                JAVA_MIN=\`curl -s "\${API}/versions/\${V}" | jq -r '.version.java.version.minimum // 0'\`
                if [ -n "\${JAVA_MIN}" ] && [ "\${JAVA_MIN}" -gt "\${RUNTIME_JAVA_MAJOR}" ] 2>/dev/null; then
                    continue
                fi
            fi
            CANDIDATE=\`curl -s "\${API}/versions/\${V}/builds" | jq -c 'map(select(.channel=="STABLE")) | last // empty'\`
            if [ -n "\${CANDIDATE}" ] && [ "\${CANDIDATE}" != "null" ]; then
                MINECRAFT_VERSION=\${V}
                BUILD_JSON=\${CANDIDATE}
                break
            fi
        done
    else
        echo -e "Using version \${MINECRAFT_VERSION}"
        BUILDS=\`curl -s "\${API}/versions/\${MINECRAFT_VERSION}/builds"\`
        BUILD_JSON=\`echo "\${BUILDS}" | jq -c --arg B "\${BUILD_NUMBER}" 'map(select((.id|tostring)==$B)) | .[0] // empty'\`
        if [ -z "\${BUILD_JSON}" ] || [ "\${BUILD_JSON}" = "null" ]; then
            BUILD_JSON=\`echo "\${BUILDS}" | jq -c '(map(select(.channel=="STABLE")) | last) // last // empty'\`
        fi
    fi

    if [ -z "\${BUILD_JSON}" ] || [ "\${BUILD_JSON}" = "null" ]; then
        echo -e "ERROR: could not resolve a \${PROJECT} build from \${API}"
        exit 1
    fi

    DL=\`echo "\${BUILD_JSON}" | jq -c '.downloads["server:default"] // (.downloads | to_entries | .[0].value)'\`
    DOWNLOAD_URL=\`echo "\${DL}" | jq -r '.url'\`
    BUILD_NUMBER=\`echo "\${BUILD_JSON}" | jq -r '.id'\`
    echo -e "MC Version: \${MINECRAFT_VERSION}"
    echo -e "Build: \${BUILD_NUMBER}"
fi

cd /mnt/server

# Minecraft servers exit on first boot unless the Mojang EULA is accepted.
${EULA_SNIPPET}

echo -e "Running curl -o \${SERVER_JARFILE} \${DOWNLOAD_URL}"
if [ -f "\${SERVER_JARFILE}" ]; then
    mv "\${SERVER_JARFILE}" "\${SERVER_JARFILE}.old"
fi
curl -fsSL -o "\${SERVER_JARFILE}" "\${DOWNLOAD_URL}"

if [ ! -f server.properties ]; then
    echo -e "Downloading MC server.properties"
    curl -o server.properties https://raw.githubusercontent.com/parkervcp/eggs/master/minecraft/java/server.properties
fi
`;
}

/**
 * VanillaCord's build host (src.me1312.net) is dead, so the upstream vanilla egg
 * can never install. Replace it with a clean installer that pulls the official
 * Mojang server jar straight from the version manifest — no third-party deps,
 * Java-capped, EULA accepted.
 */
function cleanVanillaScript(): string {
  return `#!/bin/ash
# Vanilla install script — rewritten by InfraWeaver to use the official Mojang
# version manifest (VanillaCord's build host is offline). Java-capped + EULA.
apk --no-cache --update add curl jq 2>/dev/null || { apt-get update && apt-get install -y curl jq; }
cd /mnt/server

${mojangVersionCapSnippet("VANILLA_VERSION", "${RUNTIME_JAVA_MAJOR}")}

if [ -z "\${VANILLA_VERSION}" ]; then
    echo "ERROR: could not resolve a Minecraft version"; exit 1
fi
echo "Installing Minecraft \${VANILLA_VERSION}"

VJSON_URL=\`jq -r --arg v "\${VANILLA_VERSION}" '.versions[] | select(.id==$v) | .url' /tmp/mc_manifest.json\`
SERVER_URL=\`curl -s "\${VJSON_URL}" | jq -r '.downloads.server.url'\`
if [ -z "\${SERVER_URL}" ] || [ "\${SERVER_URL}" = "null" ]; then
    echo "ERROR: no server download for \${VANILLA_VERSION}"; exit 1
fi

${EULA_SNIPPET}

echo "Downloading \${SERVER_URL} -> \${SERVER_JARFILE}"
curl -fsSL -o "\${SERVER_JARFILE}" "\${SERVER_URL}"

if [ ! -f server.properties ]; then
    curl -o server.properties https://raw.githubusercontent.com/parkervcp/eggs/master/minecraft/java/server.properties
fi
`;
}

/**
 * Fabric: upstream fabric meta is healthy, but "latest" resolves to a game
 * version that may need newer Java than the runtime, and the egg never accepts
 * the EULA. Cap MC_VERSION to a runtime-Java-compatible release (via the Mojang
 * manifest) before the fabric installer runs, and append EULA acceptance.
 */
function patchFabricScript(script: string): string {
  const capped = `# InfraWeaver: cap MC_VERSION to a Java-\${RUNTIME_JAVA_MAJOR:-any}-compatible release\n${mojangVersionCapSnippet("MC_VERSION", "${RUNTIME_JAVA_MAJOR}")}\n`;
  // Insert the cap right after the shebang so it runs before fabric's own
  // MC_VERSION resolution.
  const withCap = script.replace(/^(#![^\n]*\n)/, `$1${capped}`);
  return appendEula(withCap);
}

/**
 * Spigot builds from source with BuildTools. The egg's bundled JDK selection
 * tops out at Java 17, which cannot compile 1.21+, and it never accepts the
 * EULA. Cap DL_VERSION to a Java-17-buildable release and append EULA. (Runtime
 * java_21 runs the resulting 1.20.x jar fine.)
 */
function patchSpigotScript(script: string): string {
  const capped = `# InfraWeaver: cap DL_VERSION to a version BuildTools' bundled JDK can compile\n${mojangVersionCapSnippet("DL_VERSION", "17")}\n`;
  const withCap = script.replace(/^(#![^\n]*\n)/, `$1${capped}`);
  return appendEula(withCap);
}

/**
 * Forge: the upstream installer runs and generates run files; cap MC_VERSION to
 * a runtime-Java-compatible release and accept the EULA. (The Java-8 install
 * container is bumped separately by patchPelicanInstallContainer.)
 */
function patchForgeScript(script: string): string {
  const capped = `# InfraWeaver: cap MC_VERSION to a Java-\${RUNTIME_JAVA_MAJOR:-any}-compatible release\n${mojangVersionCapSnippet("MC_VERSION", "${RUNTIME_JAVA_MAJOR}")}\n`;
  const withCap = script.replace(/^(#![^\n]*\n)/, `$1${capped}`);
  return appendEula(withCap);
}

/** Append EULA acceptance (idempotent) to a script that installs into /mnt/server. */
function appendEula(script: string): string {
  if (/eula\.txt/.test(script)) return script;
  return `${script.replace(/\s*$/, "")}\n\n# InfraWeaver: accept Mojang EULA so the server does not exit on first boot.\ncd /mnt/server\n${EULA_SNIPPET}\n`;
}

/**
 * Apply known install-script patches. Returns the (possibly rewritten) script.
 * No-op for scripts that don't match a known-broken pattern.
 */
export function patchPelicanInstallScript(script: string): string {
  if (!script) return script;

  // PaperMC v2 sunset — rewrite paper-family scripts to the v3 API.
  if (script.includes("api.papermc.io/v2")) {
    const project = script.match(/PROJECT=([A-Za-z0-9_-]+)/)?.[1] ?? "paper";
    return paperV3Script(project);
  }

  // Vanilla (VanillaCord) — dead build host, replace with clean Mojang installer.
  if (script.includes("src.me1312.net")) {
    return cleanVanillaScript();
  }

  // Fabric — cap MC version + accept EULA.
  if (script.includes("meta.fabricmc.net")) {
    return patchFabricScript(script);
  }

  // Spigot — cap build version + accept EULA.
  if (script.includes("BuildTools.jar")) {
    return patchSpigotScript(script);
  }

  // Forge — cap MC version + accept EULA.
  if (script.includes("minecraftforge")) {
    return patchForgeScript(script);
  }

  return script;
}

/**
 * Some Minecraft eggs install with a Java version too old to run their own
 * installer/build for modern game versions (e.g. Forge's openjdk:8 install
 * container cannot run a modern Forge installer). Bump such install containers
 * to a modern JDK. Returns the (possibly replaced) container image.
 *
 * General rule: if a Minecraft-family install container is a plain openjdk/JDK
 * image older than the modern baseline, upgrade it to eclipse-temurin:21-jdk
 * (Ubuntu-based, so apt-based install scripts keep working).
 */
const MODERN_JDK_INSTALL_IMAGE = "eclipse-temurin:21-jdk";

export function patchPelicanInstallContainer(container: string, script: string): string {
  if (!container) return container;
  const isMinecraft = /fabricmc|minecraftforge|BuildTools|papermc|launchermeta\.mojang|src\.me1312/.test(script);
  if (!isMinecraft) return container;
  // openjdk:8 / openjdk:11 / :16 / :17 style images that predate what modern
  // installers need. eslint-safe numeric parse of the major version.
  const major = container.match(/openjdk:(\d{1,2})/i)?.[1];
  if (major && parseInt(major, 10) < 21 && !/-jre/.test(container)) {
    return MODERN_JDK_INSTALL_IMAGE;
  }
  return container;
}
