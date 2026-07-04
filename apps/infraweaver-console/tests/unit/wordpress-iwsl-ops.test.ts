/** @jest-environment node */
// Managed connector operations (§5.1 + §6 over exec) — the transport scripts
// stay fixed strings (signed wire objects travel via stdin, never argv), and
// the response extraction tolerates PHP notice noise around the JSON.

import {
  connectorSelftestCliScript,
  connectorStatusCliScript,
  extractCommandJson,
  signedCommandScript,
} from "@/addons/wordpress-manager/lib/iwsl-managed-commands";

describe("iwsl ops command builders", () => {
  test("signed command script ferries stdin into handle_command untouched", () => {
    const script = signedCommandScript();
    expect(script).toContain('file_get_contents( "php://stdin" )');
    expect(script).toContain("handle_command");
    expect(script).toContain("wp_json_encode");
    // Fixed string: nothing user-controlled may be interpolated.
    expect(script).toBe(signedCommandScript());
  });

  test("CLI diagnostics tolerate a failing plugin (broken link is the use case)", () => {
    expect(connectorStatusCliScript()).toContain("wp --allow-root infraweaver status");
    expect(connectorStatusCliScript()).toContain("|| true");
    expect(connectorSelftestCliScript()).toContain("wp --allow-root infraweaver selftest");
    expect(connectorSelftestCliScript()).toContain("|| true");
  });
});

describe("extractCommandJson", () => {
  const reply = '{"status":200,"body":{"envelope":{"ok":true},"sigs":{"ed25519":"x"}}}';

  test("returns the JSON document verbatim", () => {
    expect(extractCommandJson(reply)).toBe(reply);
  });

  test("skips PHP notice noise around the document", () => {
    expect(extractCommandJson(`PHP Warning: foo\n${reply}\n`)).toBe(reply);
  });

  test("throws when the plugin printed no JSON at all", () => {
    expect(() => extractCommandJson("Error: plugin not found")).toThrow(/no command response/);
  });
});
