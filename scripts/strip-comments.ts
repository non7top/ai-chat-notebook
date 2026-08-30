/**
 * Removes HTML comments from stored turns, and reclaims the space.
 *
 * Google leaves its serialised page data in comments — <!--TgQPHd|[[null,null,
 * ["data:image/png;base64,... — up to 5KB apiece, dozens per answer. They were
 * captured along with the markup and are most of what this archive is made of.
 * Measured: the 400 largest turns hold 149MB of html, 106MB of it comments
 * (70.9%) across 130,585 comments, and those turns are only 11% of the 1301MB
 * total.
 *
 * Nothing renders from a comment, so nothing visible is lost. This is also why
 * "Move inline images" appeared to do nothing when run: it looks for
 * <img src="data:" and every one of the 3,504 turns holding a data: image holds
 * it inside a comment instead.
 *
 * The capture no longer stores them and the reader already drops them at render
 * time; this is for the rows already written.
 *
 *   node --experimental-strip-types scripts/strip-comments.ts <notebook.sqlite> [--apply] [--vacuum]
 *
 * Reports without --apply. CLOSE THE APP FIRST: this writes, and --vacuum needs
 * exclusive access.
 */
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
const vacuum = process.argv.includes('--vacuum');
if (!file) {
  console.error('Pass the path to notebook.sqlite.');
  process.exit(1);
}

const db = new DatabaseSync(file, { readOnly: !apply });
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

// Non-greedy, over newlines: a comment can carry anything except its own
// terminator, and these run to kilobytes.
const COMMENT = /<!--[\s\S]*?-->/g;

const select = db.prepare(
  'SELECT id, html FROM messages WHERE html IS NOT NULL AND html LIKE ? AND id > ? ORDER BY id LIMIT ?',
);
const update = db.prepare('UPDATE messages SET html = ? WHERE id = ?');

let scanned = 0;
let changed = 0;
let before = 0;
let after = 0;
let refused = 0;
let afterId = 0;

for (;;) {
  const rows = select.all('%<!--%', afterId, 200) as unknown as { id: number; html: string }[];
  if (rows.length === 0) break;
  afterId = rows[rows.length - 1].id;

  for (const row of rows) {
    scanned += 1;
    const stripped = row.html.replace(COMMENT, '');
    if (stripped.length === row.html.length) continue;

    // THE INVARIANT. A comment cannot contain a real tag — an unterminated one
    // could swallow the rest of the answer, and a regex is not a parser. If the
    // count of images or paragraphs changes, this row is left exactly as it is
    // and counted, rather than trusted.
    const imgsBefore = (row.html.match(/<img\b/gi) || []).length;
    const imgsAfter = (stripped.match(/<img\b/gi) || []).length;
    const tagsBefore = (row.html.match(/<(p|div|li|h[1-6])\b/gi) || []).length;
    const tagsAfter = (stripped.match(/<(p|div|li|h[1-6])\b/gi) || []).length;
    if (imgsBefore !== imgsAfter || tagsBefore !== tagsAfter) {
      refused += 1;
      continue;
    }

    before += row.html.length;
    after += stripped.length;
    changed += 1;
    if (apply) update.run(stripped, row.id);
  }
}

console.log(`turns holding a comment: ${scanned}`);
console.log(`  rewritten:  ${changed}`);
console.log(`  refused (an image or block tag would have been lost): ${refused}`);
console.log(`  html before ${mb(before)} -> after ${mb(after)}  (frees ${mb(before - after)})`);

if (!apply) {
  console.log('\ndry run — pass --apply to rewrite, and --vacuum to return the space to the disk');
  process.exit(0);
}

if (vacuum) {
  // Without this the file does not shrink: SQLite keeps the freed pages for
  // itself. Measured before any of this ran, freelist_count was 0, so every byte
  // released here is new free space that only a VACUUM returns.
  console.log('\nvacuuming — this rewrites the whole file and takes a while...');
  db.exec('VACUUM');
  console.log('done');
} else {
  console.log('\nspace freed inside the file; pass --vacuum to return it to the disk');
}
