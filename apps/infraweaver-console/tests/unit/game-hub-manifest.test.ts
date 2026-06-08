import { generateServerManifestYaml } from "@/lib/game-hub-manifest";
import type { GameHubClients } from "@/lib/game-hub-server";

// Regression: the git server manifest must NOT pin spec.replicas. The console
// owns start/stop by scaling the live Deployment; pinning replicas in git makes
// ArgoCD selfHeal restart a stopped server on every sync. New servers must
// inherit the valheim stop-fix (replicas omitted from git).
describe("generateServerManifestYaml", () => {
  function makeClients(replicas: number): GameHubClients {
    const reject = () => Promise.reject(new Error("not found"));
    return {
      appsApi: {
        readNamespacedDeployment: jest.fn().mockResolvedValue({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "demo", namespace: "game-hub", labels: { app: "demo" } },
          spec: {
            replicas,
            strategy: { type: "Recreate" },
            selector: { matchLabels: { app: "demo" } },
            template: {
              metadata: { labels: { app: "demo" } },
              spec: { containers: [{ name: "demo", image: "demo:latest" }], volumes: [] },
            },
          },
        }),
      },
      coreApi: {
        readNamespacedService: jest.fn().mockResolvedValue({
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: "demo", namespace: "game-hub" },
          spec: { type: "NodePort", selector: { app: "demo" }, ports: [{ port: 25565 }] },
        }),
        readNamespacedConfigMap: jest.fn(reject),
        readNamespacedPersistentVolumeClaim: jest.fn(reject),
      },
      autoscalingApi: { readNamespacedHorizontalPodAutoscaler: jest.fn(reject) },
      batchApi: { readNamespacedCronJob: jest.fn(reject) },
    } as unknown as GameHubClients;
  }

  test("omits spec.replicas even when the live deployment is scaled up", async () => {
    const yamlOutput = await generateServerManifestYaml("demo", makeClients(1));

    expect(yamlOutput).toContain("kind: Deployment");
    expect(yamlOutput).not.toMatch(/^\s*replicas:/m);
  });

  test("omits spec.replicas when the live deployment is stopped (replicas 0)", async () => {
    const yamlOutput = await generateServerManifestYaml("demo", makeClients(0));

    expect(yamlOutput).not.toMatch(/^\s*replicas:/m);
  });
});
