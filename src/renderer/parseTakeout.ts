/**
 * Parses a Takeout "My Activity > AI Mode" export.
 *
 * Written against the real markup, which is Google's standard Takeout shape:
 *
 *   div.outer-cell
 *     div.header-cell            → product name ("AI Mode")
 *     div.content-cell           → the conversation:
 *        a[href]                   ?udm=50&mstk=...&q=<opening query>
 *        "Aug 21, 2026, 6:14:28 AM GMT+07:00"
 *        p > strong "Your prompt:"       … the user's turn
 *        p > strong "Search's response:" … the answer
 *        p                              … continuation of the previous turn
 *     div.content-cell...text-right  → img.image-preview   (a SIBLING cell)
 *     div.content-cell...caption     → "Products:", "Why is this here?"
 *
 * Three things an earlier version got wrong by inferring the shape instead of
 * looking at it: the entry container (it took the innermost element holding a
 * timestamp, which sits inside the body cell and truncated the conversation),
 * the images (they live in a sibling cell, so scanning the body found none), and
 * the turns (they are cleanly labelled, not an undifferentiated blob).
 *
 * Runs in the renderer so DOMParser can do the work: a real parser, no new
 * dependency, and unlike loading the file in a window it runs no scripts and
 * fetches nothing.
 */

const TIMESTAMP_RE =
  /\b([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})\s?(AM|PM)\s*(GMT[+-]\d{2}:\d{2})?/;

