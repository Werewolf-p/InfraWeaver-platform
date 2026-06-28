import { generatePassword, generateSiteSecrets, generateWpSalts, vaultPaths, vaultData } from "@/addons/wordpress-manager/lib/secrets";
import { isValidSiteName, assertValidSiteName, resourceNames, buildHost, deriveSiteId, legacySiteHost } from "@/addons/wordpress-manager/lib/naming";
import { listDomains, defaultDomain, isAllowedDomain } from "@/addons/wordpress-manager/lib/config";
import { buildSiteManifests, buildIngressRoute, siteLabels } from "@/addons/wordpress-manager/lib/manifest";
import { buildPluginSyncPlan, buildPluginSyncCommands, installPluginCommand, removePluginCommand, PLUGIN_CATALOG, AUTHENTIK_PLUGIN_SLUG } from "@/addons/wordpress-manager/lib/plugins";
import { redirectUri, buildOidcSettings, OIDC_SETTINGS_OPTION, optionUpdateFromStdinCommand } from "@/addons/wordpress-manager/lib/authentik";
import { shellQuote, isInstalledScript, coreInstallScript } from "@/addons/wordpress-manager/lib/core-install";
import type { OidcCredentials } from "@/lib/sso/types";
import { getScopedWordpressSites, wordpressScope, hasWordpressPermission } from "@/addons/wordpress-manager/lib/wordpress-rbac";
import { isK8sNotFound, k8sErrorStatus } from "@/addons/wordpress-manager/lib/k8s-errors";
import { AddonHttpError, SiteNotFoundError, ServiceUnavailableError } from "@/addons/wordpress-manager/lib/errors";
import { BUILT_IN_ROLES, resolveRoleDefinition, type RoleAssignment } from "@/lib/rbac";

describe("secrets", () => {
  test("generatePassword returns the requested length from the safe alphabet", () => {
    const pw = generatePassword(40);
    expect(pw).toHaveLength(40);
    expect(pw).toMatch(/^[A-Za-z0-9]+$/);
    expect(pw).not.toMatch(/[O0Il]/);
  });

  test("generatePassword is effectively unique across calls", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword(24)));
    expect(seen.size).toBe(200);
  });

  test("generateWpSalts produces all eight keys", () => {
    const salts = generateWpSalts();
    expect(Object.keys(salts).sort()).toEqual([
      "AUTH_KEY", "AUTH_SALT", "LOGGED_IN_KEY", "LOGGED_IN_SALT", "NONCE_KEY", "NONCE_SALT", "SECURE_AUTH_KEY", "SECURE_AUTH_SALT",
    ]);
  });

  test("generateSiteSecrets derives db identifiers and vault data maps cleanly", () => {
    const secrets = generateSiteSecrets("my-blog");
    expect(secrets.db.database).toBe("wp_my_blog");
    expect(secrets.db.user).toBe("wp_my_blog");
    const data = vaultData(secrets);
    expect(data.db.password).toBe(secrets.db.password);
    expect(data.wp.AUTH_KEY).toBe(secrets.wp.salts.AUTH_KEY);
    expect(data.wp.adminPassword).toBe(secrets.wp.adminPassword);
  });

  test("vaultPaths are deterministic and namespaced per site", () => {
    expect(vaultPaths("blog")).toEqual({
      db: "secret/wordpress/blog/db",
      wp: "secret/wordpress/blog/wp",
      authentik: "secret/wordpress/blog/authentik",
      config: "secret/wordpress/blog/config",
    });
  });
});

