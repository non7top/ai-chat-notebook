/**
 * Runs the adopted-duplicate fold against a COPY and checks the outcome.
 * Never point this at a live archive.
 *
 *   node --experimental-strip-types scripts/run-fold.ts <dir>
 */
import * as db from '../src/main/db.ts';

const dir = process.argv[2];
if (!dir) { console.error('Pass a directory containing notebook.sqlite.'); process.exit(1); }
db.initDb(dir);

const before = {
  live: db.listChats({ kind: 'all' }).length,
  plan: db.planAdoptedFold().length,
  orphans: db.orphanSourceEntries().length,
};
console.log('before:', JSON.stringify(before));

const result = db.foldAdoptedDuplicates();
console.log('fold  :', JSON.stringify(result));

const after = {
  live: db.listChats({ kind: 'all' }).length,
  plan: db.planAdoptedFold().length,
  orphans: db.orphanSourceEntries().length,
};
console.log('after :', JSON.stringify(after));

// The claims this recovery makes, each checked rather than asserted.
if (after.plan !== 0) throw new Error(`${after.plan} duplicates left unfolded`);
if (after.live !== before.live - before.plan) {
  throw new Error(`expected ${before.live - before.plan} live threads, got ${after.live}`);
}
if (after.orphans > before.orphans) throw new Error('the fold created orphans');
// Nothing deleted: every folded thread is still there, marked merged.
const merged = db.suspectCopies().length;
console.log(`orphans ${before.orphans} -> ${after.orphans}, identical-conversation groups now ${merged}`);
console.log('OK');
