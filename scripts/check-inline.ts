/**
 * The has_inline flag, the trigger that maintains it, and the count that reads
 * it.
 *
 * This exists because of what it replaced. "How many turns still hold base64"
 * was answered by LIKE '%data:image%' over messages.html — and on the real
 * archive that column is 780 MB of a 959 MB file. node:sqlite is synchronous,
 * so the scan ran on the main process's only thread: measured at 79 seconds
 * cold, and it sat on the startup path. The window was dead for ten seconds on
 * every launch.
 *
 * The replacement is a flag column kept up to date by trigger. A flag that
 * silently stops matching the markup is worse than the slow scan was, because
 * the number still looks right — so every claim about it is checked here.
 *
 * Rows are inserted over a SECOND connection on purpose: the trigger has to be
 * part of the schema rather than something the writing code remembers to do,
 * and a separate connection is the only way to prove that.
 *
 *   npm run check:inline
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/main/db.ts';
import type { InlineImageCount } from '../src/shared/types.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-inline-'));
db.initDb(dir);

const raw = new DatabaseSync(path.join(dir, 'notebook.sqlite'));
raw.exec(`
  INSERT INTO chats (external_id, last_seen_at, source, raw_json)
  VALUES ('t:1', '2026-08-24T00:00:00Z', 'capture', '{}');
`);
const insert = raw.prepare(
  'INSERT INTO messages (chat_id, seq, role, text, html) VALUES (1, ?, ?, ?, ?)',
);
const base64 = '<img src="data:image/png;base64,iVBORw0KGgo=">';
insert.run(0, 'user', 'a question', `<p>a question</p>${base64}`);
insert.run(1, 'ai', 'an answer', '<p>an answer</p><img src="assets/aa/aa.jpg">');
insert.run(2, 'ai', 'no markup at all', null);

let count = db.countMessagesWithInlineImages();
console.log(`after insert: ${count.inline} inline, ${count.unexamined} unexamined`);
if (count.inline !== 1) throw new Error(`the trigger did not flag the base64 row (${count.inline})`);
// NULL html must resolve to 0, not to NULL. Left NULL it would count as
// unexamined forever, and the backfill would never drain.
if (count.unexamined !== 0) {
  throw new Error(`a row was left unexamined (${count.unexamined}) — check the COALESCE`);
}

// The repair pass rewrites html. The flag has to follow it down, or the button
// keeps offering work that is already done.
const row = db.messagesWithInlineImages(10)[0];
if (!row) throw new Error('the flagged row was not selected for repair');
db.replaceMessageHtml(row.id, '<p>a question</p><img src="assets/bb/bb.png">');
count = db.countMessagesWithInlineImages();
console.log(`after the repair rewrote it: ${count.inline} inline`);
if (count.inline !== 0) throw new Error(`the flag survived the rewrite (${count.inline})`);
if (db.messagesWithInlineImages(10).length !== 0) {
  throw new Error('a repaired row is still offered for repair');
}

// And back the other way: markup that gains base64 must be flagged again.
db.replaceMessageHtml(row.id, base64);
if (db.countMessagesWithInlineImages().inline !== 1) {
  throw new Error('the trigger did not re-flag markup that gained base64');
}

// The backfill, for rows written before the column existed. Simulated by
// clearing the flag, which is exactly the state an upgrade leaves behind.
raw.exec('UPDATE messages SET has_inline = NULL');
count = db.countMessagesWithInlineImages();
console.log(`before the backfill: ${count.inline} inline, ${count.unexamined} unexamined`);
if (count.unexamined !== 3) throw new Error(`expected 3 unexamined, got ${count.unexamined}`);
// One row per slice, so the slicing itself is exercised rather than assumed.
let slices = 0;
for (;;) {
  const { examined, remaining } = db.examineInlineImages(1);
  slices += 1;
  if (remaining === 0) break;
  if (examined === 0) throw new Error('the backfill stopped making progress');
  if (slices > 10) throw new Error('the backfill did not converge');
}
count = db.countMessagesWithInlineImages();
console.log(`after ${slices} slices: ${count.inline} inline, ${count.unexamined} unexamined`);
if (count.inline !== 1 || count.unexamined !== 0) {
  throw new Error(`the backfill got it wrong: ${JSON.stringify(count)}`);
}

// The label. Checked because the version that used to be inlined in the menu
// ADDED the two counts together — different quantities in different units — and
// read "(23263)" on an archive holding 2245. Nothing could catch that: both
// numbers were real, the arithmetic was valid, and the result was nonsense.
const { inlineImageLabel, inlineImagesWorthMoving } = await import(
  '../src/shared/inlineLabel.ts'
);
const cases: [InlineImageCount, string, boolean][] = [
  // Nothing looked at yet: no number, because none is known. This is the state a
  // fresh upgrade is in, and the one that produced the wrong figure.
  [{ inline: 0, unexamined: 23263 }, 'Move inline images out of the text…', true],
  // Some found, more to check: a lower bound, marked as one.
  [{ inline: 2245, unexamined: 21018 }, 'Move inline images out of the text (2245+)', true],
  // Everything checked: the number, exactly.
  [{ inline: 2245, unexamined: 0 }, 'Move inline images out of the text (2245)', true],
  // Checked and clean: the only state where there is nothing to offer.
  [{ inline: 0, unexamined: 0 }, 'Move inline images out of the text (0)', false],
];
for (const [count, expected, offered] of cases) {
  const label = inlineImageLabel(count);
  console.log(`  ${JSON.stringify(count)} -> "${label}" offered=${inlineImagesWorthMoving(count)}`);
  if (label !== expected) throw new Error(`expected "${expected}", got "${label}"`);
  if (inlineImagesWorthMoving(count) !== offered) {
    throw new Error(`${JSON.stringify(count)} should ${offered ? '' : 'not '}be offered`);
  }
  // The specific mistake, guarded directly: the label must never name the sum.
  if (count.unexamined > 0 && label.includes(String(count.inline + count.unexamined))) {
    throw new Error('the label is naming inline + unexamined again');
  }
}

raw.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('OK');