describe("naming", () => {
  test.each([
    ["blog", true],
    ["my-blog", true],
    ["a1", false],
    ["-blog", false],
    ["blog-", false],
    ["Blog", false],
    ["a".repeat(40), false],
  ])("isValidSiteName(%s) === %s", (name, expected) => {
    expect(isValidSiteName(name)).toBe(expected);
  });

  test("assertValidSiteName throws on invalid input", () => {
    expect(() => assertValidSiteName("Bad Name")).toThrow();
    expect(assertValidSiteName("good-name")).toBe("good-name");
  });

  test("resourceNames are stable and derived from the site", () => {
    const names = resourceNames("blog");
    expect(names.db).toBe("blog-db");
    expect(names.wpSecret).toBe("blog-wp");
    expect(names.dbPvc).toBe("blog-db-data");
  });

  test("buildHost composes subdomain, internal label and domain", () => {
    expect(buildHost({ name: "blog", domain: "example.com", internal: false })).toBe("blog.example.com");
    expect(buildHost({ name: "blog", domain: "example.com", internal: true })).toBe("blog.int.example.com");
    expect(buildHost({ name: "", domain: "example.com", internal: false })).toBe("example.com");
    expect(buildHost({ name: "", domain: "example.com", internal: true })).toBe("int.example.com");
  });

  test("deriveSiteId uses the subdomain, or slugifies the domain for a root site", () => {
    expect(deriveSiteId("blog", "example.com")).toBe("blog");
    expect(deriveSiteId("", "example.com")).toBe("example-com");
  });

  test("legacySiteHost falls back to BASE_DOMAIN for pre-domain-model sites", () => {
    expect(legacySiteHost("blog", "example.com")).toBe("blog.example.com");
  });
});

describe("config", () => {
  const ORIGINAL = process.env;
  afterEach(() => { process.env = ORIGINAL; });

  test("listDomains parses + dedups the env list; isAllowedDomain gates writes", () => {
    process.env = { ...ORIGINAL, WORDPRESS_DOMAINS: "a.com, b.com a.com" };
    expect(listDomains()).toEqual(["a.com", "b.com"]);
    expect(defaultDomain()).toBe("a.com");
    expect(isAllowedDomain("b.com")).toBe(true);
    expect(isAllowedDomain("evil.com")).toBe(false);
  });

  test("listDomains falls back to BASE_DOMAIN when no explicit list", () => {
    process.env = { ...ORIGINAL, WORDPRESS_DOMAINS: "", BASE_DOMAIN: "fallback.com" };
    expect(listDomains()).toEqual(["fallback.com"]);
  });
});

