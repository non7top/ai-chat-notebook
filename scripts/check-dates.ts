/**
 * The export's timestamp pattern.
 *
 * Exists because a single \b cost 2104 of 3085 entries their date. The export
 * runs text together with no separator, so a date arrives glued to the words
 * around it and there is no word boundary in front of the month. Every sample
 * below is real text taken from an actual export scan.
 *
 *   npm run check:dates
 */
import { parseTimestamp } from '../src/renderer/parseTakeout.ts';

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`, ok ? '' : `got ${JSON.stringify(got)}`);
}

const dateOf = (text: string) => parseTimestamp(text).iso;
const rawOf = (text: string) => parseTimestamp(text).raw;

// Glued to the preceding word — the case that was silently failing.
check(
  'date glued to the preceding word',
  dateOf('key Aug 22, 2026, 10:07:33 AM GMT+07:00Your prompt: gpg'),
  '2026-08-22T10:07:33+07:00',
);
check(
  'date with no separator at all',
  // Verbatim from a real scan — this is the form that was failing.
  dateOf('keyAug 22, 2026, 10:07:33 AM GMT+07:00Your prompt: gpg'),
  '2026-08-22T10:07:33+07:00',
);
// Still works where it always did.
check(
  'date after a space',
  dateOf(' Aug 22, 2026, 10:07:33 AM GMT+07:00Your prompt: gpg'),
  '2026-08-22T10:07:33+07:00',
);
check('PM converts to 24-hour', dateOf('xAug 22, 2026, 5:15:48 PM GMT+07:00'), '2026-08-22T17:15:48+07:00');
check('midnight hour is 00, not 12', dateOf('xAug 22, 2026, 12:30:00 AM GMT+07:00'), '2026-08-22T00:30:00+07:00');
check('noon hour is 12, not 00', dateOf('xAug 22, 2026, 12:30:00 PM GMT+07:00'), '2026-08-22T12:30:00+07:00');
// The offset is KEPT, never normalised: reinterpreting this instant as UTC moved
// "Aug 22, 3:09 AM GMT+07:00" back to Aug 21 in the list.
check('offset is preserved, not normalised', dateOf('xAug 22, 2026, 3:09:33 AM GMT+07:00'), '2026-08-22T03:09:33+07:00');
check('no date at all stays null', dateOf('nothing dateish here'), null);

// When the strict pattern fails, the loose one still quotes the text back — that
// is what turned 2104 silent blanks into a reported, diagnosable number.
// A 24-hour clock: a real locale variant, and one the strict pattern refuses
// because it insists on AM/PM. It must come back as text rather than as a blank.
check('24-hour time is not parsed', dateOf('xAug 22, 2026, 14:07:33 GMT+07:00'), null);
// Quoted back INCLUDING whatever it was glued to, deliberately: the samples
// that exposed the missing word boundary read "keyAug 22, 2026, ...", and the
// prefix is what showed the text was run together rather than merely odd.
check(
  'and is still quoted back so it can be fixed',
  rawOf('xAug 22, 2026, 14:07:33 GMT+07:00')?.includes('Aug 22, 2026'),
  true,
);
check('nothing dateish returns no text either', rawOf('just words'), null);

if (failures > 0) throw new Error(`${failures} check(s) failed`);
console.log('OK');
