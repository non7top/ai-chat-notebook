// Sanitising happens here, at the point of rendering, and not only at capture
// time. Two reasons:
//
// 1. Rows already in the database were written by whatever version of the
//    capture code was current that day. Cleaning only on the way in means a
//    bug in an old capture stays live forever, replayed every time the
//    conversation is opened.
// 2. This runs in the renderer, which has a real HTML parser. Regex-stripping
//    tags in the main process is exactly the approach that loses to
//    `<img src=x onerror=...>` written five different ways — DOMParser sees
//    the same tree the browser would actually build.
//
// The renderer CSP (index.html) is the backstop, not the primary defence: it
// blocks remote loads, so a missed image URL breaks visibly rather than
// silently re-fetching from Google.

const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DD', 'DIV', 'DL', 'DT', 'EM', 'FIGCAPTION',
  'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'LI', 'OL', 'P',
  'PRE', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD',
  'TR', 'UL',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  A: new Set(['href', 'title']),
  IMG: new Set(['src', 'alt', 'width', 'height']),
  TD: new Set(['colspan', 'rowspan']),
  TH: new Set(['colspan', 'rowspan']),
};

// No http/https: archived conversations must render from local bytes only.
// A surviving remote URL is a bug in the asset pipeline, and should look like
// one rather than quietly working while online.
const SAFE_SRC = /^(file:|data:image\/|assets\/)/i;
const SAFE_HREF = /^(https?:|mailto:)/i;

function isSafeAttr(tag: string, name: string, value: string): boolean {
  if (!ALLOWED_ATTRS[tag]?.has(name)) return false;
  if (name === 'src') return SAFE_SRC.test(value);
  // Links are kept readable but inert — see the click handler in ChatReader.
  if (name === 'href') return SAFE_HREF.test(value);
  return true;
}

function clean(node: Element): void {
  // Snapshot first: removing children while iterating a live HTMLCollection
  // skips elements.
  for (const child of Array.from(node.children)) {
    if (!ALLOWED_TAGS.has(child.tagName)) {
      // Unwrap rather than delete, so stripping a <font> or <script>-adjacent
      // wrapper doesn't take readable text with it. <script>/<style> are the
      // exception: their text content is code, not prose.
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') {
        child.remove();
      } else {
        clean(child);
        child.replaceWith(...Array.from(child.childNodes));
      }
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      if (!isSafeAttr(child.tagName, attr.name.toLowerCase(), attr.value)) {
        child.removeAttribute(attr.name);
      }
    }
    clean(child);
  }
}

/**
 * Removes the copies of a picture that a turn already holds.
 *
 * AI Mode draws every image TWICE: once in the answer (`img.HkNHyd` generated,
 * `img.taqkMe` uploaded) and again inside the click-to-expand wrapper as
 * `img.fRm5F[data-deferred]`. On the live page Google's own stylesheet hides
 * the second. The archive has no stylesheet, because clean() strips every
 * <style> as code — so both showed, and every picture appeared twice down the
 * length of the conversation.
 *
 * The duplicate was known and kept on purpose: the driver classifies img.fRm5F
 * as "the second copy of a real image", reasoning that the content-addressed
 * store collapses it. It does, for the BYTES. The second <img> TAG stayed in the
 * markup, and that is what the reader draws. CHAT_SUMMARY_SQL carries the same
 * knowledge and works around it, counting DISTINCT sha256 "because every image
 * is rendered twice by the page". Two places compensated for it; the reader did
 * not.
 *
 * Two rules, because the two cases are not the same shape — measured on thread
 * #2842, which has one of each:
 *
 *  - Identical src twice. The generated-image case: Google reuses one URL, so
 *    one asset row, and matching on src is exact.
 *  - `img.fRm5F` beside a primary copy. The upload case: the expand copy is the
 *    same picture RE-ENCODED, so the src differs and the hashes differ — 768px
 *    b4b2000… in the answer, 768px b8bfc15… in the wrapper. Nothing about the
 *    bytes says they are one picture; only the markup does.
 *
 * An `img.fRm5F` with no primary beside it is KEPT. If Google ever renders only
 * the deferred copy, dropping it would lose the picture rather than a duplicate
 * of it.
 *
 * Mirrors redundantImages() in aiModeDriver.ts, which applies the same rule at
 * capture time so new threads stop storing the copy at all. Duplicated rather
 * than shared because that one is injected page script and cannot import.
 *
 * Retroactive by construction: it runs at render time, so the 2848 conversations
 * already stored are corrected without rewriting a byte of them.
 */