describe("manifest builders", () => {
  test("buildSiteManifests emits the full object set in dependency order", () => {
    const { objects, host } = buildSiteManifests("blog", { host: "blog.example.com" });
    const kinds = objects.map((o) => o.kind);
    expect(kinds).toEqual([
      "PersistentVolumeClaim", "NetworkPolicy", "Service", "Deployment",
      "PersistentVolumeClaim", "Service", "Deployment",
      "IngressRoute",
    ]);
    expect(host).toBe("blog.example.com");
  });

  test("every object carries the addon ownership labels", () => {
    const { objects } = buildSiteManifests("blog");
    for (const obj of objects) {
      expect(obj.metadata?.labels).toMatchObject(siteLabels("blog"));
    }
  });

  test("db and wp containers are hardened and run non-root", () => {
    const { db, wp } = buildSiteManifests("blog");
    const dbc = db.deployment.spec.template.spec.containers[0];
    const wpc = wp.deployment.spec.template.spec.containers[0];
    expect(dbc.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(dbc.securityContext.capabilities.drop).toContain("ALL");
    expect(wpc.securityContext.runAsNonRoot).toBe(true);
  });

  test("wordpress reads every credential from a secret reference, never inline", () => {
    const { wp } = buildSiteManifests("blog");
    const env = wp.deployment.spec.template.spec.containers[0].env as Array<{ name: string; value?: string; valueFrom?: unknown }>;
    const password = env.find((e) => e.name === "WORDPRESS_DB_PASSWORD");
    expect(password?.value).toBeUndefined();
    expect(password?.valueFrom).toBeDefined();
  });

  test("deployments carry the component label on their own metadata (so listSites can select them)", () => {
    const { db, wp } = buildSiteManifests("blog");
    expect(wp.deployment.metadata.labels["infraweaver.io/component"]).toBe("wordpress");
    expect(db.deployment.metadata.labels["infraweaver.io/component"]).toBe("db");
  });

  test("both containers declare resource requests and a memory limit", () => {
    const { db, wp } = buildSiteManifests("blog");
    for (const dep of [db.deployment, wp.deployment]) {
      const res = dep.spec.template.spec.containers[0].resources;
      expect(res.requests.memory).toBeTruthy();
      expect(res.requests.cpu).toBeTruthy();
      expect(res.limits.memory).toBeTruthy();
    }
  });

  test("an init container stages a checksum-verified wp-cli onto the wordpress PATH", () => {
    const { wp } = buildSiteManifests("blog");
    const spec = wp.deployment.spec.template.spec;
    const init = spec.initContainers?.find((c: { name: string }) => c.name === "wp-cli");
    expect(init).toBeDefined();
    // The install must verify the download against a checksum, never trust it blind.
    expect(init.command.join(" ")).toContain("sha256sum -c -");
    // wp-cli is shared via a volume that the wordpress container can read…
    const mount = spec.containers[0].volumeMounts.find((m: { name: string }) => m.name === "wp-cli");
    expect(mount).toMatchObject({ name: "wp-cli", readOnly: true });
    expect(spec.volumes.some((v: { name: string }) => v.name === "wp-cli")).toBe(true);
    // …and that dir is on PATH so `sh -c "wp …"` resolves it in-pod.
    const env = spec.containers[0].env as Array<{ name: string; value?: string }>;
    expect(env.find((e) => e.name === "PATH")?.value).toContain(mount.mountPath);
  });

  test("custom resource overrides are honoured", () => {
    const { wp } = buildSiteManifests("blog", { wpResources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { memory: "1Gi" } } });
    expect(wp.deployment.spec.template.spec.containers[0].resources.limits.memory).toBe("1Gi");
  });

  test("both containers declare a liveness probe in addition to readiness", () => {
    const { db, wp } = buildSiteManifests("blog");
    expect(db.deployment.spec.template.spec.containers[0].livenessProbe).toBeDefined();
    expect(wp.deployment.spec.template.spec.containers[0].livenessProbe).toBeDefined();
  });

  test("wordpress probes are TCP (an httpGet would follow SSO auto-login into a redirect loop)", () => {
    const wpc = buildSiteManifests("blog").wp.deployment.spec.template.spec.containers[0];
    expect(wpc.readinessProbe.tcpSocket).toEqual({ port: 80 });
    expect(wpc.livenessProbe.tcpSocket).toEqual({ port: 80 });
    expect(wpc.readinessProbe.httpGet).toBeUndefined();
    expect(wpc.livenessProbe.httpGet).toBeUndefined();
  });

  test("the db readiness/liveness probe never puts the root password on the command line", () => {
    const { db } = buildSiteManifests("blog");
    const probe = db.deployment.spec.template.spec.containers[0].readinessProbe.exec.command.join(" ");
    expect(probe).toContain("MYSQL_PWD=");
    expect(probe).not.toMatch(/-p\$?MARIADB_ROOT_PASSWORD/);
  });

  test("the wordpress service selects wordpress pods even for a site named like '-db'", () => {
    const { wp, db } = buildSiteManifests("my-db");
    expect(wp.service.spec.selector["infraweaver.io/component"]).toBe("wordpress");
    expect(db.service.spec.selector["infraweaver.io/component"]).toBe("db");
  });

  test("a NetworkPolicy isolates the db to only the site's wordpress pods", () => {
    const { objects } = buildSiteManifests("blog");
    const netpol = objects.find((o) => o.kind === "NetworkPolicy") as {
      spec: { podSelector: { matchLabels: Record<string, string> } };
    } | undefined;
    expect(netpol).toBeDefined();
    expect(netpol.spec.podSelector.matchLabels["infraweaver.io/component"]).toBe("db");
    expect(netpol.spec.ingress[0].from[0].podSelector.matchLabels["infraweaver.io/component"]).toBe("wordpress");
    expect(netpol.spec.ingress[0].ports[0].port).toBe(3306);
  });

  test("ingressRoute auth modes: none is public, full gates everything, admin gates only sensitive paths", () => {
    const allMw = (r: ReturnType<typeof buildIngressRoute>) => r.spec.routes.flatMap((rt) => rt.middlewares.map((m) => m.name));

    const none = buildIngressRoute("blog", { host: "blog.example.com", authMode: "none" });
    expect(allMw(none)).not.toContain("forward-auth");
    expect(none.spec.routes).toHaveLength(1);
    expect(none.spec.routes[0].match).toBe("Host(`blog.example.com`)");

    const full = buildIngressRoute("blog", { host: "blog.example.com", authMode: "full" });
    // The gated catch-all plus the unguarded outpost-callback route.
    expect(full.spec.routes).toHaveLength(2);
    expect(allMw(full)).toContain("forward-auth");

    const admin = buildIngressRoute("blog", { host: "blog.example.com", authMode: "admin" });
    expect(admin.spec.routes.length).toBeGreaterThanOrEqual(4);
    const gated = admin.spec.routes.find((rt) => rt.match.includes("/wp-admin") && !rt.match.includes("admin-ajax"));
    expect(gated?.middlewares.map((m) => m.name)).toContain("forward-auth");
    const blocked = admin.spec.routes.find((rt) => rt.match.includes("xmlrpc"));
    expect(blocked?.middlewares.map((m) => m.name)).toContain("wordpress-deny");
    const ajax = admin.spec.routes.find((rt) => rt.match.includes("admin-ajax"));
    expect(ajax?.middlewares.map((m) => m.name)).not.toContain("forward-auth");
  });

  test("gated modes route /outpost.goauthentik.io/ to the Authentik outpost, unguarded; none does not", () => {
    for (const authMode of ["admin", "full"] as const) {
      const r = buildIngressRoute("blog", { host: "blog.example.com", authMode });
      const outpost = r.spec.routes.find((rt) => rt.match.includes("/outpost.goauthentik.io/"));
      expect(outpost).toBeDefined();
      // Must NOT carry forward-auth (the outpost serves these paths; gating would loop).
      expect(outpost?.middlewares.map((m) => m.name)).not.toContain("forward-auth");
      // Routes to the Authentik service, not WordPress, cross-namespace.
      expect(outpost?.services[0].name).toBe("authentik-server");
      expect(outpost?.services[0].namespace).toBe("authentik");
      // Highest priority so it wins over the catch-all / gated rules.
      expect(outpost?.priority).toBe(200);
    }
    const none = buildIngressRoute("blog", { host: "blog.example.com", authMode: "none" });
    expect(none.spec.routes.some((rt) => rt.match.includes("/outpost.goauthentik.io/"))).toBe(false);
  });

  test("WordPress container trusts X-Forwarded-Proto so it serves https URLs", () => {
    const { wp } = buildSiteManifests("blog", { host: "blog.example.com" });
    const env = wp.deployment.spec.template.spec.containers[0].env as { name: string; value?: string }[];
    const extra = env.find((e) => e.name === "WORDPRESS_CONFIG_EXTRA");
    expect(extra?.value).toContain("HTTP_X_FORWARDED_PROTO");
    expect(extra?.value).toContain("$_SERVER['HTTPS'] = 'on'");
  });

  test("admin mode emits the deny Middleware object; none/full do not", () => {
    const adminKinds = buildSiteManifests("blog", { host: "blog.example.com", authMode: "admin" }).objects.map((o) => o.kind);
    expect(adminKinds).toContain("Middleware");
    const noneKinds = buildSiteManifests("blog", { host: "blog.example.com", authMode: "none" }).objects.map((o) => o.kind);
    expect(noneKinds).not.toContain("Middleware");
  });
});

