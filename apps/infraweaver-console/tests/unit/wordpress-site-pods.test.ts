import { shapeSitePods, type SitePodSource } from "@/addons/wordpress-manager/lib/site-pods";

function podSource(partial: Partial<SitePodSource> & { name: string; component?: string }): SitePodSource {
  const { name, component, ...rest } = partial;
  return {
    metadata: {
      name,
      labels: component ? { "infraweaver.io/component": component } : {},
      creationTimestamp: "2026-07-01T00:00:00Z",
    },
    status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }] },
    ...rest,
  };
}

describe("shapeSitePods", () => {
  it("orders the WordPress pod before the database pod", () => {
    const shaped = shapeSitePods([
      podSource({ name: "blog-db-1", component: "db" }),
      podSource({ name: "blog-1", component: "wordpress" }),
    ]);

    expect(shaped.map((p) => p.name)).toEqual(["blog-1", "blog-db-1"]);
    expect(shaped.map((p) => p.component)).toEqual(["wordpress", "db"]);
  });

  it("surfaces a waiting reason over the pod phase", () => {
    const shaped = shapeSitePods([
      {
        metadata: { name: "blog-1", labels: { "infraweaver.io/component": "wordpress" } },
        status: {
          phase: "Pending",
          containerStatuses: [{ ready: false, restartCount: 2, state: { waiting: { reason: "ImagePullBackOff" } } }],
        },
      },
    ]);

    expect(shaped[0].status).toBe("ImagePullBackOff");
    expect(shaped[0].ready).toBe(false);
    expect(shaped[0].restarts).toBe(2);
  });

  it("is only ready when every container is ready", () => {
    const shaped = shapeSitePods([
      {
        metadata: { name: "blog-1" },
        status: { phase: "Running", containerStatuses: [{ ready: true }, { ready: false }] },
      },
    ]);

    expect(shaped[0].ready).toBe(false);
    expect(shaped[0].component).toBe("other");
  });

  it("drops entries without a name and handles missing statuses", () => {
    const shaped = shapeSitePods([
      { metadata: {} },
      { metadata: { name: "blog-1" } },
    ]);

    expect(shaped).toHaveLength(1);
    expect(shaped[0]).toMatchObject({ name: "blog-1", status: "Unknown", ready: false, restarts: 0 });
  });

  it("normalizes Date creation timestamps to ISO strings", () => {
    const shaped = shapeSitePods([
      {
        metadata: { name: "blog-1", creationTimestamp: new Date("2026-07-02T12:00:00Z") },
        status: { phase: "Running", containerStatuses: [{ ready: true }] },
      },
    ]);

    expect(shaped[0].startedAt).toBe("2026-07-02T12:00:00.000Z");
  });
});
