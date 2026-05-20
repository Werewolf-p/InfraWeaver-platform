import { getPageConfig, mergeRegisteredPages, navItemFromPage } from "@/lib/page-registry";

describe("page registry", () => {
  it("returns page metadata for registered pages", () => {
    const page = getPageConfig("/settings");
    expect(page).toBeDefined();
    expect(page?.pageTitle).toBe("Settings");
    expect(page?.groupId).toBe("settings");
  });

  it("creates nav items from page definitions", () => {
    expect(navItemFromPage("/profile")).toEqual(
      expect.objectContaining({ href: "/profile", label: "My Profile" }),
    );
  });

  it("merges scaffoldable pages into existing nav groups", () => {
    const groups = mergeRegisteredPages([
      {
        id: "settings",
        label: "Settings",
        description: "Preferences",
        icon: (() => null) as never,
        items: [],
      },
    ]);

    expect(groups[0].items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: "/settings" }),
        expect.objectContaining({ href: "/profile" }),
      ]),
    );
  });
});