describe("plugin manager", () => {
  test("sync plan installs missing, removes deselected catalog plugins, keeps the rest", () => {
    const plan = buildPluginSyncPlan(["wordfence", "wordpress-seo"], ["wordfence", "wp-super-cache"]);
    expect(plan.toInstall).toEqual(["wordpress-seo"]);
    expect(plan.toRemove).toEqual(["wp-super-cache"]);
    expect(plan.unchanged).toEqual(["wordfence"]);
  });

  test("sync plan never removes non-catalog (manually installed) plugins", () => {
    const plan = buildPluginSyncPlan([], ["some-manual-plugin"]);
    expect(plan.toRemove).toEqual([]);
  });

  test("commands are built in install-then-remove order", () => {
    const cmds = buildPluginSyncCommands({ toInstall: ["wordfence"], toRemove: ["wp-super-cache"], unchanged: [] });
    expect(cmds[0]).toBe(installPluginCommand("wordfence"));
    expect(cmds[1]).toBe(removePluginCommand("wp-super-cache"));
  });

  test("unsafe plugin slugs are rejected (no shell injection)", () => {
    expect(() => installPluginCommand("wordfence; rm -rf /")).toThrow();
  });

  test("catalog contains the Authentik SSO plugin flagged for the SSO flow", () => {
    const sso = PLUGIN_CATALOG.find((p) => p.slug === AUTHENTIK_PLUGIN_SLUG);
    expect(sso?.sso).toBe(true);
  });
});

