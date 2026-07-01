import { stripMinecraftColors } from "@/addons/gamehub/components/server-detail/utils";

describe("stripMinecraftColors", () => {
  test("strips color and style codes from real /help output", () => {
    // Arrange
    const line = "§e--------- §fHelp: §rIndex (1/23) §e-----------";

    // Act
    const cleaned = stripMinecraftColors(line);

    // Assert
    expect(cleaned).toBe("--------- Help: Index (1/23) -----------");
  });

  test("strips stacked codes (§7§6...) and leaves the text", () => {
    expect(stripMinecraftColors("§7§6Aliases: §fLists command aliases")).toBe(
      "Aliases: Lists command aliases",
    );
  });

  test("removes each §<char> pair in the §x hex color sequence", () => {
    // §x§1§2§3§4§5§6 is the Java 1.16+ hex-color encoding.
    expect(stripMinecraftColors("§x§1§2§3§4§5§6Rainbow")).toBe("Rainbow");
  });

  test("returns lines without codes unchanged", () => {
    const line = "There are 2 of a max of 20 players online: alice, bob";
    expect(stripMinecraftColors(line)).toBe(line);
  });

  test("handles empty string", () => {
    expect(stripMinecraftColors("")).toBe("");
  });
});
