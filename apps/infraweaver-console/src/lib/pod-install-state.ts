import type * as k8s from "@kubernetes/client-node";

/**
 * True while a pod is still executing an init container — i.e. the install /
 * first-boot phase (SteamCMD download, egg install, config-sync) has not handed
 * off to the main container yet. Mirrors the `activeInitContainer` check the
 * game-hub status route uses to report the "installing" power state.
 *
 * Lives in core (not the game-hub addon) so any restart/delete route can refuse
 * to churn a mid-install pod without reaching across the addon boundary.
 */
export function isPodInstalling(pod: k8s.V1Pod | null | undefined): boolean {
  return (pod?.status?.initContainerStatuses ?? []).some(
    (cs) => cs.state?.running != null && !cs.ready,
  );
}
