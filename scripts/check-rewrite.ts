/**
 * Rewriting captured HTML to point at the local asset store.
 *
 * Guards a measured failure: 452 turns in a real archive held inline data: URIs
 * worth 63.9 MB, because an image that failed the size filter never entered the
 * replacement map and its base64 was left in the markup verbatim.
 *
 *   npm run check:rewrite
 */
import { rewriteImageSources as rewrite } from '../src/shared/rewriteImages.ts';

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
}

const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

// A stored image is pointed at the asset store.
const stored = rewrite(
  `<p>text</p><img src="${tiny}" alt="a">`,
  new Map([[tiny, 'assets/ab/abcdef.png']]),
);
check('a stored image points at the asset store', stored.includes('assets/ab/abcdef.png'));
check('and its base64 is gone', !stored.includes('base64'));
check('the surrounding text survives', stored.includes('<p>text</p>'));

// An image that was NOT stored must not leave its base64 behind.
const skipped = rewrite(`<p>text</p><img src="${tiny}" alt="a">`, new Map());
check('an unstored data: image is dropped entirely', !skipped.includes('base64'));
check('the element goes with it', !skipped.includes('<img'), 'a src-less img renders as broken');
check('and the text is untouched', skipped.includes('<p>text</p>'));

// Remote sources are left alone — the asset pipeline handles those, and a URL is
// a few dozen bytes rather than a megabyte.
const remote = rewrite('<img src="https://example.com/a.png">', new Map());
check('an https image is left in place', remote.includes('https://example.com/a.png'));

// Several on one turn, mixed.
const mixed = rewrite(
  `<img src="${tiny}"><img src="assets/x/y.png"><img src="${tiny}2">`,
  new Map([[tiny, 'assets/kept.png']]),
);
check('the stored one is kept', mixed.includes('assets/kept.png'));
check('the unstored one is dropped', !mixed.includes('base64'));
check('an already-local one is untouched', mixed.includes('assets/x/y.png'));

if (failures > 0) throw new Error(`${failures} check(s) failed`);
console.log('OK');
