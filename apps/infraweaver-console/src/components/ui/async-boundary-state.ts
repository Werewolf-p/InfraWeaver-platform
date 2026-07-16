/**
 * Async region state selection — PURE (unit-testable). Precedence:
 * error → loading → empty → ready. Loading beats empty so a first load shows a
 * skeleton, not an empty state, even before the caller's data arrives.
 */

export type AsyncState = "error" | "loading" | "empty" | "ready";

export interface AsyncStateInput {
  isLoading: boolean;
  isError: boolean;
  isEmpty?: boolean;
}

export function selectAsyncState({ isLoading, isError, isEmpty }: AsyncStateInput): AsyncState {
  if (isError) return "error";
  if (isLoading) return "loading";
  if (isEmpty) return "empty";
  return "ready";
}
