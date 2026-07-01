import { checkJavaCompatibility, minecraftVersionFromEnv, requiredJavaForMinecraftVersion } from "@/addons/gamehub/lib/minecraft-java-compat";

// Mojang manifest fetch is stubbed so the validator logic is deterministic.
// `latest` drives dynamic-version resolution ("latest"/"snapshot"/"recommended").
const MANIFEST = {
  latest: { release: "1.21.4", snapshot: "1.21.4" },
  versions: [
    { id: "1.21.4", type: "release", url: "https://mojang/1.21.4.json" },
    { id: "1.16.5", type: "release", url: "https://mojang/1.16.5.json" },
  ],
};
const DETAIL: Record<string, unknown> = {
  "https://mojang/1.21.4.json": { javaVersion: { majorVersion: 21 } },
  "https://mojang/1.16.5.json": { javaVersion: { majorVersion: 8 } },
};

beforeEach(() => {
  // jsdom does not implement AbortSignal.timeout; the lib uses it for fetch.
  AbortSignal.timeout = () => new AbortController().signal;
  global.fetch = jest.fn(async (url: string) => {
    const body = url.includes("version_manifest") ? MANIFEST : DETAIL[url] ?? {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
});

describe("minecraftVersionFromEnv", () => {
  it("reads whichever version key the egg family uses", () => {
    expect(minecraftVersionFromEnv({ MINECRAFT_VERSION: "1.21.4" })).toBe("1.21.4");
    expect(minecraftVersionFromEnv({ MC_VERSION: "1.20.1" })).toBe("1.20.1");
    expect(minecraftVersionFromEnv({ VANILLA_VERSION: "1.19.2" })).toBe("1.19.2");
    expect(minecraftVersionFromEnv({ OTHER: "x" })).toBeNull();
    expect(minecraftVersionFromEnv({ MC_VERSION: "" })).toBeNull();
  });
});

describe("requiredJavaForMinecraftVersion", () => {
  it("returns the Java major from the Mojang manifest", async () => {
    expect(await requiredJavaForMinecraftVersion("1.21.4")).toBe(21);
    expect(await requiredJavaForMinecraftVersion("1.16.5")).toBe(8);
  });
  it("resolves dynamic 'latest'/'snapshot'/'recommended' to the manifest's newest build and constrains on it", async () => {
    // "latest" resolves to the newest release (1.21.4 → Java 21) so the wizard
    // can still pick a compatible runtime image instead of silently skipping the
    // check — a server that boots on the latest MC must not run an old Java.
    expect(await requiredJavaForMinecraftVersion("latest")).toBe(21);
    expect(await requiredJavaForMinecraftVersion("recommended")).toBe(21);
    expect(await requiredJavaForMinecraftVersion("snapshot")).toBe(21);
  });
  it("returns null for empty or unknown concrete versions (no constraint)", async () => {
    expect(await requiredJavaForMinecraftVersion("")).toBeNull();
    expect(await requiredJavaForMinecraftVersion("9.9.9")).toBeNull();
  });
});

describe("checkJavaCompatibility", () => {
  it("rejects a too-old Java image for the version with a clear reason", async () => {
    const r = await checkJavaCompatibility("ghcr.io/pterodactyl/yolks:java_17", "1.21.4");
    expect(r.compatible).toBe(false);
    expect(r.imageJava).toBe(17);
    expect(r.requiredJava).toBe(21);
    expect(r.reason).toMatch(/requires Java 21/);
  });
  it("accepts a new-enough Java image", async () => {
    expect((await checkJavaCompatibility("ghcr.io/pterodactyl/yolks:java_21", "1.21.4")).compatible).toBe(true);
    expect((await checkJavaCompatibility("ghcr.io/pterodactyl/yolks:java_8", "1.16.5")).compatible).toBe(true);
  });
  it("now constrains dynamic 'latest' by resolving it to the newest build", async () => {
    // java_8 can no longer run "latest" (resolves to 1.21.4 → needs Java 21).
    const r = await checkJavaCompatibility("ghcr.io/pterodactyl/yolks:java_8", "latest");
    expect(r.compatible).toBe(false);
    expect(r.requiredJava).toBe(21);
  });
  it("does not constrain non-Java images or unknown versions", async () => {
    expect((await checkJavaCompatibility("ghcr.io/parkervcp/yolks:dotnet_9", "1.21.4")).compatible).toBe(true);
    expect((await checkJavaCompatibility("ghcr.io/pterodactyl/yolks:java_8", "9.9.9")).compatible).toBe(true);
  });
});
