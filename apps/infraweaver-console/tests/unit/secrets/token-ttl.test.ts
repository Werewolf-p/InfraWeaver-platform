/**
 * Token-TTL classifier + lookup-self parse. Pure logic — no OpenBao, no fetch.
 */
import {
  classifyTokenTtl,
  parseTokenLookupData,
  TOKEN_TTL_CRITICAL_SECONDS,
  TOKEN_TTL_WARN_SECONDS,
} from "@/lib/secrets/lifecycle-types";

const ONE_DAY = 24 * 60 * 60;

describe("classifyTokenTtl", () => {
  test("returns critical when the token is already expired", () => {
    // Arrange
    const token = { available: true, ttlSeconds: 0 };

    // Act
    const severity = classifyTokenTtl(token);

    // Assert
    expect(severity).toBe("critical");
  });

  test("returns critical when TTL is at or under the 7-day threshold", () => {
    // Arrange
    const token = { available: true, ttlSeconds: TOKEN_TTL_CRITICAL_SECONDS };

    // Act
    const severity = classifyTokenTtl(token);

    // Assert
    expect(severity).toBe("critical");
  });

  test("returns warn when TTL is between the critical and warn thresholds", () => {
    // Arrange
    const token = { available: true, ttlSeconds: TOKEN_TTL_CRITICAL_SECONDS + ONE_DAY };

    // Act
    const severity = classifyTokenTtl(token);

    // Assert
    expect(severity).toBe("warn");
  });

  test("returns ok when TTL is comfortably above the 30-day warn threshold", () => {
    // Arrange
    const token = { available: true, ttlSeconds: TOKEN_TTL_WARN_SECONDS + ONE_DAY };

    // Act
    const severity = classifyTokenTtl(token);

    // Assert
    expect(severity).toBe("ok");
  });

  test("returns warn when the token endpoint is unreachable", () => {
    // Arrange
    const token = { available: false, ttlSeconds: null };

    // Act
    const severity = classifyTokenTtl(token);

    // Assert
    expect(severity).toBe("warn");
  });

  test("returns warn when TTL is unknown even though reachable", () => {
    // Arrange
    const token = { available: true, ttlSeconds: null };

    // Act
    const severity = classifyTokenTtl(token);

    // Assert
    expect(severity).toBe("warn");
  });
});

describe("parseTokenLookupData", () => {
  test("extracts ttl, expire_time, renewable and policies from a lookup-self body", () => {
    // Arrange
    const body = {
      data: {
        ttl: 3600,
        expire_time: "2026-08-01T00:00:00Z",
        renewable: true,
        policies: ["default", "platform-k8s"],
      },
    };

    // Act
    const parsed = parseTokenLookupData(body);

    // Assert
    expect(parsed).toEqual({
      ttlSeconds: 3600,
      expireTime: "2026-08-01T00:00:00Z",
      renewable: true,
      policies: ["default", "platform-k8s"],
    });
  });

  test("degrades to null/empty when the body is malformed", () => {
    // Arrange
    const body = { data: { ttl: "not-a-number", policies: "nope" } };

    // Act
    const parsed = parseTokenLookupData(body);

    // Assert
    expect(parsed).toEqual({ ttlSeconds: null, expireTime: null, renewable: false, policies: [] });
  });
});
