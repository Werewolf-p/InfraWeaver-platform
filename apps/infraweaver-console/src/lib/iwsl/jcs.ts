// RFC 8785 (JCS) canonicalization, restricted to the IWSL wire profile:
//  - numbers MUST be safe integers (no floats — §6.1; ES number formatting for
//    integers is plain digits, trivially mirrored in PHP)
//  - object keys MUST be ASCII (UTF-16 code-unit sort == byte sort, so the PHP
//    canonicalizer sorts identically without a UTF-16 transcode)
// String escaping via JSON.stringify matches JCS exactly (minimal ES escaping).

export function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error("IWSL JCS: only safe integers are allowed on the wire");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      return Array.isArray(value)
        ? canonicalizeArray(value)
        : canonicalizeObject(value as Record<string, unknown>);
    default:
      throw new Error(`IWSL JCS: unsupported value type "${typeof value}"`);
  }
}

function canonicalizeArray(values: readonly unknown[]): string {
  return `[${values.map(canonicalize).join(",")}]`;
}

function canonicalizeObject(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  for (const [key] of entries) {
    if (!/^[\x00-\x7f]*$/.test(key)) {
      throw new Error("IWSL JCS: object keys must be ASCII");
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${parts.join(",")}}`;
}
