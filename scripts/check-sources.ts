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
import { DatabaseSync } from 'node:sqlite';
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
    timestampText: 'Aug 19, 2026, 3:09:33 AM GMT+07:00',
    href: 'https://www.google.com/?udm=50&q=a',
    turns: [turn('user', 'how do sprites get generated'), turn('ai', 'first answer')],
    imageFiles: [],
  },
  {
    query: 'how do sprites get generated',
    timestamp: '2026-08-20T11:00:00+07:00',
    timestampText: 'Aug 20, 2026, 11:00:00 AM GMT+07:00',
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
// ---------------------------------------------------------------------------
// Re-importing on top of a grouping an earlier run got wrong.
//
// This is the repair path for the database that already exists: the buggy
// import folded two entries into one conversation and threw away the shorter
// reading, and re-importing the same export is supposed to undo that.
//
// Run twice, because the importer's licence to delete a link cuts both ways and
// the two cases are the same DELETE told apart only by linked_by. It may remove
// a link its own earlier run made; it may not remove one made by hand. Testing
// either alone proves nothing about the other.
function repairScenario(glueByHand: boolean): void {
  const label = glueByHand ? 'hand-glued' : 'left as the importer made it';
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-regroup-'));
  db.initDb(scratch);

  // The wrong state: one conversation carrying the LATER entry's four turns,
  // with both entries linked to it by the importer — what the old code left.
  db.importTakeoutConversations([rows[0]] as never);
  const [wrong] = db.listChats({ kind: 'all' });
  db.importTakeoutConversations([rows[1]] as never);
  const separate = db.listChats({ kind: 'all' }).find((c) => c.id !== wrong.id);
  if (!separate) throw new Error('expected a second conversation to borrow its entry from');
  const stray = db.sourceEntriesForChat(separate.id).filter((e) => e.linked)[0];
  db.deleteChat(separate.id);

  // Written straight into the file, on a second connection, because this is the
  // state the OLD code left and no code path produces it any more. Doing it
  // through an exported helper would mean adding a way to corrupt the database
  // to the app itself, just to test the repair.
  const raw = new DatabaseSync(path.join(scratch, 'notebook.sqlite'));
  raw
    .prepare(
      "INSERT INTO chat_sources (chat_id, source_entry_id, linked_by) VALUES (?, ?, 'import')",
    )
    .run(wrong.id, stray.id);
  raw.prepare('DELETE FROM messages WHERE chat_id = ?').run(wrong.id);
  const insertWrong = raw.prepare(
    'INSERT INTO messages (chat_id, seq, role, text, html) VALUES (?, ?, ?, ?, ?)',
  );
  rows[1].turns.forEach((t, i) => insertWrong.run(wrong.id, i, t.role, t.text, t.html));
  raw.close();

  if (glueByHand) db.linkSourceEntry(wrong.id, stray.id);

  console.log(
    `\nwrong state (${label}): chat ${wrong.id} holds`,
    db.getChat(wrong.id)?.messageCount,
    'turns, entries linked:',
    db.sourceEntriesForChat(wrong.id).filter((e) => e.linked).map((e) => e.id),
    '| conversations:',
    db.listChats({ kind: 'all' }).length,
  );

  const repair = db.importTakeoutConversations(rows as never);
  const after = db.listChats({ kind: 'all' });
  const linked = db.sourceEntriesForChat(wrong.id).filter((e) => e.linked).map((e) => e.id);
  console.log(
    're-import:',
    `regrouped=${repair.regrouped} ambiguous=${repair.ambiguousOpenings}`,
    '| conversations:',
    after.map((c) => `${c.id}:${c.messageCount}t`).join(' '),
    '| entries on the repaired chat:',
    linked,
  );

  // Both readings must be back in full either way: repairing the turns is
  // independent of what happens to the links.
  if (after.length !== 2) throw new Error(`expected 2 conversations, got ${after.length}`);
  const totals = after.map((c) => c.messageCount).sort((a, b) => a - b);
  if (totals[0] !== 2 || totals[1] !== 4) {
    throw new Error(`both readings should be back in full, got ${totals.join('/')}`);
  }

  if (glueByHand) {
    if (!linked.includes(stray.id)) throw new Error('the re-import removed a link made by hand');
    if (repair.regrouped !== 0) throw new Error('a hand-made link was counted as regrouped');
  } else {
    if (linked.includes(stray.id)) {
      throw new Error('the stale link from the wrong grouping survived the re-import');
    }
    if (repair.regrouped !== 1) throw new Error(`expected 1 regrouped, got ${repair.regrouped}`);
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

repairScenario(false);
repairScenario(true);

// ---------------------------------------------------------------------------
// The placeholder date, and whether it lets go.
//
// A conversation read from the panel has no date anywhere, so the app records
// when it first saved it as a stand-in. The whole risk of that is a stand-in
// that sticks: it would look like a date, sort like a date, and quietly claim
// that years of history all happened the week the app was installed. So what is
// actually checked here is that a real date displaces it.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-dates-'));
  db.initDb(scratch);

  const dated = {
    query: 'why does the placeholder need to let go',
    timestamp: '2026-08-19T03:09:33+07:00',
    timestampText: 'Aug 19, 2026, 3:09:33 AM GMT+07:00',
    href: null,
    turns: [turn('user', 'why does the placeholder need to let go'), turn('ai', 'because')],
    imageFiles: [],
  };

  db.upsertThreadFromList('thread-dates', dated.query, null, 0);
  const [chat] = db.listChats({ kind: 'all' });
  console.log('\nbefore capture:', `date=${chat.startedAt} basis=${chat.dateBasis}`);
  if (chat.startedAt !== null) throw new Error('a listed conversation should have no date yet');

  db.replaceTurns(
    chat.id,
    dated.turns.map((t, i) => ({ seq: i, role: t.role, text: t.text, html: t.html })),
    [],
  );
  const captured = db.listChats({ kind: 'all' })[0];
  console.log('after capture:', `date=${captured.startedAt} basis=${captured.dateBasis}`);
  if (captured.dateBasis !== 'placeholder') {
    throw new Error(`expected a placeholder date, got ${captured.dateBasis}`);
  }

  db.importTakeoutConversations([dated] as never);
  const enriched = db.listChats({ kind: 'all' }).find((c) => c.id === chat.id);
  console.log('after the export arrives:', `date=${enriched?.startedAt} basis=${enriched?.dateBasis}`);
  if (enriched?.dateBasis !== 'takeout' || enriched.startedAt !== dated.timestamp) {
    throw new Error('the placeholder survived a real date — it must be displaced');
  }

  // And a real date is not downgraded by a later capture.
  db.replaceTurns(chat.id, [{ seq: 0, role: 'user', text: 'again', html: null }], []);
  const after = db.listChats({ kind: 'all' }).find((c) => c.id === chat.id);
  console.log('after a later capture:', `date=${after?.startedAt} basis=${after?.dateBasis}`);
  if (after?.dateBasis !== 'takeout' || after.startedAt !== dated.timestamp) {
    throw new Error('a capture overwrote a real date with a placeholder');
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The sweep must predict the import.
//
// A preview that reimplements the decision is worse than none: it would
// describe an import that never happens, and the gap would show up as lost
// conversations rather than as a wrong number. Both go through placeEntry, and
// this is what holds them to it.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-sweep-'));
  db.initDb(scratch);

  // A conversation already known from the sidebar, so the enrichment case is
  // exercised and not just creation.
  db.upsertThreadFromList('thread-sweep', 'a question asked once', null, 0);
  const solo = {
    query: 'a question asked once',
    timestamp: '2026-08-18T10:00:00+07:00',
    timestampText: 'Aug 18, 2026, 10:00:00 AM GMT+07:00',
    href: null,
    turns: [turn('user', 'a question asked once'), turn('ai', 'answered')],
    imageFiles: [],
  };
  const batch = [solo, ...rows];

  const before = db.previewTakeoutImport(batch as never);
  console.log('\nsweep:', JSON.stringify(before));
  const actual = db.importTakeoutConversations(batch as never);
  console.log('import:', JSON.stringify(actual));

  const claims: [string, number, number][] = [
    ['created', before.wouldCreate, actual.created],
    ['ambiguous', before.ambiguous, actual.ambiguousOpenings],
    // wouldEnrich covers both the capture merge and the plain extend, which the
    // import counts in two different fields.
    ['enriched', before.wouldEnrich, actual.extended + actual.mergedIntoHarvested],
  ];
  for (const [what, predicted, got] of claims) {
    console.log(`  ${what}: predicted ${predicted}, got ${got}`);
    if (predicted !== got) throw new Error(`sweep mispredicted ${what}: ${predicted} vs ${got}`);
  }

  // Run twice: the second sweep must report everything as already known, and
  // the second import must create nothing.
  const second = db.previewTakeoutImport(batch as never);
  console.log('second sweep:', JSON.stringify(second));
  if (second.alreadyKnown !== batch.length) {
    throw new Error(`re-sweep should know all ${batch.length}, knew ${second.alreadyKnown}`);
  }
  if (second.wouldCreate !== 0) throw new Error('a re-import would create duplicates');
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Nothing is ever lost.
//
// An entry with no opening prompt cannot be made into a conversation — there is
// nothing to identify it by. It used to be skipped before being stored at all,
// which is the one outcome this design does not allow. It must survive as an
// orphan: kept verbatim, attached to nothing, and reachable.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-noloss-'));
  db.initDb(scratch);

  const placeless = {
    query: '',
    timestamp: null,
    timestampText: null,
    href: null,
    turns: [turn('ai', 'an answer with no prompt above it')],
    imageFiles: [],
  };
  // Two of them, differing only in content, to prove the payload-derived
  // identity keeps them apart instead of collapsing them into one.
  const alsoPlaceless = {
    ...placeless,
    turns: [turn('ai', 'a different answer with no prompt above it')],
  };

  const sweep = db.previewTakeoutImport([placeless, alsoPlaceless] as never);
  const result = db.importTakeoutConversations([placeless, alsoPlaceless] as never);
  console.log('\nplaceless entries — sweep says orphan:', sweep.wouldOrphan);
  console.log('  import orphaned:', result.orphaned, '| conversations made:', result.created);
  const orphans = db.orphanSourceEntries();
  console.log('  listed as orphans:', orphans.length, '| turns readable:', orphans.map((e) => e.turnCount));
  if (sweep.wouldOrphan !== 2) throw new Error(`sweep should predict 2 orphans, said ${sweep.wouldOrphan}`);
  if (result.created !== 0) throw new Error('a promptless entry became a conversation');
  if (orphans.length !== 2) throw new Error(`both entries must survive, found ${orphans.length}`);
  if (db.sourceEntryTurns(orphans[0].id).length !== 1) throw new Error('an orphan lost its turn');

  // Re-importing must recognise them, not duplicate them.
  db.importTakeoutConversations([placeless, alsoPlaceless] as never);
  const again = db.orphanSourceEntries();
  console.log('  after re-import:', again.length);
  if (again.length !== 2) throw new Error(`re-import duplicated orphans: ${again.length}`);
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// An export image reaches its conversation.
//
// The bytes were being copied into the asset store and then abandoned: no row
// pointed at them, so the app could not count them, show them, or find them
// again. A file on disk that nothing references is lost in every sense that
// matters, and the count said zero images for a conversation that had one.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-images-'));
  db.initDb(scratch);

  const withImage = {
    query: 'draw me a sprite',
    timestamp: '2026-08-17T09:00:00+07:00',
    timestampText: 'Aug 17, 2026, 9:00:00 AM GMT+07:00',
    href: null,
    turns: [turn('user', 'draw me a sprite'), turn('ai', "here's your generated image")],
    imageFiles: ['sprite.png'],
  };
  db.importTakeoutConversations([withImage] as never);

  // The ref must be derivable from the row alone — that is what lets an image
  // find its entry after the import has finished.
  const ref = db.takeoutEntryRef(withImage.turns[0].text, withImage.timestamp, {
    turns: withImage.turns,
    images: withImage.imageFiles,
    href: withImage.href,
  });
  const chatId = db.chatIdForEntry(ref);
  console.log('\nexport image — entry resolves to chat:', chatId);
  if (chatId === null) throw new Error('an entry could not be found again by its own ref');

  const before = db.listChats({ kind: 'all' })[0];
  db.attachExportImage(chatId, {
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    localPath: '/nowhere/a.png',
    bytes: 1234,
  });
  const after = db.listChats({ kind: 'all' })[0];
  console.log(`  image count ${before.imageCount} -> ${after.imageCount}`);
  if (after.imageCount !== before.imageCount + 1) {
    throw new Error('an attached export image was not counted');
  }
  // Counted as a real image, not as page furniture.
  if (after.previewCount !== 0) throw new Error('an export image was counted as a preview');
  fs.rmSync(scratch, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('OK');
