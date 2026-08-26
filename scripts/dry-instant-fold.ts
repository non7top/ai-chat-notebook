/**
 * Dry run then real run of the prompt+instant fold, against a COPY.
 * Never point this at a live archive.
 *
 *   node --experimental-strip-types scripts/dry-instant-fold.ts <dir> [--run]
 */
import * as db from '../src/main/db.ts';

const dir = process.argv[2];
if (!dir) { console.error('Pass a directory containing notebook.sqlite.'); process.exit(1); }
db.initDb(dir);

const plan = db.planPromptInstantFold();
const moving = plan.filter((s) => s.fullestId !== s.keepId && s.fullestTurns > s.keepTurns);
console.log(`groups:            ${plan.length}`);
console.log(`threads folded:    ${plan.reduce((n, s) => n + s.foldIds.length, 0)}`);
console.log(`keeper not fullest: ${moving.length} (that reading moves onto the keeper)`);
console.log(`live threads before: ${db.listChats({ kind: 'all' }).length}`);
console.log('\nfirst 8 groups (keeper <- folded, turns):');
for (const s of plan.slice(0, 8)) {
  console.log(`  #${s.keepId}(${s.keepTurns}) <- ${s.foldIds.map((i) => '#' + i).join(',')}` +
    (s.fullestId !== s.keepId ? `   fullest #${s.fullestId}(${s.fullestTurns})` : ''));
}

if (process.argv.includes('--run')) {
  const before = db.listChats({ kind: 'all' }).length;
  const r = db.foldPromptInstantDuplicates();
  const after = db.listChats({ kind: 'all' }).length;
  console.log('\nfold :', JSON.stringify(r));
  console.log(`live threads ${before} -> ${after}`);
  if (db.planPromptInstantFold().length !== 0) {
    throw new Error('groups remain after the fold');
  }
  if (after !== before - r.folded) {
    throw new Error(`expected ${before - r.folded} live threads, got ${after}`);
  }
  console.log('OK');
}
