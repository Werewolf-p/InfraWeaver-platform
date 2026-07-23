import "server-only";
import { buildConnectorPackage } from "./connector-package";
import type { ReleaseChannel } from "./channels";

/**
 * Connector artifact delivery seam (§5.1 channel-aware update).
 *
 * The update sweep targets each site with the version its release channel
 * resolves to (see `channel-registry.ts`). To install a specific version we must
 * obtain the matching plugin zip. This module is the ONE place that maps a
 * version string to its bytes, so the "where do older/newer artifacts come from"
 * question has a single answer that grows over time.
 *
 * v1 can only produce the version bundled into THIS console image (the vendored
 * copy `connector-package.ts` builds). Asking for any other version throws
 * `ConnectorArtifactUnavailableError` rather than silently shipping the bundled
 * bytes under the wrong version label — a mismatched install is worse than a
 * clearly-reported skip, because it would defeat the whole point of channel
 * targeting (a prod site would receive an alpha build, or vice versa).
 */

/**
 * Thrown when the requested Connector version cannot be delivered by this
 * console — e.g. a channel points at a version other than the one bundled in the
 * running image, and no artifact store is wired yet. Carries the version so the
 * caller can surface a precise per-site reason.
 */
export class ConnectorArtifactUnavailableError extends Error {
  constructor(readonly version: string, readonly bundledVersion: string) {
    super(
      `No Connector artifact available for version ${version} ` +
        `(this console bundles ${bundledVersion}). Refusing to install a mismatched version.`,
    );
    this.name = "ConnectorArtifactUnavailableError";
  }
}

/** The plugin zip for a target version, base64-encoded for the exec stdin transport. */
export interface ResolvedConnectorArtifact {
  readonly zipBase64: string;
}

/**
 * Resolve the installable artifact for `version`.
 *
 * v1: only the bundled version is available — return the vendored build's bytes.
 * For any other version, throw `ConnectorArtifactUnavailableError`; the caller
 * (`updateConnectorPlugin`) must refuse rather than push the wrong bytes.
 *
 * TODO(§5.1 artifact store): fetch the plugin zip for an arbitrary tagged
 * version here — e.g. a signed git-tag tarball / release-asset download keyed by
 * `version`, verified against a checksum — so a channel can point at a version
 * the running image doesn't happen to bundle. Until that lands, only the bundled
 * version is deliverable and every other target fails closed.
 */
export async function resolveConnectorArtifact(
  version: string,
  channel?: ReleaseChannel,
): Promise<ResolvedConnectorArtifact> {
  // Build from the channel's own source (a per-channel git-sync volume — see
  // connector-package.resolveDir, IWSL_CONNECTOR_DIR_<CHANNEL>). Deliver ONLY
  // when that source actually holds the requested version; otherwise fail closed
  // so a mid-sync or misconfigured channel never installs the wrong bytes under
  // the right label. The bundled copy remains the default source, so a channel
  // whose target equals the bundled version needs no extra wiring.
  const pkg = await buildConnectorPackage(channel);
  if (version === pkg.version) {
    return { zipBase64: pkg.zip.toString("base64") };
  }
  throw new ConnectorArtifactUnavailableError(version, pkg.version);
}
