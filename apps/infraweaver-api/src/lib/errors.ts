/** Extract a human-readable message from an unknown thrown value. */
export function errMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}
