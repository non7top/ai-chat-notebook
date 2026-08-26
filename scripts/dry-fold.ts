/**
 * Dry run of the adopted-duplicate fold, against a COPY of a real archive.
 *
 * Prints what the fold would do and changes nothing. Takes the directory
 * holding a notebook.sqlite, as initDb does.
 *
 *   node --experimental-strip-types scripts/dry-fold.ts <dir>
 */
import * as db from '../src/main/db.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('Pass a directory containing notebook.sqlite.');
  process.exit(1);
}
db.initDb(dir);

const plan = db.planAdoptedFold();
const moving = plan.filter((s) => s.movesTurns);
const noKeeper = plan.filter((s) => !s.keepId);
console.log(`pairs to fold:            ${plan.length}`);
console.log(`  turns would MOVE:       ${moving.length} (the adopted copy is fuller)`);
console.log(`  turns stay put:         ${plan.length - moving.length}`);
console.log(`  no keeper found:        ${noKeeper.length} (skipped)`);
console.log(`  turns moved in total:   ${moving.reduce((n, s) => n + s.adoptedTurns, 0)}`);
console.log(`  images carried:         ${moving.reduce((n, s) => n + s.adoptedImages, 0)}`);
console.log('\nfirst 12 pairs (adopted -> keeper, turns adopted/keeper):');
for (const s of plan.slice(0, 12)) {
  console.log(
    `  #${s.adoptedId} -> #${s.keepId}   ${s.adoptedTurns}/${s.keepTurns}` +
      (s.movesTurns ? '   moves' : ''),
  );
}
const live = db.listChats({ kind: 'all' }).length;
console.log(`\nlive threads now ${live}, after the fold ${live - plan.length}`);
