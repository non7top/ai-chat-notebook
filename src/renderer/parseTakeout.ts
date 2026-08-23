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

// No \b before the month, and that single character was costing 2104 of 3085
// entries their date. The export's cells run text together with no separator,
// so the date arrives glued to whatever preceded it:
//
//   "keyAug 22, 2026, 10:07:33 AM GMT+07:00Your prompt: gpg"
//
// There is no word boundary between "key" and "Aug" — both are word characters —
// so the pattern simply did not match, and the entry came out undated. The 981
// that did parse were the ones where the date happened to follow a space or a
// tag boundary. Reported as "dates unread" rather than "no date", which is what
// made it findable: the two had been the same blank space in the list.
const TIMESTAMP_RE =
  /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})\s?(AM|PM)\s*(GMT[+-]\d{2}:\d{2})?/;

// Deliberately permissive: it only has to recognise "this is meant to be a
// date" well enough to quote it back, not to parse it.
const LOOSE_TIMESTAMP_RE = /[A-Za-z]{3,}\s+\d{1,2},?\s+(19|20)\d{2}[^<\n]{0,40}/;

/**
 * How many submissions a cell's text holds.
 *
 * A Takeout submission carries exactly one timestamp, so this is what separates
 * one long conversation from several merged into a single cell — the question a
 * 190-turn entry against a median of 2 raises and nothing else can answer.
 *
 * A fresh regex per call, deliberately. A module-level global one keeps
 * lastIndex between calls, so the same input would count differently depending
 * on what was counted before it.
 */
