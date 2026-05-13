import { loadAll } from "js-yaml";
import { convertAppFeedEntry, type AppFeedEntry } from "@/lib/appfeed-converter";

type ParsedDoc = { kind?: string };
type ParsedDeployment = ParsedDoc & {
  spec: {
    template: {
      spec: {
        containers: Array<{
          image: string;
          args?: string[];
          env?: Array<{ name: string; value?: string }>;
        }>;
      };
    };
  };
};
type ParsedIngressRoute = ParsedDoc & {
  spec: { routes: Array<{ services: Array<{ port: number }> }> };
};
type ParsedService = ParsedDoc & {
  spec: { ports: Array<{ name: string }> };
};
type ParsedPvc = ParsedDoc & {
  spec: { storageClassName?: string };
};

describe("convertAppFeedEntry", () => {
  it("handles placeholder WebUI ports, tagged images, and quoted PostArgs", () => {
    const app: AppFeedEntry = {
      Name: "Test App",
      Repository: "ghcr.io/example/test-app:latest",
      WebUI: "http://[IP]:[PORT:8080]/",
      PostArgs: '--listen "0.0.0.0:8080"',
      Config: [
        {
          "@attributes": {
            Name: "Web UI",
            Target: "8080",
            Default: "8080",
            Type: "Port",
          },
        },
        {
          "@attributes": {
            Name: "AppData",
            Target: "/config",
            Default: "/mnt/user/appdata/test-app",
            Required: "true",
            Type: "Path",
          },
        },
      ],
    };

    const result = convertAppFeedEntry(app);
    expect(result.slug).toBe("test-app");

    const docs = loadAll(result.combinedYaml) as ParsedDoc[];
    expect(docs.map(doc => doc.kind)).toEqual([
      "Deployment",
      "Service",
      "PersistentVolumeClaim",
      "IngressRoute",
    ]);

    const deployment = docs[0] as ParsedDeployment;
    expect(deployment.spec.template.spec.containers[0].image).toBe("ghcr.io/example/test-app:latest");
    expect(deployment.spec.template.spec.containers[0].args).toEqual(["--listen", "0.0.0.0:8080"]);

    const ingress = docs[3] as ParsedIngressRoute;
    expect(ingress.spec.routes[0].services[0].port).toBe(8080);
  });

  it("handles a single Config object", () => {
    const result = convertAppFeedEntry({
      Name: "Single Config App",
      Repository: "ghcr.io/example/single-config:1.0",
      Config: {
        "@attributes": {
          Name: "Main Port",
          Target: "3000",
          Default: "3000",
          Type: "Port",
        },
      },
    });

    const docs = loadAll(result.combinedYaml) as ParsedDoc[];
    expect(docs.some(doc => doc.kind === "Service")).toBe(true);
  });

  it("falls back to a safe port name when config names are empty", () => {
    const result = convertAppFeedEntry({
      Name: "Unnamed Port App",
      Repository: "ghcr.io/example/unnamed-port:1.0",
      Config: {
        "@attributes": {
          Name: "",
          Target: "9090",
          Default: "9090",
          Type: "Port",
        },
      },
    });

    const docs = loadAll(result.combinedYaml) as ParsedDoc[];
    const service = docs.find(doc => doc.kind === "Service") as ParsedService;
    expect(service.spec.ports[0].name).toBe("port-9090");
  });

  it("prefers config defaults when AppFeed values are blank", () => {
    const result = convertAppFeedEntry({
      Name: "Defaulted Env App",
      Repository: "ghcr.io/example/defaulted-env:1.0",
      Config: {
        "@attributes": {
          Name: "Mode",
          Target: "MODE",
          Default: "standalone",
          Type: "Variable",
        },
        value: "",
      },
    });

    const docs = loadAll(result.combinedYaml) as ParsedDoc[];
    const deployment = docs[0] as ParsedDeployment;
    expect(deployment.spec.template.spec.containers[0].env).toEqual([
      { name: "MODE", value: "standalone" },
    ]);
  });

  it("defaults PVCs to the longhorn-game storage class", () => {
    const result = convertAppFeedEntry({
      Name: "PVC App",
      Repository: "ghcr.io/example/pvc-app:1.0",
      Config: {
        "@attributes": {
          Name: "AppData",
          Target: "/config",
          Default: "/mnt/user/appdata/pvc-app",
          Required: "true",
          Type: "Path",
        },
      },
    });

    const docs = loadAll(result.combinedYaml) as ParsedDoc[];
    const pvc = docs.find(doc => doc.kind === "PersistentVolumeClaim") as ParsedPvc;
    expect(pvc.spec.storageClassName).toBe("longhorn-game");
  });

  it("rejects apps without an image", () => {
    expect(() => convertAppFeedEntry({ Name: "Broken App", Repository: "   " })).toThrow(
      'App "Broken App" is missing a container image'
    );
  });
});
