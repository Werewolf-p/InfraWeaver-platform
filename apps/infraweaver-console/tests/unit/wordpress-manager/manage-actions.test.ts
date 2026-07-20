/** @jest-environment node */
// Manage write-action registry: the PURE half — the wp-cli command mapping, the
// shell-safety of secrets (passwords/values ride STDIN, never argv), the option
// allow-list, and the last-admin guardrail predicate. The exec/provision I/O layer
// is mocked so importing actions.ts never touches a cluster.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/addons/wordpress-manager/lib/provision", () => ({
  siteExists: jest.fn(),
  syncSiteWpUsers: jest.fn(),
  setMaintenanceMode: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/k8s-exec", () => ({ execInWpPod: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/overview", () => ({ requireRunningWpPod: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/snapshot-cache", () => ({ invalidateManageCache: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-commands", () => ({ CONNECTOR_PLUGIN_SLUG: "infraweaver-connector" }));
jest.mock("@/lib/mailer", () => ({ sendWpPasswordResetEmail: jest.fn(), isMailerConfigured: jest.fn(() => true) }));

import {
  commandFor,
  actionPermission,
  parseResetTarget,
  isLastAdmin,
  parseAdministratorIds,
  manageActionSchema,
  WP_OPTION_ALLOWLIST,
  type ManageAction,
} from "@/addons/wordpress-manager/lib/manage/actions";

const parse = (input: unknown): ManageAction => manageActionSchema.parse(input);

describe("commandFor mappings", () => {
  test("plugin/theme lifecycle", () => {
    expect(commandFor(parse({ type: "update-plugin", slug: "akismet" }))?.command).toBe("wp --allow-root plugin update akismet");
    expect(commandFor(parse({ type: "delete-plugin", slug: "hello" }))?.command).toBe("wp --allow-root plugin delete hello");
    expect(commandFor(parse({ type: "activate-theme", slug: "twentytwentyfour" }))?.command).toBe("wp --allow-root theme activate twentytwentyfour");
    expect(commandFor(parse({ type: "delete-theme", slug: "twentytwentyone" }))?.command).toBe("wp --allow-root theme delete twentytwentyone");
  });

  test("content ops: trash keeps to trash, delete forces, untrash restores to draft", () => {
    expect(commandFor(parse({ type: "trash-post", postId: 5 }))?.command).toBe("wp --allow-root --skip-plugins --skip-themes post delete 5");
    expect(commandFor(parse({ type: "delete-post", postId: 5 }))?.command).toBe("wp --allow-root --skip-plugins --skip-themes post delete 5 --force");
    expect(commandFor(parse({ type: "untrash-post", postId: 5 }))?.command).toBe("wp --allow-root --skip-plugins --skip-themes post update 5 --post_status=draft");
  });

  test("moderate-comments: by id vs the whole pending queue", () => {
    expect(commandFor(parse({ type: "moderate-comments", action: "approve", scope: "id", commentId: 9 }))?.command).toBe(
      "wp --allow-root --skip-plugins --skip-themes comment approve 9",
    );
    const all = commandFor(parse({ type: "moderate-comments", action: "spam", scope: "all" }))?.command ?? "";
    expect(all).toContain("comment list --status=hold --field=ID --format=ids");
    expect(all).toContain("comment spam");
    // scope=id without a commentId is rejected at build time.
    expect(() => commandFor(parse({ type: "moderate-comments", action: "trash", scope: "id" }))).toThrow();
  });

  test("delete-user honours reassignment (WP-core parity) and always confirms", () => {
    expect(commandFor(parse({ type: "delete-user", userId: 3 }))?.command).toBe("wp --allow-root --skip-plugins --skip-themes user delete 3 --yes");
    expect(commandFor(parse({ type: "delete-user", userId: 3, reassignTo: 1 }))?.command).toBe(
      "wp --allow-root --skip-plugins --skip-themes user delete 3 --reassign=1 --yes",
    );
  });

  test("passwords ride STDIN and never appear on the command line", () => {
    const secret = "S3cr3t;rm -rf /$(whoami)";
    const built = commandFor(parse({ type: "set-user-password", userId: 4, password: secret }));
    expect(built?.stdin).toBe(secret);
    expect(built?.command).toContain("read -r WP_PASS");
    expect(built?.command).not.toContain(secret);
  });

  test("add-user: STDIN password when given, generated in-pod when omitted", () => {
    const withPw = commandFor(parse({ type: "add-user", login: "jane", email: "jane@example.com", role: "editor", password: "longenough1" }));
    expect(withPw?.stdin).toBe("longenough1");
    expect(withPw?.command).toContain(`user create jane jane@example.com --role=editor`);
    const noPw = commandFor(parse({ type: "add-user", login: "jane", email: "jane@example.com", role: "author" }));
    expect(noPw?.stdin).toBeUndefined();
    expect(noPw?.command).toContain("head -c 32 /dev/urandom");
  });

  test("update-site-option: value rides STDIN; admin_email is shape-checked", () => {
    const built = commandFor(parse({ type: "update-site-option", key: "blogname", value: 'My "Cool" Site & Co' }));
    expect(built?.stdin).toBe('My "Cool" Site & Co');
    expect(built?.command).toContain("option update blogname");
    expect(built?.command).not.toContain("Cool");
    // A bogus admin_email is refused before any command is built.
    expect(() => commandFor(parse({ type: "update-site-option", key: "admin_email", value: "not-an-email" }))).toThrow();
    expect(commandFor(parse({ type: "update-site-option", key: "admin_email", value: "root@example.com" }))?.stdin).toBe("root@example.com");
  });

  test("specially-routed actions return null (handled via provision, not raw exec)", () => {
    expect(commandFor(parse({ type: "sync-users" }))).toBeNull();
    expect(commandFor(parse({ type: "set-maintenance-mode", enabled: true }))).toBeNull();
  });
});

describe("option-key allow-list", () => {
  test("only the allow-listed keys parse", () => {
    for (const key of WP_OPTION_ALLOWLIST) {
      expect(manageActionSchema.safeParse({ type: "update-site-option", key, value: "x" }).success).toBe(true);
    }
    for (const bad of ["siteurl", "home", "template", "active_plugins", "users_can_register"]) {
      expect(manageActionSchema.safeParse({ type: "update-site-option", key: bad, value: "x" }).success).toBe(false);
    }
  });
});

describe("role allow-list", () => {
  test("assignable roles parse; anything else is refused", () => {
    for (const role of ["administrator", "editor", "author", "contributor", "subscriber"]) {
      expect(manageActionSchema.safeParse({ type: "update-user-role", userId: 1, role }).success).toBe(true);
    }
    expect(manageActionSchema.safeParse({ type: "update-user-role", userId: 1, role: "superadmin" }).success).toBe(false);
  });
});

describe("last-admin guardrail predicate", () => {
  test("isLastAdmin true only when the user is the sole administrator", () => {
    expect(isLastAdmin([1], 1)).toBe(true);
    expect(isLastAdmin([1, 2], 1)).toBe(false);
    expect(isLastAdmin([2], 1)).toBe(false);
    expect(isLastAdmin([], 1)).toBe(false);
  });

  test("parseAdministratorIds handles scalar arrays, object rows and garbage", () => {
    expect(parseAdministratorIds("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseAdministratorIds('[{"ID":"7"},{"ID":8}]')).toEqual([7, 8]);
    expect(parseAdministratorIds("Success: nothing")).toEqual([]);
  });
});

describe("actionPermission", () => {
  test("destructive/identity actions require admin, operational ones only write", () => {
    expect(actionPermission(parse({ type: "delete-user", userId: 2 }))).toBe("wordpress:admin");
    expect(actionPermission(parse({ type: "delete-plugin", slug: "x" }))).toBe("wordpress:admin");
    expect(actionPermission(parse({ type: "update-site-option", key: "blogname", value: "x" }))).toBe("wordpress:admin");
    expect(actionPermission(parse({ type: "trash-post", postId: 1 }))).toBe("wordpress:write");
    expect(actionPermission(parse({ type: "set-maintenance-mode", enabled: false }))).toBe("wordpress:write");
    expect(actionPermission(parse({ type: "flush-cache" }))).toBe("wordpress:write");
  });
});

describe("parseResetTarget — in-pod reset-link eval output", () => {
  test("parses a well-formed JSON blob", () => {
    const stdout = JSON.stringify({
      email: " user@example.com ",
      name: "Jane Doe",
      reset_url: "https://hi2.rlservers.com/wp-login.php?action=rp&key=abc&login=jane",
      site_name: "Hi2 Blog",
      site_url: "https://hi2.rlservers.com/",
    });
    expect(parseResetTarget(stdout)).toEqual({
      email: "user@example.com",
      name: "Jane Doe",
      resetUrl: "https://hi2.rlservers.com/wp-login.php?action=rp&key=abc&login=jane",
      siteName: "Hi2 Blog",
      siteUrl: "https://hi2.rlservers.com/",
    });
  });

  test("returns null on empty, malformed, or reset-url-less output", () => {
    expect(parseResetTarget("")).toBeNull();
    expect(parseResetTarget("   ")).toBeNull();
    expect(parseResetTarget("not json")).toBeNull();
    expect(parseResetTarget(JSON.stringify({ email: "a@b.c" }))).toBeNull(); // no reset_url
    expect(parseResetTarget(JSON.stringify({ reset_url: "" }))).toBeNull();
  });

  test("coerces missing/typed fields to safe defaults but keeps the reset url", () => {
    const t = parseResetTarget(JSON.stringify({ reset_url: "https://x/rp", email: 123, name: null }));
    expect(t).not.toBeNull();
    expect(t?.email).toBe("");
    expect(t?.name).toBe("");
    expect(t?.resetUrl).toBe("https://x/rp");
  });
});
