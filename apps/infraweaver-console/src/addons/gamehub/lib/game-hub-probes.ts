import type * as k8s from "@kubernetes/client-node";

/**
 * A network port a game server listens on. Drives the port-binding probe so the
 * check stays game-agnostic: we only care that the declared socket is bound, not
 * which game owns it.
 */
export interface GameServerProbePort {
  port: number;
  protocol?: "TCP" | "UDP" | string;
}

// Fallback liveness signal used when no ports are known and, additionally, to
// bridge the window before a slow game has bound its socket. Passes when PID 1
// has at least one child process — i.e. the entrypoint is a wrapper/shell that
// forked the game (Minecraft-style eggs). It intentionally does NOT pass for
// exec-as-PID-1 images (dotnet/Terraria), which is why it can never be the only
// signal — see buildProbeExecCommand.
const CHILD_PROCESS_CHECK = "pgrep -P 1 > /dev/null 2>&1";

/**
 * Format a port number the way the Linux kernel renders the local port in
 * /proc/net/{tcp,tcp6,udp,udp6}: 4-digit, upper-case, zero-padded hex.
 */
function toProcNetHexPort(port: number): string {
  return (port & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Build a shell expression that succeeds if the given port is bound in any of
 * the supplied /proc/net files.
 *
 * - TCP: require the socket to be in LISTEN state (st == 0A). A game that is
 *   accepting connections is genuinely ready.
 * - UDP: connectionless, so there is no LISTEN state — a bound local port is the
 *   strongest available signal. This is what lets UDP-only servers (Valheim)
 *   report ready without a TCP check that would never pass.
 *
 * Each file is guarded with `[ -r ... ]` because /proc/net/tcp6 / udp6 are
 * absent when IPv6 is disabled, and an unreadable file would otherwise poison
 * grep's exit status.
 */
function buildPortCheck(port: GameServerProbePort): string {
  const hex = toProcNetHexPort(port.port);
  const isUdp = (port.protocol ?? "TCP").toUpperCase() === "UDP";
  const files = isUdp
    ? ["/proc/net/udp", "/proc/net/udp6"]
    : ["/proc/net/tcp", "/proc/net/tcp6"];
  // Local address column is "HEXADDR:HEXPORT". For TCP also pin the state field
  // that follows the remote address (rem_addr rem_port state) to 0A (LISTEN).
  const pattern = isUdp
    ? ` [0-9A-F]+:${hex} `
    : ` [0-9A-F]+:${hex} [0-9A-F]+:[0-9A-F]+ 0A `;
  return files
    .map((file) => `{ [ -r ${file} ] && grep -Eiq "${pattern}" ${file}; }`)
    .join(" || ");
}

export interface ProbeExecCommandOptions {
  /**
   * Whether to append the PID-1-has-a-child fallback (CHILD_PROCESS_CHECK).
   *
   * Keep it ON (the default) for startup and liveness: it bridges the window
   * before a slow, wrapper-style game (SteamCMD pre-download, world gen, JVM
   * warm-up) has bound its socket, so the container isn't failed/killed while it
   * is legitimately still coming up.
   *
   * Turn it OFF for readiness. The fallback is the root of the SteamCMD
   * silent-install gap: a steamcmd that hangs mid-download — or a broken/corrupt
   * install whose wrapper never launches the game — keeps PID 1's child alive
   * indefinitely while the game port is never bound. A child-based readiness then
   * reports the pod Ready and routes players to a dead server forever. Requiring a
   * genuinely bound socket makes those pods report NotReady instead.
   *
   * When no ports are known there is nothing else to check, so the fallback is
   * force-enabled regardless of this flag — otherwise the command would be empty
   * (and thus always fail), wedging every such server NotReady. This preserves the
   * previous no-ports behaviour for eggs that don't declare a port.
   */
  childProcessFallback?: boolean;
}

/**
 * Build the exec probe command used by startup / liveness / readiness.
 *
 * The command is entrypoint-agnostic. It succeeds when EITHER:
 *   1. any declared game port is bound (TCP LISTEN or UDP bound), which is true
 *      whether the game runs as PID 1 (exec-style dotnet/Terraria yolks) or as a
 *      child of a wrapper (Minecraft eggs), and works for UDP-only servers; OR
 *   2. (only when `childProcessFallback` is enabled) PID 1 has a child process,
 *      which bridges the startup window before a slow game has bound its socket
 *      for wrapper-style entrypoints.
 *
 * Readiness passes `{ childProcessFallback: false }` so "ready" means the socket
 * is actually bound. See ProbeExecCommandOptions and buildUniversalGameServerProbes.
 */
export function buildProbeExecCommand(
  ports: GameServerProbePort[] = [],
  { childProcessFallback = true }: ProbeExecCommandOptions = {},
): string[] {
  const checks = ports.map(buildPortCheck);
  // Force the child check when there is no port signal at all, otherwise the
  // command would be empty and the probe would fail permanently.
  if (childProcessFallback || checks.length === 0) {
    checks.push(CHILD_PROCESS_CHECK);
  }
  return ["sh", "-c", checks.join(" || ")];
}

/**
 * Builds probes for a game server container.
 *
 * Uses a startupProbe (up to ~15 minutes, configurable) to allow for slow-starting
 * games (SteamCMD pre-download, world gen, JVM warm-up, etc.) without killing
 * the container prematurely. Once startup passes, normal liveness / readiness
 * probes take over.
 *
 * The underlying check is game-agnostic and works across entrypoint styles:
 * exec-as-PID-1 images (dotnet/Terraria), wrapper/child-process eggs (Minecraft),
 * and UDP-only servers (Valheim). See buildProbeExecCommand.
 *
 * @param startupMinutes - Maximum allowed startup time before the container is
 *   considered failed. Default 10 minutes. Heavy games (ARK, Satisfactory,
 *   Space Engineers) may need 15–20.
 * @param ports - The ports the server listens on (from the egg / container spec).
 *   Passing these enables the entrypoint-agnostic port-binding check.
 */
export function buildUniversalGameServerProbes(
  startupMinutes = 10,
  ports: GameServerProbePort[] = [],
): Pick<k8s.V1Container, "startupProbe" | "livenessProbe" | "readinessProbe"> {
  const startupFailureThreshold = Math.ceil((startupMinutes * 60) / 20);
  // startup + liveness keep the child-process bridge so a slow-booting wrapper egg
  // (SteamCMD pre-download, world gen, JVM warm-up) is neither failed during
  // startup nor killed by liveness before it has bound its socket.
  const bridgedCommand = buildProbeExecCommand(ports);
  // readiness drops the bridge: a pod is only Ready once a declared game port is
  // actually bound. This closes the SteamCMD silent-install gap — a hung or corrupt
  // steamcmd keeps a child of PID 1 alive but never binds the port, so the pod now
  // reports NotReady (readyReplicas stays 0) instead of green. With no known ports
  // it falls back to the child check to avoid wedging (see buildProbeExecCommand).
  const readinessCommand = buildProbeExecCommand(ports, { childProcessFallback: false });
  return {
    // startupProbe gates liveness/readiness until the server is up.
    // failureThreshold * periodSeconds = total allowed startup window.
    startupProbe: {
      exec: { command: bridgedCommand },
      initialDelaySeconds: 15,
      periodSeconds: 20,
      failureThreshold: startupFailureThreshold,
    },
    livenessProbe: {
      exec: { command: bridgedCommand },
      periodSeconds: 30,
      failureThreshold: 3,
    },
    readinessProbe: {
      exec: { command: readinessCommand },
      periodSeconds: 15,
      failureThreshold: 3,
    },
  };
}
