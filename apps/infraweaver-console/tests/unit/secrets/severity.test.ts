/**
 * Roll-up severity: the single glanceable state that drives the banner + badge.
 */
import { computeSeverity, type SeveritySignals } from "@/lib/secrets/lifecycle-types";

const HEALTHY_SIGNALS: SeveritySignals = {
  token: { available: true, ttlSeconds: 365 * 24 * 60 * 60 },
  openbaoAvailable: true,
  sealed: false,
  esNotReady: 0,
  retainTraps: 0,
  missingCatalogKeys: 0,
  mirrorFailing: false,
};

describe("computeSeverity", () => {
  test("returns ok when every signal is healthy", () => {
    // Arrange
    const signals = { ...HEALTHY_SIGNALS };

    // Act
    const severity = computeSeverity(signals);

    // Assert
    expect(severity).toBe("ok");
  });

  test("returns critical when OpenBao is reachable and sealed", () => {
    // Arrange
    const signals = { ...HEALTHY_SIGNALS, sealed: true };

    // Act
    const severity = computeSeverity(signals);

    // Assert
    expect(severity).toBe("critical");
  });

  test("returns critical when a Retain trap is present", () => {
    // Arrange
    const signals = { ...HEALTHY_SIGNALS, retainTraps: 1 };

    // Act
    const severity = computeSeverity(signals);

    // Assert
    expect(severity).toBe("critical");
  });

  test("returns critical when an ExternalSecret is not ready", () => {
    // Arrange
    const signals = { ...HEALTHY_SIGNALS, esNotReady: 1 };

    // Act
    const severity = computeSeverity(signals);

    // Assert
    expect(severity).toBe("critical");
  });

  test("returns warn when the token TTL is under 30 days but nothing is critical", () => {
    // Arrange
    const signals = { ...HEALTHY_SIGNALS, token: { available: true, ttlSeconds: 10 * 24 * 60 * 60 } };

    // Act
    const severity = computeSeverity(signals);

    // Assert
    expect(severity).toBe("warn");
  });

  test("returns warn when the public mirror is failing", () => {
    // Arrange
    const signals = { ...HEALTHY_SIGNALS, mirrorFailing: true };

    // Act
    const severity = computeSeverity(signals);

    // Assert
    expect(severity).toBe("warn");
  });

  test("prefers critical over warn when both are present", () => {
    // Arrange
    const signals = { ...HEALTHY_SIGNALS, esNotReady: 1, missingCatalogKeys: 3, mirrorFailing: true };

    // Act
    const severity = computeSeverity(signals);

    // Assert
    expect(severity).toBe("critical");
  });
});