describe("core install", () => {
  test("is-installed probe never fails the exec — it reports state on stdout", () => {
    const script = isInstalledScript("https://blog.example.com");
    expect(script).toContain("core is-installed");
    expect(script).toContain("echo INSTALLED");
    expect(script).toContain("echo MISSING");
  });

  test("the admin password is read from stdin, never placed on the command line", () => {
    const script = coreInstallScript({
      url: "https://blog.example.com",
      title: "blog",
      adminUser: "admin",
      adminEmail: "admin@example.com",
    });
    // Tolerate a newline-less secret on stdin without aborting under `set -e`.
    expect(script).toContain("read -r WP_ADMIN_PW || true");
    expect(script).toContain('--admin_password="$WP_ADMIN_PW"');
    // The literal password must never be interpolated into the script text.
    expect(script).toContain("core install");
    expect(script).toContain("--skip-email");
  });

  test("shellQuote neutralises embedded single quotes (no script injection)", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    // A title carrying shell metacharacters is wrapped as one quoted literal, so the
    // metacharacters are inert: the value appears only inside the quoted token.
    const title = "x'; rm -rf /";
    const script = coreInstallScript({ url: "u", title, adminUser: "admin", adminEmail: "e" });
    expect(script).toContain(`--title=${shellQuote(title)}`);
    expect(shellQuote(title)).toBe(`'x'\\''; rm -rf /'`);
  });
});

describe("authentik SSO (WordPress plugin glue)", () => {
  const creds: OidcCredentials = {
    issuer: "https://auth.example.com/application/o/wordpress-blog/",
    clientId: "wordpress-blog",
    clientSecret: "super-secret-value",
    authorizeUrl: "https://auth.example.com/application/o/authorize/",
    tokenUrl: "https://auth.example.com/application/o/token/",
    userinfoUrl: "https://auth.example.com/application/o/userinfo/",
    endSessionUrl: "https://auth.example.com/application/o/wordpress-blog/end-session/",
  };

  test("redirectUri targets the WordPress OIDC callback", () => {
    expect(redirectUri("blog.example.com")).toContain("https://blog.example.com/wp-admin/admin-ajax.php");
  });

  test("buildOidcSettings maps the Authentik endpoints straight into the plugin options", () => {
    const settings = buildOidcSettings(creds);
    expect(settings.login_type).toBe("auto");
    expect(settings.client_id).toBe("wordpress-blog");
    expect(settings.endpoint_login).toBe(creds.authorizeUrl);
    expect(settings.endpoint_token).toBe(creds.tokenUrl);
    expect(settings.endpoint_userinfo).toBe(creds.userinfoUrl);
    expect(settings.endpoint_end_session).toBe(creds.endSessionUrl);
  });

  test("the client secret lives only in the stdin payload, never on the wp-cli command line", () => {
    const command = optionUpdateFromStdinCommand(OIDC_SETTINGS_OPTION);
    const settings = buildOidcSettings(creds);
    expect(command).not.toContain("super-secret-value");
    expect(command).toContain("openid_connect_generic_settings");
    // The value arg is OMITTED so wp-cli reads it from STDIN; an explicit `-` is
    // parsed as a literal value by wp-cli 2.x and must NOT be present.
    expect(command.trim().endsWith("--format=json")).toBe(true);
    expect(command).not.toContain("- --format=json");
    expect(settings.client_secret).toBe("super-secret-value");
  });
});

describe("k8s error helpers", () => {
  test.each([
    [{ code: 404 }, true],
    [{ statusCode: 404 }, true],
    [{ body: { code: 404 } }, true],
    [{ code: 403 }, false],
    [{ statusCode: 409 }, false],
    ["a plain string error", false],
    [null, false],
  ])("isK8sNotFound(%p) === %p", (err, expected) => {
    expect(isK8sNotFound(err)).toBe(expected);
  });

  test("k8sErrorStatus extracts the first available numeric status", () => {
    expect(k8sErrorStatus({ code: 500 })).toBe(500);
    expect(k8sErrorStatus({ body: { code: 422 } })).toBe(422);
    expect(k8sErrorStatus({})).toBeNull();
  });
});

