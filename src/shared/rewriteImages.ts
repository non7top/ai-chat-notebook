/**
 * Points captured HTML at the local asset store, and refuses to keep base64.
 *
 * Lives here rather than beside the capture code so it can be checked on its
 * own: it is pure string work, and reaching it through the main process would
 * mean importing Electron to test a regular expression.
 *
 * Measured on a real archive: 452 turns held inline data: URIs accounting for
 * 63.9 MB of a 198 MB database, one of them 1,290,911 bytes of HTML around 2,810
 * characters of text. Those images were not in the asset store either — so they
 * were uncounted, undeduplicated, unusable as a thread's thumbnail, and stored
 * again wherever the same picture appeared in another turn.
 *
 * The cause was the size filter upstream. An image that fails it never enters the
 * replacement map, so its data: URI was left in place: the pipeline decided the
 * image was not content and then carried a megabyte of it regardless. Anything
 * still holding base64 after the rewrite is therefore dropped — the decision the
 * filter already made, applied to the bytes as well as to the count.
 */
export function rewriteImageSources(html: string, replacements: Map<string, string>): string {
  let out = html;
  for (const [original, href] of replacements) {
    out = out.split(original).join(href);
  }
  // The whole element, not just its src: an <img> with no usable source renders
  // as a broken-image icon, which is worse than nothing being there.
  return out.replace(/<img\b[^>]*\bsrc="data:[^"]*"[^>]*>/gi, '');
}
