import type { z } from "zod";

/**
 * Row-salvage validation: run `schema` over each element of `rows` and keep
 * only the elements that parse. Non-array input yields `[]`.
 *
 * Used by the OpenBao-backed registries (`@/lib/nas/store`,
 * `@/lib/app-accounts/store`) so one malformed row never blanks the whole
 * collection — dropping a bad entry beats throwing away the registry.
 */
export function filterValid<T>(schema: z.ZodType<T>, rows: unknown): T[] {
  if (!Array.isArray(rows)) return [];
  return (rows as unknown[]).flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}
