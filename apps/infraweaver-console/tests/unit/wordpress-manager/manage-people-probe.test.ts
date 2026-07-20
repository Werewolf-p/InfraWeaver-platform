/** @jest-environment node */
// Users (People) probe parsing: id/login/email/role/last-login for the action UI,
// EXACT per-role counts + total independent of the bounded row list, and the row
// bound that keeps a Users snapshot under the per-panel ConfigMap cap.
import { parsePeople, USER_LIST_LIMIT } from "@/addons/wordpress-manager/lib/manage/probes/people";

function usersJson(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => ({
    ID: i + 1,
    user_login: `u${i + 1}`,
    display_name: `User ${i + 1}`,
    user_email: `u${i + 1}@example.com`,
    roles: "subscriber",
    user_registered: "2026-01-01 00:00:00",
  }));
  return JSON.stringify(rows);
}

describe("parsePeople", () => {
  test("maps id/login/email/roles/registered and defaults last-login to null", () => {
    const data = parsePeople({
      users: JSON.stringify([
        { ID: 1, user_login: "admin", display_name: "Admin", user_email: "a@x.io", roles: "administrator", user_registered: "2026-01-01 00:00:00" },
      ]),
      counts: "ROLE_administrator=1\nROLE_editor=0\nROLE_author=0\nROLE_contributor=0\nROLE_subscriber=0",
      total: "1",
    });
    expect(data.users[0]).toEqual({
      id: 1,
      login: "admin",
      displayName: "Admin",
      email: "a@x.io",
      roles: ["administrator"],
      registered: "2026-01-01 00:00:00",
      lastLogin: null,
    });
  });

  test("role counts are exact (from the count batch), sorted desc, zero-roles dropped", () => {
    const data = parsePeople({
      users: usersJson(3),
      counts: "ROLE_administrator=2\nROLE_editor=5\nROLE_author=0\nROLE_contributor=0\nROLE_subscriber=9",
      total: "16",
    });
    expect(data.roleCounts).toEqual([
      { role: "subscriber", count: 9 },
      { role: "editor", count: 5 },
      { role: "administrator", count: 2 },
    ]);
    expect(data.total).toBe(16);
  });

  test("bounds the row list to USER_LIST_LIMIT while reporting the exact total", () => {
    const data = parsePeople({
      users: usersJson(250),
      counts: "ROLE_subscriber=250",
      total: "250",
    });
    expect(data.users).toHaveLength(USER_LIST_LIMIT);
    expect(data.limit).toBe(USER_LIST_LIMIT);
    expect(data.total).toBe(250);
  });
});
