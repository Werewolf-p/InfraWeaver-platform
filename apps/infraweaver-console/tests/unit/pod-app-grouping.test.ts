import {
  groupPodsByApp,
  podsForApp,
  podMatchesAppByLabel,
  podMatchesAppByOwner,
  type AppIdentity,
} from "@/lib/pod-app-grouping";
import type { KubernetesPod } from "@/types/kubernetes";

function pod(partial: Partial<KubernetesPod> & Pick<KubernetesPod, "name" | "namespace">): KubernetesPod {
  return {
    status: "Running",
    containers: [],
    createdAt: "2026-06-30T00:00:00Z",
    ...partial,
  };
}

describe("groupPodsByApp", () => {
  it("assigns every pod in a namespace to the single app that owns it", () => {
    const apps: AppIdentity[] = [{ name: "foo", namespace: "foo-ns" }];
    const pods = [
      pod({ name: "foo-abc", namespace: "foo-ns" }),
      pod({ name: "foo-def", namespace: "foo-ns" }),
    ];

    const grouped = groupPodsByApp(apps, pods);

    expect(grouped.foo.map((p) => p.name)).toEqual(["foo-abc", "foo-def"]);
  });

  it("ignores pods that live outside any app's destination namespace", () => {
    const apps: AppIdentity[] = [{ name: "foo", namespace: "foo-ns" }];
    const pods = [
      pod({ name: "foo-abc", namespace: "foo-ns" }),
      pod({ name: "stray", namespace: "kube-system" }),
    ];

    const grouped = groupPodsByApp(apps, pods);

    expect(grouped.foo.map((p) => p.name)).toEqual(["foo-abc"]);
  });

  it("returns an empty bucket for an app with no pods", () => {
    const apps: AppIdentity[] = [{ name: "empty", namespace: "empty-ns" }];
    expect(groupPodsByApp(apps, [])).toEqual({ empty: [] });
  });

  it("disambiguates shared-namespace pods by the ArgoCD instance label", () => {
    const apps: AppIdentity[] = [
      { name: "alpha", namespace: "shared" },
      { name: "beta", namespace: "shared" },
    ];
    const pods = [
      pod({ name: "alpha-1", namespace: "shared", labels: { "app.kubernetes.io/instance": "alpha" } }),
      pod({ name: "beta-1", namespace: "shared", labels: { "app.kubernetes.io/instance": "beta" } }),
    ];

    const grouped = groupPodsByApp(apps, pods);

    expect(grouped.alpha.map((p) => p.name)).toEqual(["alpha-1"]);
    expect(grouped.beta.map((p) => p.name)).toEqual(["beta-1"]);
  });

  it("disambiguates shared-namespace pods by controller owner reference", () => {
    const apps: AppIdentity[] = [
      { name: "alpha", namespace: "shared" },
      { name: "beta", namespace: "shared" },
    ];
    const pods = [
      pod({ name: "alpha-1", namespace: "shared", ownerReferences: [{ kind: "ReplicaSet", name: "alpha-7c9" }] }),
      pod({ name: "beta-1", namespace: "shared", ownerReferences: [{ kind: "StatefulSet", name: "beta" }] }),
    ];

    const grouped = groupPodsByApp(apps, pods);

    expect(grouped.alpha.map((p) => p.name)).toEqual(["alpha-1"]);
    expect(grouped.beta.map((p) => p.name)).toEqual(["beta-1"]);
  });

  it("matches the bare slug when the app uses the catalog naming wrapper", () => {
    const apps: AppIdentity[] = [
      { name: "catalog-foo-manifests", namespace: "shared" },
      { name: "catalog-bar-manifests", namespace: "shared" },
    ];
    const pods = [
      pod({ name: "foo-1", namespace: "shared", labels: { "app.kubernetes.io/name": "foo" } }),
      pod({ name: "bar-1", namespace: "shared", labels: { "app.kubernetes.io/name": "bar" } }),
    ];

    const grouped = groupPodsByApp(apps, pods);

    expect(grouped["catalog-foo-manifests"].map((p) => p.name)).toEqual(["foo-1"]);
    expect(grouped["catalog-bar-manifests"].map((p) => p.name)).toEqual(["bar-1"]);
  });

  it("shares ambiguous pods across co-located apps rather than dropping them", () => {
    const apps: AppIdentity[] = [
      { name: "alpha", namespace: "shared" },
      { name: "beta", namespace: "shared" },
    ];
    // No identifying labels/owners — cannot be attributed to one app.
    const pods = [pod({ name: "mystery", namespace: "shared" })];

    const grouped = groupPodsByApp(apps, pods);

    expect(grouped.alpha.map((p) => p.name)).toEqual(["mystery"]);
    expect(grouped.beta.map((p) => p.name)).toEqual(["mystery"]);
  });

  it("does not mutate the input pods", () => {
    const apps: AppIdentity[] = [{ name: "foo", namespace: "foo-ns" }];
    const original = pod({ name: "foo-abc", namespace: "foo-ns" });
    const snapshot = JSON.stringify(original);

    groupPodsByApp(apps, [original]);

    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("podsForApp", () => {
  it("returns just the pods owned by the requested app", () => {
    const app: AppIdentity = { name: "foo", namespace: "foo-ns" };
    const pods = [
      pod({ name: "foo-abc", namespace: "foo-ns" }),
      pod({ name: "other", namespace: "bar-ns" }),
    ];

    expect(podsForApp(app, pods).map((p) => p.name)).toEqual(["foo-abc"]);
  });

  it("honors sibling apps when disambiguating a shared namespace", () => {
    const app: AppIdentity = { name: "alpha", namespace: "shared" };
    const siblings: AppIdentity[] = [
      { name: "alpha", namespace: "shared" },
      { name: "beta", namespace: "shared" },
    ];
    const pods = [
      pod({ name: "alpha-1", namespace: "shared", labels: { app: "alpha" } }),
      pod({ name: "beta-1", namespace: "shared", labels: { app: "beta" } }),
    ];

    expect(podsForApp(app, pods, siblings).map((p) => p.name)).toEqual(["alpha-1"]);
  });
});

describe("pod match predicates", () => {
  it("matches labels only against the owning app", () => {
    const p = pod({ name: "x", namespace: "ns", labels: { "app.kubernetes.io/part-of": "alpha" } });
    expect(podMatchesAppByLabel(p, { name: "alpha", namespace: "ns" })).toBe(true);
    expect(podMatchesAppByLabel(p, { name: "beta", namespace: "ns" })).toBe(false);
  });

  it("matches owner references by exact name or workload prefix", () => {
    const p = pod({ name: "x", namespace: "ns", ownerReferences: [{ kind: "ReplicaSet", name: "alpha-abc123" }] });
    expect(podMatchesAppByOwner(p, { name: "alpha", namespace: "ns" })).toBe(true);
    expect(podMatchesAppByOwner(p, { name: "alp", namespace: "ns" })).toBe(false);
  });
});
