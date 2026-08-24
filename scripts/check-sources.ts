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

// Identified by SOURCE, not by title. An imported thread takes its opening
// prompt as its title, so the sidebar-listed thread and the imported one share
// one — and .find then returned whichever the list happened to order first,
// which made this check depend on the sort.
const harvested = db.listChats({ kind: 'all' }).find((c) => c.sources.includes('harvest'));
console.log(
  'harvested chat after import:',
  harvested && `${harvested.id}:${harvested.messageCount}t:${harvested.sources}`,
);

// Chosen by turn count, not by list position. Picking chats[0] made this check
// depend on the list's ORDER BY, so changing the sort broke it while nothing
// about gluing had changed.
const chats = db
  .listChats({ kind: 'all' })
  .filter((c) => c.id !== harvested?.id)
  .sort((a, b) => b.messageCount - a.messageCount);
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
const keeperEntriesBefore = db.sourceEntriesForChat(first.id).filter((e) => e.linked).length;
const loserEntriesBefore = db.sourceEntriesForChat(other.id).filter((e) => e.linked).length;
console.log('merge:', JSON.stringify(db.mergeChats(first.id, [other.id])));
console.log('chats after glue:', db.listChats({ kind: 'all' }).length);

// Gluing must move the loser's entries onto the keeper: a conversation with
// three entries attached is what a glue of three IS, and the keeper's list is
// the only place they can be reviewed or taken apart.
// Asserted as a conservation law rather than a fixed number: whatever the two
// threads held between them before the glue, the keeper holds afterwards. The
// literal 2 encoded an assumption about which thread the list returned first,
// so it broke when the sort changed while gluing itself was untouched.
const both = db.sourceEntriesForChat(first.id).filter((e) => e.linked);
console.log(
  `keeper held ${keeperEntriesBefore} + loser ${loserEntriesBefore} -> keeper holds`,
  both.map((e) => `#${e.id} chats=${e.chatCount}`),
);
if (both.length !== keeperEntriesBefore + loserEntriesBefore) {
  throw new Error(
    `glue lost entries: ${keeperEntriesBefore} + ${loserEntriesBefore} became ${both.length}`,
  );
}

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

  // A date read off the panel replaces a placeholder, and an export's date then
  // replaces THAT: the panel gives the day, the export gives the second, and a
  // coarser fact must not overwrite a finer one.
  const panelOnly = db.listChats({ kind: 'all' })[0];
  db.setPanelDate(panelOnly.id, '2026-08-18T12:00:00');
  const afterPanel = db.listChats({ kind: 'all' })[0];
  console.log('panel date over a real one:', `${afterPanel.startedAt} basis=${afterPanel.dateBasis}`);
  if (afterPanel.dateBasis !== 'takeout') {
    throw new Error('a day-precision panel date overwrote a second-precision export date');
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

  // Wholly empty cells: no prompt, no turns, no images. Their payloads are
  // IDENTICAL, so hashing the payload alone gave every one of them the same
  // reference and kept a single row — 259 records collapsing to one. Only the
  // timestamp tells them apart, and they are meant to be preserved.
  const empties = [
    { query: '', timestamp: '2026-08-02T07:42:02+07:00', timestampText: null, href: null, turns: [], imageFiles: [] },
    { query: '', timestamp: '2026-08-03T07:42:02+07:00', timestampText: null, href: null, turns: [], imageFiles: [] },
    { query: '', timestamp: '2026-08-04T07:42:02+07:00', timestampText: null, href: null, turns: [], imageFiles: [] },
  ];
  db.importTakeoutConversations(empties as never);
  const withEmpties = db.orphanSourceEntries();
  console.log('  empty cells preserved:', withEmpties.length - again.length, 'of 3');
  if (withEmpties.length !== again.length + 3) {
    throw new Error(`empty cells collapsed: kept ${withEmpties.length - again.length} of 3`);
  }
  // And each keeps its own date, which is the only thing it has.
  const dates = withEmpties.filter((e) => e.turnCount === 0).map((e) => e.occurredAt).sort();
  console.log('  their dates:', dates);
  if (new Set(dates).size !== 3) throw new Error('empty cells lost their distinct dates');
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
  // Inside the real assets directory, because a path outside it is deliberately
  // refused — resolved against the assets base in the renderer it would point
  // somewhere else on the disk entirely.
  const inStore = (name: string) => path.join(db.getAssetsDir(), name.slice(0, 2), name);
  db.attachExportImage(chatId, {
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    localPath: inStore(`${'a'.repeat(64)}.png`),
    bytes: 1234,
  });
  const after = db.listChats({ kind: 'all' })[0];
  console.log(`  image count ${before.imageCount} -> ${after.imageCount}`);
  if (after.imageCount !== before.imageCount + 1) {
    throw new Error('an attached export image was not counted');
  }
  // Counted as a real image, not as page furniture.
  if (after.previewCount !== 0) throw new Error('an export image was counted as a preview');

  // And it becomes the row's thumbnail, as a relative path the renderer can
  // resolve the same way it resolves images inside stored turn HTML.
  console.log('  title image:', after.titleImage);
  if (!after.titleImage?.startsWith('assets/') || after.titleImage.includes('..')) {
    throw new Error(`title image should be a relative assets/ path, got ${after.titleImage}`);
  }

  // A preview must never become the face of a conversation.
  db.attachExportImage(chatId, {
    sha256: 'b'.repeat(64),
    mime: 'image/png',
    localPath: inStore(`${'b'.repeat(64)}.png`),
    bytes: 1,
  });
  const stable = db.listChats({ kind: 'all' })[0];
  if (stable.titleImage !== after.titleImage) {
    throw new Error('the thumbnail moved when a later image was added');
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The thumbnail is the image the conversation STARTED with.
//
// The first version took the earliest image anywhere, so a conversation
// beginning with text was represented by whatever picture turned up later — and
// for captures made before images were classified, that was usually a rich link
// preview. Each case below is built explicitly, because the version of this
// check that inferred them from earlier fixtures reported "n/a" and proved
// nothing.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-thumb-'));
  db.initDb(scratch);
  const inStore = (c: string) => path.join(db.getAssetsDir(), c.repeat(2), `${c.repeat(64)}.png`);
  const asset = (seq: number, kind: string | null, c: string) => ({
    messageSeq: seq,
    kind,
    originalUrl: null,
    sha256: c.repeat(64),
    mime: 'image/png',
    localPath: inStore(c),
    bytes: 1,
  });
  const sixTurns = Array.from({ length: 6 }, (_, i) => ({
    seq: i,
    role: (i % 2 === 0 ? 'user' : 'ai') as 'user' | 'ai',
    text: `turn ${i}`,
    html: null,
  }));

  const make = (ext: string, assets: ReturnType<typeof asset>[]): number => {
    db.upsertThreadFromList(ext, ext, null, 0);
    const id = db.listChats({ kind: 'all' }).find((c) => c.title === ext)?.id as number;
    db.replaceTurns(id, sixTurns, assets);
    return id;
  };
  const thumbOf = (id: number) =>
    db.listChats({ kind: 'all' }).find((c) => c.id === id)?.titleImage ?? null;

  // Opens with an upload: shown.
  const opens = make('opens-with-image', [asset(0, 'upload', 'a')]);
  // Text first, a generated picture five turns in: NOT the opening image.
  const later = make('image-much-later', [asset(5, 'generated', 'b')]);
  // A link preview at the opening: never the face of a conversation.
  const preview = make('opens-with-preview', [asset(0, 'other', 'c')]);
  // Captured before kinds existed, so nothing is known about it. This is the
  // case that produced the random thumbnails.
  const unknown = make('unclassified', [asset(0, null, 'd')]);

  for (const [what, id, want] of [
    ['opens with an image', opens, true],
    ['image only later', later, false],
    ['opens with a preview', preview, false],
    // Reversed deliberately: requiring a known kind meant nothing qualified,
    // since every image captured before that column existed is unclassified and
    // that is most of the archive. The opening-turn restriction is what keeps
    // favicons out, and it still applies.
    ['unclassified image at the opening', unknown, true],
  ] as const) {
    const got = thumbOf(id) !== null;
    console.log(`  ${what}: thumbnail ${got ? 'shown' : 'none'}`);
    if (got !== want) throw new Error(`${what}: expected ${want ? 'a thumbnail' : 'none'}`);
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Snapshots of one conversation, versus two conversations that merely open the
// same way.
//
// This is the distinction both earlier attempts got wrong in opposite
// directions: one conversation per entry turned 981 entries into 736 phantom
// chats, and grouping by opening prompt collapsed genuinely separate
// conversations into one. Prefix consistency decides it without guessing, and
// all three cases are checked here because getting any one of them wrong looks
// like ordinary success.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-plan-'));
  db.initDb(scratch);
  const entry = (ts: string, turns: { role: 'user' | 'ai'; text: string; html: string }[]) => ({
    query: turns[0].text,
    timestamp: ts,
    timestampText: null,
    href: null,
    turns,
    imageFiles: [],
  });

  const q = turn('user', 'how do sprites get generated');
  const a1 = turn('ai', 'first answer');
  const q2 = turn('user', 'and the palette?');
  const a2 = turn('ai', 'about palettes');

  // Three snapshots of ONE conversation: each is the previous plus more.
  const snap1 = entry('2026-08-19T01:00:00+07:00', [q, a1]);
  const snap2 = entry('2026-08-19T02:00:00+07:00', [q, a1, q2]);
  const snap3 = entry('2026-08-19T03:00:00+07:00', [q, a1, q2, a2]);
  // Same opening, different answer — a separate conversation, or Google's clone.
  const diverged = entry('2026-08-20T01:00:00+07:00', [q, turn('ai', 'a different answer')]);
  // Its own snapshot, which must attach to IT and not to the first chain.
  const divergedLater = entry('2026-08-20T02:00:00+07:00', [
    q,
    turn('ai', 'a different answer'),
    turn('user', 'follow up'),
  ]);

  const plans = db.planConversations([snap2, diverged, snap1, divergedLater, snap3] as never);
  console.log(
    '\nplans:',
    plans.map((p) => `${p.snapshots.length} snapshots → ${p.best.turns.length} turns`),
  );
  if (plans.length !== 2) throw new Error(`expected 2 conversations, got ${plans.length}`);
  const sizes = plans.map((p) => p.snapshots.length).sort((a, b) => a - b);
  if (sizes[0] !== 2 || sizes[1] !== 3) {
    throw new Error(`snapshots should split 3 and 2, got ${sizes.join('/')}`);
  }
  // The longest snapshot is the conversation; the shorter ones are its history.
  const longest = plans.map((p) => p.best.turns.length).sort((a, b) => b - a);
  if (longest[0] !== 4 || longest[1] !== 3) {
    throw new Error(`furthest-along snapshots should be 4 and 3 turns, got ${longest.join('/')}`);
  }
  // Order of arrival must not change the outcome — the export is not sorted.
  const shuffled = db.planConversations([snap3, divergedLater, snap1, diverged, snap2] as never);
  if (shuffled.length !== plans.length) {
    throw new Error('the grouping depends on the order entries arrive in');
  }

  // The same question asked twice with identical answers is indistinguishable
  // from one conversation logged twice, and is deliberately treated as one:
  // there is nothing in the text to tell them apart, and inventing a second
  // conversation would be a guess in the other direction.
  const twice = db.planConversations([snap1, entry('2026-08-25T00:00:00+07:00', [q, a1])] as never);
  console.log('identical entries collapse to:', twice.length);
  if (twice.length !== 1) throw new Error('identical entries should not make two conversations');
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The Empty threads scope.
//
// A thread with no turns looks exactly like a full one in a list of hundreds, so
// the capture backlog is only findable as a category. The scope has to return
// precisely those and nothing else — the 'orphans' scope once fell through to
// the folder query and matched nothing, which looked identical to an empty
// backlog.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-empty-'));
  db.initDb(scratch);

  db.upsertThreadFromList('empty-1', 'never read', null, 0);
  db.upsertThreadFromList('empty-2', 'also never read', null, 1);
  db.upsertThreadFromList('has-turns', 'read already', null, 2);
  const full = db.listChats({ kind: 'all' }).find((c) => c.title === 'read already');
  if (!full) throw new Error('fixture missing');
  db.replaceTurns(full.id, [{ seq: 0, role: 'user', text: 'something', html: null }], []);

  // A thread with no Google thread id must never enter the capture queue: the
  // panel cannot open it, so it would fail on every run, and a run of them
  // together trips the consecutive-failure abort and stops a capture with real
  // work still to do. entry:% ids — made by adopting or ungluing an entry — were
  // missing from that exclusion.
  const adopted = db.adoptSourceEntry(
    (() => {
      db.importTakeoutConversations([
        { query: '', timestamp: '2026-07-01T00:00:00+07:00', timestampText: null, href: null, turns: [], imageFiles: [] },
      ] as never);
      return db.orphanSourceEntries()[0].id;
    })(),
    null,
  );
  const queued = db.chatsWithoutTurns(100).map((c) => c.id);
  console.log('capture queue:', queued, '| adopted thread', adopted.chatId, 'queued?', queued.includes(adopted.chatId));
  if (queued.includes(adopted.chatId)) {
    throw new Error('a thread with no Google thread id was queued for capture');
  }

  // Derived from the full list rather than a literal count: the scope's job is
  // to return exactly the threads with no turns, and asserting a number instead
  // made this break whenever a fixture above it added one.
  const empties = db.listChats({ kind: 'empty' });
  const expectedEmpty = db.listChats({ kind: 'all' }).filter((c) => c.messageCount === 0);
  console.log(
    '\nempty threads:',
    empties.map((c) => c.id),
    'of',
    db.listChats({ kind: 'all' }).length,
    'threads',
  );
  if (empties.length !== expectedEmpty.length) {
    throw new Error(`empty scope returned ${empties.length}, expected ${expectedEmpty.length}`);
  }
  if (empties.some((c) => c.messageCount > 0)) throw new Error('a thread with turns was listed');
  if (empties.some((c) => c.id === full.id)) throw new Error('the read thread was listed as empty');
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Matching by the answer when the opening prompt is shared.
//
// The visible symptom this fixes: a thread captured from the panel sitting in the
// list beside an imported thread of the same conversation, because the same
// question had been asked more than once and the importer refused to guess which
// was which. The answers differ, so the answers can decide — but only when one
// candidate is CLEARLY closer than the rest, which is the part that has to be
// checked, because a rule that always picks a winner will confidently pick wrong.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-match-'));
  db.initDb(scratch);

  const ask = 'gpg clearsign specify the key';
  const answerA =
    'Use the -u or --local-user option followed by the key identifier. You can name ' +
    'the key by email address, by short or long key id, by full fingerprint, or by name.';
  const answerB =
    'Vacuum decay describes a false vacuum state collapsing, where a bubble of true ' +
    'vacuum expands at light speed and destroys everything it passes through.';
  const entry = (ts: string, answer: string) => ({
    query: ask,
    timestamp: ts,
    timestampText: null,
    href: null,
    entryId: null,
    fingerprints: { long: `L${ts}`, short: `S${ts}`, empty: `E${ts}` },
    turns: [turn('user', ask), turn('ai', answer)],
    imageFiles: [],
  });

  // Two threads captured from the panel, same question, different answers.
  db.upsertThreadFromList('thread-A', ask, null, 0);
  db.upsertThreadFromList('thread-B', ask, null, 1);
  const chatA = db.listChats({ kind: 'all' })[0].id;
  db.replaceTurns(chatA, [
    { seq: 0, role: 'user', text: ask, html: null },
    { seq: 1, role: 'ai', text: answerA, html: null },
  ], []);
  const chatB = db.listChats({ kind: 'all' }).find((c) => c.id !== chatA)?.id as number;
  db.replaceTurns(chatB, [
    { seq: 0, role: 'user', text: ask, html: null },
    { seq: 1, role: 'ai', text: answerB, html: null },
  ], []);

  // Two entries with the same opening and those two answers. Each must land on
  // the thread whose answer it matches — not on the other, and not on a new row.
  const before = db.listChats({ kind: 'all' }).length;
  const result = db.importTakeoutConversations([
    entry('2026-08-22T01:00:00+07:00', answerA),
    entry('2026-08-22T02:00:00+07:00', answerB),
  ] as never);
  const after = db.listChats({ kind: 'all' });
  console.log(
    `\nsame prompt, different answers: ${before} threads -> ${after.length}`,
    `| created ${result.created} enriched ${result.extended + result.mergedIntoHarvested}`,
  );
  if (after.length !== before) {
    throw new Error(`matching by answer failed: ${before} threads became ${after.length}`);
  }
  const linkedA = db.sourceEntriesForChat(chatA).filter((e) => e.linked);
  const linkedB = db.sourceEntriesForChat(chatB).filter((e) => e.linked);
  console.log('  each thread took one entry:', linkedA.length, linkedB.length);
  if (linkedA.length !== 1 || linkedB.length !== 1) {
    throw new Error(`entries landed wrong: A=${linkedA.length} B=${linkedB.length}`);
  }
  // The one that matters: they must not have swapped.
  const turnsA = db.getChat(chatA)?.messages.map((m) => m.text).join(' ') ?? '';
  if (!turnsA.includes('local-user')) {
    throw new Error('a thread took the wrong entry — the answers were swapped');
  }

  // A near-tie must DECLINE. Two threads whose answers are the same give the
  // fingerprint nothing to separate them by, and a rule that picks anyway would
  // attach an entry to whichever row came back first.
  db.upsertThreadFromList('thread-C', 'a tied question', null, 2);
  db.upsertThreadFromList('thread-D', 'a tied question', null, 3);
  const tied = db.listChats({ kind: 'all' }).filter((c) => c.title === 'a tied question');
  for (const t of tied) {
    db.replaceTurns(t.id, [
      { seq: 0, role: 'user', text: 'a tied question', html: null },
      { seq: 1, role: 'ai', text: answerA, html: null },
    ], []);
  }
  const tiedBefore = db.listChats({ kind: 'all' }).length;
  db.importTakeoutConversations([
    { ...entry('2026-08-23T01:00:00+07:00', answerA), query: 'a tied question',
      turns: [turn('user', 'a tied question'), turn('ai', answerA)] },
    { ...entry('2026-08-23T02:00:00+07:00', answerA), query: 'a tied question',
      turns: [turn('user', 'a tied question'), turn('ai', `${answerA} and a little more`)] },
  ] as never);
  const tiedAfter = db.listChats({ kind: 'all' }).length;
  console.log(`  a near-tie declines: ${tiedBefore} threads -> ${tiedAfter} (new rows expected)`);
  if (tiedAfter <= tiedBefore) {
    throw new Error('a near-tie was matched anyway instead of standing aside');
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Finding threads that hold identical conversations.
//
// The detector for a real bug: clicking a sidebar row that was not there did
// nothing and reported success, so a thread Google had rotated out was stored
// with whatever the panel was still showing. Two thread rows, one conversation,
// nothing on screen to say so.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-copies-'));
  db.initDb(scratch);
  const same = [
    { seq: 0, role: 'user' as const, text: 'what is a false vacuum', html: null },
    { seq: 1, role: 'ai' as const, text: 'a metastable state that can decay', html: null },
  ];

  db.upsertThreadFromList('copy-a', 'first thread', null, 0);
  db.upsertThreadFromList('copy-b', 'second thread', null, 1);
  db.upsertThreadFromList('copy-c', 'unrelated thread', null, 2);
  const ids = db.listChats({ kind: 'all' }).map((c) => c.id);
  db.replaceTurns(ids[0], same, []);
  db.replaceTurns(ids[1], same, []);
  db.replaceTurns(ids[2], [
    { seq: 0, role: 'user', text: 'how do sprites get generated', html: null },
    { seq: 1, role: 'ai', text: 'by a diffusion model', html: null },
  ], []);

  const found = db.suspectCopies();
  console.log(
    '\nidentical conversations:',
    found.map((g) => g.chatIds),
    '| threads:',
    ids.length,
  );
  if (found.length !== 1) throw new Error(`expected 1 group, got ${found.length}`);
  if (found[0].chatIds.length !== 2) {
    throw new Error(`expected 2 threads in the group, got ${found[0].chatIds.length}`);
  }
  // The unrelated thread must not be dragged in, and a thread with no turns must
  // not group with every other empty one — its fingerprint is the all-zero value
  // and grouping on that would report the entire capture backlog as copies.
  if (found[0].chatIds.includes(ids[2])) throw new Error('an unrelated thread was grouped');
  db.upsertThreadFromList('empty-1', 'never read', null, 3);
  db.upsertThreadFromList('empty-2', 'also never read', null, 4);
  if (db.suspectCopies().length !== 1) {
    throw new Error('threads with no turns were reported as copies of each other');
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Matching after the fact — "fetch the threads, then match".
//
// The case that motivates it: an entry imported BEFORE its thread was captured
// had nothing to match against, so it became a thread of its own. Deciding
// during an import decides too early; run afterwards, every thread and every
// entry is on the table.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-rematch-'));
  db.initDb(scratch);

  const ask = 'why does the queue keep the same links';
  const answer =
    'Because a rejected link kept its place in the queue, so every run walked it ' +
    'again and reached the same conclusion at the cost of a page load.';

  // Imported with nothing to match against: no thread exists yet.
  db.importTakeoutConversations([
    {
      query: ask,
      timestamp: '2026-08-15T09:00:00+07:00',
      timestampText: null,
      href: 'https://www.google.com/?udm=50&q=x',
      entryId: null,
      fingerprints: { long: 'L1', short: 'S1', empty: 'E1' },
      turns: [turn('user', ask), turn('ai', answer)],
      imageFiles: [],
    },
  ] as never);
  const beforeThreads = db.listChats({ kind: 'all' }).length;

  // The thread is captured afterwards, which is the ordinary order of events.
  db.upsertThreadFromList('thread-late', ask, null, 0);
  const late = db.listChats({ kind: 'all' }).find((c) => c.sources.includes('harvest'))?.id ?? 0;
  db.replaceTurns(late, [
    { seq: 0, role: 'user', text: ask, html: null },
    { seq: 1, role: 'ai', text: answer, html: null },
  ], []);

  // The state a real archive was found in: an import created the thread and wrote
  // its turns, then failed to link the entry it came from — the linking code
  // rebuilt the reference string in the old format and missed every entry keyed
  // by Google's mstk token. The link is repaired rather than the export
  // re-imported, since reference shapes changed between those builds and a
  // re-import would store the same entries again instead of recognising them.
  const importedThread = db
    .listChats({ kind: 'all' })
    .find((c) => c.sources === 'takeout')?.id as number;
  const raw = new DatabaseSync(path.join(scratch, 'notebook.sqlite'));
  raw.prepare('DELETE FROM chat_sources WHERE chat_id = ?').run(importedThread);
  raw.close();
  const strandedBefore = db.sourceEntriesForChat(importedThread).filter((e) => e.linked).length;

  // Two threads now hold the same conversation: the one the import made and the
  // one that was captured. That is the duplicate the list shows.
  const listedBefore = db.listChats({ kind: 'all' }).length;
  const r = db.rematchEntriesToThreads();
  console.log(
    `  stranded entry links: ${strandedBefore} before, repaired ${r.relinked}`,
  );
  if (r.relinked !== 1) throw new Error(`the stranded link was not repaired (${r.relinked})`);
  const listedAfter = db.listChats({ kind: 'all' });
  const linkedAfter = db.sourceEntriesForChat(late).filter((e) => e.linked).length;
  console.log(
    `\nrematch: considered ${r.considered} glued ${r.attached} declined ${r.declined}`,
    `| listed ${listedBefore} -> ${listedAfter.length} | captured thread's entries ${linkedAfter}`,
  );
  if (r.attached !== 1) throw new Error(`nothing was glued (attached=${r.attached})`);
  if (listedAfter.length !== listedBefore - 1) {
    throw new Error(`the duplicate did not fold away: ${listedBefore} -> ${listedAfter.length}`);
  }
  // The entry moves to the thread Google knows about, which is the point: that
  // thread keeps its id and can be re-captured later.
  if (linkedAfter !== 1) throw new Error('the entry did not move to the captured thread');
  // Nothing is deleted — a wrong glue has to be undoable.
  const again = db.rematchEntriesToThreads();
  if (again.attached !== 0) throw new Error('rematch glued the same pair twice');
  db.unmergeChat(beforeThreads > 0 ? db.listChats({ kind: 'all' })[0].id : 0);
  fs.rmSync(scratch, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('OK');