function dropRepeatedImages(body: HTMLElement): void {
  const imgs = Array.from(body.querySelectorAll('img'));
  const isExpandCopy = (img: Element) =>
    img.classList.contains('fRm5F') || img.hasAttribute('data-deferred');
  // Whether the turn holds a copy that is NOT the expand wrapper's. Without
  // this the rule would strip the only picture out of a turn whose primary copy
  // Google did not render.
  const hasPrimary = imgs.some((img) => {
    if (isExpandCopy(img)) return false;
    const alt = img.getAttribute('alt') ?? '';
    return (
      img.classList.contains('HkNHyd') ||
      img.classList.contains('taqkMe') ||
      alt === 'AI generated image' ||
      alt === 'Visually searched image'
    );
  });
  const seen = new Set<string>();
  for (const img of imgs) {
    const src = img.getAttribute('src');
    if (!src) continue;
    if (seen.has(src) || (hasPrimary && isExpandCopy(img))) {
      img.remove();
      continue;
    }
    seen.add(src);
  }
}

export function sanitizeHtml(
  html: string,
  assetsBaseUrl?: string,
  /**
   * Relative paths of images that are page furniture — link previews, source
   * thumbnails. Marked so the reader can render them small. The class is set
   * AFTER clean() has run, so it survives the attribute allowlist rather than
   * needing an exception in it.
   */
  previewPaths?: string[],
): string {
  // DOMParser builds a detached document: nothing here loads a resource or
  // runs a script, unlike assigning to innerHTML on a live node.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // BEFORE clean(), and that order is load-bearing: the rule reads class and
  // alt, and clean() strips both off an <img> — the allowlist keeps only src,
  // alt, width and height. Run afterwards it could only see identical src, which
  // catches the generated-image case and misses the re-encoded one entirely.
  // The same comments the capture now drops, removed here as well so the 3,504
  // turns already stored render without them. Retroactive by construction, like
  // dropRepeatedImages: nothing is rewritten, they simply never reach the DOM.
  //
  // This does NOT shrink the database — the bytes stay in the html column until
  // something rewrites the rows. It stops them being parsed into a live document
  // on every open, which for a turn carrying 300KB of comments is the difference
  // between a reader that opens instantly and one that stalls.
  // Walked by nodeType rather than with a TreeWalker: this function also runs
  // outside a browser, in check:sanitize, against a DOM shim that has no
  // NodeFilter. Node.COMMENT_NODE is 8 everywhere.
  const dropComments = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 8) child.parentNode?.removeChild(child);
      else if (child.childNodes.length) dropComments(child);
    }
  };
  dropComments(doc.body);

  dropRepeatedImages(doc.body);
  // WHICH IMAGES ARE ICONS, decided from Google's own markup while it is still
  // here. clean() strips class off every element, so this has to happen first —
  // the same reason dropRepeatedImages runs above.
  //
  // The alternative, and what this replaces, was to ask the database: every asset
  // recorded as kind 'other' was rendered at 1.25em. Measured, that is 43,682 of
  // 46,814 assets — 93% of every picture in the archive shrunk to the size of a
  // letter, which is what "valid images scaled down to nonexistence" was.
  //
  // Nothing about the FILE can tell an icon from a picture. Favicons ship at
  // 256px now, so pixel size cannot; a generated image's median is 5,348 bytes
  // against a favicon's 2,172, so bytes cannot either. What can is where the
  // image sat: img.IpiY3d is a source-citation favicon, and Google says so.
  //
  // Retroactive by construction, like dropRepeatedImages: it reads stored HTML at
  // render time, and the classes are still in there — measured, IpiY3d appears in
  // 186 of 600 sampled turns holding an image.
  const icons = new Set(
    Array.from(doc.body.querySelectorAll('img.IpiY3d, div.S9OuHf img, img.RKMwI')),
  );
  clean(doc.body);
  for (const img of icons) img.setAttribute('class', 'preview-image');

  // Relative "assets/..." paths are stored rather than absolute file:// URLs so
  // the archive can be moved between machines. Resolve them now, against the
  // real assets directory, since the renderer itself lives inside the app
  // bundle and would otherwise look for images there.
  if (assetsBaseUrl) {
    for (const img of Array.from(doc.body.querySelectorAll('img[src^="assets/"]'))) {
      const src = img.getAttribute('src') ?? '';
      // The database's opinion, now a FALLBACK rather than the rule: it only
      // applies to an image Google's markup said nothing about. Where both speak,
      // the markup wins, because "this is the favicon of a cited source" is a
      // fact about the page and "kind = other" is a bucket everything unrecognised
      // fell into.
      if (!icons.has(img) && previewPaths?.includes(src)) {
        img.setAttribute('class', 'preview-image');
      }
      img.setAttribute('src', assetsBaseUrl + src.slice('assets/'.length));
    }
  }
  return doc.body.innerHTML;
}
