/** @jest-environment node */
// isOidcHealthy — the pure check behind validate/self-heal OIDC. Encodes the exact
// hi2 failure: settings option absent, or present with an empty client_id / endpoint.
import { isOidcHealthy } from "@/addons/wordpress-manager/lib/oidc-health";

describe("isOidcHealthy", () => {
  test("healthy when client_id AND endpoint_login are both present", () => {
    const raw = JSON.stringify({
      client_id: "abc123",
      client_secret: "shh",
      scope: "openid email profile",
      endpoint_login: "https://auth.rlservers.com/application/o/authorize/",
    });
    expect(isOidcHealthy(raw)).toEqual({ ok: true, reason: "" });
  });

  test("settings-missing when the option is absent (empty stdout — the hi2 case)", () => {
    expect(isOidcHealthy("")).toEqual({ ok: false, reason: "settings-missing" });
    expect(isOidcHealthy("   ")).toEqual({ ok: false, reason: "settings-missing" });
  });

  test("settings-unparseable on non-JSON output", () => {
    expect(isOidcHealthy("Error: could not get option").ok).toBe(false);
    expect(isOidcHealthy("Error: could not get option").reason).toBe("settings-unparseable");
  });

  test("client-id-empty when the map exists but client_id is blank", () => {
    expect(isOidcHealthy(JSON.stringify({ client_id: "", scope: "", endpoint_login: "" }))).toEqual({
      ok: false,
      reason: "client-id-empty",
    });
    expect(isOidcHealthy(JSON.stringify({ scope: "openid" }))).toEqual({ ok: false, reason: "client-id-empty" });
  });

  test("endpoint-login-empty when client_id is set but the login endpoint is not", () => {
    expect(isOidcHealthy(JSON.stringify({ client_id: "abc", endpoint_login: "" }))).toEqual({
      ok: false,
      reason: "endpoint-login-empty",
    });
    expect(isOidcHealthy(JSON.stringify({ client_id: "abc" }))).toEqual({ ok: false, reason: "endpoint-login-empty" });
  });

  test("non-object JSON is treated as missing", () => {
    expect(isOidcHealthy("[1,2,3]").reason).toBe("settings-missing");
    expect(isOidcHealthy("42").reason).toBe("settings-missing");
  });
});
