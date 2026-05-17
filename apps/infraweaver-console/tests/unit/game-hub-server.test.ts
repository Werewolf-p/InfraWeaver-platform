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

import { buildConsoleInputScript, forceStopServer, isKubernetesNotFoundError, scaleServerWorkload } from "@/lib/game-hub-server";

describe("game hub server helpers", () => {
  it("builds a safe exec script for console input", () => {
    const script = buildConsoleInputScript("say it's time");
    expect(script).toContain("mc-send-to-console");
    expect(script).toContain("/proc/1/fd/0");
    expect(script).toContain("rcon-cli");
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
