import {
  buildWpUserSyncPlan,
  createWpUserCommand,
  listWpUsersCommand,
  parseWpUserList,
  updateWpUserCommand,
  type ExistingWpUser,
} from "@/addons/wordpress-manager/lib/wp-users";
import type { DesiredWordpressUser } from "@/addons/wordpress-manager/lib/access-policy";

const remon: DesiredWordpressUser = { username: "remon", email: "remon@example.com", role: "administrator" };

describe("wp-cli user commands", () => {
  test("create command carries login, email, role, and a pod-generated password", () => {
    const cmd = createWpUserCommand(remon);
    expect(cmd).toContain("wp --allow-root user create remon remon@example.com");
    expect(cmd).toContain("--role=administrator");
    expect(cmd).toContain("/dev/urandom");
  });

  test("update command converges role and email without notification emails", () => {
    const cmd = updateWpUserCommand({ ...remon, role: "editor" });
    expect(cmd).toContain("user update remon");
    expect(cmd).toContain("--role=editor");
    expect(cmd).toContain("--skip-email");
  });

  test("refuses shell-unsafe logins and emails outright", () => {
    expect(() => createWpUserCommand({ ...remon, username: "a; rm -rf /" })).toThrow(/unsafe/);
    expect(() => createWpUserCommand({ ...remon, email: "x@y.dev\"; id" })).toThrow(/unsafe/);
    expect(() => updateWpUserCommand({ ...remon, username: "$(whoami)" })).toThrow(/unsafe/);
  });
});

describe("parseWpUserList", () => {
  test("parses the JSON table and skips nameless entries", () => {
    const stdout = 'Warning: something\n[{"user_login":"admin","roles":"administrator"},{"user_login":"","roles":"x"}]';
    expect(parseWpUserList(stdout)).toEqual([{ login: "admin", roles: "administrator" }]);
  });

  test("maps unparseable output to an empty list", () => {
    expect(parseWpUserList("Error: not installed")).toEqual([]);
    expect(parseWpUserList("[not-json")).toEqual([]);
  });
});

describe("buildWpUserSyncPlan", () => {
  const existing: ExistingWpUser[] = [
    { login: "admin", roles: "administrator" },
    { login: "remon", roles: "subscriber" },
  ];

  test("creates missing users, updates wrong roles, leaves matches alone", () => {
    const desired: DesiredWordpressUser[] = [
      remon, // exists as subscriber → update to administrator
      { username: "carol", email: "c@x.dev", role: "editor" }, // missing → create
    ];

    const plan = buildWpUserSyncPlan(desired, existing, "admin");

    expect(plan.actions).toEqual([
      { username: "remon", role: "administrator", action: "updated" },
      { username: "carol", role: "editor", action: "created" },
    ]);
    expect(plan.commands).toHaveLength(2);
    expect(plan.commands[0]).toContain("user update remon");
    expect(plan.commands[1]).toContain("user create carol");
  });

  test("reports an in-sync user as unchanged with no command", () => {
    const plan = buildWpUserSyncPlan(
      [{ username: "remon", email: "remon@example.com", role: "subscriber" }],
      existing,
      "admin",
    );

    expect(plan.commands).toEqual([]);
    expect(plan.actions).toEqual([{ username: "remon", role: "subscriber", action: "unchanged" }]);
  });

  test("never touches the protected install admin account", () => {
    const plan = buildWpUserSyncPlan(
      [{ username: "admin", email: "a@x.dev", role: "subscriber" }],
      existing,
      "admin",
    );

    expect(plan.commands).toEqual([]);
    expect(plan.actions).toEqual([]);
  });

  test("matches existing logins case-insensitively", () => {
    const plan = buildWpUserSyncPlan(
      [{ username: "Remon", email: "remon@example.com", role: "subscriber" }],
      existing,
      "admin",
    );

    expect(plan.commands).toEqual([]);
    expect(plan.actions).toEqual([{ username: "Remon", role: "subscriber", action: "unchanged" }]);
  });

  test("wp-cli list command is the machine-readable form", () => {
    expect(listWpUsersCommand()).toBe("wp --allow-root user list --fields=user_login,roles --format=json");
  });
});
