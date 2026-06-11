import { apiClient } from "@/lib/api-client";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("apiClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("unwraps success envelopes", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ data: { ok: true } })) as typeof fetch;

    await expect(apiClient.get<{ ok: boolean }>("/api/test")).resolves.toEqual({ ok: true });
  });

  it("serializes query parameters and JSON bodies", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ data: { ok: true } })) as typeof fetch;

    await apiClient.post<{ ok: boolean }>("/api/test", {
      query: { namespace: "default", include: ["pods", "services"] },
      json: { enabled: true },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/test?namespace=default&include=pods&include=services",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ enabled: true }),
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("throws a friendly permission error on 403", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: "Forbidden" }, 403)) as typeof fetch;

    await expect(apiClient.get("/api/test")).rejects.toThrow("You don't have permission to perform this action");
  });

  it("throws API envelope errors for generic failures", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: "Boom" }, 500)) as typeof fetch;

    await expect(apiClient.get("/api/test")).rejects.toThrow("Boom");
  });
});
