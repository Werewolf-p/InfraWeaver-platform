import { checkSameOrigin, getRequestBodyLimit, getRequestSizeViolation } from "@/lib/api-helpers";

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
