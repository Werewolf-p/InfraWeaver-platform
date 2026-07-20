import {
  buildLogs,
  debugLogValue,
  parseDebugLog,
  safeLogPath,
} from "@/addons/wordpress-manager/lib/manage/probes/logs";

describe("debugLogValue", () => {
  test("undefined/blank/false renderings ⇒ off with no path", () => {
    for (const raw of [null, "", "0", "false", "off", "  FALSE "]) {
      expect(debugLogValue(raw)).toEqual({ enabled: false, path: null });
    }
  });

  test("boolean-true renderings ⇒ on at the default path", () => {
    for (const raw of ["1", "true", " TRUE "]) {
      expect(debugLogValue(raw)).toEqual({ enabled: true, path: "wp-content/debug.log" });
    }
  });

  test("a string value ⇒ on at that custom path", () => {
    expect(debugLogValue("/var/log/wp/errors.log")).toEqual({
      enabled: true,
      path: "/var/log/wp/errors.log",
    });
  });
});

describe("safeLogPath", () => {
  test("accepts the default and reasonable absolute/relative paths", () => {
    expect(safeLogPath("wp-content/debug.log")).toBe("wp-content/debug.log");
    expect(safeLogPath("/var/www/html/wp-content/uploads/errors.log")).toBe(
      "/var/www/html/wp-content/uploads/errors.log",
    );
    expect(safeLogPath("  wp-content/debug.log  ")).toBe("wp-content/debug.log");
  });

  test("refuses shell metacharacters, spaces, traversal and a leading dash", () => {
    for (const bad of [
      null,
      "",
      "a log.log", // space
      "$(rm -rf /)",
      "a;rm -rf /",
      "a|b",
      "`x`",
      "wp-content/../../etc/passwd", // traversal
      "-rf", // leading dash → tail flag
      "/x".padEnd(600, "y"), // too long
    ]) {
      expect(safeLogPath(bad)).toBeNull();
    }
  });
});

describe("parseDebugLog", () => {
  test("parses header lines, classifies levels, newest-first", () => {
    const tail = [
      "[07-Jul-2026 10:00:00 UTC] PHP Notice:  older notice",
      "[07-Jul-2026 12:00:00 UTC] PHP Warning:  something is off",
      "  stack trace continuation line", // ignored (no header)
      "[07-Jul-2026 13:00:00 UTC] PHP Fatal error:  boom",
    ].join("\n");
    const entries = parseDebugLog(tail);
    expect(entries).toHaveLength(3);
    expect(entries[0].level).toBe("Fatal error");
    expect(entries[0].at).toBe("07-Jul-2026 13:00:00 UTC");
    expect(entries[2].level).toBe("Notice");
  });
});

describe("buildLogs", () => {
  test("off ⇒ disabled, no entries, no error", () => {
    const data = buildLogs({ config: "", tail: "" });
    expect(data).toEqual({
      debugLogEnabled: false,
      logPath: null,
      entries: [],
      counts: { "Fatal error": 0, Error: 0, Warning: 0, Notice: 0, Deprecated: 0, Other: 0 },
      readError: null,
    });
  });

  test("on with entries ⇒ parsed + counted, custom path preserved", () => {
    const data = buildLogs({
      config: "/var/log/wp/errors.log",
      tail: "[07-Jul-2026 12:00:00 UTC] PHP Warning:  x\n[07-Jul-2026 12:01:00 UTC] PHP Warning:  y",
    });
    expect(data.debugLogEnabled).toBe(true);
    expect(data.logPath).toBe("/var/log/wp/errors.log");
    expect(data.entries).toHaveLength(2);
    expect(data.counts.Warning).toBe(2);
    expect(data.readError).toBeNull();
  });

  test("on but empty tail ⇒ enabled, no entries, no error (nothing logged yet)", () => {
    const data = buildLogs({ config: "1", tail: "" });
    expect(data.debugLogEnabled).toBe(true);
    expect(data.entries).toHaveLength(0);
    expect(data.readError).toBeNull();
  });

  test("config read failure ⇒ NOT reported as off; carries readError", () => {
    const data = buildLogs({ config: "", tail: "", configError: "boom" });
    expect(data.debugLogEnabled).toBe(false);
    expect(data.readError).toBe("boom");
  });

  test("logging on but tail unreadable ⇒ stays enabled with readError, never blanks silently", () => {
    const data = buildLogs({ config: "1", tail: "", tailError: "unreadable" });
    expect(data.debugLogEnabled).toBe(true);
    expect(data.entries).toHaveLength(0);
    expect(data.readError).toBe("unreadable");
  });
});
