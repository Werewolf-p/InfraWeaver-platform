import type * as k8s from "@kubernetes/client-node";

/**
 * Upper bound on how long a main-container install may hold a pod in the
 * "running but never-ready" state before we stop treating it as installing.
 *
 * A first-boot SteamCMD install runs inside the main container for eggs that
 * have no init container (palworld / rust / satisfactory). While it downloads,
 * the pod is 0/1 (the readiness/startup probe can't pass until the game binds
 * its socket). This ceiling exists purely as a stuck-pod backstop: a genuinely
 * wedged pod that sits running-yet-never-ready forever (restartCount still 0)
 * would otherwise be shielded from restart indefinitely. The largest install we
 * ship (ARK, ~23GB) completes well under this, so a first-boot pod older than
 * the ceiling is treated as stuck, not installing.
 */
export const MAX_MAIN_CONTAINER_INSTALL_MS = 60 * 60 * 1000; // 60 minutes

// Game-hub labels the pod (and its owning workload) with these. The
// main-container heuristic below is deliberately scoped to game workloads: a
// bare "running but not ready" main container is a normal (transient) state for
// arbitrary cluster pods, so applying it cluster-wide would freeze restart /
// delete of any freshly-rolled-out pod that hasn't gone ready yet. Requiring the
// game marker keeps the guard from over-reaching beyond the installs it targets.
const GAME_MARKER_LABEL_KEYS = ["infraweaver/game", "infraweaver.io/game"] as const;

function hasGameMarker(pod: k8s.V1Pod | null | undefined): boolean {
  const labels = pod?.metadata?.labels ?? {};
  return GAME_MARKER_LABEL_KEYS.some((key) => labels[key] === "true");
}

/**
 * True while a pod is still executing an init container — i.e. the install /
 * first-boot phase (SteamCMD download, egg install, config-sync) has not handed
 * off to the main container yet. Mirrors the `activeInitContainer` check the
 * game-hub status route uses to report the "installing" power state.
 */
export function isInitContainerInstalling(pod: k8s.V1Pod | null | undefined): boolean {
  return (pod?.status?.initContainerStatuses ?? []).some(
    (cs) => cs.state?.running != null && !cs.ready,
  );
}

/**
 * True while a MAIN container is running its first-boot install and has never
 * yet reached readiness — covering steam-install eggs that have no init
 * container (palworld / rust / satisfactory), whose install executes inside the
 * long-running container itself. Such a pod reports 0/1: the container is
 * `running` but `ready:false` (startup/readiness probe can't pass until the game
 * binds its socket), restartCount 0, with no prior container state.
 *
 * The heuristic is deliberately narrow so it does not shield a genuinely stuck
 * pod from restart:
 *   - scoped to game-marked pods (see hasGameMarker);
 *   - the container's startup probe must not have passed (`started !== true`) —
 *     once startup passes the install/first-boot phase is over;
 *   - restartCount must be 0 and there must be no prior container state — a pod
 *     that has crashed and restarted is churning, not installing, and the
 *     operator should be able to restart it;
 *   - the container must have started within the install window — a pod wedged
 *     running-yet-never-ready past the ceiling is treated as stuck.
 */
export function isMainContainerInstalling(
  pod: k8s.V1Pod | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!hasGameMarker(pod)) return false;
  // An init container still running is the init-install case (handled above); a
  // main container can't be mid-install while init work is still in flight.
  if ((pod?.status?.initContainerStatuses ?? []).some((cs) => cs.state?.running != null)) {
    return false;
  }
  return (pod?.status?.containerStatuses ?? []).some((cs) => isFirstBootInstallContainer(cs, now));
}

function isFirstBootInstallContainer(cs: k8s.V1ContainerStatus, now: number): boolean {
  const running = cs.state?.running;
  if (running == null) return false; // waiting/terminated — not a live first boot
  if (cs.ready) return false; // readiness already reached — not installing
  if (cs.started === true) return false; // startup probe passed — install/first-boot phase over
  if ((cs.restartCount ?? 0) > 0) return false; // has restarted — crashloop/stuck, not first boot
  if (cs.lastState?.terminated != null || cs.lastState?.waiting != null || cs.lastState?.running != null) {
    return false; // has a prior container state — not a first boot
  }
  const startedAtRaw = running.startedAt;
  if (startedAtRaw != null) {
    const startedAt = new Date(startedAtRaw).getTime();
    if (Number.isFinite(startedAt) && now - startedAt > MAX_MAIN_CONTAINER_INSTALL_MS) {
      return false; // past the install window — treat as stuck, not installing
    }
  }
  return true;
}

/**
 * True while a pod is still installing — either an init container is running the
 * install (isInitContainerInstalling) or a main container is running its
 * first-boot install and has never reached readiness (isMainContainerInstalling).
 *
 * Lives in core (not the game-hub addon) so any restart/delete route can refuse
 * to churn a mid-install pod without reaching across the addon boundary.
 */
export function isPodInstalling(
  pod: k8s.V1Pod | null | undefined,
  now: number = Date.now(),
): boolean {
  return isInitContainerInstalling(pod) || isMainContainerInstalling(pod, now);
}