// Deliberately permissive: it only has to recognise "this is meant to be a
// date" well enough to quote it back, not to parse it.
const LOOSE_TIMESTAMP_RE = /[A-Za-z]{3,}\s+\d{1,2},?\s+(19|20)\d{2}[^<\n]{0,40}/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The labels Google uses to delimit turns inside an entry. */
const USER_LABEL = /^your prompt:?$/i;
const AI_LABEL = /^(search's response|response):?$/i;

export interface TakeoutTurn {
  role: 'user' | 'ai';
  text: string;
  /**
   * The turn's own markup, label removed. Google emphasises words inside
   * answers with <strong> and includes links, and flattening to text threw all
   * of that away — the reader then showed a wall of undifferentiated prose.
   */
  html: string;
}

export interface TakeoutEntry {
  /** From the link's q= parameter: the conversation's opening query. */
  query: string;
  /** ISO 8601 keeping its original offset — normalising to UTC shifted days. */
  timestamp: string | null;
  timestampText: string | null;
  /** Provenance only. Following it re-runs the prompt, so it is never a link. */
  href: string | null;
  /** Local image file names, gathered across the whole entry. */
  images: string[];
  /** The conversation, split on Google's own turn labels. */
  turns: TakeoutTurn[];
  /** Product label, e.g. "AI Mode" — an export can mix products. */
  product: string;
}

export interface TakeoutScan {
  entryCount: number;
  aiModeEntries: number;
  withTimestamp: number;
  withQuery: number;
  withImages: number;
  imageRefsTotal: number;
  containerDescription: string;
  /** Turns per entry: >2 proves entries hold whole conversations, not prompts. */
  turnCounts: { min: number; median: number; max: number; total: number };
  multiTurnEntries: number;
  /**
   * Cells sitting inside another cell. Must be zero: a nested match means the
   * same conversation is counted more than once, and every downstream number
   * inherits the error.
   */
  nestedCells: number;
  /** Undated entries carrying no date-like text at all — a gap in the export. */
  noDateText: number;
  /** Undated entries that DO carry date text — a gap in the parser instead. */
  unparsedDateText: number;
  /** Up to five of those, verbatim, so the pattern can be fixed against them. */
  unparsedDateSamples: string[];
  /**
   * Cells with no query, no turns and no images. Not conversations by any
   * measure, so counting them as entries inflates every total.
   */
  emptyCells: number;
}

function parseTimestamp(text: string): { iso: string | null; raw: string | null } {
  const m = TIMESTAMP_RE.exec(text);
  if (!m) {
    // Keep whatever date-like text was there. Without this, a date the parser
    // cannot read is indistinguishable from an entry that never had one, and
    // both show up as a row with no date — so a parse failure looks like
    // missing data in the export instead of a bug here. The strict pattern
    // above insists on AM/PM and English month names, neither of which every
    // export is guaranteed to use.
    const loose = LOOSE_TIMESTAMP_RE.exec(text);
    return { iso: null, raw: loose ? loose[0].trim() : null };
  }
  const [raw, mon, day, year, hourRaw, minute, second, meridiem, zone] = m;
  const monthIndex = MONTHS.indexOf(mon);
  if (monthIndex < 0) return { iso: null, raw };
  let hour = Number(hourRaw) % 12;
  if (meridiem === 'PM') hour += 12;
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = zone ? zone.replace('GMT', '') : 'Z';
  const iso = `${year}-${pad(monthIndex + 1)}-${pad(Number(day))}T${pad(hour)}:${minute}:${second}${offset}`;
  return { iso: Number.isNaN(new Date(iso).getTime()) ? null : iso, raw };
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Splits a conversation cell into turns.
 *
 * Each labelled paragraph starts a turn; an unlabelled one continues the
 * previous. Dropping the continuations would silently truncate answers, which
 * in this export are often several paragraphs long.
 */
function turnsFrom(cell: Element): TakeoutTurn[] {
  const turns: TakeoutTurn[] = [];
  for (const p of Array.from(cell.querySelectorAll('p'))) {
    const label = clean(p.querySelector('strong')?.textContent);
    const isUser = USER_LABEL.test(label);
    const isAi = AI_LABEL.test(label);

    if (isUser || isAi) {
      // Remove only the label element, keeping everything else — including the
      // further <strong> emphasis Google uses inside answers.
      const copy = p.cloneNode(true) as Element;
      copy.querySelector('strong')?.remove();
      // A leading <br> is left behind where the label was.
      while (copy.firstChild && copy.firstChild.nodeName === 'BR') copy.firstChild.remove();
      turns.push({
        role: isUser ? 'user' : 'ai',
        text: clean(copy.textContent),
        html: copy.innerHTML.trim(),
      });
      continue;
    }

    const text = clean(p.textContent);
    if (!text) continue;
    if (turns.length > 0) {
      const last = turns[turns.length - 1];
      last.text += `\n\n${text}`;
      // Continuations are appended as their own paragraph so the answer keeps
      // its shape instead of collapsing into one block.
      last.html += `<p>${p.innerHTML.trim()}</p>`;
    }
  }
  return turns.filter((t) => t.text.length > 0);
}

function entryFrom(cell: Element): TakeoutEntry {
  const product = clean(cell.querySelector('.header-cell')?.textContent);
  // The first content-cell is the conversation; later ones are the image and
  // the "Why is this here?" caption.
  const bodyCell = cell.querySelector('.content-cell');
  const bodyText = clean(bodyCell?.textContent);
  const { iso, raw } = parseTimestamp(bodyText);

  const link = bodyCell?.querySelector('a[href]')?.getAttribute('href') ?? null;
  let query = '';
  if (link) {
    try {
      query = new URL(link, 'https://www.google.com').searchParams.get('q') ?? '';
    } catch {
      query = '';
    }
  }

  // Across the WHOLE entry, not the body cell: the image sits in a sibling
  // cell, which is why an earlier version found none.
  const images = [
    ...Array.from(cell.querySelectorAll('img[src]')).map((n) => n.getAttribute('src') || ''),
    ...Array.from(cell.querySelectorAll('a[href]')).map((n) => n.getAttribute('href') || ''),
  ]
    .filter((ref) => ref && !/^https?:|^data:/i.test(ref))
    .filter((ref) => /\.(jpe?g|png|webp|gif)$/i.test(ref.split('?')[0]))
    .map((ref) => decodeURIComponent(ref.split('?')[0].split('/').pop() || ref));

  return {
    query,
    timestamp: iso,
    timestampText: raw,
    href: link,
    images: [...new Set(images)],
    turns: bodyCell ? turnsFrom(bodyCell) : [],
    product,
  };
}

export function parseTakeoutHtml(html: string): { entries: TakeoutEntry[]; scan: TakeoutScan } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // The documented Takeout container. Falling back to a heuristic would risk
  // silently repeating the truncation bug, so an unexpected layout should show
  // as zero entries and be dealt with deliberately.
  const cells = Array.from(doc.querySelectorAll('div.outer-cell'));
  const all = cells.map(entryFrom);
  const entries = all.filter((e) => /ai mode/i.test(e.product));

  // A cell inside another cell would be counted twice, and would explain a
  // total that grew without the history growing. Checked rather than assumed:
  // the entry count tripled between two exports and only the previous total's
  // worth of entries had dates, which is the shape over-counting makes.
  const nested = cells.filter((cell) => cell.parentElement?.closest('div.outer-cell')).length;

  const undated = entries.filter((e) => !e.timestamp);
  const unparsed = undated.filter((e) => e.timestampText);

  const counts = entries.map((e) => e.turns.length).sort((a, b) => a - b);
  return {
    entries,
    scan: {
      entryCount: all.length,
      aiModeEntries: entries.length,
      withTimestamp: entries.filter((e) => e.timestamp).length,
      withQuery: entries.filter((e) => e.query).length,
      withImages: entries.filter((e) => e.images.length > 0).length,
      imageRefsTotal: entries.reduce((n, e) => n + e.images.length, 0),
      containerDescription: `div.outer-cell x${cells.length}`,
      turnCounts: {
        min: counts[0] ?? 0,
        median: counts[Math.floor(counts.length / 2)] ?? 0,
        max: counts[counts.length - 1] ?? 0,
        total: counts.reduce((a, b) => a + b, 0),
      },
      multiTurnEntries: entries.filter((e) => e.turns.length > 2).length,
      nestedCells: nested,
      noDateText: undated.length - unparsed.length,
      unparsedDateText: unparsed.length,
      // Dates only — no conversation text. The owner has asked that the
      // contents not be read, and a date is not content.
      unparsedDateSamples: unparsed.slice(0, 5).map((e) => e.timestampText ?? ''),
      emptyCells: all.filter((e) => !e.query && e.turns.length === 0 && e.images.length === 0)
        .length,
    },
  };
}
