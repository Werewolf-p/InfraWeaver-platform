/** @jest-environment node */
// Managed enrollment (§5.1) drives a site pod over `wp` — the scripts are
// fixed strings fed secrets via stdin, so the contract is: no interpolated
// input anywhere, temp files cleaned up, and proof extraction resilient to
// PHP notice noise ahead of the JSON.

import {
  enrollBundleScript,
  extractProofJson,
  installConnectorScript,
  readEnrollProofScript,
  resetConnectorStateScript,
  uninstallConnectorScript,
} from "@/addons/wordpress-manager/lib/iwsl-managed-commands";

describe("iwsl managed command builders", () => {
  test("install streams the zip from stdin and cleans up the temp file", () => {
    const script = installConnectorScript();
    expect(script).toContain("base64 -d");
    expect(script).toContain("wp --allow-root plugin install");
    expect(script).toContain("--force --activate");
    expect(script).toMatch(/trap 'rm -f/);
  });

  test("enroll consumes the bundle from stdin via the §5.1 CLI path", () => {
    const script = enrollBundleScript();
    expect(script).toContain("cat >");
    expect(script).toContain("wp --allow-root infraweaver enroll --file=");
    expect(script).toMatch(/trap 'rm -f/);
  });

  test("state reset deletes only iwsl_ options", () => {
    const script = resetConnectorStateScript();
    expect(script).toContain("--search='iwsl_%'");
    expect(script).toContain("option delete");
  });

  test("uninstall deactivates and deletes the plugin, tolerating absence", () => {
    const script = uninstallConnectorScript();
    expect(script).toContain("plugin deactivate infraweaver-connector");
    expect(script).toContain("plugin delete infraweaver-connector");
    expect(script).toContain("|| true");
  });

  test("proof read echoes the plugin's proof document as JSON", () => {
    expect(readEnrollProofScript()).toContain("wp_json_encode");
    expect(readEnrollProofScript()).toContain("build_proof()");
  });
});

describe("extractProofJson", () => {
  const proof = '{"proof":{"v":1},"sigs":{"ed25519":"x"}}';

  test("returns the JSON document verbatim", () => {
    expect(extractProofJson(proof)).toBe(proof);
  });

  test("skips PHP notice noise ahead of the document", () => {
    expect(extractProofJson(`PHP Notice: something\nDeprecated: thing\n${proof}\n`)).toBe(proof);
  });

  test("rejects a null proof (no pending enrollment)", () => {
    expect(() => extractProofJson("null\n")).toThrow(/no pending enrollment/i);
  });

  test("rejects output with no JSON object at all", () => {
    expect(() => extractProofJson("Fatal error: wp died")).toThrow(/no pending enrollment/i);
  });
});
