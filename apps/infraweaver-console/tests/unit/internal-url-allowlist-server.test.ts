// Server-only dynamic SSRF allowlist. Verifies that the resolved host set
// unions env/git identity + OpenBao-stored NAS providers, that the wizard
// variant additionally accepts unambiguously private hosts, and that
// invalidate() forces a re-read.

import {
  getResolvedInternalHosts,
  invalidateInternalHostAllowlist,
  isAllowedInternalHostAsync,
  isAllowedInternalHostForWizard,
  parseAllowedInternalUrlAsync,
} from "@/lib/internal-url-allowlist-server";
import * as identity from "@/lib/platform-config-server";
import * as store from "@/lib/nas/store";
import type { StoredNasProvider } from "@/lib/nas/store";
import type { ResolvedPlatformIdentity } from "@/lib/platform-config";

const BASE_IDENTITY: ResolvedPlatformIdentity = {
  baseDomain: "example.com",
  brandName: "InfraWeaver",
  registryHost: "registry.int.example.com",
  argocdUrl: "https://argocd.int.example.com",
  authentikUrl: "http://authentik-server.authentik.svc.cluster.local",
  authentikIssuer: "https://auth.example.com/application/o/x/",
  defaultCluster: "homelab-prod",
  tlsSecrets: { public: "p", internal: "i" },
  accessTierMiddlewares: { vpn: "vpn", internal: "int" },
  internalHostAllowlist: ["10.25.0.21", "argocd.int.example.com"],
  externalRouteDomains: [],
  homepageServiceMap: {},
};

function storedProvider(host: string, id = "media-nas"): StoredNasProvider {
  return {
    id,
    name: id,
    host,
    port: 5001,
    protocol: "https",
    kind: "synology",
    backends: ["smb"],
    credentials: { username: "svc", password: "pw" },
  };
}

describe("internal-url-allowlist-server", () => {
  afterEach(() => {
    invalidateInternalHostAllowlist();
    jest.restoreAllMocks();
  });

  it("unions git-overlay identity hosts with OpenBao-stored NAS provider hosts", async () => {
    jest.spyOn(identity, "getPlatformIdentity").mockResolvedValue(BASE_IDENTITY);
    jest.spyOn(store, "readStoredNasProviders").mockResolvedValue([storedProvider("10.99.0.7")]);

    const hosts = await getResolvedInternalHosts();
    expect(hosts.has("10.25.0.21")).toBe(true);
    expect(hosts.has("argocd.int.example.com")).toBe(true);
    expect(hosts.has("10.99.0.7")).toBe(true);
  });

  it("degrades to identity-only when the NAS store is down", async () => {
    jest.spyOn(identity, "getPlatformIdentity").mockResolvedValue(BASE_IDENTITY);
    jest.spyOn(store, "readStoredNasProviders").mockRejectedValue(new Error("vault down"));

    const hosts = await getResolvedInternalHosts();
    expect(hosts.has("10.25.0.21")).toBe(true);
    expect(hosts.size).toBeGreaterThan(0);
  });

  it("isAllowedInternalHostAsync accepts *.INTERNAL_DOMAIN and stored hosts, rejects public", async () => {
    jest.spyOn(identity, "getPlatformIdentity").mockResolvedValue(BASE_IDENTITY);
    jest.spyOn(store, "readStoredNasProviders").mockResolvedValue([storedProvider("10.99.0.7")]);

    await expect(isAllowedInternalHostAsync("registry.int.example.com")).resolves.toBe(true);
    await expect(isAllowedInternalHostAsync("10.99.0.7")).resolves.toBe(true);
    await expect(isAllowedInternalHostAsync("evil.example.com")).resolves.toBe(false);
  });

  it("parseAllowedInternalUrlAsync rejects userinfo and non-http(s) schemes", async () => {
    jest.spyOn(identity, "getPlatformIdentity").mockResolvedValue(BASE_IDENTITY);
    jest.spyOn(store, "readStoredNasProviders").mockResolvedValue([]);

    await expect(parseAllowedInternalUrlAsync("file:///etc/passwd")).resolves.toBeNull();
    await expect(parseAllowedInternalUrlAsync("https://user:pw@10.25.0.21/")).resolves.toBeNull();
    await expect(parseAllowedInternalUrlAsync("https://10.25.0.21/")).resolves.not.toBeNull();
  });

  it("isAllowedInternalHostForWizard accepts private hosts not yet on the allowlist", async () => {
    jest.spyOn(identity, "getPlatformIdentity").mockResolvedValue(BASE_IDENTITY);
    jest.spyOn(store, "readStoredNasProviders").mockResolvedValue([]);

    // Not on the allowlist — but it's a private IP, so the wizard admits it.
    await expect(isAllowedInternalHostForWizard("10.42.0.99")).resolves.toBe(true);
    await expect(isAllowedInternalHostForWizard("nas.local")).resolves.toBe(true);
    // A public host is still fail-closed even in the wizard.
    await expect(isAllowedInternalHostForWizard("nas.example.com")).resolves.toBe(false);
  });

  it("invalidateInternalHostAllowlist forces a re-read of the store", async () => {
    const idSpy = jest.spyOn(identity, "getPlatformIdentity").mockResolvedValue(BASE_IDENTITY);
    const storeSpy = jest
      .spyOn(store, "readStoredNasProviders")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([storedProvider("10.42.0.7")]);

    await expect(isAllowedInternalHostAsync("10.42.0.7")).resolves.toBe(false);
    invalidateInternalHostAllowlist();
    await expect(isAllowedInternalHostAsync("10.42.0.7")).resolves.toBe(true);
    expect(storeSpy).toHaveBeenCalledTimes(2);
    expect(idSpy).toHaveBeenCalledTimes(2);
  });
});
