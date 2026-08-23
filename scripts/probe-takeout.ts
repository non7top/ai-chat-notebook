/**
 * Structure of a real Takeout export, read with a real parser.
 *
 * Written after answering the same questions with grep twice and getting them
 * wrong twice: once because the HTML escapes the query parameter as `&amp;q=`,
 * so a search for `&q=` found 54 of 2026, and once because an unescaped quote
 * inside a $(...) broke the pattern and a match that existed 1933 times reported
 * zero. A parser has neither failure mode, and this uses the same DOM the app
 * parses with.
 *
 * Prints STRUCTURE ONLY — element names, class names, counts, shapes, and how
 * many distinct values a token takes. Never conversation text, never a query,
 * never a token's value. The owner asked that their chats not be read, and a
 * diagnostic has no business reproducing them.
 *
 *   docker compose run --rm dev npm run probe:takeout -- <path to MyActivity.html>
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { entryFrom } from '../src/renderer/parseTakeout.ts';

const file = process.argv[2];
if (!file) {
  console.error('Pass the path to MyActivity.html.');
  process.exit(1);
}

const dom = new JSDOM(fs.readFileSync(file, 'utf8'));
const doc = dom.window.document;

const cells = Array.from(doc.querySelectorAll('div.outer-cell'));
const titles = doc.querySelectorAll('p.mdl-typography--title').length;
console.log(`cells ${cells.length} | record titles ${titles}`);

const tally = (name: string, values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n${name} (${counts.size} distinct)`);
  for (const [value, count] of rows.slice(0, 10)) {
    console.log(`  ${String(count).padStart(6)}  ${value}`);
  }
  if (rows.length > 10) console.log(`  ${' '.repeat(6)}  … ${rows.length - 10} more`);
};

// What the record says it is: the leading text of the body cell, before any
// link. Truncated hard — the point is the prefix, not the query after it.
tally(
  'record prefixes',
  cells.map((cell) => {
    const body = cell.querySelector('.content-cell');
    const first = body?.firstChild;
    const text = (first?.nodeType === 3 ? (first.textContent ?? '') : '').trim();
    return text.slice(0, 26) || '(no leading text)';
  }),
);

// Which elements answers are actually built from. This is the measurement that
// found the parser keeping only paragraphs.
const blockTags: string[] = [];
for (const cell of cells) {
  const body = cell.querySelector('.content-cell');
  if (!body) continue;
  for (const child of Array.from(body.children)) blockTags.push(child.tagName);
}
tally('block elements inside body cells', blockTags);

// Identity. All-distinct means it names a record exactly.
const tokens = cells
  .map((cell) => {
    const href = cell.querySelector('.content-cell a[href]')?.getAttribute('href');
    if (!href) return null;
    try {
      return new URL(href, 'https://www.google.com').searchParams.get('mstk');
    } catch {
      return null;
    }
  })
  .filter((t): t is string => Boolean(t));
console.log(
  `\nmstk tokens: ${tokens.length} present, ${new Set(tokens).size} distinct` +
    (tokens.length === new Set(tokens).size ? ' — unique per record' : ' — REPEATED, not unique'),
);

// Timestamps per cell. One means a cell is one record; more would mean several
// records share a cell and only the first date is being kept.
const STAMP = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})\s?(AM|PM)/g;
const stampCounts = cells.map((cell) => (cell.textContent ?? '').match(STAMP)?.length ?? 0);
tally('timestamps per cell', stampCounts.map(String));

// Labelled turns per cell, the same way the app splits them.
const labels = cells.map((cell) => {
  const body = cell.querySelector('.content-cell');
  if (!body) return '0';
  let n = 0;
  for (const child of Array.from(body.children)) {
    const lead = child.tagName === 'P' ? child.firstElementChild : null;
    if (lead?.tagName !== 'STRONG') continue;
    const text = (lead.textContent ?? '').trim().toLowerCase();
    if (/^(your prompt|search's response|response):?$/.test(text)) n += 1;
  }
  return n === 0 ? '0' : n <= 2 ? '1-2' : n <= 10 ? '3-10' : n <= 50 ? '11-50' : '50+';
});
tally('labelled turns per cell', labels);

tally(
  'images per cell',
  cells.map((cell) => String(cell.querySelectorAll('img.image-preview').length)),
);

// Can a cell be named without Google's token? 1059 of them have no link, and
// they still have to be told apart from each other — including the wholly empty
// ones, whose only distinguishing feature is a date.
//
// Candidates are tested by counting collisions, because that is the only thing
// that matters about an identifier: two records sharing one means one of them is
// lost on import.
const stampOf = (cell: Element): string => {
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})\s?(AM|PM)[^<]*/.exec(
    cell.textContent ?? '',
  );
  return m ? m[0].trim() : '';
};
const imagesOf = (cell: Element): string =>
  Array.from(cell.querySelectorAll('img.image-preview'))
    .map((img) => img.getAttribute('src') ?? '')
    .join(',');
// The RAW cell markup, not the parsed text. A hash of parsed content moves every
// time the parser changes — which has happened twice — and renames every record
// with it. The markup is what Google wrote and does not move.
const rawOf = (cell: Element): string => cell.innerHTML.replace(/\s+/g, ' ').trim();

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

const collisions = (name: string, keys: string[]): void => {
  const seen = new Map<string, number>();
  for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  const dupes = [...seen.values()].filter((n) => n > 1);
  const lost = dupes.reduce((n, c) => n + c - 1, 0);
  console.log(
    `  ${name}: ${keys.length} records, ${seen.size} distinct` +
      (lost === 0 ? ' — no collisions' : ` — ${dupes.length} colliding, ${lost} would be lost`),
  );
};

// The shipped functions, not a reimplementation of them: a probe that measures
// something the app does not compute proves nothing about the app.
const entries = cells.map((cell) => entryFrom(cell as unknown as Element));
console.log('\nthe three shipped fingerprints');
collisions('long  (whole cell)        ', entries.map((e) => `${e.timestamp ?? 'nodate'}|${e.fingerprints.long}`));
collisions('empty (date + images)     ', entries.map((e) => e.fingerprints.empty));
// Collisions here are the POINT: records sharing an opening exchange are the
// split-and-continued case, so this number is a finding rather than a fault.
const shorts = entries.filter((e) => e.turns.length > 0).map((e) => e.fingerprints.short);
collisions('short (opening exchange)  ', shorts);

console.log('\nfingerprint candidates, all cells');
collisions('timestamp alone           ', cells.map(stampOf));
collisions('timestamp + images        ', cells.map((c) => `${stampOf(c)}|${imagesOf(c)}`));
collisions('timestamp + raw markup    ', cells.map((c) => `${stampOf(c)}|${digest(rawOf(c))}`));
collisions('raw markup alone          ', cells.map((c) => digest(rawOf(c))));

const tokenless = cells.filter((cell) => {
  const href = cell.querySelector('.content-cell a[href]')?.getAttribute('href');
  if (!href) return true;
  try {
    return !new URL(href, 'https://www.google.com').searchParams.get('mstk');
  } catch {
    return true;
  }
});
console.log(`\nfingerprint candidates, the ${tokenless.length} cells with no mstk`);
collisions('timestamp alone           ', tokenless.map(stampOf));
collisions('timestamp + images        ', tokenless.map((c) => `${stampOf(c)}|${imagesOf(c)}`));
collisions('timestamp + raw markup    ', tokenless.map((c) => `${stampOf(c)}|${digest(rawOf(c))}`));
