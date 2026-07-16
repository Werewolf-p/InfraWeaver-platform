/**
 * Retain-trap detector + referenced-key extraction. The Retain trap: with
 * deletionPolicy=Retain, ESO fails the WHOLE secret if ANY referenced key is
 * missing.
 */
import { detectRetainTrap, extractReferencedKeys } from "@/lib/secrets/lifecycle-types";

const ONE_MISSING_KEY = 1;
const NO_MISSING_KEYS = 0;

describe("detectRetainTrap", () => {
  test("flags Retain policy with at least one missing referenced key", () => {
    // Arrange
    const policy = "Retain";

    // Act
    const isTrap = detectRetainTrap(policy, ONE_MISSING_KEY);

    // Assert
    expect(isTrap).toBe(true);
  });

  test("is case-insensitive on the policy name", () => {
    // Arrange
    const policy = "retain";

    // Act
    const isTrap = detectRetainTrap(policy, ONE_MISSING_KEY);

    // Assert
    expect(isTrap).toBe(true);
  });

  test("does not flag a Delete policy even with missing keys", () => {
    // Arrange
    const policy = "Delete";

    // Act
    const isTrap = detectRetainTrap(policy, ONE_MISSING_KEY);

    // Assert
    expect(isTrap).toBe(false);
  });

  test("does not flag Retain when every referenced key is present", () => {
    // Arrange
    const policy = "Retain";

    // Act
    const isTrap = detectRetainTrap(policy, NO_MISSING_KEYS);

    // Assert
    expect(isTrap).toBe(false);
  });
});

describe("extractReferencedKeys", () => {
  test("extracts key + property pairs from spec.data[].remoteRef", () => {
    // Arrange
    const spec = {
      data: [
        { remoteRef: { key: "platform/wiki", property: "admin-password" } },
        { remoteRef: { key: "platform/wiki", property: "admin-email" } },
      ],
    };

    // Act
    const referenced = extractReferencedKeys(spec);

    // Assert
    expect(referenced).toEqual([
      { path: "platform/wiki", property: "admin-password" },
      { path: "platform/wiki", property: "admin-email" },
    ]);
  });

  test("extracts whole-path references from spec.dataFrom[].extract as property null", () => {
    // Arrange
    const spec = { dataFrom: [{ extract: { key: "platform/gitea" } }] };

    // Act
    const referenced = extractReferencedKeys(spec);

    // Assert
    expect(referenced).toEqual([{ path: "platform/gitea", property: null }]);
  });

  test("returns an empty array when the spec has neither data nor dataFrom", () => {
    // Arrange
    const spec = undefined;

    // Act
    const referenced = extractReferencedKeys(spec);

    // Assert
    expect(referenced).toEqual([]);
  });
});
