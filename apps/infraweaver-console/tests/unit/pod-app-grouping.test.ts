import {
  groupPodsByApp,
  podsForApp,
  podMatchesAppByLabel,
  podMatchesAppByOwner,
  podMatchesAppByName,
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

  it("disambiguates WordPress site pods by the infraweaver.io/site label", () => {
    const apps: AppIdentity[] = [
      { name: "blog", namespace: "wordpress" },
      { name: "shop", namespace: "wordpress" },
    ];
    const pods = [
      pod({ name: "blog-7c9-x1", namespace: "wordpress", labels: { "infraweaver.io/site": "blog", "infraweaver.io/component": "wordpress" } }),
      pod({ name: "blog-db-5f2-y2", namespace: "wordpress", labels: { "infraweaver.io/site": "blog", "infraweaver.io/component": "db" } }),
      pod({ name: "shop-8d1-z3", namespace: "wordpress", labels: { "infraweaver.io/site": "shop", "infraweaver.io/component": "wordpress" } }),
    ];

    const grouped = groupPodsByApp(apps, pods);

    expect(grouped.blog.map((p) => p.name)).toEqual(["blog-7c9-x1", "blog-db-5f2-y2"]);
    expect(grouped.shop.map((p) => p.name)).toEqual(["shop-8d1-z3"]);
  });

  it("falls back to the pod name prefix when labels and owners are missing", () => {
    const apps: AppIdentity[] = [
      { name: "blog", namespace: "wordpress" },
      { name: "shop", namespace: "wordpress" },
    ];
    // Shape returned by backends that omit labels/ownerReferences entirely.
    const pods = [
      pod({ name: "blog-7c9-x1", namespace: "wordpress" }),
      pod({ name: "blog-db-5f2-y2", namespace: "wordpress" }),
      pod({ name: "shop-8d1-z3", namespace: "wordpress" }),
    ];

    const grouped = groupPodsByApp(apps, pods);

    expect(grouped.blog.map((p) => p.name)).toEqual(["blog-7c9-x1", "blog-db-5f2-y2"]);
    expect(grouped.shop.map((p) => p.name)).toEqual(["shop-8d1-z3"]);
  });

  it("prefers the longest matching identifier for nested app names", () => {
    const apps: AppIdentity[] = [
      { name: "blog", namespace: "wordpress" },
      { name: "blog-shop", namespace: "wordpress" },
    ];
    const pods = [
      pod({ name: "blog-7c9-x1", namespace: "wordpress" }),
      pod({ name: "blog-shop-8d1-z3", namespace: "wordpress" }),
      pod({ name: "blog-shop-db-4a0-w4", namespace: "wordpress" }),
    ];

    const grouped = groupPodsByApp(apps, pods);

    expect(grouped.blog.map((p) => p.name)).toEqual(["blog-7c9-x1"]);
    expect(grouped["blog-shop"].map((p) => p.name)).toEqual(["blog-shop-8d1-z3", "blog-shop-db-4a0-w4"]);
  });

  it("lets an explicit label beat a competing owner/name prefix match", () => {
    const apps: AppIdentity[] = [
      { name: "alpha", namespace: "shared" },
      { name: "beta", namespace: "shared" },
    ];
    // Named like alpha's workload but labelled as beta's — the label wins.
    const pods = [
      pod({ name: "alpha-worker-1", namespace: "shared", labels: { "app.kubernetes.io/instance": "beta" } }),
    ];

    const grouped = groupPodsByApp(apps, pods);

    expect(grouped.alpha).toEqual([]);
    expect(grouped.beta.map((p) => p.name)).toEqual(["alpha-worker-1"]);
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

  it("matches the pod's own name by workload prefix only", () => {
    const p = pod({ name: "alpha-abc123-x9", namespace: "ns" });
    expect(podMatchesAppByName(p, { name: "alpha", namespace: "ns" })).toBe(true);
    expect(podMatchesAppByName(p, { name: "alp", namespace: "ns" })).toBe(false);
    expect(podMatchesAppByName(p, { name: "beta", namespace: "ns" })).toBe(false);
  });
});
