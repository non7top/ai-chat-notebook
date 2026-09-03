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

// What a cross-source key would have to work with. The panel and the export
// render the same thread differently, so a key for matching across them can only
// use text — and how much text, and how unique it is, decides the algorithm.
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
const convos = entries.filter((e) => e.turns.length > 0);
const firstPrompt = convos.map((e) => norm(e.turns.find((t) => t.role === 'user')?.text ?? ''));
const firstAnswer = convos.map((e) => norm(e.turns.find((t) => t.role === 'ai')?.text ?? ''));
const stats = (name: string, values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
  console.log(
    `  ${name}: min ${sorted[0]} p25 ${at(0.25)} median ${at(0.5)} p75 ${at(0.75)} ` +
      `p95 ${at(0.95)} max ${sorted[sorted.length - 1]}`,
  );
};
console.log('\nnormalised text lengths (letters and digits only)');
stats('first prompt ', firstPrompt.map((t) => t.length));
stats('first answer ', firstAnswer.map((t) => t.length));
console.log('\nhow unique is the text alone');
collisions('first prompt              ', firstPrompt);
collisions('first prompt + answer     ', firstPrompt.map((t, i) => `${t}|${firstAnswer[i]}`));
collisions('first prompt + 64 answer  ', firstPrompt.map((t, i) => `${t}|${firstAnswer[i].slice(0, 64)}`));

// ---------------------------------------------------------------------------
// Two candidate text fingerprints, measured on the real records rather than
// argued about.
//
// Both start from the same place, which is the part of the proposal that is
// plainly right: take the DOM's text, not the markup, decode entities, collapse
// whitespace, keep only letters and digits. Where they differ is what happens
// next.
//
// A — first letter of each word, overlapping bigrams, each setting one bit of a
//     64-bit vector by OR. This is a Bloom filter, and the question a Bloom
//     filter cannot escape is saturation: enough insertions and every bit is 1.
// B — SimHash over 3-word shingles: each shingle votes + or - on all 64 bit
//     positions and the sign of the sum becomes the bit. The length of the text
//     does not push it toward all-ones, and the distance between two values is
//     meaningful, which is the whole point of the technique.
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

const hash32 = (text: string, seed: number): number => {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h ^ text.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2545f491) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
};

const bloomFirstLetters = (text: string): { hex: string; bits: number } => {
  const ws = words(text);
  let letters = ws.map((w) => w[0]);
  if (letters.length < 5) letters = ws.flatMap((w) => w.slice(0, 2).split(''));
  const lanes = [0, 0];
  for (let i = 0; i + 1 < letters.length; i += 1) {
    const index = hash32(letters[i] + letters[i + 1], 42) % 64;
    lanes[index < 32 ? 0 : 1] |= 1 << index % 32;
  }
  const bits =
    ((lanes[0] >>> 0).toString(2).split('1').length - 1) +
    ((lanes[1] >>> 0).toString(2).split('1').length - 1);
  return {
    hex: (lanes[1] >>> 0).toString(16).padStart(8, '0') + (lanes[0] >>> 0).toString(16).padStart(8, '0'),
    bits,
  };
};

const simhash = (text: string): string => {
  const ws = words(text);
  const votes = new Array(64).fill(0);
  const shingles = ws.length < 3 ? ws : ws.slice(0, -2).map((_, i) => ws.slice(i, i + 3).join(' '));
  for (const shingle of shingles) {
    const a = hash32(shingle, 0x9e3779b9);
    const b = hash32(shingle, 0x85ebca6b);
    for (let bit = 0; bit < 64; bit += 1) {
      const source = bit < 32 ? a : b;
      votes[bit] += (source >>> bit % 32) & 1 ? 1 : -1;
    }
  }
  let hex = '';
  for (let nibble = 15; nibble >= 0; nibble -= 1) {
    let value = 0;
    for (let bit = 3; bit >= 0; bit -= 1) {
      value = (value << 1) | (votes[nibble * 4 + bit] > 0 ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
};

const answers = convos.map((e) => e.turns.find((t) => t.role === 'ai')?.text ?? '');
const blooms = answers.map(bloomFirstLetters);
const avgBits = blooms.reduce((n, b) => n + b.bits, 0) / blooms.length;
console.log('\ntwo text fingerprints over the first answer of each record');
console.log(`  A bloom-of-first-letters: average ${avgBits.toFixed(1)} of 64 bits set`);
collisions('  A bloom-of-first-letters ', blooms.map((b) => b.hex));
collisions('  B simhash of 3-word shingles', answers.map(simhash));

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
