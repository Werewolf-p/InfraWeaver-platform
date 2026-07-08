// Verifies the dynamic resolver merges env/JSON built-ins with OpenBao-stored
// providers, that stored entries override built-ins by id, and that credential
// resolution prefers stored secrets and falls back to env.

import { resolveNasProviders, resolveNasCredentials, resetProviderRegistry } from "@/lib/nas/providers";
import * as store from "@/lib/nas/store";
import type { StoredNasProvider } from "@/lib/nas/store";

const STORED: StoredNasProvider = {
  id: "media-nas",
  name: "Media NAS",
  host: "10.25.0.99",
  port: 5001,
  protocol: "https",
  kind: "synology",
  backends: ["smb"],
  credentials: { username: "svc", password: "pw" },
};

describe("dynamic NAS provider resolution", () => {
  afterEach(() => {
    resetProviderRegistry();
    jest.restoreAllMocks();
  });

  it("merges env built-ins with OpenBao-stored providers", async () => {
    jest.spyOn(store, "readStoredNasProviders").mockResolvedValue([STORED]);
    resetProviderRegistry();
    const providers = await resolveNasProviders({
      SYNOLOGY_HOST: "10.25.0.21",
      SYNOLOGY_PASSWORD: "envpw",
    } as NodeJS.ProcessEnv);
    const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
    expect(byId["synology"].source).toBe("env");
    expect(byId["synology"].hasCredentials).toBe(true);
    expect(byId["media-nas"].source).toBe("openbao");
    expect(byId["media-nas"].hasCredentials).toBe(true);
  });

  it("marks an env provider without credentials as disabled", async () => {
    jest.spyOn(store, "readStoredNasProviders").mockResolvedValue([]);
    resetProviderRegistry();
    const providers = await resolveNasProviders({ SYNOLOGY_HOST: "10.25.0.21" } as NodeJS.ProcessEnv);
    expect(providers.find((p) => p.id === "synology")?.hasCredentials).toBe(false);
  });

  it("a stored provider overrides a built-in with the same id", async () => {
    jest.spyOn(store, "readStoredNasProviders").mockResolvedValue([{ ...STORED, id: "synology", host: "10.25.0.99" }]);
    resetProviderRegistry();
    const providers = await resolveNasProviders({
      SYNOLOGY_HOST: "10.25.0.21",
      SYNOLOGY_PASSWORD: "envpw",
    } as NodeJS.ProcessEnv);
    const syno = providers.find((p) => p.id === "synology")!;
    expect(syno.host).toBe("10.25.0.99");
    expect(syno.source).toBe("openbao");
  });

  it("credentials prefer the stored secret, else fall back to env", async () => {
    jest.spyOn(store, "readStoredNasProviders").mockResolvedValue([STORED]);
    await expect(resolveNasCredentials("media-nas", {} as NodeJS.ProcessEnv)).resolves.toEqual({
      username: "svc",
      password: "pw",
    });
    await expect(
      resolveNasCredentials("truenas", { TRUENAS_API_KEY: "abc" } as NodeJS.ProcessEnv),
    ).resolves.toEqual({ apiKey: "abc" });
    await expect(resolveNasCredentials("unknown", {} as NodeJS.ProcessEnv)).resolves.toBeNull();
  });

  it("hides a suppressed (tombstoned) env provider from the registry", async () => {
    jest.spyOn(store, "readStoredNasProviders").mockResolvedValue([]);
    jest.spyOn(store, "readSuppressedEnvProviderIds").mockResolvedValue(["synology"]);
    resetProviderRegistry();
    const providers = await resolveNasProviders({
      SYNOLOGY_HOST: "10.25.0.21",
      SYNOLOGY_PASSWORD: "envpw",
      TRUENAS_HOST: "10.25.0.135",
    } as NodeJS.ProcessEnv);
    expect(providers.find((p) => p.id === "synology")).toBeUndefined();
    // Non-suppressed env providers still resolve.
    expect(providers.find((p) => p.id === "truenas")).toBeDefined();
  });

  it("keeps an env id visible when a stored provider re-uses it despite suppression", async () => {
    jest.spyOn(store, "readStoredNasProviders").mockResolvedValue([{ ...STORED, id: "synology", host: "10.25.0.99" }]);
    jest.spyOn(store, "readSuppressedEnvProviderIds").mockResolvedValue(["synology"]);
    resetProviderRegistry();
    const providers = await resolveNasProviders({
      SYNOLOGY_HOST: "10.25.0.21",
      SYNOLOGY_PASSWORD: "envpw",
    } as NodeJS.ProcessEnv);
    const syno = providers.find((p) => p.id === "synology");
    expect(syno).toBeDefined();
    expect(syno?.source).toBe("openbao");
    expect(syno?.host).toBe("10.25.0.99");
  });
});
