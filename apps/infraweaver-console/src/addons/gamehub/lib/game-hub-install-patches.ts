// Patches for upstream Pelican egg installation scripts that have rotted against
// third-party APIs. Applied when an egg is imported (pelicanToGameEgg) so the
// generated install init-container runs a working script.
//
// Kept data-driven and narrowly scoped: a patch only fires when its detection
// string is present, so unaffected eggs pass through untouched.

/**
 * PaperMC sunset the v2 API (api.papermc.io/v2 now returns {"error":"sunset"}),
 * which breaks every paper-family egg (paper, folia, velocity, waterfall): the
 * version/build lookup returns null and the installer downloads a tiny error
 * page as server.jar ("Invalid or corrupt jarfile"). The replacement uses the
 * v3 "fill" API (fill.papermc.io/v3), which returns the download URL directly
 * in the build JSON. PROJECT is read from the original script so the same
 * template serves all paper-family projects.
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
            # Skip versions whose minimum Java exceeds the runtime image's Java, so
            # "latest" never resolves to a build the container cannot run.
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
 * Apply known install-script patches. Returns the (possibly rewritten) script.
 * No-op for scripts that don't match a known-broken pattern.
 */
export function patchPelicanInstallScript(script: string): string {
  if (!script) return script;

  // PaperMC v2 sunset — rewrite paper-family scripts to the v3 API.
  if (script.includes("api.papermc.io/v2")) {
    const projectMatch = script.match(/PROJECT=([A-Za-z0-9_-]+)/);
    const project = projectMatch?.[1] ?? "paper";
    return paperV3Script(project);
  }

  return script;
}
