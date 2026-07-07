import { isUdmConfigured, parseUdmConfig, UdmConfigError, getUdmClient } from "@/lib/udm/config";

const FULL_ENV = {
  UDM_HOST: "https://10.10.0.1",
  UDM_USERNAME: "apiuser",
  UDM_PASSWORD: "test-pw",
  UDM_CERT_SHA256: "138fe3eec634b3ebdb973788c188e23f5aa499e42c6632309c79d6a1d7f97bf6",
} as NodeJS.ProcessEnv;

describe("parseUdmConfig", () => {
  it("parses a complete environment and defaults the site to 'default'", () => {
    const config = parseUdmConfig(FULL_ENV);
    expect(config).toMatchObject({
      host: "https://10.10.0.1",
      username: "apiuser",
      password: "test-pw",
      site: "default",
    });
  });

  it("honors an explicit UDM_SITE", () => {
    expect(parseUdmConfig({ ...FULL_ENV, UDM_SITE: "lab" }).site).toBe("lab");
  });

  it("throws UdmConfigError naming every missing variable", () => {
    expect(() => parseUdmConfig({ UDM_HOST: "https://10.10.0.1" } as NodeJS.ProcessEnv)).toThrow(UdmConfigError);
    try {
      parseUdmConfig({} as NodeJS.ProcessEnv);
      throw new Error("expected throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("UDM_HOST");
      expect(message).toContain("UDM_USERNAME");
      expect(message).toContain("UDM_PASSWORD");
      expect(message).toContain("UDM_CERT_SHA256");
    }
  });
});

describe("isUdmConfigured / getUdmClient", () => {
  it("reports configured only when all required vars are present", () => {
    expect(isUdmConfigured(FULL_ENV)).toBe(true);
    expect(isUdmConfigured({ UDM_HOST: "https://10.10.0.1" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("returns null client when the connector is not configured", () => {
    expect(getUdmClient({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("builds a client when configured", () => {
    expect(getUdmClient(FULL_ENV)).not.toBeNull();
  });
});
