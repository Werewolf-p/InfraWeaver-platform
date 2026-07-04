/** @jest-environment node */
// The connector zip is what operators upload to external WordPress sites and
// what managed enrollment streams into site pods — a malformed layout (files
// not under a single `infraweaver-connector/` root) silently breaks
// `wp plugin install`, so the archive shape is contract-tested here.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { buildConnectorPackage, __resetConnectorPackageCache } from "@/addons/wordpress-manager/lib/connector-package";

const HEADER = `<?php
/**
 * Plugin Name: InfraWeaver Connector
 * Version: 0.9.9
 */
`;

describe("wordpress connector package", () => {
  let dir: string;

  beforeEach(() => {
    __resetConnectorPackageCache();
    dir = mkdtempSync(path.join(tmpdir(), "iwc-"));
    const plugin = path.join(dir, "infraweaver-connector");
    mkdirSync(path.join(plugin, "includes"), { recursive: true });
    writeFileSync(path.join(plugin, "infraweaver-connector.php"), HEADER);
    writeFileSync(path.join(plugin, "includes", "class-iwsl-plugin.php"), "<?php // stub\n");
    process.env.IWSL_CONNECTOR_DIR = plugin;
  });

  afterEach(() => {
    delete process.env.IWSL_CONNECTOR_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test("zips every file under a single infraweaver-connector/ root", async () => {
    const pkg = await buildConnectorPackage();
    const entries = unzipSync(new Uint8Array(pkg.zip));
    const names = Object.keys(entries).sort();
    expect(names).toEqual([
      "infraweaver-connector/includes/class-iwsl-plugin.php",
      "infraweaver-connector/infraweaver-connector.php",
    ]);
    expect(strFromU8(entries["infraweaver-connector/infraweaver-connector.php"])).toContain("InfraWeaver Connector");
  });

  test("parses the plugin version from the header for the filename", async () => {
    const pkg = await buildConnectorPackage();
    expect(pkg.version).toBe("0.9.9");
    expect(pkg.filename).toBe("infraweaver-connector-0.9.9.zip");
  });

  test("caches the built archive across calls", async () => {
    const first = await buildConnectorPackage();
    // A file added after the first build must not appear — the archive is
    // immutable for the life of the process (image contents never change).
    writeFileSync(path.join(dir, "infraweaver-connector", "late.php"), "<?php\n");
    const second = await buildConnectorPackage();
    expect(second.zip).toBe(first.zip);
  });

  test("throws a clear error when the vendored plugin dir is missing", async () => {
    process.env.IWSL_CONNECTOR_DIR = path.join(dir, "nope");
    await expect(buildConnectorPackage()).rejects.toThrow(/vendored connector plugin not found/i);
  });
});
