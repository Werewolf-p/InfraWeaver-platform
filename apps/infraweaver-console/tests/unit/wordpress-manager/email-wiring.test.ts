import {
  RPC_METHODS,
  RPC_REGISTRY,
  type RpcMethod,
} from "@/addons/wordpress-manager/lib/rpc/registry";
import {
  getPanelDef,
  resolveCapabilities,
} from "@/addons/wordpress-manager/lib/manage/capabilities";
import { emailReasonText } from "@/addons/wordpress-manager/lib/manage/email";

const EMAIL_METHODS: RpcMethod[] = [
  "email.config.get",
  "email.config.set",
  "email.test",
  "email.log.get",
  "email.log.clear",
];

const VALID_SETTINGS = {
  host: "smtp.office365.com",
  port: 587,
  auth: true,
  username: "postmaster@example.com",
  from_email: "postmaster@example.com",
  from_name: "Example",
  secure: "tls",
  allow_option_password: true,
};

describe("RPC registry — email methods", () => {
  test("all five email methods are registered", () => {
    for (const method of EMAIL_METHODS) {
      expect(RPC_METHODS).toContain(method);
      expect(RPC_REGISTRY[method]).toBeDefined();
    }
  });

  test("reads and clear carry no params; set and test carry params", () => {
    expect(RPC_REGISTRY["email.config.get"].hasParams).toBe(false);
    expect(RPC_REGISTRY["email.log.get"].hasParams).toBe(false);
    expect(RPC_REGISTRY["email.log.clear"].hasParams).toBe(false);
    expect(RPC_REGISTRY["email.config.set"].hasParams).toBe(true);
    expect(RPC_REGISTRY["email.test"].hasParams).toBe(true);
  });

  test("no-param methods reject stray params (§6.3)", () => {
    expect(RPC_REGISTRY["email.config.get"].validate({ x: 1 })).toBe(false);
    expect(RPC_REGISTRY["email.config.get"].validate({})).toBe(true);
    expect(RPC_REGISTRY["email.log.clear"].validate({ y: 2 })).toBe(false);
  });

  test("config.set validator mirrors the wire shape (write-only password, strays refused)", () => {
    expect(RPC_REGISTRY["email.config.set"].validate({ settings: VALID_SETTINGS })).toBe(true);
    expect(RPC_REGISTRY["email.config.set"].validate({ settings: VALID_SETTINGS, password: "x" })).toBe(true);
    // unknown top-level key
    expect(RPC_REGISTRY["email.config.set"].validate({ settings: VALID_SETTINGS, foo: 1 })).toBe(false);
    // CRLF in a header field
    expect(
      RPC_REGISTRY["email.config.set"].validate({ settings: { ...VALID_SETTINGS, host: "a\r\nb" } }),
    ).toBe(false);
  });

  test("test validator requires a single-line recipient", () => {
    expect(RPC_REGISTRY["email.test"].validate({ to: "ops@example.com" })).toBe(true);
    expect(RPC_REGISTRY["email.test"].validate({ to: "" })).toBe(false);
    expect(RPC_REGISTRY["email.test"].validate({ to: "a@b.c", cc: "x" })).toBe(false);
  });
});

describe("capabilities — email panel widening", () => {
  test("email capability lights for a connector site OR a third-party SMTP plugin", () => {
    const connectorOnly = resolveCapabilities({ activePlugins: new Set<string>(), connectorActive: true });
    const pluginOnly = resolveCapabilities({ activePlugins: new Set(["wp-mail-smtp"]), connectorActive: false });
    const neither = resolveCapabilities({ activePlugins: new Set<string>(), connectorActive: false });
    expect(connectorOnly.email).toBe(true);
    expect(pluginOnly.email).toBe(true);
    expect(neither.email).toBe(false);
  });

  test("the Email panel gates on the widened `email` capability, not raw `smtp`", () => {
    const def = getPanelDef("email");
    expect(def?.requires?.capability).toBe("email");
  });

  test("the Email panel no longer recommends wp-mail-smtp in its hint", () => {
    const def = getPanelDef("email");
    expect(def?.requires?.hint.toLowerCase()).not.toContain("wp mail smtp");
    expect(def?.requires?.connector).toBe(true);
  });
});

describe("emailReasonText", () => {
  test("known engine reasons map to actionable copy, never the raw code", () => {
    expect(emailReasonText("password-storage-not-allowed")).toMatch(/database|IWSL_SMTP_PASS/);
    expect(emailReasonText("password-encryption-unavailable")).toMatch(/IWSL_SMTP_PASS/);
    expect(emailReasonText("entitlement-locked")).toMatch(/plan/i);
    expect(emailReasonText("rate-limited")).toMatch(/wait/i);
  });
  test("empty reason yields empty string; unknown reason yields a generic message", () => {
    expect(emailReasonText("")).toBe("");
    const unknown = emailReasonText("some-new-code");
    expect(unknown).not.toContain("some-new-code");
    expect(unknown.length).toBeGreaterThan(0);
  });
});
