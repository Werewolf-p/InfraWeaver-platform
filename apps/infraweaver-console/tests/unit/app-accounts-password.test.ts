import { generateAppPassword } from "@/lib/app-accounts/password";

describe("generateAppPassword", () => {
  it("produces a password of the requested length", () => {
    expect(generateAppPassword(20)).toHaveLength(20);
    expect(generateAppPassword(32)).toHaveLength(32);
  });

  it("refuses to mint a weak (short) credential", () => {
    expect(() => generateAppPassword(8)).toThrow(/>= 16/);
  });

  it("uses only the unambiguous alphabet (no 0/O/1/l/I)", () => {
    const password = generateAppPassword(64);
    expect(password).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]+$/);
    expect(password).not.toMatch(/[0O1lI]/);
  });

  it("is effectively unique across calls (CSPRNG, not a fixed value)", () => {
    const samples = new Set(Array.from({ length: 200 }, () => generateAppPassword(20)));
    expect(samples.size).toBe(200);
  });

  it("draws across the whole alphabet, not a biased sub-range", () => {
    // Rejection sampling should exercise most of the 54-symbol alphabet over a
    // large sample; a modulo-skewed generator would starve the tail symbols.
    const chars = new Set(generateAppPassword(4000).split(""));
    expect(chars.size).toBeGreaterThan(45);
  });
});
