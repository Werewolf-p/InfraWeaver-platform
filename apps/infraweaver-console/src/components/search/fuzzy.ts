export interface FuzzyMatch {
  /** Higher is a better match. Only comparable within the same query. */
  score: number;
  /** Indices in the source text that matched query characters (for highlighting). */
  indices: number[];
}

const BOUNDARY = /[\s\-_/.:]/;

/**
 * Lightweight subsequence fuzzy matcher. Returns `null` when `query` is not a
 * subsequence of `text`; otherwise a score that rewards contiguous runs,
 * word-boundary and camelCase starts, and early matches — so typing "wrkld"
 * still ranks "Workloads" and "argocd apps" still finds "ArgoCD Applications".
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  if (!text) return null;

  const lower = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let qi = 0;
  let prevMatch = -2;

  for (let i = 0; i < text.length && qi < q.length; i++) {
    if (lower[i] !== q[qi]) continue;

    let bonus = 1;
    if (i === 0) {
      bonus += 8;
    } else {
      const prevChar = text[i - 1];
      if (BOUNDARY.test(prevChar)) {
        bonus += 6;
      } else if (prevChar === prevChar.toLowerCase() && text[i] !== text[i].toLowerCase()) {
        bonus += 5;
      }
    }
    if (i === prevMatch + 1) bonus += 5;

    score += bonus;
    indices.push(i);
    prevMatch = i;
    qi++;
  }

  if (qi < q.length) return null;

  // Prefer matches that begin earlier in the string.
  score += Math.max(0, 10 - (indices[0] ?? 0));
  return { score, indices };
}

/**
 * Splits `text` into alternating unmatched / matched segments given the matched
 * indices, so a renderer can emphasise the characters that satisfied the query.
 */
export function splitHighlight(
  text: string,
  indices: number[] | undefined,
): Array<{ text: string; match: boolean }> {
  if (!indices || indices.length === 0) return [{ text, match: false }];
  const matched = new Set(indices);
  const segments: Array<{ text: string; match: boolean }> = [];
  let buffer = "";
  let bufferMatch = matched.has(0);

  for (let i = 0; i < text.length; i++) {
    const isMatch = matched.has(i);
    if (isMatch === bufferMatch) {
      buffer += text[i];
    } else {
      if (buffer) segments.push({ text: buffer, match: bufferMatch });
      buffer = text[i];
      bufferMatch = isMatch;
    }
  }
  if (buffer) segments.push({ text: buffer, match: bufferMatch });
  return segments;
}
