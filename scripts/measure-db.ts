/**
 * Where an archive's bytes actually are.
 *
 * Written because a 200MB database for a few thousand text conversations is a
 * number worth explaining rather than accepting. Reports sizes per table and per
 * large column, plus how much of the file is free space that a VACUUM would
 * reclaim.
 *
 * Read-only, and reports LENGTHS only — never a row's content.
 *
 *   node --experimental-strip-types scripts/measure-db.ts <path to notebook.sqlite>
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Pass the path to notebook.sqlite.');
  process.exit(1);
}

const db = new DatabaseSync(file, { readOnly: true });
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const one = (sql: string): number =>
  Number((db.prepare(sql).get() as unknown as { n: number | null }).n ?? 0);

console.log(`file on disk: ${mb(fs.statSync(file).size)}`);

const pageSize = one('SELECT page_size AS n FROM pragma_page_size');
const pageCount = one('SELECT page_count AS n FROM pragma_page_count');
const freeList = one('SELECT freelist_count AS n FROM pragma_freelist_count');
console.log(
  `pages: ${pageCount} of ${pageSize} bytes · free ${freeList} (${mb(freeList * pageSize)} a VACUUM would reclaim)`,
);

console.log('\nrows');
for (const table of ['chats', 'messages', 'assets', 'source_entries', 'activity', 'folders']) {
  try {
    console.log(`  ${table.padEnd(15)} ${one(`SELECT COUNT(*) AS n FROM ${table}`)}`);
  } catch {
    console.log(`  ${table.padEnd(15)} (absent)`);
  }
}

console.log('\nbytes held by the columns that carry text');
const columns: [string, string, string][] = [
  ['messages', 'html', 'the reading shown to the reader'],
  ['messages', 'text', 'the same conversation as plain text, for search'],
  ['source_entries', 'payload_json', "each export record's own reading, verbatim"],
  ['chats', 'raw_json', 'per-thread provenance, and the alternate reading'],
];
for (const [table, column, why] of columns) {
  try {
    const total = one(`SELECT SUM(LENGTH(${column})) AS n FROM ${table}`);
    const max = one(`SELECT MAX(LENGTH(${column})) AS n FROM ${table}`);
    console.log(`  ${`${table}.${column}`.padEnd(30)} ${mb(total).padStart(9)}  largest ${max} — ${why}`);
  } catch {
    console.log(`  ${`${table}.${column}`.padEnd(30)} (absent)`);
  }
}

// The specific redundancy worth knowing about: an alternate reading kept in
// raw_json when the entry it came from already holds the same turns.
try {
  const alt = one(
    "SELECT SUM(LENGTH(json_extract(raw_json, '$.takeout.turns'))) AS n FROM chats",
  );
  console.log(`\n  of which raw_json holds ${mb(alt)} of turns that source_entries also holds`);
} catch {
  /* older schema */
}
// The hypothesis a 1.29 MB turn suggests: an image left inline as base64 rather
// than rewritten to the content-addressed store. If so those bytes are in the
// database instead of on disk, and the picture is not in the asset store at all.
console.log('\ninline data: URIs left in stored HTML');
const withData = one("SELECT COUNT(*) AS n FROM messages WHERE html LIKE '%data:image%'");
const dataBytes = one(
  "SELECT SUM(LENGTH(html)) AS n FROM messages WHERE html LIKE '%data:image%'",
);
console.log(`  ${withData} turns · ${mb(dataBytes)} of HTML in those turns`);

// And the other candidate: markup that is simply enormous.
console.log('\nlargest turns, by what they hold');
const rows = db
  .prepare(
    `SELECT LENGTH(html) AS bytes,
            LENGTH(text) AS textBytes,
            html LIKE '%data:image%' AS hasData,
            (LENGTH(html) - LENGTH(REPLACE(html, '<svg', ''))) / 4 AS svgs,
            (LENGTH(html) - LENGTH(REPLACE(html, '<img', ''))) / 4 AS imgs
       FROM messages ORDER BY LENGTH(html) DESC LIMIT 5`,
  )
  .all() as unknown as {
  bytes: number;
  textBytes: number;
  hasData: number;
  svgs: number;
  imgs: number;
}[];
for (const row of rows) {
  console.log(
    `  html ${String(row.bytes).padStart(8)}  text ${String(row.textBytes).padStart(6)}` +
      `  data: ${row.hasData ? 'yes' : 'no '}  svg ${row.svgs}  img ${row.imgs}`,
  );
}
// Did the repair lose anything? Asked of the data rather than assumed.
//
// The rewrite only ever removes an image AFTER storing it, or when storing failed
// — so an image that reached the asset store is intact, and one that did not was
// never in the store to begin with. What can be checked is whether the counts add
// up: assets present, turns still holding base64, and turns pointing at asset
// paths that do not exist on disk.
console.log('\nwhat the repair left behind');
console.log(`  turns still holding base64: ${withData}`);
const localRefs = one(
  "SELECT COUNT(*) AS n FROM messages WHERE html LIKE '%\"assets/%' OR html LIKE '%''assets/%'",
);
console.log(`  turns pointing at the asset store: ${localRefs}`);
const assetRows = one('SELECT COUNT(*) AS n FROM assets');
const assetKinds = db
  .prepare("SELECT COALESCE(kind, 'unclassified') AS kind, COUNT(*) AS n FROM assets GROUP BY 1 ORDER BY n DESC")
  .all() as unknown as { kind: string; n: number }[];
console.log(`  asset rows: ${assetRows} — ${assetKinds.map((k) => `${k.n} ${k.kind}`).join(', ')}`);

// A reference with no file behind it is the one shape that would mean a lost
// picture, so it is looked for specifically.
const paths = db
  .prepare('SELECT local_path FROM assets')
  .all() as unknown as { local_path: string }[];
let missingFiles = 0;
for (const row of paths) if (!fs.existsSync(row.local_path)) missingFiles += 1;
console.log(
  `  asset rows whose file is missing: ${missingFiles}` +
    (missingFiles === 0 ? ' — every recorded image is on disk' : ' — INVESTIGATE'),
);
db.close();
