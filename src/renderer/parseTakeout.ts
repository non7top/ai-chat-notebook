/**
 * Parses a Takeout "My Activity > AI Mode" export.
 *
 * Runs in the renderer on purpose: DOMParser gives a real HTML parser without
 * adding a dependency, and unlike loading the file into a window it executes no
 * scripts and fetches no resources. The main process has no DOM, and
 * regex-parsing 30MB of Google's markup would be guesswork.
 *
 * Deliberately structure-discovering rather than hardcoded to Takeout's current
 * class names. It looks for the shapes that must be present — a full timestamp,
 * a udm=50 link — and reports what it matched, so a layout change surfaces as a
 * count that looks wrong instead of a silent empty import.
 */

/** "Aug 19, 2026, 3:09:33 AM GMT+07:00" — seconds and zone, unlike the live page. */
const TIMESTAMP_RE =
  /\b([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})\s?(AM|PM)\s*(GMT[+-]\d{2}:\d{2})?/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface TakeoutEntry {
  /** From the link's q= parameter — cleaner than scraping the "Searched for" text. */
  query: string;
  /** ISO 8601, or null when the stamp could not be parsed. */
  timestamp: string | null;
  /** Raw stamp text, kept so a parse failure is diagnosable rather than lost. */
  timestampText: string | null;
  /** The mstk link. Stored as provenance ONLY — navigating it re-runs the prompt. */
  href: string | null;
  /** Local image filenames referenced by this entry. */
  images: string[];
  /** Everything the entry says, for turn reconstruction. */
  text: string;
}

export interface TakeoutScan {
  entryCount: number;
  withTimestamp: number;
  withQuery: number;
  withImages: number;
  imageRefsTotal: number;
  /** Which container the entries were found as, for verifying the parse. */
  containerDescription: string;
  /** Text length distribution — long entries mean full conversations, not just prompts. */
  textLengths: { min: number; median: number; max: number };
  /** Structural labels seen inside entries, to find turn boundaries. */
  repeatedLabels: string[];
}

function parseTimestamp(text: string): { iso: string | null; raw: string | null } {
  const m = TIMESTAMP_RE.exec(text);
  if (!m) return { iso: null, raw: null };
  const [raw, mon, day, year, hourRaw, minute, second, meridiem, zone] = m;
  const monthIndex = MONTHS.indexOf(mon);
  if (monthIndex < 0) return { iso: null, raw };
  let hour = Number(hourRaw) % 12;
  if (meridiem === 'PM') hour += 12;
  const pad = (n: number) => String(n).padStart(2, '0');
  // The zone is part of the stamp, so keep it rather than reinterpreting the
  // time in whatever timezone this machine happens to be in.
  const offset = zone ? zone.replace('GMT', '') : 'Z';
  const iso = `${year}-${pad(monthIndex + 1)}-${pad(Number(day))}T${pad(hour)}:${minute}:${second}${offset}`;
  const date = new Date(iso);
  return { iso: Number.isNaN(date.getTime()) ? null : date.toISOString(), raw };
}

function textOf(el: Element): string {
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Finds the innermost elements that each contain exactly one activity entry:
 * a full timestamp and an AI Mode link. Innermost matters — every ancestor up
 * to <body> also "contains" a timestamp.
 */
function findEntryElements(doc: Document): { elements: Element[]; description: string } {
  const all = Array.from(doc.querySelectorAll('div,li,section,article'));
  const candidates = all.filter((el) => {
    const t = textOf(el);
    if (!TIMESTAMP_RE.test(t)) return false;
    return !Array.from(el.children).some((child) => TIMESTAMP_RE.test(textOf(child)));
  });
  // Report the class actually used, so an unexpected parse is visible.
  const classes = new Map<string, number>();
  for (const el of candidates) {
    const key = String(el.className || '(no class)').slice(0, 40);
    classes.set(key, (classes.get(key) || 0) + 1);
  }
  const description = [...classes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c, n]) => `${c} x${n}`)
    .join(', ');
  return { elements: candidates, description };
}

function entryFrom(el: Element): TakeoutEntry {
  const text = textOf(el);
  const { iso, raw } = parseTimestamp(text);

  const links = Array.from(el.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') || '');
  const href = links.find((h) => h.includes('udm=50')) ?? links[0] ?? null;

  let query = '';
  if (href) {
    try {
      // The q= parameter is the clean query. Reading it beats scraping the
      // "Searched for ..." text, which runs into the timestamp.
      query = new URL(href, 'https://www.google.com').searchParams.get('q') ?? '';
    } catch {
      query = '';
    }
  }

  const images = Array.from(el.querySelectorAll('img[src]'))
    .map((img) => img.getAttribute('src') || '')
    // Local files only. A remote src would be a tracking pixel, and this import
    // must not reach the network.
    .filter((src) => src && !/^https?:|^data:/i.test(src))
    .map((src) => src.split('/').pop() || src);

  return { query, timestamp: iso, timestampText: raw, href, images, text };
}

export function parseTakeoutHtml(html: string): { entries: TakeoutEntry[]; scan: TakeoutScan } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const { elements, description } = findEntryElements(doc);
  const entries = elements.map(entryFrom);

  const lengths = entries.map((e) => e.text.length).sort((a, b) => a - b);
  const labelCounts = new Map<string, number>();
  for (const entry of entries) {
    // Short "Label:" runs are how turns are likely delimited ("Your prompt:").
    for (const m of entry.text.matchAll(/([A-Z][A-Za-z ]{2,24}):/g)) {
      labelCounts.set(m[1], (labelCounts.get(m[1]) || 0) + 1);
    }
  }

  return {
    entries,
    scan: {
      entryCount: entries.length,
      withTimestamp: entries.filter((e) => e.timestamp).length,
      withQuery: entries.filter((e) => e.query).length,
      withImages: entries.filter((e) => e.images.length > 0).length,
      imageRefsTotal: entries.reduce((n, e) => n + e.images.length, 0),
      containerDescription: description || '(none found)',
      textLengths: {
        min: lengths[0] ?? 0,
        median: lengths[Math.floor(lengths.length / 2)] ?? 0,
        max: lengths[lengths.length - 1] ?? 0,
      },
      repeatedLabels: [...labelCounts.entries()]
        .filter(([, n]) => n >= Math.max(3, entries.length * 0.1))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([label, n]) => `${label}: x${n}`),
    },
  };
}
