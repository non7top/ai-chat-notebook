/**
 * The cross-source text fingerprint.
 *
 * A simhash is only useful through its DISTANCE, so what has to hold is an
 * ORDERING: the same thread read from two sources must land closer than two
 * different threads. An equality check would prove nothing about that, and the
 * numbers below are the actual claim being made.
 *
 *   npm run check:fingerprint
 */
import {
  hammingDistance,
  normaliseForFingerprint,
  openingFingerprint,
  textFingerprint,
} from '../src/shared/fingerprint.ts';

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
}

// Normalisation has to erase every difference that is about markup rather than
// content, because that is all that separates the two sources.
check(
  'markup differences normalise away',
  normaliseForFingerprint('Hello  <b>World</b>') === normaliseForFingerprint('hello world'),
);
check(
  'punctuation and case normalise away',
  normaliseForFingerprint("Don't — stop!") === normaliseForFingerprint('dont stop'),
);
check(
  'accents normalise away',
  normaliseForFingerprint('café') === normaliseForFingerprint('cafe'),
);

const panel =
  'To specify a specific key when using gpg --clearsign, use the -u or --local-user ' +
  'option followed by the key identifier. You can identify your key using an email ' +
  'address, a short or long key ID, a full fingerprint, or a name.';
// The same answer as the export renders it: the same words, some dropped in the
// rougher reading, which is the difference actually seen between the sources.
const takeout =
  'To specify a key when using gpg --clearsign, use the -u or --local-user option ' +
  'followed by the key identifier. You can identify your key using an email address, ' +
  'a key ID, a fingerprint, or a name.';
const unrelated =
  'The vacuum decay hypothesis suggests the universe sits in a false vacuum state, ' +
  'and a bubble of true vacuum would expand at the speed of light destroying ' +
  'everything it touches.';

const same = hammingDistance(textFingerprint(panel), textFingerprint(takeout));
const different = hammingDistance(textFingerprint(panel), textFingerprint(unrelated));
console.log(`\n  same thread, two sources: distance ${same}`);
console.log(`  different threads:        distance ${different}\n`);

check('identical text is distance 0', hammingDistance(textFingerprint(panel), textFingerprint(panel)) === 0);
// The ordering is the whole claim. A margin is required, not merely "less than":
// a difference of one or two bits would leave no threshold that separates them.
check('the same thread is much closer than a different one', different - same >= 8, `margin ${different - same}`);
check('a different thread is far away', different >= 16, `distance ${different}`);

// Empty text must not collide with everything: a fingerprint of zero would make
// every text-less record match every other.
check('empty text is a constant, not a match-anything value', textFingerprint('') === '0'.repeat(16));
check(
  'empty text is far from real text',
  hammingDistance(textFingerprint(''), textFingerprint(panel)) >= 8,
);

// A short prompt still has to work: three-word shingles need four words, and a
// quarter of real prompts are shorter than that.
check(
  'two-word prompts differ from each other',
  hammingDistance(textFingerprint('vacuum decay'), textFingerprint('sprite generation')) >= 8,
);
check(
  'a one-word prompt matches itself',
  hammingDistance(textFingerprint('gpg'), textFingerprint('GPG')) === 0,
);

// The opening exchange is what gets compared in practice.
check(
  'opening fingerprint ignores later turns',
  openingFingerprint([
    { role: 'user', text: 'how do sprites work' },
    { role: 'ai', text: panel },
    { role: 'user', text: 'a follow-up the export never saw' },
  ]) ===
    openingFingerprint([
      { role: 'user', text: 'how do sprites work' },
      { role: 'ai', text: panel },
    ]),
);

check('mismatched lengths report maximum distance', hammingDistance('abc', 'abcd') === 64);

if (failures > 0) throw new Error(`${failures} check(s) failed`);
console.log('OK');
