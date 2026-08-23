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
  /** Shape of a sampled entry, so a wrong container choice is visible. */
  structure: {
    sampled: number;
    descendantsPerEntry: string;
    anchorsInSample: number;
    imgsInSample: number;
    localImageHrefsInSample: number;
  };
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
  if (Number.isNaN(date.getTime())) return { iso: null, raw };
  // Returned WITH its original offset rather than normalised to UTC. Converting
  // moved conversations across midnight — "Aug 22, 3:09 AM GMT+07:00" became
  // 2026-08-21T20:09Z, and the list then showed Aug 21 for something Google
  // records as Aug 22. For an archive the meaningful date is the one it happened
  // on where it happened, so the offset is part of the value, not noise to
  // discard.
  return { iso, raw };
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

  // Both <img src> and <a href> are checked: a first pass over a real export
  // found zero images looking only at <img>, and Takeout is as likely to link a
  // file as embed it. Local files only — a remote src would be a tracking pixel,
  // and this import must not reach the network.
  const imageRefs = [
    ...Array.from(el.querySelectorAll('img[src]')).map((n) => n.getAttribute('src') || ''),
    ...Array.from(el.querySelectorAll('a[href]')).map((n) => n.getAttribute('href') || ''),
  ];
  const images = imageRefs
    .filter((ref) => ref && !/^https?:|^data:/i.test(ref))
    .filter((ref) => /\.(jpe?g|png|webp|gif)$/i.test(ref.split('?')[0]))
    .map((ref) => decodeURIComponent(ref.split('?')[0].split('/').pop() || ref));

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
      // Sanity signals for the container choice: an entry holding a whole
      // conversation should contain several elements and some markup, not a
      // single line of text.
      structure: (() => {
        const sample = elements.slice(0, 40);
        const childCounts = sample.map((el) => el.querySelectorAll('*').length);
        const anchors = sample.reduce((n, el) => n + el.querySelectorAll('a').length, 0);
        const imgs = sample.reduce((n, el) => n + el.querySelectorAll('img').length, 0);
        const localFileRefs = sample.reduce(
          (n, el) =>
            n +
            Array.from(el.querySelectorAll('a[href]')).filter((a) =>
              /\.(jpe?g|png|webp|gif)$/i.test((a.getAttribute('href') || '').split('?')[0]),
            ).length,
          0,
        );
        return {
          sampled: sample.length,
          descendantsPerEntry: childCounts.length
            ? `${Math.min(...childCounts)}/${childCounts[Math.floor(childCounts.length / 2)]}/${Math.max(...childCounts)}`
            : 'n/a',
          anchorsInSample: anchors,
          imgsInSample: imgs,
          localImageHrefsInSample: localFileRefs,
        };
      })(),
      repeatedLabels: [...labelCounts.entries()]
        .filter(([, n]) => n >= Math.max(3, entries.length * 0.1))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([label, n]) => `${label}: x${n}`),
    },
  };
}
