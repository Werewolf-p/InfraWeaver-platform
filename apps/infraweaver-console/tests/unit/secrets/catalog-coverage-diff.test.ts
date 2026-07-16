/**
 * Catalog key-coverage diff: declared vs seeded vs referenced. Pure set math.
 */
import { diffCatalogCoverage } from "@/lib/secrets/lifecycle-types";

describe("diffCatalogCoverage", () => {
  test("reports declared-but-unseeded keys as missing", () => {
    // Arrange
    const declared = ["admin-password", "admin-email", "postgresql-password"];
    const seeded = ["admin-password", "admin-email"];
    const referenced = ["admin-password"];

    // Act
    const { missingKeys } = diffCatalogCoverage(declared, seeded, referenced);

    // Assert
    expect(missingKeys).toEqual(["postgresql-password"]);
  });

  test("reports referenced-but-undeclared keys as undeclaredReferenced", () => {
    // Arrange
    const declared = ["admin-password"];
    const seeded = ["admin-password"];
    const referenced = ["admin-password", "oidc-client-secret"];

    // Act
    const { undeclaredReferencedKeys } = diffCatalogCoverage(declared, seeded, referenced);

    // Assert
    expect(undeclaredReferencedKeys).toEqual(["oidc-client-secret"]);
  });

  test("returns empty diffs when declared, seeded and referenced all agree", () => {
    // Arrange
    const keys = ["admin-password", "admin-email"];

    // Act
    const { missingKeys, undeclaredReferencedKeys } = diffCatalogCoverage(keys, keys, keys);

    // Assert
    expect(missingKeys).toEqual([]);
    expect(undeclaredReferencedKeys).toEqual([]);
  });

  test("de-duplicates referenced keys before diffing", () => {
    // Arrange
    const declared = ["admin-password"];
    const seeded = ["admin-password"];
    const referenced = ["stray", "stray", "stray"];

    // Act
    const { undeclaredReferencedKeys } = diffCatalogCoverage(declared, seeded, referenced);

    // Assert
    expect(undeclaredReferencedKeys).toEqual(["stray"]);
  });
});
