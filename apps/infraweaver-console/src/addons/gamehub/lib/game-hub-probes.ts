import type * as k8s from "@kubernetes/client-node";

// Checks that at least one child of PID 1 exists (game process is alive).
// Works for any game server regardless of protocol or port.
const PROCESS_CHECK = ["sh", "-c", "pgrep -P 1 > /dev/null 2>&1"];

/**
 * Builds probes for a game server container.
 *
 * Uses a startupProbe (up to ~15 minutes, configurable) to allow for slow-starting
 * games (SteamCMD pre-download, world gen, JVM warm-up, etc.) without killing
 * the container prematurely. Once startup passes, normal liveness / readiness
 * probes take over.
 *
 * @param startupMinutes - Maximum allowed startup time before the container is
 *   considered failed. Default 10 minutes. Heavy games (ARK, Satisfactory,
 *   Space Engineers) may need 15–20.
 */
export function buildUniversalGameServerProbes(startupMinutes = 10): Pick<
  k8s.V1Container,
  "startupProbe" | "livenessProbe" | "readinessProbe"
> {
  const startupFailureThreshold = Math.ceil((startupMinutes * 60) / 20);
  return {
    // startupProbe gates liveness/readiness until the game process is alive.
    // failureThreshold * periodSeconds = total allowed startup window.
    startupProbe: {
      exec: { command: PROCESS_CHECK },
      initialDelaySeconds: 15,
      periodSeconds: 20,
      failureThreshold: startupFailureThreshold,
    },
    livenessProbe: {
      exec: { command: PROCESS_CHECK },
      periodSeconds: 30,
      failureThreshold: 3,
    },
    readinessProbe: {
      exec: { command: PROCESS_CHECK },
      periodSeconds: 15,
      failureThreshold: 3,
    },
  };
}
