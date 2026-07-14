/**
 * @jest-environment node
 *
 * Pins the roster-drift detection contract shared by the scheduled CronJob
 * endpoint (`GET /api/security/roster-drift`) and the `sec-roster-drift` runtime
 * self-test. Drives the pure classifier + the injectable `detectRosterDrift` with
 * stub deps — no live Authentik, no real users.yaml — so the flag rules cannot
 * regress silently in either caller.
 */

jest.mock("server-only", () => ({}), { virtual: true });

// The module's default deps import these; stub so importing never reaches a real
// Authentik or the git-backed users.yaml. Every test injects its own deps.
jest.mock("@/lib/authentik", () => ({ authentikFetch: jest.fn() }));
jest.mock("@/lib/users-config", () => ({ loadUsersConfig: jest.fn() }));

import {
  classifyDirectory,
  detectRosterDrift,
  type AuthentikDirectoryUser,
  type RosterKeys,
} from "@/lib/security/roster-drift";

const roster = (usernames: string[], emails: string[] = []): RosterKeys => ({
  usernames: new Set(usernames.map((u) => u.toLowerCase())),
  emails: new Set(emails.map((e) => e.toLowerCase())),
});

const user = (u: Partial<AuthentikDirectoryUser> & { username: string }): AuthentikDirectoryUser => ({
  pk: u.pk ?? 1,
  is_active: true,
  ...u,
});

describe("classifyDirectory — flag rules", () => {
  test("active account absent from roster is flagged unmanaged", () => {
    const report = classifyDirectory([user({ username: "ghost", email: "ghost@x.io" })], roster(["remon"]));
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({ username: "ghost", reasons: ["unmanaged"], privileged: false });
    expect(report.alert).toBe(false);
    expect(report.scanned).toBe(1);
  });

  test("ak-outpost-* service account is excluded, never flagged", () => {
    const report = classifyDirectory(
      [user({ username: "ak-outpost-ldap-abc123" }), user({ username: "ak-outpost-proxy" })],
      roster([]),
    );
    expect(report.drift).toHaveLength(0);
    expect(report.excluded).toBe(2);
    expect(report.scanned).toBe(0);
  });

  test("disabled (is_active:false) account absent from roster is NOT flagged", () => {
    const report = classifyDirectory([user({ username: "oldstaff", is_active: false })], roster([]));
    expect(report.drift).toHaveLength(0);
    expect(report.scanned).toBe(0);
  });

  test("e2e-* / test-* / *-test names are flagged suspicious even when in roster", () => {
    const names = ["e2e-phoenix", "test-alice", "smoke-test"];
    const report = classifyDirectory(
      names.map((username) => user({ username, email: `${username}@x.io` })),
      // All three present in the roster — still flagged on the name rule alone.
      roster(names, names.map((n) => `${n}@x.io`)),
    );
    expect(report.drift.map((d) => d.username).sort()).toEqual(["e2e-phoenix", "smoke-test", "test-alice"]);
    for (const entry of report.drift) expect(entry.reasons).toEqual(["suspicious-name"]);
  });

  test("username drift resolved by roster email is NOT flagged", () => {
    // Authentik username drifted from the roster key, but the email still matches.
    const report = classifyDirectory(
      [user({ username: "koen-renamed", email: "koenluppers@gmail.com" })],
      roster(["koen"], ["koenluppers@gmail.com"]),
    );
    expect(report.drift).toHaveLength(0);
  });

  test("managed non-privileged account produces no drift", () => {
    const report = classifyDirectory(
      [user({ username: "koen", email: "koenluppers@gmail.com", groups_obj: [{ name: "platform-users" }] })],
      roster(["koen"], ["koenluppers@gmail.com"]),
    );
    expect(report.drift).toHaveLength(0);
    expect(report.alert).toBe(false);
  });
});

describe("classifyDirectory — privilege escalation", () => {
  test("unmanaged is_superuser account raises the alert", () => {
    const report = classifyDirectory([user({ username: "akadmin", is_superuser: true })], roster([]));
    expect(report.alert).toBe(true);
    expect(report.privilegedUnmanaged).toHaveLength(1);
    expect(report.privilegedUnmanaged[0].privilegedVia).toBe("is_superuser");
  });

  test("unmanaged member of a privileged group raises the alert", () => {
    const report = classifyDirectory(
      [user({ username: "rogueadmin", groups_obj: [{ name: "platform-admins" }] })],
      roster([]),
    );
    expect(report.alert).toBe(true);
    expect(report.privilegedUnmanaged[0].privilegedVia).toBe("group:platform-admins");
  });

  test("privileged-group match is case-insensitive (authentik Admins)", () => {
    const report = classifyDirectory(
      [user({ username: "rogue", groups_obj: [{ name: "authentik Admins" }] })],
      roster([]),
    );
    expect(report.alert).toBe(true);
  });

  test("group carrying is_superuser flag counts as privileged", () => {
    const report = classifyDirectory(
      [user({ username: "rogue", groups_obj: [{ name: "custom-admins", is_superuser: true }] })],
      roster([]),
    );
    expect(report.alert).toBe(true);
    expect(report.privilegedUnmanaged[0].privilegedVia).toBe("group:custom-admins (superuser)");
  });

  test("suspicious-named privileged account escalates (name rule + privilege)", () => {
    const report = classifyDirectory(
      [user({ username: "e2e-root", is_superuser: true })],
      // In the roster, so not 'unmanaged' — but the test name + superuser still alerts.
      roster(["e2e-root"]),
    );
    expect(report.alert).toBe(true);
    expect(report.privilegedUnmanaged[0].reasons).toEqual(["suspicious-name"]);
  });
});

describe("detectRosterDrift — dependency wiring", () => {
  test("classifies the directory returned by the injected deps", async () => {
    const listDirectoryUsers = jest.fn(async () => [
      user({ username: "ghost", email: "ghost@x.io" }),
      user({ username: "ak-outpost-ldap" }),
    ]);
    const loadRoster = jest.fn(async () => roster(["remon"]));

    const report = await detectRosterDrift({ listDirectoryUsers, loadRoster });

    expect(listDirectoryUsers).toHaveBeenCalledTimes(1);
    expect(loadRoster).toHaveBeenCalledTimes(1);
    expect(report.drift.map((d) => d.username)).toEqual(["ghost"]);
    expect(report.excluded).toBe(1);
  });
});
