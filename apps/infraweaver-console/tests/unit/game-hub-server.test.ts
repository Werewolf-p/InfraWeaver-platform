jest.mock("@kubernetes/client-node", () => {
  class DummyApi {}
  class DummyExec {
    exec() {
      return Promise.resolve({ on: jest.fn() });
    }
  }
  class DummyKubeConfig {
    loadFromString() {}
    loadFromCluster() {}
    loadFromFile() {}
    loadFromDefault() {}
    getCurrentCluster() {
      return { server: "https://cluster.example.test" };
    }
  }

  return {
    Exec: DummyExec,
    KubeConfig: DummyKubeConfig,
    AppsV1Api: DummyApi,
    AutoscalingV2Api: DummyApi,
    BatchV1Api: DummyApi,
    CoreV1Api: DummyApi,
    CustomObjectsApi: DummyApi,
    ServerConfiguration: class {},
    createConfiguration: jest.fn(() => ({})),
  };
});

import { buildConsoleInputScript, derivePowerStatus, forceStopServer, isKubernetesNotFoundError, isPodInstalling, restartServerPods, scaleServerWorkload } from "@/lib/game-hub-server";

describe("derivePowerStatus", () => {
  it("reports maintenance regardless of replica counts", () => {
    expect(
      derivePowerStatus({ maintenanceMode: true, specReplicas: 1, statusReplicas: 1, readyReplicas: 1 }),
    ).toBe("maintenance");
  });

  it("reports stopping while pods are still terminating after a stop", () => {
    // Stop scales spec.replicas to 0, but the pod lingers during graceful shutdown.
    expect(
      derivePowerStatus({ maintenanceMode: false, specReplicas: 0, statusReplicas: 1, readyReplicas: 0 }),
    ).toBe("stopping");
  });

  it("reports stopped once the last pod has exited", () => {
    expect(
      derivePowerStatus({ maintenanceMode: false, specReplicas: 0, statusReplicas: 0, readyReplicas: 0 }),
    ).toBe("stopped");
  });

  it("reports running when at least one pod is ready", () => {
    expect(
      derivePowerStatus({ maintenanceMode: false, specReplicas: 1, statusReplicas: 1, readyReplicas: 1 }),
    ).toBe("running");
  });

  it("returns null while scaling up so callers can layer transitional states", () => {
    expect(
      derivePowerStatus({ maintenanceMode: false, specReplicas: 1, statusReplicas: 1, readyReplicas: 0 }),
    ).toBeNull();
  });
});

describe("game hub server helpers", () => {
  it("builds a safe exec script for console input", () => {
    const script = buildConsoleInputScript("say it's time");
    expect(script).toContain("mc-send-to-console");
    expect(script).toContain("/proc/1/fd/0");
    // rcon-cli is handled by runRconCommand/getGameRconArgs; buildConsoleInputScript is stdin-only
    expect(script).toContain("'say it'\\''s time'");
    expect(buildConsoleInputScript("^C")).toBe("kill -INT 1");
  });

  it("scales deployments through the scale subresource", async () => {
    const appsApi = {
      readNamespacedDeploymentScale: jest.fn().mockResolvedValue({ metadata: { resourceVersion: "1" }, spec: { replicas: 1 } }),
      replaceNamespacedDeploymentScale: jest.fn().mockResolvedValue({}),
      readNamespacedStatefulSetScale: jest.fn(),
      replaceNamespacedStatefulSetScale: jest.fn(),
    };

    const result = await scaleServerWorkload(appsApi as never, "demo", 0);

    expect(result).toEqual({ kind: "deployment", replicas: 0 });
    expect(appsApi.replaceNamespacedDeploymentScale).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo",
      namespace: "game-hub",
      body: expect.objectContaining({ spec: expect.objectContaining({ replicas: 0 }) }),
    }));
    expect(appsApi.readNamespacedStatefulSetScale).not.toHaveBeenCalled();
  });

  it("falls back to statefulset scaling when deployment scale is unavailable", async () => {
    const appsApi = {
      readNamespacedDeploymentScale: jest.fn().mockRejectedValue(new Error("deployment missing")),
      replaceNamespacedDeploymentScale: jest.fn(),
      readNamespacedStatefulSetScale: jest.fn().mockResolvedValue({ metadata: { resourceVersion: "2" }, spec: { replicas: 1 } }),
      replaceNamespacedStatefulSetScale: jest.fn().mockResolvedValue({}),
    };

    const result = await scaleServerWorkload(appsApi as never, "demo", 0);

    expect(result).toEqual({ kind: "statefulset", replicas: 0 });
    expect(appsApi.replaceNamespacedStatefulSetScale).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo",
      namespace: "game-hub",
      body: expect.objectContaining({ spec: expect.objectContaining({ replicas: 0 }) }),
    }));
  });

  it("detects kubernetes not found errors from client-node responses", () => {
    expect(isKubernetesNotFoundError({ statusCode: 404 })).toBe(true);
    expect(isKubernetesNotFoundError({ body: { code: 404, reason: "NotFound" } })).toBe(true);
    expect(isKubernetesNotFoundError(new Error("HTTP-Code: 404"))).toBe(true);
    expect(isKubernetesNotFoundError({ statusCode: 500 })).toBe(false);
  });

  it("force stops by scaling down and deleting pods with zero grace period", async () => {
    const appsApi = {
      readNamespacedDeploymentScale: jest.fn().mockResolvedValue({ metadata: { resourceVersion: "1" }, spec: { replicas: 1 } }),
      replaceNamespacedDeploymentScale: jest.fn().mockResolvedValue({}),
      readNamespacedStatefulSetScale: jest.fn(),
      replaceNamespacedStatefulSetScale: jest.fn(),
    };
    const coreApi = {
      listNamespacedPod: jest.fn().mockResolvedValue({ items: [{ metadata: { name: "demo-0" } }, { metadata: { name: "demo-1" } }] }),
      deleteNamespacedPod: jest.fn().mockResolvedValue({}),
    };

    const result = await forceStopServer({ appsApi, coreApi } as never, "demo");

    expect(result).toEqual({ deletedPods: ["demo-0", "demo-1"] });
    expect(coreApi.deleteNamespacedPod).toHaveBeenNthCalledWith(1, {
      name: "demo-0",
      namespace: "game-hub",
      gracePeriodSeconds: 0,
      body: { gracePeriodSeconds: 0 },
    });
    expect(coreApi.deleteNamespacedPod).toHaveBeenNthCalledWith(2, {
      name: "demo-1",
      namespace: "game-hub",
      gracePeriodSeconds: 0,
      body: { gracePeriodSeconds: 0 },
    });
  });
});

