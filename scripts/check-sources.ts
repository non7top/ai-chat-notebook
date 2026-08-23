/**
 * Exercises the source-entry model against a real database: import, glue,
 * unglue, adopt, orphan listing.
 *
 * Runs outside Electron because initDb takes its path as an argument, so the
 * whole storage layer is testable with nothing mocked — these are the real
 * queries against real SQLite, not a reimplementation of them.
 *
 * It exists because this model's failures are silent ones. A correlated
 * subquery that matches nothing looks exactly like "no entries"; a scope that
 * falls through to the folder query looks exactly like "no orphans"; a wrong
 * grouping looks exactly like a conversation. Every claim below is printed so a
 * regression shows up as a changed number rather than an empty pane.
 *
 * Excluded from tsconfig.json: node --experimental-strip-types needs the .ts
 * import extension that tsc refuses. It still typechecks by proxy — every
 * function it calls is checked where it is defined, and a signature change
 * breaks this script the next time it runs.
 *
 *   npm run check:sources
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/main/db.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-check-'));
db.initDb(dir);

const turn = (role: 'user' | 'ai', text: string) => ({ role, text, html: `<p>${text}</p>` });

// Two entries with the SAME opening prompt at different times: the case the
// user described — either one conversation snapshotted twice, or two separate
// asks. Import must NOT decide.
const rows = [
  {
    query: 'how do sprites get generated',
    timestamp: '2026-08-19T03:09:33+07:00',
    href: 'https://www.google.com/?udm=50&q=a',
    turns: [turn('user', 'how do sprites get generated'), turn('ai', 'first answer')],
    imageFiles: [],
  },
  {
    query: 'how do sprites get generated',
    timestamp: '2026-08-20T11:00:00+07:00',
    href: 'https://www.google.com/?udm=50&q=b',
    turns: [
      turn('user', 'how do sprites get generated'),
      turn('ai', 'second, different answer'),
      turn('user', 'follow up'),
      turn('ai', 'more'),
    ],
    imageFiles: [],
  },
];

// A conversation the app already knows about from the sidebar, with no turns
// yet. An entry with the same opening MUST attach to this rather than making a
// second row: that is the enrichment path — the export carries the text and the
// date, the panel carries the images — and narrowing the candidate query to stop
// entries grouping into each other could easily have broken it.
db.upsertThreadFromList(
  'thread-abc',
  'how do sprites get generated',
  'https://www.google.com/search?udm=50',
  0,
);

const summary = db.importTakeoutConversations(rows as never);
console.log('import:', JSON.stringify(summary));

const harvested = db.listChats({ kind: 'all' }).find((c) => c.title.startsWith('how do sprites'));
console.log(
  'harvested chat after import:',
  harvested && `${harvested.id}:${harvested.messageCount}t:${harvested.sources}`,
);

const chats = db.listChats({ kind: 'all' }).filter((c) => c.id !== harvested?.id);
console.log('chats after import:', chats.length, chats.map((c) => `${c.id}:${c.messageCount}t`).join(' '));

const first = chats[0];
const entries = db.sourceEntriesForChat(first.id);
console.log(
  'entries visible on chat',
  first.id,
  entries.map((e) => `#${e.id} ${e.kind} linked=${e.linked} chats=${e.chatCount} turns=${e.turnCount} date=${e.occurredAt}`),
);

console.log('similar to', first.id, '->', db.similarChats(first.id).map((c) => c.id));

// Glue the two, then unglue by entry — the entry must come back as its own
// conversation with its own id and its own link, not as an orphan.
const other = chats.find((c) => c.id !== first.id);
if (!other) throw new Error('expected two conversations');
console.log('merge:', JSON.stringify(db.mergeChats(first.id, [other.id])));
console.log('chats after glue:', db.listChats({ kind: 'all' }).length);

// Gluing must move the loser's entries onto the keeper: a conversation with
// three entries attached is what a glue of three IS, and the keeper's list is
// the only place they can be reviewed or taken apart.
const both = db.sourceEntriesForChat(first.id).filter((e) => e.linked);
console.log('keeper holds after glue:', both.map((e) => `#${e.id} chats=${e.chatCount}`));
if (both.length !== 2) throw new Error(`glue did not move entries: keeper holds ${both.length}`);

// And unmerging must give them back, exactly.
db.unmergeChat(other.id);
console.log(
  'after unmerge — keeper:',
  db.sourceEntriesForChat(first.id).filter((e) => e.linked).map((e) => e.id),
  'loser:',
  db.sourceEntriesForChat(other.id).filter((e) => e.linked).map((e) => e.id),
  '| conversations listed:',
  db.listChats({ kind: 'all' }).length,
);
db.mergeChats(first.id, [other.id]);

const regrouped = db.sourceEntriesForChat(first.id).filter((e) => e.linked);
const split = db.unglueSourceEntry(first.id, regrouped[1].id);
console.log('unglue ->  new chat id', split.chatId);
const after = db.listChats({ kind: 'all' });
console.log('chats after unglue:', after.map((c) => `${c.id}:${c.messageCount}t:${c.sources}`).join(' '));
console.log('keeper entries now:', db.sourceEntriesForChat(first.id).filter((e) => e.linked).map((e) => e.id));
console.log('new chat entries:', db.sourceEntriesForChat(split.chatId).filter((e) => e.linked).map((e) => e.id));

// Ungluing the same entry twice must reuse the conversation, not pile up rows.
db.linkSourceEntry(first.id, regrouped[1].id);
const again = db.unglueSourceEntry(first.id, regrouped[1].id);
console.log('unglue again -> same chat?', again.chatId === split.chatId, again.chatId);

// Orphans. An entry is only orphaned once NOTHING points at it, which the
// many-to-many link makes easy to get wrong: deleting the conversation an entry
// was unglued into leaves it attached to the one it was unglued from.
console.log('orphans before:', db.orphanSourceEntries().length);
for (const c of db.listChats({ kind: 'all' })) db.deleteChat(c.id);
const orphans = db.orphanSourceEntries();
console.log(
  'orphans once every conversation is gone:',
  orphans.map((e) => `#${e.id} turns=${e.turnCount} date=${e.occurredAt}`),
);
if (orphans.length !== 2) throw new Error(`expected both entries orphaned, got ${orphans.length}`);
console.log('orphan readable in full:', db.sourceEntryTurns(orphans[0].id).length, 'turns');

// Adopting rebuilds a conversation from the entry alone — the entries really
// are enough to reconstruct from, which is the reason for storing them apart.
const adopted = db.adoptSourceEntry(orphans[0].id, null);
const rebuilt = db.getChat(adopted.chatId);
console.log(
  'adopt ->',
  adopted.chatId,
  `${rebuilt?.messageCount}t`,
  rebuilt?.sources,
  '| orphans now:',
  db.orphanSourceEntries().length,
);
if (rebuilt?.messageCount !== orphans[0].turnCount) {
  throw new Error('adopted conversation lost turns');
}
console.log('orphans scope returns no chats:', db.listChats({ kind: 'orphans' }).length === 0);
fs.rmSync(dir, { recursive: true, force: true });
console.log('OK');