export function countTimestamps(text: string): number {
  return (text.match(new RegExp(TIMESTAMP_RE.source, 'g')) ?? []).length;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The labels Google uses to delimit turns inside an entry. */
/**
 * A cell's fingerprint: a cheap hash of the markup Google wrote for it.
 *
 * Needed because 1059 records in a real export carry no mstk token, and they
 * still have to be told apart — including the wholly empty ones whose only
 * distinguishing feature is a date. Measured on that export: the timestamp alone
 * collides on 6 records, so 6 would be lost on every import; the timestamp
 * together with this hash collides on none of the 3085.
 *
 * The RAW markup, deliberately, not the parsed text and not a sample of it. A
 * fingerprint taken from parsed content moves whenever the parser changes — which
 * has happened twice here — and renames every record with it, so the next import
 * duplicates the archive instead of updating it. What Google wrote does not move.
 *
 * Not cryptographic and does not need to be: it distinguishes a few thousand
 * records that already differ. FNV-1a over two lanes, so the result behaves like
 * a 64-bit value without needing BigInt in the renderer.
 */
export function fingerprintOf(markup: string): string {
  const text = markup.replace(/\s+/g, ' ').trim();
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = (a ^ c) >>> 0;
    a = (a * 0x01000193) >>> 0;
    b = (b + c) >>> 0;
    b = (b * 0x85ebca6b) >>> 0;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * The opening exchange's markup: up to the first two labelled paragraphs.
 *
 * Deliberately the paragraphs Google labelled rather than the turns this file
 * splits out, so the value does not shift when the splitter is corrected. Two
 * records with the same opening and different endings are the case worth
 * spotting — one thread continued in a copy — and it is a candidate to review,
 * never an identity.
 */
function openingMarkupOf(bodyCell: Element | null | undefined): string {
  if (!bodyCell) return '';
  const parts: string[] = [];
  for (const child of Array.from(bodyCell.children)) {
    const lead = child.tagName === 'P' ? child.firstElementChild : null;
    if (lead?.tagName !== 'STRONG') continue;
    const label = clean(lead.textContent);
    if (!USER_LABEL.test(label) && !AI_LABEL.test(label)) continue;
    parts.push(child.outerHTML);
    if (parts.length === 2) break;
  }
  return parts.join('');
}

const LENS_ACTIVITY = /searched with google lens/i;

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
  /**
   * The link's mstk token — Google's own identifier for this record.
   *
   * Measured across a real export: 2026 records carry one and all 2026 are
   * distinct, so it names a cell exactly. This is what the export was thought
   * not to have, and it is worth more than a content hash for one specific
   * reason: a hash of the parsed content changes whenever the parser changes, so
   * fixing a parsing bug silently renames every entry and a re-import
   * duplicates the lot instead of updating it. This does not move.
   *
   * Null for records with no link — Lens searches and the blank ones — which
   * still need the content-derived fallback.
   */
  entryId: string | null;
  /**
   * Three fingerprints at three scopes, because one cannot do both jobs.
   *
   * long  — the whole cell's markup. Exact identity: unique across all 3085
   *         records of a real export when paired with the timestamp, where the
   *         timestamp alone loses six.
   * short — the opening exchange only, first prompt and first response. This is
   *         what finds a thread that Google split and continued in a copy: the
   *         copy shares its opening and diverges after it, so `long` sees two
   *         unrelated records and `short` sees the relationship.
   * empty — the timestamp and the image filenames, which for a Lens or blank
   *         record is everything there is. It is the only handle those have, and
   *         they must still be told apart from each other.
   *
   * All three are taken from what Google wrote, never from parsed text: a
   * fingerprint over parsed content moves whenever the parser changes — twice so
   * far — and renames every record, so the next import duplicates the archive
   * rather than updating it.
   */
  fingerprints: { long: string; short: string; empty: string };
  /** Local image file names, gathered across the whole entry. */
  images: string[];
  /** The conversation, split on Google's own turn labels. */
  turns: TakeoutTurn[];
  /** Product label, e.g. "AI Mode" — an export can mix products. */
  product: string;
  /**
   * What kind of activity this cell records.
   *
   * The folder holds more than conversations. "Searched with Google Lens"
   * entries carry a date and sometimes an image, but no prompt and no response —
   * Google did not save either. They were being counted as entries with no
   * prompt, which is true and useless: it reads as data loss when it is a
   * different kind of record.
   *
   * 'conversation' — has labelled turns.
   * 'lens'         — a Lens search: no prompt, no response, maybe an image.
   * 'other'        — dated, but nothing recognisable in it.
   */
  activity: 'conversation' | 'lens' | 'other';
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
  /**
   * An independent count of records, from the product-title paragraph rather
   * than the container.
   *
   * Takeout writes exactly one p.mdl-typography--title per activity, so this and
   * entryCount are two ways of counting the same thing and must agree. They are
   * measured separately on purpose: when the cell count looked three times too
   * large, nothing in the app could say whether the container was wrong or the
   * expectation was, and it took counting titles by hand to settle it. A
   * disagreement here means div.outer-cell is no longer one-per-record and every
   * figure derived from it is measuring something else.
   */
  titleCount: number;
  /**
   * Of those titles, how many say "AI Mode".
   *
   * Reported beside the total because a text search cannot settle this: the
   * class appears on other products' records too, an attribute can be split
   * across lines, and some tools count matching LINES rather than matches — so
   * two searches of the same file gave 2088 and 3085, which cannot both be
   * counts of the same thing since one string contains the other. Parsed
   * figures from one pass are comparable; grep counts from two passes are not.
   */
  aiModeTitleCount: number;
  /**
   * Entries whose cell contains more than one timestamp.
   *
   * A submission carries exactly one, so a cell with several holds several
   * submissions — and the parser records only the FIRST date and the FIRST
   * query while gluing every turn in the cell together. That is the other
   * explanation for a 190-turn entry against a median of 2, the first being a
   * genuinely long conversation, and nothing else here can tell them apart.
   */
  multiStampEntries: number;
  /** The most timestamps seen in a single cell. 1 means each cell is one submission. */
  maxStamps: number;
  /**
   * The entry with the most turns, described structurally. Turn count alone
   * cannot say whether it is one long conversation or several run together;
   * the number of timestamps and links inside it can.
   */
  largestEntry: { turns: number; stamps: number; links: number };
  /**
   * Cells grouped by their shape — how many timestamps, search links and turns
   * each holds — commonest first.
   *
   * The decisive diagnostic for a cell count that does not match the number of
   * conversations. A real entry has exactly one timestamp, one search link and
   * at least one turn. If most cells are missing one of those, they are not
   * entries: they are fragments of one, and the container being counted is the
   * wrong element. Ratios alone cannot say which — 3085 cells against a file
   * holding about 1000 entries could be three cells per entry or one entry in
   * three pieces — but the shapes can.
   */
  cellShapes: { shape: string; count: number }[];
  /**
   * Cells by what kind of record they are. The folder is not all conversations:
   * "Searched with Google Lens" records carry a date and sometimes an image but
   * no prompt and no response, and counting those as prompt-less entries makes a
   * different kind of record look like a loss.
   */
  activityCounts: { conversation: number; lens: number; other: number };
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

/**
 * Exported for scripts/check-dates.ts. The DOM traversal around it needs a
 * browser DOMParser, but this is where the pattern lives and where the bugs
 * have been — testing it directly is what makes it testable at all, without
 * pulling in a DOM implementation to reach one regular expression.
 */
export function parseTimestamp(text: string): { iso: string | null; raw: string | null } {
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
/**
 * Exported for scripts/check-turns.ts. The blocks an answer is made of are the
 * substance of this archive, and they were being dropped silently — a check
 * against the real markup shape is the only thing that catches that.
 */
export function turnsFrom(cell: Element): TakeoutTurn[] {
  const turns: TakeoutTurn[] = [];
  // Every element child in document order, not just the paragraphs.
  //
  // This walked querySelectorAll('p') and therefore kept only the prose. An
  // answer's other blocks are SIBLINGS of those paragraphs, not descendants, so
  // they were never visited: measured against one real export, that silently
  // discarded 3032 code blocks, 16990 headings, 51979 list items, 608 tables and
  // 805 blockquotes. In an archive of technical questions the code block is
  // usually the answer, so the part being dropped was the part worth keeping.
  //
  // Only element children of the cell are considered. Descending would visit a
  // <p> inside an <li> twice — once as part of the list and once on its own.
  for (const node of Array.from(cell.children)) {
    // A label is a <strong> at the very start of a paragraph. Checked as the
    // FIRST element child rather than anywhere in the node, because answers use
    // <strong> freely for emphasis and a bolded phrase mid-sentence must not
    // look like the start of a new turn.
    const leading = node.tagName === 'P' ? node.firstElementChild : null;
    const label = leading?.tagName === 'STRONG' ? clean(leading.textContent) : '';
    const isUser = USER_LABEL.test(label);
    const isAi = AI_LABEL.test(label);

    if (isUser || isAi) {
      // Remove only the label element, keeping everything else — including the
      // further <strong> emphasis Google uses inside answers.
      const copy = node.cloneNode(true) as Element;
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

    // Anything else continues the turn in progress: a paragraph, a code block, a
    // heading, a list, a table. Before the first label there is no turn to
    // continue — that content is the record's own header text, e.g.
    // "Searched for …" and the timestamp.
    if (turns.length === 0) continue;
    const text = clean(node.textContent);
    const html = node.outerHTML.trim();
    if (!text && !html) continue;
    const last = turns[turns.length - 1];
    // Kept as its own block so the answer keeps its shape instead of collapsing
    // into one run of text — and so a <pre> stays a <pre> rather than becoming a
    // paragraph of code with its newlines squeezed out.
    if (text) last.text += `\n\n${text}`;
    last.html += html;
  }
  return turns.filter((t) => t.text.length > 0 || t.html.length > 0);
}

/** Exported for scripts/probe-takeout.ts, so the probe measures shipped code. */
export function entryFrom(cell: Element): TakeoutEntry {
  const product = clean(cell.querySelector('.header-cell')?.textContent);
  // The first content-cell is the conversation; later ones are the image and
  // the "Why is this here?" caption.
  const bodyCell = cell.querySelector('.content-cell');
  const bodyText = clean(bodyCell?.textContent);
  const { iso, raw } = parseTimestamp(bodyText);

  const link = bodyCell?.querySelector('a[href]')?.getAttribute('href') ?? null;
  let query = '';
  let entryId: string | null = null;
  if (link) {
    try {
      const parsed = new URL(link, 'https://www.google.com');
      query = parsed.searchParams.get('q') ?? '';
      entryId = parsed.searchParams.get('mstk');
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
    entryId,
    fingerprints: {
      long: fingerprintOf(cell.innerHTML),
      // The first pair of labelled paragraphs as Google wrote them. Taken from
      // markup rather than the split turns so it survives a change to the
      // splitter.
      short: fingerprintOf(openingMarkupOf(bodyCell)),
      empty: fingerprintOf(
        `${raw ?? ''}|${[...new Set(images)].sort().join(',')}`,
      ),
    },
    images: [...new Set(images)],
    turns: bodyCell ? turnsFrom(bodyCell) : [],
    product,
    activity: activityOf(bodyText, bodyCell ? turnsFrom(bodyCell) : []),
  };
}

/**
 * What kind of record a cell is.
 *
 * Turns decide it first: anything with a labelled prompt or response is a
 * conversation whatever else the cell says. A Lens search has neither — Google
 * saved the date, sometimes the image, and neither the prompt nor the response —
 * so it was being reported as an entry with no prompt, which reads as data lost
 * rather than as a different kind of record entirely.
 */
function activityOf(bodyText: string, turns: TakeoutTurn[]): TakeoutEntry['activity'] {
  if (turns.length > 0) return 'conversation';
  if (LENS_ACTIVITY.test(bodyText)) return 'lens';
  return 'other';
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
  const titleNodes = Array.from(doc.querySelectorAll('p.mdl-typography--title'));
  const titles = titleNodes.length;
  const aiModeTitles = titleNodes.filter((node) => /ai mode/i.test(node.textContent ?? '')).length;

  // How many submissions each cell actually holds. Counted from timestamps
  // because a submission has exactly one, and from search links because it also
  // has exactly one — two independent readings of the same question.
  const stampsIn = (cell: Element): number => countTimestamps(clean(cell.textContent));
  const linksIn = (cell: Element): number =>
    cell.querySelectorAll('a[href*="q="]').length;

  const perCell = cells.map((cell, index) => ({
    stamps: stampsIn(cell),
    links: linksIn(cell),
    turns: all[index]?.turns.length ?? 0,
  }));
  const biggest = perCell.reduce(
    (best, one) => (one.turns > best.turns ? one : best),
    { turns: 0, stamps: 0, links: 0 },
  );

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
      titleCount: titles,
      aiModeTitleCount: aiModeTitles,
      multiStampEntries: perCell.filter((c) => c.stamps > 1).length,
      maxStamps: perCell.reduce((most, c) => Math.max(most, c.stamps), 0),
      largestEntry: biggest,
      activityCounts: {
        conversation: entries.filter((e) => e.activity === 'conversation').length,
        lens: entries.filter((e) => e.activity === 'lens').length,
        other: entries.filter((e) => e.activity === 'other').length,
      },
      cellShapes: (() => {
        const tally = new Map<string, number>();
        for (const cell of perCell) {
          const shape = `${cell.stamps} date${cell.stamps === 1 ? '' : 's'}, ${cell.links} link${
            cell.links === 1 ? '' : 's'
          }, ${cell.turns} turn${cell.turns === 1 ? '' : 's'}`;
          tally.set(shape, (tally.get(shape) ?? 0) + 1);
        }
        return [...tally.entries()]
          .map(([shape, count]) => ({ shape, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 8);
      })(),
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
