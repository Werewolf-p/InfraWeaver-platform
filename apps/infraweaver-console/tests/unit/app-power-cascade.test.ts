/**
 * Cascade-stop wiring: powering an app OFF must scale every controller in its
 * destination namespace to zero (which terminates the controllers' pods) AND
 * durably pause ArgoCD so the self-healer cannot restore it. This proves the
 * Apps-page "Stop app" action cascades to the app's child pods.
 */

// app-power is a server module; neutralize the `server-only` import guard under jest.
jest.mock("server-only", () => ({}), { virtual: true });

// Named classes so app-power's `makeApiClient(k8s.AppsV1Api)` can be routed by name.
jest.mock("@kubernetes/client-node", () => ({
  AppsV1Api: class AppsV1Api {},
  CustomObjectsApi: class CustomObjectsApi {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
}));

jest.mock("@/lib/kube-client", () => ({ makeCoreApi: jest.fn(() => ({})) }));
jest.mock("@/lib/k8s", () => ({ loadKubeConfig: jest.fn() }));

import { loadKubeConfig } from "@/lib/k8s";
import { powerApp } from "@/lib/app-power";

const POWER_ANNOTATION = "infraweaver.io/power";

interface ScaleCall {
  name: string;
  replicas: number | undefined;
}

interface ScaleArg {
  name: string;
  body?: { spec?: { replicas?: number } };
}

interface ArgoAppShape {
  metadata: { name?: string; annotations: Record<string, string> };
  spec: { destination?: { namespace?: string }; syncPolicy?: { automated?: unknown } };
}

function buildClients(argoApp: unknown) {
  const scaleCalls: ScaleCall[] = [];
  let replacedArgoApp: ArgoAppShape | null = null;

  const appsApi = {
    listNamespacedDeployment: jest.fn().mockResolvedValue({
      items: [{ metadata: { name: "web" } }, { metadata: { name: "worker" } }],
    }),
    listNamespacedStatefulSet: jest.fn().mockResolvedValue({
      items: [{ metadata: { name: "db" } }],
    }),
    readNamespacedDeploymentScale: jest.fn().mockResolvedValue({ spec: { replicas: 1 } }),
    replaceNamespacedDeploymentScale: jest.fn().mockImplementation(({ name, body }: ScaleArg) => {
      scaleCalls.push({ name: `deploy/${name}`, replicas: body?.spec?.replicas });
      return {};
    }),
    readNamespacedStatefulSetScale: jest.fn().mockResolvedValue({ spec: { replicas: 1 } }),
    replaceNamespacedStatefulSetScale: jest.fn().mockImplementation(({ name, body }: ScaleArg) => {
      scaleCalls.push({ name: `statefulset/${name}`, replicas: body?.spec?.replicas });
      return {};
    }),
  };

  const customApi = {
    getNamespacedCustomObject: jest.fn().mockResolvedValue(argoApp),
    replaceNamespacedCustomObject: jest.fn().mockImplementation(({ body }: { body: ArgoAppShape }) => {
      replacedArgoApp = body;
      return {};
    }),
  };

  (loadKubeConfig as jest.Mock).mockReturnValue({
    makeApiClient: (ctor: { name: string }) => (ctor?.name === "AppsV1Api" ? appsApi : customApi),
  });

  return { appsApi, customApi, scaleCalls, getReplacedArgoApp: () => replacedArgoApp };
}

describe("powerApp — stop cascades to child pods", () => {
  beforeEach(() => jest.clearAllMocks());

  it("scales every deployment and statefulset in the namespace to zero", async () => {
    const { scaleCalls } = buildClients({
      metadata: { name: "demo", annotations: {} },
      spec: { destination: { namespace: "demo" }, syncPolicy: { automated: { prune: true, selfHeal: true } } },
    });

    const result = await powerApp("cluster-1", "demo", "stop");

    expect(scaleCalls).toEqual([
      { name: "deploy/web", replicas: 0 },
      { name: "deploy/worker", replicas: 0 },
      { name: "statefulset/db", replicas: 0 },
    ]);
    expect(result.workloads).toEqual(["deploy/web", "deploy/worker", "statefulset/db"]);
    expect(result.state).toBe("off");
  });

  it("durably annotates power=off and pauses ArgoCD automated sync", async () => {
    const { getReplacedArgoApp } = buildClients({
      metadata: { name: "demo", annotations: {} },
      spec: { destination: { namespace: "demo" }, syncPolicy: { automated: { prune: true, selfHeal: true } } },
    });

    await powerApp("cluster-1", "demo", "stop");

    const saved = getReplacedArgoApp();
    expect(saved).not.toBeNull();
    expect(saved?.metadata.annotations[POWER_ANNOTATION]).toBe("off");
    // Automated sync must be cleared so selfHeal/the self-healer cannot scale pods back up.
    expect(saved?.spec.syncPolicy?.automated).toBeUndefined();
  });

  it("rejects an app with no destination namespace (nothing to cascade to)", async () => {
    buildClients({ metadata: { name: "demo", annotations: {} }, spec: {} });
    await expect(powerApp("cluster-1", "demo", "stop")).rejects.toThrow(/destination namespace/);
  });
});