describe("typed domain errors", () => {
  test("SiteNotFoundError is a 404 AddonHttpError with a safe message", () => {
    const err = new SiteNotFoundError("blog");
    expect(err).toBeInstanceOf(AddonHttpError);
    expect(err.status).toBe(404);
    expect(err.message).toContain("blog");
  });

  test("ServiceUnavailableError is a retryable 503", () => {
    const err = new ServiceUnavailableError("pod not ready");
    expect(err).toBeInstanceOf(AddonHttpError);
    expect(err.status).toBe(503);
  });
});

describe("rbac scoping", () => {
  test("wordpressScope formats a per-site scope", () => {
    expect(wordpressScope("blog")).toBe("/wordpress/sites/blog");
  });

  test("getScopedWordpressSites extracts only wordpress site scopes", () => {
    const sites = getScopedWordpressSites([
      { scope: "/wordpress/sites/blog", role: "x", permissions: [] },
      { scope: "/wordpress/sites/shop", role: "y", permissions: [] },
      { scope: "/game-hub/servers/mc", role: "z", permissions: [] },
      { scope: "/", role: "w", permissions: [] },
    ] as never);
    expect(sites.sort()).toEqual(["blog", "shop"]);
  });

  test("getScopedWordpressSites ignores expired grants", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const sites = getScopedWordpressSites([
      { scope: "/wordpress/sites/blog", role: "x", permissions: [], expiresAt: past },
      { scope: "/wordpress/sites/shop", role: "y", permissions: [], expiresAt: future },
      { scope: "/wordpress/sites/news", role: "z", permissions: [] },
    ] as never);
    expect(sites.sort()).toEqual(["news", "shop"]);
  });

  test("wordpress permissions are first-class: built-in roles resolve and carry them", () => {
    // Regression guard for the dead-code bug: previously no role could grant
    // wordpress:* because resolveRoleDefinition only knows built-in roles and none
    // carried these permissions, so only "*" (admin) ever passed.
    expect(resolveRoleDefinition("wordpress-admin")).not.toBeNull();
    expect(BUILT_IN_ROLES["wordpress-admin"].permissions).toContain("wordpress:admin");
    expect(BUILT_IN_ROLES["wordpress-editor"].permissions).toEqual(["wordpress:read", "wordpress:write"]);
    expect(BUILT_IN_ROLES["wordpress-viewer"].permissions).toEqual(["wordpress:read"]);
  });

  test("a per-site wordpress-admin grant authorizes that site but not another", () => {
    const assignments: RoleAssignment[] = [{
      id: "a1", roleId: "wordpress-admin", scope: "/wordpress/sites/blog",
      principalType: "user", principalId: "alice", grantedBy: "owner", grantedAt: new Date().toISOString(),
    }];
    // Non-admin groups, so the only path to true is the scoped grant resolving.
    expect(hasWordpressPermission([], "alice", assignments, "wordpress:admin", "blog")).toBe(true);
    expect(hasWordpressPermission([], "alice", assignments, "wordpress:admin", "shop")).toBe(false);
    // A different user with the same assignment list must not inherit alice's grant.
    expect(hasWordpressPermission([], "mallory", assignments, "wordpress:read", "blog")).toBe(false);
  });

  test("an expired per-site grant no longer authorizes", () => {
    const assignments: RoleAssignment[] = [{
      id: "a2", roleId: "wordpress-admin", scope: "/wordpress/sites/blog",
      principalType: "user", principalId: "alice", grantedBy: "owner",
      grantedAt: new Date(Date.now() - 172_800_000).toISOString(),
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    }];
    expect(hasWordpressPermission([], "alice", assignments, "wordpress:read", "blog")).toBe(false);
  });

  test("platform admin group passes for any site without an explicit grant", () => {
    expect(hasWordpressPermission(["platform-admins"], "root", [], "wordpress:admin", "anything")).toBe(true);
  });
});
