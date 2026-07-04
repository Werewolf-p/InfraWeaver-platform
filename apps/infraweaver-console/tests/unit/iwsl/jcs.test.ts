/** @jest-environment node */
import { canonicalize } from "@/lib/iwsl/jcs";

describe("IWSL JCS canonicalization", () => {
  test("sorts object keys by code unit and preserves array order", () => {
    expect(canonicalize({ b: 2, a: [1, "x", null, true], c: { z: 1, y: "é" } })).toBe(
      '{"a":[1,"x",null,true],"b":2,"c":{"y":"é","z":1}}',
    );
  });

  test("empty containers", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
  });

  test("escapes strings like JSON.stringify (JCS minimal escaping)", () => {
    expect(canonicalize({ s: 'a"b\\c\n\té€' })).toBe('{"s":"a\\"b\\\\c\\n\\té€"}');
  });

  test("rejects floats — integers only on the wire", () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow("safe integers");
    expect(() => canonicalize(Number.NaN)).toThrow("safe integers");
    expect(() => canonicalize(Number.MAX_SAFE_INTEGER + 2)).toThrow("safe integers");
  });

  test("rejects non-ASCII object keys", () => {
    expect(() => canonicalize({ kéy: 1 })).toThrow("ASCII");
  });

  test("skips undefined properties like JSON.stringify", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
