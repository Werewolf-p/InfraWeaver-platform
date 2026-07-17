/**
 * Unit coverage for the instant-query helpers added for the cluster-vitals
 * monitoring widget: value extraction, empty-result → null, and error surfacing.
 */
import { promQueryInstant, promScalar } from "@/lib/prometheus";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
  // Prometheus helpers call the global fetch.
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("prometheus instant helpers", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("promScalar returns the first series' numeric value", async () => {
    mockFetchOnce({
      status: "success",
      data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "42.5"] }] },
    });
    await expect(promScalar("some_query")).resolves.toBe(42.5);
  });

  it("promScalar returns null when Prometheus yields no samples", async () => {
    mockFetchOnce({ status: "success", data: { resultType: "vector", result: [] } });
    await expect(promScalar("no_data")).resolves.toBeNull();
  });

  it("promScalar returns null when the value is non-numeric (NaN)", async () => {
    mockFetchOnce({
      status: "success",
      data: { result: [{ value: [1700000000, "NaN"] }] },
    });
    await expect(promScalar("bad")).resolves.toBeNull();
  });

  it("promQueryInstant throws with Prometheus' error when status is not success", async () => {
    mockFetchOnce({ status: "error", error: "parse error: unexpected end of input" });
    await expect(promQueryInstant("bogus(")).rejects.toThrow("parse error");
  });

  it("promQueryInstant throws on a non-ok HTTP response", async () => {
    mockFetchOnce({ status: "success", data: { result: [] } }, false, 502);
    await expect(promQueryInstant("q")).rejects.toThrow(/502|failed/i);
  });

  it("promQueryInstant returns every vector series", async () => {
    mockFetchOnce({
      status: "success",
      data: {
        result: [
          { metric: { pod: "a" }, value: [1, "1"] },
          { metric: { pod: "b" }, value: [1, "2"] },
        ],
      },
    });
    await expect(promQueryInstant("q")).resolves.toHaveLength(2);
  });
});
