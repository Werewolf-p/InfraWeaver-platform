import { cn } from "@/lib/utils";

describe("cn utility", () => {
  it("merges class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("handles conditional classes", () => {
    expect(cn("a", false && "b", "c")).toBe("a c");
  });

  it("deduplicates tailwind classes", () => {
    const result = cn("px-2", "px-4");
    expect(result).toBe("px-4");
  });
});
