/**
 * Title filtering for find-as-you-type.
 *
 * Matches on every whitespace-separated term independently, in any order, which
 * is what makes it usable against this archive: the titles are opening prompts,
 * so "sprite gen" has to find "how do sprites get generated" — a plain
 * substring search would not, and typing a prompt back word-perfect defeats the
 * point of searching for it.
 *
 * Separated from the component so the matching rule can be checked on its own;
 * it is easy to get subtly wrong and hard to see wrong through a UI.
 */

/**
 * Case- and accent-insensitive, so "café" is found by typing "cafe".
 *
 * Returns the folded text alongside a map from each folded character back to
 * the character it came from in the original. Highlighting needs that map:
 * folding is not length-preserving — stripping a combining mark removes a
 * character — so a position found in the folded string cannot be used to slice
 * the original directly. Without it, matching and highlighting disagreed:
 * typing "cafe" matched "le café noir" and then highlighted nothing in it.
 */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const decomposed = text[i]
      .normalize('NFD')
      // Written as escapes rather than literal combining marks, which are
      // invisible in an editor and survive a copy-paste only by luck.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    for (const char of decomposed) {
      folded += char;
      origin.push(i);
    }
  }
  return { folded, origin };
}

export function termsOf(query: string): string[] {
  return fold(query).folded.split(/\s+/).filter(Boolean);
}

export function matchesTitle(title: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const { folded } = fold(title);
  return terms.every((term) => folded.includes(term));
}

export interface Segment {
  text: string;
  hit: boolean;
  /** Offset in the original title — a stable React key, unlike an array index. */
  at: number;
}

/**
 * Splits a title into matched and unmatched runs for highlighting.
 *
 * Searches the folded text and maps the hits back through to the original, so
 * the title is displayed exactly as stored — accents and capitals intact — and
 * anything matchesTitle accepted is actually marked.
 */
export function highlight(title: string, terms: string[]): Segment[] {
  if (terms.length === 0) return [{ text: title, hit: false, at: 0 }];
  const { folded, origin } = fold(title);
  const hits: [number, number][] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at === -1) break;
      // Back to original offsets: the first folded character's source, and one
      // past the last one's, so a marked run covers the accents it folded away.
      hits.push([origin[at], origin[at + term.length - 1] + 1]);
      from = at + term.length;
    }
  }
  if (hits.length === 0) return [{ text: title, hit: false, at: 0 }];

  // Merged because terms overlap constantly here — "sprite" and "sprites" both
  // match the same run, and emitting both would double the text.
  hits.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [hits[0]];
  for (const [start, end] of hits.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of merged) {
    if (start > at) out.push({ text: title.slice(at, start), hit: false, at });
    out.push({ text: title.slice(start, end), hit: true, at: start });
    at = end;
  }
  if (at < title.length) out.push({ text: title.slice(at), hit: false, at });
  return out;
}
