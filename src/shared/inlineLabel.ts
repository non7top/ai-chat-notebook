import type { InlineImageCount } from './types';

/**
 * How to name the inline-image repair, given what is actually known.
 *
 * A pure function in its own file because the version inlined in the menu got it
 * wrong in a way nothing could catch: it added `inline` to `unexamined`. Those
 * are different quantities in different units — turns known to hold base64
 * against turns nobody has looked at yet — and summed they produced "(23263)"
 * on an archive holding 2245. The label reported the size of the CHECK as if it
 * were the size of the work.
 *
 * The rule: name a number only when it is known.
 *
 *  - nothing examined yet      → no number, and an ellipsis to say so
 *  - some found, some to check → the number found, with a "+"
 *  - everything examined       → the number, exactly
 */
export function inlineImageLabel(count: InlineImageCount): string {
  const base = 'Move inline images out of the text';
  if (count.unexamined === 0) return `${base} (${count.inline})`;
  if (count.inline > 0) return `${base} (${count.inline}+)`;
  return `${base}…`;
}

/**
 * Whether the repair is worth offering.
 *
 * True while anything is unexamined, because then the answer is not yet known —
 * offering it is how the answer gets found. False only when it is known to be
 * zero.
 */
export function inlineImagesWorthMoving(count: InlineImageCount): boolean {
  return count.inline > 0 || count.unexamined > 0;
}