describe("isPodInstalling", () => {
  it("is true while an init container is still running (installing)", () => {
    // SteamCMD installer init container mid-download: running and not ready.
    expect(
      isPodInstalling({ status: { initContainerStatuses: [{ name: "installer", ready: false, state: { running: { startedAt: new Date() } } }] } } as never),
    ).toBe(true);
  });

  it("is false once every init container has terminated (install finished)", () => {
    expect(
      isPodInstalling({ status: { initContainerStatuses: [{ name: "installer", ready: true, state: { terminated: { exitCode: 0 } } }] } } as never),
    ).toBe(false);
  });

  it("is false for a pod with no init containers", () => {
    expect(isPodInstalling({ status: { containerStatuses: [{ name: "game", ready: true, state: { running: {} } }] } } as never)).toBe(false);
    expect(isPodInstalling(null)).toBe(false);
    expect(isPodInstalling(undefined)).toBe(false);
  });
});

describe("restartServerPods", () => {
  it("deletes ready pods but skips pods still installing", async () => {
    const coreApi = {
      listNamespacedPod: jest.fn().mockResolvedValue({
        items: [
          // Mid-install pod: installer init container still running — must NOT be deleted.
          { metadata: { name: "ark-installing" }, status: { initContainerStatuses: [{ name: "installer", ready: false, state: { running: { startedAt: new Date() } } }] } },
          // Booted pod: init containers done — safe to restart.
          { metadata: { name: "ark-ready" }, status: { initContainerStatuses: [{ name: "installer", ready: true, state: { terminated: { exitCode: 0 } } }], containerStatuses: [{ name: "game", ready: true, state: { running: {} } }] } },
        ],
      }),
      deleteNamespacedPod: jest.fn().mockResolvedValue({}),
    };

    const result = await restartServerPods({ coreApi } as never, "ark");

    expect(result).toEqual({ deleted: ["ark-ready"], skippedInstalling: ["ark-installing"] });
    expect(coreApi.deleteNamespacedPod).toHaveBeenCalledTimes(1);
    expect(coreApi.deleteNamespacedPod).toHaveBeenCalledWith({ name: "ark-ready", namespace: "game-hub" });
    expect(coreApi.deleteNamespacedPod).not.toHaveBeenCalledWith(expect.objectContaining({ name: "ark-installing" }));
  });

  it("deletes normally when nothing is installing", async () => {
    const coreApi = {
      listNamespacedPod: jest.fn().mockResolvedValue({ items: [{ metadata: { name: "demo-0" }, status: {} }] }),
      deleteNamespacedPod: jest.fn().mockResolvedValue({}),
    };

    const result = await restartServerPods({ coreApi } as never, "demo");

    expect(result).toEqual({ deleted: ["demo-0"], skippedInstalling: [] });
    expect(coreApi.deleteNamespacedPod).toHaveBeenCalledTimes(1);
  });
});
