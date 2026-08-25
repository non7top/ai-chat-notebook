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
db.setChatsFolder([threads[0].id], work.id);
db.setChatsFolder([threads[1].id, threads[2].id], deep.id);

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

// Bulk filing, which is the operation the counts exist to report on. It builds
// its own IN (...) list, so the id guard is checked here rather than trusted:
// this is the one query in the app that interpolates a variable-length list into
// SQL.
const rest = db.listChats({ kind: 'unfiled' }).map((c) => c.id);
const moved = db.setChatsFolder(rest, work.id);
console.log(`  bulk file: ${moved} moved into work`);
if (moved !== rest.length) throw new Error(`moved ${moved} of ${rest.length}`);
const afterBulk = db.scopeCounts();
agree('unfiled after bulk', afterBulk.unfiled, db.listChats({ kind: 'unfiled' }).length);
agree('filed after bulk', afterBulk.filed, db.listChats({ kind: 'filed' }).length);
if (afterBulk.unfiled !== 0) throw new Error('bulk filing left threads unfiled');

// Out of every folder again — null is how a drop on Unfiled is expressed, and a
// bulk unfile that quietly did nothing would look identical to one that worked.
const back = db.setChatsFolder(rest, null);
if (back !== rest.length) throw new Error(`unfiled ${back} of ${rest.length}`);
if (db.scopeCounts().unfiled !== rest.length) throw new Error('bulk unfile did not take');

// An empty pick is a no-op, not a statement with an empty IN () — which is a
// syntax error in SQLite, and would turn "drag nothing" into a crash.
if (db.setChatsFolder([], work.id) !== 0) throw new Error('an empty list moved something');

// And anything that is not an id is refused rather than pasted into the query.
let refused = false;
try {
  db.setChatsFolder([1.5 as number], work.id);
} catch {
  refused = true;
}
if (!refused) throw new Error('setChatsFolder accepted something that is not a thread id');
console.log('  empty list and non-id both refused');

// A folder's colour and icon, and the fact that a thread carries them. The
// colour ends up in a CSS class on a row, so what may be stored is checked here
// rather than left to the picker that happens to be the only caller today.
db.setFolderStyle(work.id, 'teal', '🛠');
const styled = db.listFolders().find((f) => f.id === work.id);
console.log(`  folder style: ${styled?.color} ${styled?.icon}`);
if (styled?.color !== 'teal' || styled?.icon !== '🛠') {
  throw new Error(`the style did not stick: ${JSON.stringify(styled)}`);
}
const inWork = db.listChats({ kind: 'folder', id: work.id })[0];
if (inWork?.folderName !== 'work' || inWork?.folderColor !== 'teal') {
  throw new Error('a thread does not carry its folder');
}
// An emoji is a surrogate pair, so a naive length cap would cut one in half and
// store half a character.
db.setFolderStyle(work.id, 'teal', '👨‍👩‍👧');
if ([...(db.listFolders().find((f) => f.id === work.id)?.icon ?? '')].length > 2) {
  throw new Error('the icon was not capped by code point');
}
let rejected = false;
try {
  db.setFolderStyle(work.id, 'octarine', null);
} catch {
  rejected = true;
}
if (!rejected) throw new Error('a colour outside the palette was stored');
console.log('  a colour outside the palette is refused');

// The capture queue gives up. It never did: capture_attempts was recorded from
// the first release and used only for ordering, so 18 threads sat at six and
// seven attempts each, every one failing the same way, and every run took the
// same 18 because there was nothing else to take. Two minutes per timeout.
//
// Checked here because the failure is invisible from the outside — a run that
// grinds through doomed threads looks exactly like a run doing work.
const stuck = db.listChats({ kind: 'all' }).find((c) => c.messageCount === 0);
if (!stuck) throw new Error('no empty thread to exhaust');
for (let i = 0; i < db.MAX_CAPTURE_ATTEMPTS; i += 1) db.recordCaptureFailure(stuck.id);
const queued = db.chatsWithoutTurns(100).map((c) => c.id);
console.log(`  after ${db.MAX_CAPTURE_ATTEMPTS} failures: queued=${queued.includes(stuck.id)}`);
if (queued.includes(stuck.id)) throw new Error('an exhausted thread is still queued');
if (db.countExhaustedCaptures() < 1) throw new Error('the exhausted thread is not counted');
// The label on the button and the queue the run takes must be the same set —
// offering 18 to a run that will take none of them is the same class of lie as
// a tree count that disagrees with its own list.
agree('capture queue', db.countChatsWithoutTurns(), db.chatsWithoutTurns(100000).length);
// And the deliberate way back to them.
if (!db.chatsWithoutTurns(100, true).some((c) => c.id === stuck.id)) {
  throw new Error('an exhausted thread cannot be retried on purpose');
}
console.log('  it comes back when asked for deliberately');

fs.rmSync(dir, { recursive: true, force: true });
console.log('OK');
