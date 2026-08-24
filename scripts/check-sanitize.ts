/**
 * The reader's image de-duplication, against the two shapes AI Mode actually
 * produces.
 *
 * Every picture appeared twice down the length of a conversation, because AI
 * Mode renders each one in the answer and again in a click-to-expand wrapper
 * that Google's own stylesheet hides — and the archive has no stylesheet, since
 * sanitising strips <style> as code.
 *
 * This is checked rather than eyeballed because the rule has a branch that
 * DELETES an <img>. Get the "keep it when it is the only copy" case wrong and
 * the reader silently loses pictures, which is the one failure this archive
 * exists to prevent. The markup below is the real thing, reduced: the class
 * names, alt text and both asset paths are copied from thread #2842.
 *
 *   npm run check:sanitize
 */
import { JSDOM } from 'jsdom';

// sanitize.ts is renderer code and reaches for the global DOMParser. jsdom is a
// dev dependency for exactly this — see check-turns.ts.
const dom = new JSDOM('');
(globalThis as unknown as { DOMParser: unknown }).DOMParser = dom.window.DOMParser;

const { sanitizeHtml } = await import('../src/renderer/sanitize.ts');

const srcs = (html: string): string[] =>
  Array.from(html.matchAll(/<img[^>]*\bsrc="([^"]*)"/g)).map((m) => m[1]);

const A = 'assets/c6/c6a8e2a9.jpg';
const B = 'assets/b4/b4b20003.jpg';
const C = 'assets/b8/b8bfc153.jpg';

// Case 1 — a generated image. Google reuses ONE url, so the two tags carry the
// same src and one asset row was ever written.
const generated = `
  <div class="ppOxhc">
    <img class="HkNHyd" src="${A}" alt="AI generated image">
  </div>
  <div id="aim-img-d8bfc606-wrapper" class="zqCzjc"><div class="X0Xglb">
    <img class="fRm5F" src="${A}" alt="AI generated image" data-deferred="3">
  </div></div>`;
let out = srcs(sanitizeHtml(generated));
console.log(`generated: ${out.length} img -> ${JSON.stringify(out)}`);
if (out.length !== 1 || out[0] !== A) throw new Error('the duplicate generated image survived');

// Case 2 — an upload. The expand copy is the same picture RE-ENCODED, so the
// srcs differ and so do the hashes: nothing about the bytes says they are one
// picture. This is the case a src-only rule cannot see.
const upload = `
  <img class="taqkMe Tbpky" src="${B}" alt="Visually searched image">
  <div class="X0Xglb">
    <img class="fRm5F" src="${C}" alt="Visually searched image" data-deferred="3">
  </div>`;
out = srcs(sanitizeHtml(upload));
console.log(`upload: ${out.length} img -> ${JSON.stringify(out)}`);
if (out.length !== 1 || out[0] !== B) {
  throw new Error(`the re-encoded expand copy survived: ${JSON.stringify(out)}`);
}

// Case 3 — the branch that must NOT delete. An expand copy with no primary
// beside it IS the picture. Dropping it would lose the image rather than a
// duplicate of it, which is the failure mode worth a check of its own.
const lone = `<div class="X0Xglb"><img class="fRm5F" src="${C}" alt="AI generated image"></div>`;
out = srcs(sanitizeHtml(lone));
console.log(`expand copy alone: ${out.length} img -> ${JSON.stringify(out)}`);
if (out.length !== 1 || out[0] !== C) throw new Error('the only copy of the picture was deleted');

// Case 4 — two genuinely different pictures in one turn, which is what the user
// turn of #2842 has once the expand copy is gone. Neither may be touched.
const two = `
  <img class="taqkMe Tbpky" src="${B}" alt="Visually searched image">
  <img class="taqkMe Tbpky" src="${A}" alt="Visually searched image">`;
out = srcs(sanitizeHtml(two));
console.log(`two real images: ${out.length} img -> ${JSON.stringify(out)}`);
if (out.length !== 2) throw new Error(`a real image was dropped: ${JSON.stringify(out)}`);

// The rule reads class and alt, and clean() strips both from an <img>. So it has
// to run FIRST, and this is the assertion that pins that order: with the passes
// the other way round, case 2 comes back with two images.
const ordered = sanitizeHtml(upload);
if (/class="/.test(ordered)) throw new Error('clean() no longer strips class — recheck the order');

// Sanitising itself still has to hold. Not this rule's job, but the same
// function, and a reordering that broke it would be silent.
const nasty = '<img src="x" onerror="alert(1)"><script>alert(2)</script><p>text</p>';
const cleaned = sanitizeHtml(nasty);
console.log(`sanitised: ${cleaned}`);
if (/onerror|script|alert/i.test(cleaned)) throw new Error('sanitising regressed');

console.log('OK');
