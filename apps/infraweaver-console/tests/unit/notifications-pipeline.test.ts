import { buildNotifications, deriveNotificationSeverity } from "@/lib/notifications/pipeline";
import type { RawSignal } from "@/lib/notifications/types";

function makeSignal(overrides: Partial<RawSignal> = {}): RawSignal {
  return {
    key: `evt-${Math.random()}`,
    app: "wordpress",
    cause: "BackOff",
    reason: "BackOff",
    object: "Pod/blog-7d9f8b2c1a-abcde",
    namespace: "wordpress",
    title: "BackOff · Pod/blog",
    level: "warning",
    timestamp: 1000,
    ...overrides,
  };
}

describe("deriveNotificationSeverity", () => {
  it("ranks errors as critical", () => {
    expect(deriveNotificationSeverity("error", 1, 5)).toBe("critical");
  });

  it("escalates a warning to critical once it has flapped enough", () => {
    expect(deriveNotificationSeverity("warning", 5, 5)).toBe("critical");
    expect(deriveNotificationSeverity("warning", 4, 5)).toBe("warning");
  });

  it("ranks a plain info signal as info", () => {
    expect(deriveNotificationSeverity("info", 1, 5)).toBe("info");
  });
});

describe("buildNotifications dedup", () => {
  it("collapses N identical flapping signals into one grouped notification", () => {
    // Arrange — a pod flapping: 6 near-identical warnings, differing only in key.
    const signals = Array.from({ length: 6 }, (_, i) =>
      makeSignal({ key: `evt-${i}`, timestamp: 1000 + i }),
    );

    // Act
    const result = buildNotifications(signals);

    // Assert — one row, count 6, escalated to critical (>= flap threshold).
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(6);
    expect(result[0].severity).toBe("critical");
    expect(result[0].lastSeen).toBe(1005);
  });

  it("keeps distinct app+cause combinations separate", () => {
    // Arrange
    const signals = [
      makeSignal({ app: "wordpress", cause: "BackOff", reason: "BackOff" }),
      makeSignal({ app: "wordpress", cause: "Unhealthy", reason: "Unhealthy", object: "Pod/blog-x" }),
      makeSignal({ app: "jellyfin", cause: "BackOff", reason: "BackOff", object: "Pod/jf-y" }),
    ];

    // Act
    const result = buildNotifications(signals);

    // Assert
    expect(result).toHaveLength(3);
  });
});

describe("buildNotifications rate-limit", () => {
  it("folds per-app overflow into a single 'N more' row", () => {
    // Arrange — 5 distinct causes in one app, cap of 2 per app.
    const signals = Array.from({ length: 5 }, (_, i) =>
      makeSignal({ cause: `Cause${i}`, reason: `Cause${i}`, object: `Pod/blog-${i}` }),
    );

    // Act
    const result = buildNotifications(signals, { maxPerApp: 2 });

    // Assert — 2 kept + 1 overflow row.
    expect(result).toHaveLength(3);
    const overflow = result.find((entry) => entry.overflow);
    expect(overflow).toBeDefined();
    expect(overflow?.title).toContain("more issues from wordpress");
    expect(overflow?.count).toBe(3);
  });

  it("caps the total number of notifications returned", () => {
    // Arrange
    const signals = Array.from({ length: 40 }, (_, i) =>
      makeSignal({ app: `app-${i}`, object: `Pod/p-${i}` }),
    );

    // Act
    const result = buildNotifications(signals, { maxTotal: 20, maxPerApp: 5 });

    // Assert
    expect(result.length).toBeLessThanOrEqual(20);
  });
});

describe("buildNotifications severity ordering", () => {
  it("orders critical above warning above notice", () => {
    // Arrange
    const signals = [
      makeSignal({ app: "a-notice", cause: "Done", reason: "Done", level: "success", object: "Pod/a" }),
      makeSignal({ app: "b-warning", cause: "Slow", reason: "Slow", level: "warning", object: "Pod/b" }),
      makeSignal({ app: "c-critical", cause: "Crash", reason: "Crash", level: "error", object: "Pod/c" }),
    ];

    // Act
    const result = buildNotifications(signals);

    // Assert
    expect(result.map((entry) => entry.severity)).toEqual(["critical", "warning", "notice"]);
  });
});
