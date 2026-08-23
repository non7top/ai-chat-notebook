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
  clean(doc.body);

  // Relative "assets/..." paths are stored rather than absolute file:// URLs so
  // the archive can be moved between machines. Resolve them now, against the
  // real assets directory, since the renderer itself lives inside the app
  // bundle and would otherwise look for images there.
  if (assetsBaseUrl) {
    for (const img of Array.from(doc.body.querySelectorAll('img[src^="assets/"]'))) {
      const src = img.getAttribute('src') ?? '';
      // Marked before the path is rewritten, while it still matches what the
      // database recorded. Page furniture is kept — it is part of what the
      // answer looked like — but it must not out-shout the answer.
      if (previewPaths?.includes(src)) img.setAttribute('class', 'preview-image');
      img.setAttribute('src', assetsBaseUrl + src.slice('assets/'.length));
    }
  }
  return doc.body.innerHTML;
}
