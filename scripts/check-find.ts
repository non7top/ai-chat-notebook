/**
 * The title-matching rule for find-as-you-type.
 *
 * Checked apart from the UI because the rule is easy to get subtly wrong and
 * almost impossible to see wrong through a list: a highlight off by one
 * character, or a term that quietly matches everything, looks like a working
 * search until the moment it matters.
 *
 *   npm run check:find
 */
import { highlight, matchesTitle, termsOf } from '../src/renderer/findTitles.ts';

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`, ok ? '' : `got ${JSON.stringify(got)}`);
}

const title = 'how do sprites get generated';

// Terms match in any order and out of sequence — the point of the whole rule,
// since the titles are opening prompts and nobody retypes one exactly.
check('all terms, in order', matchesTitle(title, termsOf('sprite gen')), true);
check('all terms, out of order', matchesTitle(title, termsOf('gen sprite')), true);
check('one term missing', matchesTitle(title, termsOf('sprite kitten')), false);
check('empty query matches everything', matchesTitle(title, termsOf('   ')), true);
check('case-insensitive', matchesTitle(title, termsOf('SPRITES')), true);
check('accent-insensitive', matchesTitle('le café noir', termsOf('cafe')), true);
check('accented query finds plain text', matchesTitle('le cafe noir', termsOf('café')), true);

// Highlighting must reproduce the title exactly — a segment lost or duplicated
// here silently corrupts what the list displays.
for (const query of ['', 'sprite', 'gen sprite', 'sprites sprite', 'how generated', 'zzz']) {
  const segs = highlight(title, termsOf(query));
  check(`highlight("${query}") reassembles the title`, segs.map((s) => s.text).join(''), title);
}

check(
  'overlapping terms merge into one run',
  highlight(title, termsOf('sprite sprites')).filter((s) => s.hit).map((s) => s.text),
  ['sprites'],
);
check(
  'two separate runs stay separate',
  highlight(title, termsOf('how generated')).filter((s) => s.hit).map((s) => s.text),
  ['how', 'generated'],
);
check('no match highlights nothing', highlight(title, termsOf('zzz')).some((s) => s.hit), false);
check(
  'original capitals survive highlighting',
  highlight('How Do Sprites Work', termsOf('sprites')).map((s) => s.text).join(''),
  'How Do Sprites Work',
);

// Matching and highlighting must agree. They disagreed once: folding strips
// combining marks and therefore changes length, so a position found in the
// folded text could not be used to slice the original — "cafe" matched
// "le café noir" and highlighted nothing in it. A row that survives the filter
// with nothing marked reads as a bug in the filter.
for (const [text, query] of [
  ['le café noir', 'cafe'],
  ['le cafe noir', 'café'],
  ['CAFÉ Sprites', 'cafe sprite'],
] as const) {
  const marked = highlight(text, termsOf(query)).filter((s) => s.hit);
  check(
    `"${query}" both matches and marks "${text}"`,
    [matchesTitle(text, termsOf(query)), marked.length > 0],
    [true, true],
  );
  check(
    `"${query}" highlighting reassembles "${text}"`,
    highlight(text, termsOf(query)).map((s) => s.text).join(''),
    text,
  );
}

if (failures > 0) throw new Error(`${failures} check(s) failed`);
console.log('OK');
