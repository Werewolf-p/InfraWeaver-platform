// Shared translation of raw Kubernetes event reasons/messages into plain
// language, plus severity classification. Used by both the deploy wizard's
// installation console and the server-detail activity tab so the two views
// stay consistent and a routine restart (which emits transient
// scheduling/probe warnings while a ReadWriteOnce volume detaches from the old
// pod) never reads as a hard failure.

export type EventSeverity = "warning" | "info";

export interface RawEvent {
  type: string;
  reason: string;
  message: string;
}

/**
 * Warning-severity reasons that are still expected/transient during a normal
 * deploy or restart — we render these as informational rather than alarming.
 * "FailedScheduling" for an unbound PVC is the canonical example: it fires
 * every couple of seconds while the volume is still being provisioned/attached
 * and clears on its own.
 */
const TRANSIENT_WARNING_REASONS = new Set(["FailedScheduling", "Unhealthy"]);

/**
 * Some transient events are so noisy and so meaningless to an operator that we
 * hide them from the timeline entirely (they still churn in raw kubectl). The
 * unbound-PVC scheduling retry is pure scheduler bookkeeping while storage
 * comes online — showing it as a repeated red line is what made deploys look
 * broken.
 */
export function isNoiseEvent(reason: string, message: string): boolean {
  const text = `${reason} ${message}`.toLowerCase();
  return (
    text.includes("unbound immediate persistentvolumeclaims") ||
    (reason === "FailedScheduling" && text.includes("persistentvolumeclaim"))
  );
}

export function explainEvent(reason: string, message: string): string {
  const text = `${reason} ${message}`.toLowerCase();
  if (text.includes("unbound immediate persistentvolumeclaims") || (reason === "FailedScheduling" && text.includes("persistentvolumeclaim"))) {
    return "Waiting for the storage volume to be ready. This is normal at the start of a deploy and clears on its own once the volume is attached.";
  }
  if (reason === "FailedScheduling") {
    return "The scheduler is still finding a node for this server. It retries automatically.";
  }
  if (reason === "Unhealthy" && text.includes("context canceled")) {
    return "A health check was interrupted while the container was shutting down. Safe to ignore during a restart.";
  }
  if (reason === "Unhealthy") {
    return "A health check has not passed yet. The server may still be starting up.";
  }
  if (reason === "Killing") return "Stopping the current container so a new one can take its place.";
  if (reason === "Started") return "The container started.";
  if (reason === "Created") return "The container was created.";
  if (reason === "Pulled") return "The container image is ready on the node.";
  if (reason === "Pulling") return "Downloading the container image.";
  if (reason === "Scheduled") return "The server was assigned to a node.";
  if (reason === "SuccessfulAttachVolume") return "The storage volume attached successfully.";
  if (reason === "ScalingReplicaSet") return "Starting the server process.";
  if (reason === "BackOff" || text.includes("back-off")) return "The container is restarting repeatedly. Check the server logs for the underlying error.";
  if (reason === "Failed") return "The container failed to start. Check the server logs.";
  return message || reason;
}

export function severityFor(event: RawEvent): EventSeverity {
  if (event.type !== "Warning") return "info";
  return TRANSIENT_WARNING_REASONS.has(event.reason) ? "info" : "warning";
}
