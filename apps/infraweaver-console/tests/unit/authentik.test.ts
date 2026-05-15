import { isValidAuthentikIdentifier, mapAuthentikSessions } from "@/lib/authentik";

describe("authentik session mapping", () => {
  it("keeps only safe session fields", () => {
    const sessions = mapAuthentikSessions([
      {
        identifier: "session-1",
        created: "2026-05-01T00:00:00Z",
        expires: "2026-05-02T00:00:00Z",
        description: "Desktop browser",
        secret: "should-not-leak",
      },
      {
        identifier: "../../bad",
        created: "2026-05-01T00:00:00Z",
      },
    ]);

    expect(sessions).toEqual([
      {
        identifier: "session-1",
        created: "2026-05-01T00:00:00Z",
        expires: "2026-05-02T00:00:00Z",
        description: "Desktop browser",
      },
    ]);
  });

  it("validates opaque identifiers", () => {
    expect(isValidAuthentikIdentifier("session-1")).toBe(true);
    expect(isValidAuthentikIdentifier("../../bad")).toBe(false);
  });
});
