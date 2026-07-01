import { memoryQuantityToMB } from "@/lib/game-eggs";

/**
 * Mirrors the `isHeavy` predicate in
 * src/app/api/game-hub/servers/route.ts. Heavy servers (big install/world-gen)
 * get a 20-minute startup budget; light ones get 10. The classification MUST be
 * numeric — a lexicographic string compare (the previous bug) ranks "16Gi" below
 * "4Gi" and "100Gi" below "20Gi", handing large servers the SMALL budget and
 * killing them mid world-gen.
 */
function isHeavy(defaultStorage: string | undefined, defaultMemory: string | undefined): boolean {
  return (
    memoryQuantityToMB(defaultStorage ?? "10Gi") >= 20 * 1024 ||
    memoryQuantityToMB(defaultMemory ?? "2Gi") >= 4 * 1024
  );
}

describe("game server startup budget (isHeavy)", () => {
  test("classifies large memory as heavy", () => {
    // Arrange / Act / Assert
    expect(isHeavy("10Gi", "16Gi")).toBe(true);
    expect(isHeavy("10Gi", "8Gi")).toBe(true);
    expect(isHeavy("10Gi", "4Gi")).toBe(true);
  });

  test("classifies large storage as heavy", () => {
    expect(isHeavy("100Gi", "2Gi")).toBe(true);
    expect(isHeavy("20Gi", "2Gi")).toBe(true);
  });

  test("classifies small servers as light", () => {
    expect(isHeavy("10Gi", "2Gi")).toBe(false);
    expect(isHeavy("5Gi", "1Gi")).toBe(false);
    expect(isHeavy(undefined, undefined)).toBe(false);
  });

  test("regression: lexicographic ordering would misclassify these", () => {
    // "16Gi" < "4Gi" and "100Gi" < "20Gi" as STRINGS — the old bug marked these
    // light. Numeric comparison marks them heavy.
    expect("16Gi" >= "4Gi").toBe(false); // documents the broken string compare
    expect(isHeavy("10Gi", "16Gi")).toBe(true); // correct numeric result
    expect("100Gi" >= "20Gi").toBe(false);
    expect(isHeavy("100Gi", "2Gi")).toBe(true);
  });
});
