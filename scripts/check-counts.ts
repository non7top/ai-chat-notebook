/**
 * The tree's row counts against the lists they label.
 *
 * The tree named five scopes and put a number on none of them, so nothing on
 * screen said that 2846 of 2848 threads were unfiled — "All threads" and
 * "Unfiled" were two rows showing near-identical lists.
 *
 * Adding numbers creates a failure this codebase has already been bitten by
 * twice: a count computed by a query that is subtly not the list's query. It
 * looks authoritative and it is wrong, and the LIST is what then appears
 * broken. So every count is asserted to equal the length of the list it sits
 * beside, against a database with folders, subfolders, empty threads and
 * orphaned entries in it.
 *
 *   npm run check:counts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/main/db.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-counts-'));
db.initDb(dir);

const turn = (seq: number, role: 'user' | 'ai', text: string) => ({
  seq,
  role,
  text,
  html: `<p>${text}</p>`,
});

// Six threads from the sidebar. Two get turns, four stay empty — the capture
// backlog, which is its own scope.
for (let i = 1; i <= 6; i += 1) {
  db.upsertThreadFromList(`t:${i}`, `thread ${i}`, `https://example.invalid/${i}`, i);
}
const threads = db.listChats({ kind: 'all' });
if (threads.length !== 6) throw new Error(`expected 6 threads, got ${threads.length}`);
db.replaceTurns(threads[0].id, [turn(0, 'user', 'a'), turn(1, 'ai', 'b')], []);
db.replaceTurns(threads[1].id, [turn(0, 'user', 'c'), turn(1, 'ai', 'd')], []);

// A folder with a subfolder, so the subtree total is exercised rather than
// assumed: a collapsed parent that reads 0 while holding children is the whole
// reason that number exists.
const work = db.createFolder(null, 'work');
const deep = db.createFolder(work.id, 'deep');
db.setChatFolder(threads[0].id, work.id);
db.setChatFolder(threads[1].id, deep.id);
db.setChatFolder(threads[2].id, deep.id);

// A real orphan, not a zero. The import always links what it creates, so the
// entry is stranded the way it is stranded in practice: its conversation is
// deleted and the raw entry outlives it — which is the whole reason the scope
// exists, since nothing the app has stored may vanish from view.
//
// Asserted to be non-zero below. An orphan count checked as 0 against a list of
// 0 proves nothing, and this is the exact query I first wrote with an extra join
// to chats, which would have counted entries linked only to a merged-away
// conversation.
db.importTakeoutConversations([
  {
    query: 'an entry whose conversation goes away',
    timestamp: '2026-08-20T11:00:00+07:00',
    timestampText: 'Aug 20, 2026, 11:00:00 AM GMT+07:00',
    href: 'https://www.google.com/?udm=50&q=orphan',
    turns: [turn(0, 'user', 'an entry whose conversation goes away')],
    imageFiles: [],
  },
]);
const imported = db.listChats({ kind: 'all' }).find((c) => c.source === 'takeout');
if (!imported) throw new Error('the import created no conversation to delete');
db.deleteChat(imported.id);
if (db.orphanSourceEntries().length === 0) {
  throw new Error('deleting the conversation did not strand its entry — pick another route');
}

const counts = db.scopeCounts();
console.log(JSON.stringify(counts));

// Each count against the list it labels. This is the whole point of the file.
const agree = (label: string, n: number, listed: number) => {
  console.log(`  ${label}: count ${n} vs list ${listed}`);
  if (n !== listed) throw new Error(`${label}: count says ${n}, the list holds ${listed}`);
};
agree('all', counts.all, db.listChats({ kind: 'all' }).length);
agree('unfiled', counts.unfiled, db.listChats({ kind: 'unfiled' }).length);
agree('filed', counts.filed, db.listChats({ kind: 'filed' }).length);
agree('empty', counts.empty, db.listChats({ kind: 'empty' }).length);
agree('orphans', counts.orphans, db.orphanSourceEntries().length);
if (counts.orphans === 0) throw new Error('the orphan count was never exercised');
agree('folder work', counts.byFolder[work.id] ?? 0, db.listChats({ kind: 'folder', id: work.id }).length);
agree('folder deep', counts.byFolder[deep.id] ?? 0, db.listChats({ kind: 'folder', id: deep.id }).length);

// filed and unfiled must partition all — no thread in both, none in neither.
if (counts.filed + counts.unfiled !== counts.all) {
  throw new Error(`filed ${counts.filed} + unfiled ${counts.unfiled} != all ${counts.all}`);
}
// byFolder must account for exactly the filed ones, or a folder is missing from
// the tree's numbers while its threads exist.
const summed = Object.values(counts.byFolder).reduce((a, b) => a + b, 0);
if (summed !== counts.filed) throw new Error(`byFolder sums to ${summed}, filed is ${counts.filed}`);

// A merged-away thread is kept so the merge stays undoable, and must not be
// counted as a conversation — the same rule every list query applies.
const before = db.scopeCounts().all;
db.mergeChats(threads[3].id, [threads[4].id]);
const after = db.scopeCounts();
console.log(`  after a merge: all ${before} -> ${after.all}`);
if (after.all !== before - 1) throw new Error('a merged-away thread is still counted');
agree('all after merge', after.all, db.listChats({ kind: 'all' }).length);

fs.rmSync(dir, { recursive: true, force: true });
console.log('OK');
