/**
 * Shared snippet truncation used by every search engine implementation
 * (cosine, FAISS-accelerated, lexical) so `SearchResult.snippet` is produced
 * identically regardless of which engine served the query.
 */

/** Truncate text to a snippet of approximately `maxWords` words. */
export function makeSnippet(text: string, maxWords = 40): string {
  // Strip the context header (first line before double newline)
  const bodyStart = text.indexOf('\n\n');
  const body = bodyStart >= 0 ? text.slice(bodyStart + 2) : text;
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return body.trim();
  return words.slice(0, maxWords).join(' ') + '...';
}
