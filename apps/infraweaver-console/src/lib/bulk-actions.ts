/**
 * Shared runner for "act on every selected row" flows — the
 * `Promise.allSettled` + count + pluralize pattern repeated across the
 * bulk sync / hard-refresh / delete / uninstall handlers.
 */

export interface BulkActionOptions {
  /** Singular noun for messages, e.g. "app". Default "item". */
  noun?: string;
  /** Plural noun override; defaults to `${noun}s`. */
  pluralNoun?: string;
  /** Past-tense verb for the success message, e.g. "Deleted". Default "Completed". */
  verb?: string;
  /** Infinitive verb for the failure message, e.g. "delete" → "2 apps failed to delete". Default "complete". */
  failureVerb?: string;
}

export interface BulkActionResult<R = unknown> {
  ok: number;
  failed: number;
  /** Combined summary — success and failure parts joined with "; ". Empty string when `items` was empty. */
  message: string;
  /** e.g. "Deleted 3 apps" — null when nothing succeeded. */
  successMessage: string | null;
  /** e.g. "2 apps failed to delete" — null when nothing failed. */
  errorMessage: string | null;
  /** Raw settled results, index-aligned with `items`. */
  results: PromiseSettledResult<R>[];
}

/** "3 apps" / "1 app" — count + noun with the trailing-s convention used across the console. */
export function pluralize(count: number, noun: string, pluralNoun?: string): string {
  return `${count} ${count === 1 ? noun : (pluralNoun ?? `${noun}s`)}`;
}

export async function runBulkAction<T, R = unknown>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  opts: BulkActionOptions = {},
): Promise<BulkActionResult<R>> {
  const { noun = "item", pluralNoun, verb = "Completed", failureVerb = "complete" } = opts;

  const results = await Promise.allSettled(items.map((item) => fn(item)));
  const ok = results.filter((result) => result.status === "fulfilled").length;
  const failed = results.length - ok;

  const successMessage = ok > 0 ? `${verb} ${pluralize(ok, noun, pluralNoun)}` : null;
  const errorMessage = failed > 0 ? `${pluralize(failed, noun, pluralNoun)} failed to ${failureVerb}` : null;
  const message = [successMessage, errorMessage].filter(Boolean).join("; ");

  return { ok, failed, message, successMessage, errorMessage, results };
}
