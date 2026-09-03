/**
 * Exercises recovering links that an import left inside an entry's payload.
 *
 * It exists because the first version of this shipped and failed the moment it
 * was pressed: "NOT NULL constraint failed: source_entries.payload_json". That is
 * a column the schema has declared all along, and no amount of reading the
 * insert I had just written was going to tell me — only running it would, and
 * nothing ran it until the user did.
 *
 * So this asserts the whole shape rather than just "it did not throw": the
 * record carries the href, it is attached to the entry, the entry gets its url,
 * the link queue can now see it, and a second run is a no-op rather than a
 * duplicate.
 *
 *   npm run check:recover
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/main/db.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-recover-'));
db.initDb(dir);

const HREF = 'https://www.google.com/?udm=50&mstk=AUtExfBexample&csuir=1&q=example&aep=1';
const fail = (message: string): never => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};
const eq = (actual: unknown, expected: unknown, what: string) => {
  if (actual !== expected) fail(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  console.log(`  ok  ${what} = ${String(actual)}`);
};

// An entry as the older import left it: the link inside raw_json, no record
// carrying it, no url of its own. This is the shape 815 entries are in.
db.upsertThreadFromList('takeout:example-entry', 'an imported entry', null, 0);
// A second handle on the same file, so this can assert what actually landed in
// the columns rather than trusting the accessors that wrote them.
const raw = new DatabaseSync(path.join(dir, 'notebook.sqlite'));
// upsertThreadFromList reports whether it created a row, not which one, so the
// id is read back rather than assumed to be 1.
const chatId = Number(
  (raw.prepare('SELECT id FROM chats WHERE external_id = ?').get('takeout:example-entry') as {
    id: number;
  }).id,
);
raw
  .prepare('UPDATE chats SET raw_json = ?, source = ?, url = NULL WHERE id = ?')
  .run(JSON.stringify({ takeout: { href: HREF } }), 'takeout', chatId);

console.log('before:');
eq(db.planTakeoutLinkRecovery().entries, 1, 'entries with a stranded link');
eq(db.countEntriesWithLinksToFetch(), 0, 'link queue');

const first = db.recoverTakeoutLinks();
console.log('after recovering:');
eq(first.records, 1, 'records written');
eq(first.urls, 1, 'entries given a url');
eq(first.skipped, 0, 'payloads skipped');

const record = raw
  .prepare(
    `SELECT se.href, se.kind, se.external_ref, se.payload_json, se.link_state, cs.linked_by
       FROM source_entries se JOIN chat_sources cs ON cs.source_entry_id = se.id
      WHERE cs.chat_id = ?`,
  )
  .get(chatId) as
  | {
      href: string;
      kind: string;
      external_ref: string;
      payload_json: string;
      link_state: string | null;
      linked_by: string;
    }
  | undefined;
if (!record) fail('no record attached to the entry');
eq(record?.href, HREF, 'record href');
eq(record?.kind, 'takeout', 'record kind');
eq(record?.external_ref, `recovered:${chatId}`, 'record ref');
eq(record?.linked_by, 'recovered', 'link provenance');
eq(record?.link_state, null, 'link state (null is what queues it)');
// Every consumer of this column parses it; a payload that throws would break the
// records pane rather than this flow, which is exactly how it would go unnoticed.
eq(typeof JSON.parse(record?.payload_json ?? 'null'), 'object', 'payload parses');

const url = (raw.prepare('SELECT url FROM chats WHERE id = ?').get(chatId) as { url: string })
  .url;
eq(url, HREF, "the entry's own url");
eq(db.countEntriesWithLinksToFetch(), 1, 'link queue now');
eq(db.entriesWithLinksToFetch(10)[0]?.chatId, chatId, 'the queued record points back');

// Twice, because a person will press it twice.
console.log('second run:');
eq(db.planTakeoutLinkRecovery().entries, 0, 'nothing left to recover');
const second = db.recoverTakeoutLinks();
eq(second.records, 0, 'records written again');
eq(
  Number(
    (raw.prepare('SELECT COUNT(*) AS n FROM source_entries').get() as { n: number }).n,
  ),
  1,
  'records in total',
);

fs.rmSync(dir, { recursive: true, force: true });
console.log('OK');
