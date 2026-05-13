import type * as k8s from "@kubernetes/client-node";

const UNIVERSAL_PROBE_COMMAND = ["sh", "-c", "pgrep -P 1 > /dev/null 2>&1"];

export function buildUniversalGameServerProbes(): Pick<k8s.V1Container, "livenessProbe" | "readinessProbe"> {
  return {
    livenessProbe: {
      exec: {
        command: UNIVERSAL_PROBE_COMMAND,
      },
      initialDelaySeconds: 120,
      periodSeconds: 30,
      failureThreshold: 3,
    },
    readinessProbe: {
      exec: {
        command: UNIVERSAL_PROBE_COMMAND,
      },
      initialDelaySeconds: 60,
      periodSeconds: 15,
      failureThreshold: 3,
    },
  };
}
