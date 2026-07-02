import { buildIngressRoute, buildSiteManifests, isGatedAuthMode, type AuthMode } from "@/addons/wordpress-manager/lib/manifest";

interface Route {
  match: string;
  priority?: number;
  middlewares: { name: string; namespace?: string }[];
}

function routesOf(authMode: AuthMode): Route[] {
  return buildIngressRoute("blog", { host: "blog.example.com", authMode }).spec.routes as Route[];
}

function middlewareNames(routes: Route[]): string[] {
  return routes.flatMap((r) => r.middlewares.map((m) => m.name));
}

describe("isGatedAuthMode", () => {
  test("only none is ungated", () => {
    expect(isGatedAuthMode("none")).toBe(false);
    expect(isGatedAuthMode("login")).toBe(true);
    expect(isGatedAuthMode("admin")).toBe(true);
    expect(isGatedAuthMode("full")).toBe(true);
  });
});

describe("buildIngressRoute — protection scopes", () => {
  test("none: single public route, no forward-auth, no deny", () => {
    const routes = routesOf("none");
    expect(routes).toHaveLength(1);
    expect(middlewareNames(routes)).not.toContain("forward-auth");
    expect(middlewareNames(routes)).not.toContain("wordpress-deny");
  });

  test("login: gates /wp-admin + /wp-login.php via forward-auth, keeps admin-ajax public, blocks nothing", () => {
    const routes = routesOf("login");
    const gated = routes.find((r) => r.match.includes("wp-login.php"))!;
    expect(gated.middlewares.some((m) => m.name === "forward-auth")).toBe(true);
    // admin-ajax has its own higher-priority public rule (no forward-auth).
    const ajax = routes.find((r) => r.match.includes("admin-ajax.php"))!;
    expect(ajax.middlewares.some((m) => m.name === "forward-auth")).toBe(false);
    // login mode must NOT hard-block the high-risk surface — that's admin mode's job.
    expect(middlewareNames(routes)).not.toContain("wordpress-deny");
    expect(routes.some((r) => r.match.includes("xmlrpc.php"))).toBe(false);
  });

  test("admin: keeps the high-risk deny rule (regression guard)", () => {
    const routes = routesOf("admin");
    expect(middlewareNames(routes)).toContain("wordpress-deny");
    expect(routes.some((r) => r.match.includes("xmlrpc.php"))).toBe(true);
  });

  test("full: whole site behind forward-auth", () => {
    const routes = routesOf("full");
    const catchAll = routes.find((r) => r.match === "Host(`blog.example.com`)")!;
    expect(catchAll.middlewares.some((m) => m.name === "forward-auth")).toBe(true);
  });
});

describe("buildSiteManifests — deny middleware object", () => {
  const hasDenyMiddleware = (authMode: AuthMode) =>
    buildSiteManifests("blog", { host: "blog.example.com", authMode }).objects.some(
      (o) => (o as { kind?: string }).kind === "Middleware",
    );

  test("only admin mode ships the deny Middleware object", () => {
    expect(hasDenyMiddleware("none")).toBe(false);
    expect(hasDenyMiddleware("login")).toBe(false);
    expect(hasDenyMiddleware("admin")).toBe(true);
    expect(hasDenyMiddleware("full")).toBe(false);
  });
});
