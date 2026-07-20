/** @jest-environment node */
// Client-side action-form validators for the Manage console. These MIRROR the
// server zod schemas in lib/manage/actions.ts; the server re-validates, so these
// only gate the UI. Kept in lock-step with the server's charset/length rules.
import {
  confirmationMatches,
  isPositiveIntId,
  isValidEmail,
  isValidLogin,
  isValidOptionValue,
  isValidPassword,
  isValidSlug,
  parseId,
} from "@/addons/wordpress-manager/components/demo/manage/form-validation";

describe("isValidSlug", () => {
  test("accepts lowercase alphanumeric + dashes", () => {
    expect(isValidSlug("wp-super-cache")).toBe(true);
    expect(isValidSlug("woocommerce")).toBe(true);
  });
  test("rejects uppercase, spaces, empty and over-long", () => {
    expect(isValidSlug("WP-Cache")).toBe(false);
    expect(isValidSlug("has space")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("a".repeat(65))).toBe(false);
  });
});

describe("isValidLogin", () => {
  test("accepts alphanumeric-bookended logins with inner dots/dashes", () => {
    expect(isValidLogin("john.doe")).toBe(true);
    expect(isValidLogin("a")).toBe(true);
    expect(isValidLogin("Editor_01")).toBe(true);
  });
  test("rejects leading/trailing punctuation and over-long", () => {
    expect(isValidLogin(".john")).toBe(false);
    expect(isValidLogin("john-")).toBe(false);
    expect(isValidLogin("a".repeat(61))).toBe(false);
    expect(isValidLogin("")).toBe(false);
  });
});

describe("isValidEmail", () => {
  test("accepts a standard address", () => {
    expect(isValidEmail("owner@example.com")).toBe(true);
  });
  test("rejects malformed and over-long", () => {
    expect(isValidEmail("owner@")).toBe(false);
    expect(isValidEmail("no-at.example.com")).toBe(false);
    expect(isValidEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });
});

describe("isValidPassword", () => {
  test("accepts 8..200 with no line breaks", () => {
    expect(isValidPassword("hunter2!")).toBe(true);
  });
  test("rejects short, over-long and newline-bearing", () => {
    expect(isValidPassword("short")).toBe(false);
    expect(isValidPassword("a".repeat(201))).toBe(false);
    expect(isValidPassword("line\nbreak")).toBe(false);
  });
});

describe("isValidOptionValue", () => {
  test("accepts up to 500 chars without line breaks (empty allowed)", () => {
    expect(isValidOptionValue("My Site Title")).toBe(true);
    expect(isValidOptionValue("")).toBe(true);
  });
  test("rejects over-long and newline-bearing", () => {
    expect(isValidOptionValue("a".repeat(501))).toBe(false);
    expect(isValidOptionValue("two\nlines")).toBe(false);
  });
});

describe("isPositiveIntId / parseId", () => {
  test("isPositiveIntId only accepts positive integers", () => {
    expect(isPositiveIntId(1)).toBe(true);
    expect(isPositiveIntId(0)).toBe(false);
    expect(isPositiveIntId(-5)).toBe(false);
    expect(isPositiveIntId(1.5)).toBe(false);
  });
  test("parseId parses digit strings and rejects the rest", () => {
    expect(parseId("42")).toBe(42);
    expect(parseId("  7 ")).toBe(7);
    expect(parseId("0")).toBeNull();
    expect(parseId("12a")).toBeNull();
    expect(parseId("")).toBeNull();
  });
});

describe("confirmationMatches", () => {
  test("matches an exact (trimmed) echo of the phrase", () => {
    expect(confirmationMatches("mysite", "mysite")).toBe(true);
    expect(confirmationMatches("  mysite  ", "mysite")).toBe(true);
  });
  test("rejects mismatches, case differences and empty required", () => {
    expect(confirmationMatches("MySite", "mysite")).toBe(false);
    expect(confirmationMatches("other", "mysite")).toBe(false);
    expect(confirmationMatches("", "")).toBe(false);
  });
});
