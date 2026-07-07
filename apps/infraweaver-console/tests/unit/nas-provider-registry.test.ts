// Verifies the NAS provider registry is genuinely extensible (plan §"generic").
// Adding a new provider must not require touching route handlers or the
// manifest generator; declaring it via NAS_PROVIDERS_JSON must be enough.

import { getProviderConfig, isProviderEnabled, listProviderConfigs, resetProviderRegistry } from "@/lib/nas/providers";

describe("NAS provider registry", () => {
  beforeEach(() => {
    resetProviderRegistry();
  });

  it("returns built-in providers when their host env is set", () => {
    const providers = listProviderConfigs({
      SYNOLOGY_HOST: "nas1.lan",
      SYNOLOGY_PORT: "5000",
      SYNOLOGY_PASSWORD: "x",
      TRUENAS_HOST: "nas2.lan",
      TRUENAS_API_KEY: "y",
    } as NodeJS.ProcessEnv);
    expect(providers.map((p) => p.id).sort()).toEqual(["synology", "truenas"]);
    const syno = providers.find((p) => p.id === "synology")!;
    expect(syno.host).toBe("nas1.lan");
    expect(syno.port).toBe(5000);
    expect(isProviderEnabled(syno, { SYNOLOGY_PASSWORD: "x" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("omits providers whose host env is unset (no fallback IPs baked in)", () => {
    const providers = listProviderConfigs({} as NodeJS.ProcessEnv);
    expect(providers).toEqual([]);
  });

  it("loads and validates extra providers from NAS_PROVIDERS_JSON", () => {
    const env = {
      NAS_PROVIDERS_JSON: JSON.stringify([
        {
          id: "ceph-office",
          name: "Ceph Office Cluster",
          host: "ceph.office.lan",
          port: 6789,
          protocol: "https",
          kind: "generic-nfs",
          backends: ["nfs"],
        },
      ]),
    } as NodeJS.ProcessEnv;
    const providers = listProviderConfigs(env);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("ceph-office");
    expect(providers[0].backends).toEqual(["nfs"]);
  });

  it("rejects malformed NAS_PROVIDERS_JSON without crashing (falls back to built-ins)", () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const providers = listProviderConfigs({
        SYNOLOGY_HOST: "nas1.lan",
        NAS_PROVIDERS_JSON: "not-json",
      } as NodeJS.ProcessEnv);
      expect(providers.map((p) => p.id)).toContain("synology");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("later declarations in NAS_PROVIDERS_JSON override built-ins with the same id", () => {
    const providers = listProviderConfigs({
      SYNOLOGY_HOST: "nas1.lan",
      NAS_PROVIDERS_JSON: JSON.stringify([
        {
          id: "synology",
          name: "Overridden",
          host: "override.lan",
          port: 5001,
          protocol: "https",
          kind: "synology",
          backends: ["smb"],
        },
      ]),
    } as NodeJS.ProcessEnv);
    const syno = providers.find((p) => p.id === "synology")!;
    expect(syno.host).toBe("override.lan");
    expect(syno.name).toBe("Overridden");
  });

  it("getProviderConfig returns undefined for unknown ids", () => {
    resetProviderRegistry();
    expect(getProviderConfig("nope", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
