/**
 * Text fingerprints for matching one thread across two sources.
 *
 * The export and the live panel render the same thread completely differently,
 * and nothing structural survives the crossing: the export's mstk token exists
 * only in the export, and an image arrives with a different filename, different
 * dimensions and different bytes on each side (599x1334 re-encoded JPEG against
 * a 1024x1024 original). Text is the only thing both sources hold, so text is
 * what a cross-source key has to be built from.
 *
 * SimHash over word shingles, chosen after measuring the alternative on a real
 * export of 2027 conversation records:
 *
 *   bloom filter of first letters   average 40.8 of 64 bits set, 370 records lost
 *   simhash of 3-word shingles      1911 of 2027 distinct,       116 records lost
 *
 * A bloom filter cannot escape saturation: a median answer runs about 150 words,
 * so its bigrams land in 64 buckets and two thirds of the vector reads 1
 * whatever the text said — every long answer converging on the same value. A
 * simhash keeps its bits balanced because each shingle votes both ways and only
 * the sign of the sum survives.
 *
 * Imported with an explicit .ts extension wherever this runs at runtime, and
 * tsconfig.json carries allowImportingTsExtensions for it. The check scripts run
 * under node --experimental-strip-types, whose ESM resolver takes a specifier
 * literally and will not find an extensionless one; the bundler accepts either.
 *
 * The point of a simhash is the DISTANCE between two of them, and that is not
 * optional. Compared only for equality it is a worse plain hash: it would miss
 * every pair that differs by a word, which is exactly the pair worth finding
 * when one source has rougher text than the other. Use hammingDistance.
 */

/**
 * Text as both sources would agree on it: lowercase, no punctuation, no
 * markup-driven whitespace. Nothing here may depend on how either side chose to
 * mark the text up, since that is precisely what differs.
 */
export function normaliseForFingerprint(text: string): string {
  return (
    stripMarkup(text)
      .toLowerCase()
      // Decomposed and stripped of combining marks, so an accent typed one way
      // on one side and another way on the other still matches.
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      // Apostrophes are REMOVED rather than treated as separators, so "don't"
      // becomes one word and not two. The sources disagree about which
      // apostrophe to use — a straight quote on one side, a curly one or an
      // entity on the other — and splitting on it turns that disagreement into
      // two different word counts.
      .replace(/['\u2018\u2019\u02bc]/g, '')
      .match(/[a-z0-9]+/g)
      ?.join(' ') ?? ''
  );
}

/**
 * Text with any markup taken out of it.
 *
 * Callers are meant to pass text, and this exists because when one does not the
 * failure is silent and wrong rather than loud: a tag name is made of letters,
 * so "<b>World</b>" normalises to "b world b" and the fingerprint of a marked-up
 * copy stops matching the fingerprint of a plain one. Cheap insurance at the one
 * place where both sources have to agree.
 *
 * A regex rather than a DOM: this module is shared by the main process and the
 * renderer, and only the renderer has DOMParser.
 */
function stripMarkup(text: string): string {
  return (
    text
      // Content and all, since neither is anything a person said.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      // The entities that actually occur in these exports. Numeric forms are
      // decoded generally; the named ones are enumerated because a full table
      // is not worth carrying for text that is about to lose its punctuation
      // anyway.
      .replace(/&(?:nbsp|ensp|emsp|thinsp);/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&(?:quot|apos|lsquo|rsquo|ldquo|rdquo|hellip|mdash|ndash);/gi, ' ')
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  );
}

/** Two independent 32-bit hashes, giving the 64 bit positions a simhash needs. */
function hashPair(text: string): [number, number] {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul((a ^ c) >>> 0, 0x01000193) >>> 0;
    b = Math.imul((b ^ c) >>> 0, 0x85ebca6b) >>> 0;
  }
  // Final avalanche on both lanes: without it short inputs differing in one
  // character land in neighbouring buckets and the bits correlate.
  a = Math.imul((a ^ (a >>> 15)) >>> 0, 0x2545f491) >>> 0;
  b = Math.imul((b ^ (b >>> 13)) >>> 0, 0x27d4eb2f) >>> 0;
  return [(a ^ (a >>> 16)) >>> 0, (b ^ (b >>> 16)) >>> 0];
}

const SHINGLE = 3;

/**
 * A 64-bit simhash of the text, as 16 hex characters.
 *
 * Short text falls back to single words: three-word shingles need four words to
 * produce more than one, and a quarter of the prompts in a real export are two
 * words or fewer.
 */
export function textFingerprint(text: string): string {
  const words = normaliseForFingerprint(text).split(' ').filter(Boolean);
  if (words.length === 0) return '0'.repeat(16);

  const shingles =
    words.length <= SHINGLE
      ? words
      : words.slice(0, words.length - SHINGLE + 1).map((_, i) => words.slice(i, i + SHINGLE).join(' '));

  const votes = new Array<number>(64).fill(0);
  for (const shingle of shingles) {
    const [a, b] = hashPair(shingle);
    for (let bit = 0; bit < 64; bit += 1) {
      const lane = bit < 32 ? a : b;
      votes[bit] += (lane >>> bit % 32) & 1 ? 1 : -1;
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
}

/**
 * Differing bits between two fingerprints, 0 to 64.
 *
 * This is how simhashes are meant to be compared. Near-identical text lands in
 * the low single digits; unrelated text sits near 32, which is what two
 * independent random values average. A threshold belongs to the caller, because
 * it trades false matches against missed ones and only the caller knows which
 * costs more.
 */
export function hammingDistance(left: string, right: string): number {
  if (left.length !== right.length) return 64;
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    let diff = Number.parseInt(left[i], 16) ^ Number.parseInt(right[i], 16);
    while (diff) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}

/**
 * The fingerprint of a thread's opening exchange, computed identically wherever
 * it is called from.
 *
 * The opening is used rather than the whole thread because the sources disagree
 * about the end: the panel holds turns added after the export was taken, and
 * Google truncates its own records. They agree about how a thread started.
 */
/**
 * The opening PROMPT alone.
 *
 * Preferred over prompt-plus-answer for checking that a page is the thread an
 * entry describes, and the reason is measured. Opening a real archived thread
 * from January returned 6,689 characters where the export held 1,775 — the export
 * truncates, so the answer is a partial subset and the distance between the two
 * came out at 28 of 64 bits: further apart than two unrelated threads measured in
 * the fixtures. The check rejected a genuine recovery.
 *
 * A prompt does not have that problem. It is what the person typed, both sources
 * record it in full, and neither has any reason to shorten it.
 */
export function promptFingerprint(turns: { role: 'user' | 'ai'; text: string }[]): string {
  return textFingerprint(turns.find((t) => t.role === 'user')?.text ?? '');
}

export function openingFingerprint(
  turns: { role: 'user' | 'ai'; text: string }[],
): string {
  const prompt = turns.find((t) => t.role === 'user')?.text ?? '';
  const answer = turns.find((t) => t.role === 'ai')?.text ?? '';
  return textFingerprint(`${prompt} ${answer}`);
}
