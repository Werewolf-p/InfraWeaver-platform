import { lowestTierGranting } from "@/addons/wordpress-manager/lib/tiers";

describe("lowestTierGranting", () => {
  test("returns the cheapest tier that grants a Pro-and-up feature", () => {
    // image_optimization unlocks at Pro (care_pro), inherited by Ultimate.
    const tier = lowestTierGranting("image_optimization");
    expect(tier?.id).toBe("care_pro");
  });

  test("returns Ultimate for an Ultimate-only feature", () => {
    // white_label is granted only by care_ultimate.
    const tier = lowestTierGranting("white_label");
    expect(tier?.id).toBe("care_ultimate");
  });

  test("returns the flagship media_folders at its lowest granting tier (Pro)", () => {
    expect(lowestTierGranting("media_folders")?.id).toBe("care_pro");
  });
});
