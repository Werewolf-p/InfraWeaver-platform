// Pure "update available" compare for the §5.1 Connector version badge.
// The badge flags a site ONLY when the console's bundled version is strictly
// newer than the site's — and the site's version is only ever a
// signature-verified health.check reading (see connector-version.ts header), so
// a MITM can't spoof it down to suppress the pill.
import {
  compareConnectorVersions,
  isConnectorOutdated,
} from "@/addons/wordpress-manager/lib/connector-version";

describe("isConnectorOutdated", () => {
  test("flags a site behind the bundled version", () => {
    expect(isConnectorOutdated("0.2.2", "1.4.0")).toBe(true);
    expect(isConnectorOutdated("1.3.9", "1.4.0")).toBe(true);
    expect(isConnectorOutdated("1.4.0", "1.4.1")).toBe(true);
  });

  test("does not flag an up-to-date site", () => {
    expect(isConnectorOutdated("1.4.0", "1.4.0")).toBe(false);
    // Trailing-zero segments compare equal (1.4 == 1.4.0).
    expect(isConnectorOutdated("1.4", "1.4.0")).toBe(false);
  });

  test("does not flag a site AHEAD of the bundle — nothing to push", () => {
    expect(isConnectorOutdated("1.5.0", "1.4.0")).toBe(false);
    expect(isConnectorOutdated("1.4.1", "1.4.0")).toBe(false);
  });

  test("stays silent when either version is missing", () => {
    expect(isConnectorOutdated(undefined, "1.4.0")).toBe(false);
    expect(isConnectorOutdated("1.4.0", undefined)).toBe(false);
    expect(isConnectorOutdated(null, null)).toBe(false);
    expect(isConnectorOutdated("", "1.4.0")).toBe(false);
  });

  test("stays silent on an unparseable version rather than guessing", () => {
    expect(isConnectorOutdated("dev", "1.4.0")).toBe(false);
    expect(isConnectorOutdated("1.4.0", "latest")).toBe(false);
    expect(isConnectorOutdated("v1.4.0", "1.5.0")).toBe(false); // leading 'v' → NaN segment
  });

  test("compares only the leading numeric core, ignoring pre-release/build suffixes", () => {
    expect(isConnectorOutdated("1.4.0-beta.2", "1.4.0")).toBe(false); // same core → not outdated
    expect(isConnectorOutdated("1.3.0-rc.1", "1.4.0")).toBe(true);
    expect(isConnectorOutdated("1.4.0+build.7", "1.4.0")).toBe(false);
  });
});

describe("compareConnectorVersions", () => {
  test("returns -1 / 0 / 1 over numeric cores", () => {
    expect(compareConnectorVersions("1.2.0", "1.3.0")).toBe(-1);
    expect(compareConnectorVersions("1.3.0", "1.3.0")).toBe(0);
    expect(compareConnectorVersions("2.0.0", "1.9.9")).toBe(1);
  });

  test("returns null when a version has no parseable core", () => {
    expect(compareConnectorVersions("dev", "1.0.0")).toBeNull();
    expect(compareConnectorVersions(undefined, "1.0.0")).toBeNull();
  });
});
