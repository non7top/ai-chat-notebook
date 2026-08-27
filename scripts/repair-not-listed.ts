/**
 * Clears "given up on" marks that a short sidebar walk wrote.
 *
 * recordThreadNotListed sets capture_attempts to the ceiling, which is how a
 * thread Google no longer lists stops being retried forever. Before
 * loadSidebarIds learned to refuse a conclusion from an incomplete walk, one run
 * wrote that mark onto 358 entries on the strength of a walk that had seen a
 * handful of rows — every one of them still in Google's sidebar.
 *
 * Resetting all of them rather than trying to tell those 358 from the ~14 that
 * were genuinely gone: the information needed to separate them was never
 * recorded, and the cost of being wrong is one extra attempt on a dead thread,
 * which a complete walk then re-marks by itself. Cheap and self-correcting beats
 * precise and impossible.
 *
 *   node --experimental-strip-types scripts/repair-not-listed.ts <notebook.sqlite> [--apply]
 *
 * Reports without --apply. Close the app first: this writes.
 */
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) {
  console.error('Pass the path to notebook.sqlite.');
  process.exit(1);
}

const db = new DatabaseSync(file, { readOnly: !apply });
// Entries that could still be in the sidebar: a Google id, not merged away.
const WHERE = `merged_into IS NULL
   AND external_id NOT LIKE 'takeout:%'
   AND external_id NOT LIKE 'entry:%'
   AND capture_attempts >= 4`;

const count = Number(
  (db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE ${WHERE}`).get() as { n: number }).n,
);
console.log(`entries marked as given-up with a Google id: ${count}`);

if (!apply) {
  console.log('dry run — pass --apply to clear them');
  process.exit(0);
}

const changed = db.prepare(`UPDATE chats SET capture_attempts = 0 WHERE ${WHERE}`).run();
console.log(`cleared: ${changed.changes}`);
const left = Number(
  (db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE ${WHERE}`).get() as { n: number }).n,
);
console.log(`still marked: ${left}`);
