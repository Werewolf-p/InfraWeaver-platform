import { memoryQuantityToMB, pelicanRuntimeEnv } from "@/lib/game-eggs";

// These vars are the wings-injected contract every Pelican yolk egg relies on.
// The fix must be GENERAL (derived from the pod allocation, not per-game) so any
// egg whose STARTUP uses {{SERVER_MEMORY}}/{{SERVER_PORT}}/{{SERVER_IP}} boots.
describe("memoryQuantityToMB", () => {
  it.each([
    ["2Gi", 2048],
    ["1Gi", 1024],
    ["512Mi", 512],
    ["2G", 2000],
    ["4096", 4096], // bare number = MB
    ["0.5Gi", 512],
  ])("parses %s -> %i MB", (input, expected) => {
    expect(memoryQuantityToMB(input)).toBe(expected);
  });

  it("returns 0 for empty/garbage", () => {
    expect(memoryQuantityToMB("")).toBe(0);
    expect(memoryQuantityToMB(undefined)).toBe(0);
    expect(memoryQuantityToMB("banana")).toBe(0);
  });
});

describe("pelicanRuntimeEnv", () => {
  it("derives SERVER_MEMORY below the container limit (JVM headroom prevents OOM)", () => {
    const env = pelicanRuntimeEnv("2Gi", 25565);
    const mem = Number(env.SERVER_MEMORY);
    // 2048 - max(512, 15%) = 2048 - 512 = 1536
    expect(mem).toBe(1536);
    expect(mem).toBeLessThan(2048);
  });

  it("reserves 15% headroom for large allocations", () => {
    const env = pelicanRuntimeEnv("8Gi", 25565);
    // 8192 - max(512, ceil(8192*0.15)=1229) = 8192 - 1229 = 6963
    expect(Number(env.SERVER_MEMORY)).toBe(6963);
  });

  it("never drops SERVER_MEMORY below 512MB", () => {
    expect(Number(pelicanRuntimeEnv("512Mi", 25565).SERVER_MEMORY)).toBe(512);
    expect(Number(pelicanRuntimeEnv("256Mi", 25565).SERVER_MEMORY)).toBe(512);
  });

  it("sets SERVER_IP to bind-all and SERVER_PORT from the game port", () => {
    const env = pelicanRuntimeEnv("2Gi", 7777);
    expect(env.SERVER_IP).toBe("0.0.0.0");
    expect(env.SERVER_PORT).toBe("7777");
  });
});
