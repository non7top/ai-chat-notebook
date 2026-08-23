import { DatabaseSync } from 'node:sqlite';
import { openingFingerprint } from '../shared/fingerprint.ts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ChatDetail,
  ChatScope,
  ChatSummary,
  Folder,
  Message,
  TakeoutImportRow,
} from '../shared/types';

let db: DatabaseSync;
let assetsDir: string;

// Whether the SQLite that Node bundles was built with FTS5. Not guaranteed,
// and there's no version number that answers it — the only reliable test is
// to try creating one. Search falls back to LIKE over messages.text when this
// is false, which is fine at this scale (hundreds of conversations).
let fts5Available = false;

function probeFts5(database: DatabaseSync): boolean {
  try {
    database.exec('CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x);');
    database.exec('DROP TABLE temp.__fts5_probe;');
    return true;
  } catch {
    return false;
  }
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function hasFts5(): boolean {
  return fts5Available;
}

export function initDb(userDataPath: string): void {
  db = new DatabaseSync(path.join(userDataPath, 'notebook.sqlite'));
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Nullable, ON DELETE SET NULL: deleting a folder must never delete
      -- conversations. Folder nesting cascades; the chats fall back to
      -- Unfiled (folder_id IS NULL).
      folder_id    INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      external_id  TEXT NOT NULL UNIQUE,
      -- Hash of the normalised first user turn. Deliberately NOT unique:
      -- Google sometimes surfaces one conversation as two threads, and this
      -- is how those get flagged for a manual merge rather than silently
      -- collapsed.
      content_key  TEXT,
      merged_into  INTEGER REFERENCES chats(id) ON DELETE SET NULL,
      url          TEXT,
      title        TEXT,
      user_title   TEXT,
      started_at   TEXT,
      last_seen_at TEXT NOT NULL,
      source       TEXT NOT NULL,
      -- The full capture, kept verbatim. Harvesting is slow and fragile, so a
      -- parser bug should be fixable by re-parsing locally rather than by
      -- scraping Google all over again.
      raw_json     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chats_content_key ON chats(content_key);
    CREATE INDEX IF NOT EXISTS chats_folder_id ON chats(folder_id);

    CREATE TABLE IF NOT EXISTS messages (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      seq     INTEGER NOT NULL,
      role    TEXT NOT NULL,
      text    TEXT NOT NULL,
      -- Sanitised snapshot with image URLs already rewritten to local paths.
      html    TEXT,
      -- Makes re-capturing a resumed conversation an upsert instead of a
      -- duplicate-turn pile-up. Every resume re-reads turns already stored.
      UNIQUE(chat_id, seq)
    );

    CREATE TABLE IF NOT EXISTS assets (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      original_url TEXT,
      sha256       TEXT NOT NULL,
      mime         TEXT NOT NULL,
      local_path   TEXT NOT NULL,
      bytes        INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS assets_chat_sha ON assets(chat_id, sha256);

    -- Every source record, preserved verbatim and never grouped, edited or
    -- deduplicated. This is the durable layer: conversations are a CURATED VIEW
    -- over these, so a wrong grouping is re-derivable without re-importing, and
    -- a glue that turns out to join two separate conversations can be undone
    -- without having lost either.
    --
    -- Learned the hard way. Every automatic grouping rule tried here was wrong
    -- in at least one real case — collapsing distinct conversations that opened
    -- alike, or discarding the second of two identical prompts entirely. Keeping
    -- the originals means those mistakes cost a re-derivation rather than data.
    CREATE TABLE IF NOT EXISTS source_entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      -- 'takeout' | 'capture' | 'harvest'
      kind         TEXT NOT NULL,
      -- Whatever the source calls it: a Google thread id, or opening+timestamp
      -- for an export entry that carries no id at all.
      external_ref TEXT NOT NULL,
      query        TEXT,
      query_key    TEXT,
      occurred_at  TEXT,
      href         TEXT,
      -- The entry exactly as parsed: turns, image names, everything.
      payload_json TEXT NOT NULL,
      imported_at  TEXT NOT NULL,
      UNIQUE(kind, external_ref)
    );
    CREATE INDEX IF NOT EXISTS source_entries_key ON source_entries(query_key);

    -- Which source records a conversation was built from. Many-to-one, because
    -- gluing several entries into one conversation is expected — and
    -- many-to-many, because one entry can be evidence for two conversations
    -- Google cloned apart.
    --
    -- linked_by records who made the link, and it is load-bearing rather than
    -- descriptive. Re-importing the export has to be able to undo a grouping
    -- its own earlier run got wrong, which means deleting links; but it must
    -- never delete a link made by hand, because that is the gluing work the
    -- whole design asks for. Only 'import' links are the importer's to remove.
    CREATE TABLE IF NOT EXISTS chat_sources (
      chat_id         INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      source_entry_id INTEGER NOT NULL REFERENCES source_entries(id) ON DELETE CASCADE,
      linked_by       TEXT NOT NULL DEFAULT 'import',
      PRIMARY KEY (chat_id, source_entry_id)
    );

    -- Takeout entries. Deliberately NOT chats: an export carries no thread id,
    -- so nothing in it can identify a conversation, and an importer that
    -- created chats from it invented 736 of them out of 981 entries — mostly
    -- individual turns wearing a conversation's clothes.
    --
    -- These are records of "a prompt was submitted at this exact time", which
    -- is all Takeout actually knows. They then get matched to real
    -- conversations where possible, and the ones that never match are the
    -- interesting residue: prompts whose conversation Google has dropped.
    CREATE TABLE IF NOT EXISTS activity (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      query              TEXT NOT NULL,
      -- Normalised hash of the query, the same function chats use, so the two
      -- can be compared at all.
      query_key          TEXT NOT NULL,
      -- Keeps its original UTC offset. Normalising to UTC moved late-evening
      -- conversations across midnight and showed the wrong day.
      occurred_at        TEXT,
      href               TEXT,
      -- Where it landed, if anywhere. Both null means an orphan.
      matched_chat_id    INTEGER REFERENCES chats(id) ON DELETE SET NULL,
      matched_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      -- How the match was made, so a weak one can be told from a strong one.
      match_kind         TEXT,
      -- One row per submission: the same prompt sent twice is two events.
      UNIQUE(query_key, occurred_at)
    );
    CREATE INDEX IF NOT EXISTS activity_query_key ON activity(query_key);
    CREATE INDEX IF NOT EXISTS activity_chat ON activity(matched_chat_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Columns added after the first release need a real migration: the
  // CREATE TABLE above is IF NOT EXISTS, so it does nothing to a database that
  // already holds harvested rows.
  ensureColumn('chats', 'list_rank', 'list_rank INTEGER');
  ensureColumn('chats', 'capture_attempts', 'capture_attempts INTEGER NOT NULL DEFAULT 0');
  // Accumulates rather than overwrites: a conversation imported from Takeout
  // and then extended from the panel has two provenances, and reporting only
  // the latest hides where its content actually came from.
  ensureColumn('chats', 'sources', 'sources TEXT');
  // How many export entries were folded into this conversation. Grouping
  // successive snapshots is correct, but doing it invisibly hides that three
  // records were collapsed into one — and that is exactly where a wrong
  // grouping would be spotted.
  ensureColumn('chats', 'takeout_entries', 'takeout_entries INTEGER NOT NULL DEFAULT 0');
  // Existing links predate the distinction and are all the importer's own, so
  // 'import' is the correct default for them: nothing had been glued by hand
  // before there was a way to do it.
  ensureColumn('chat_sources', 'linked_by', "linked_by TEXT NOT NULL DEFAULT 'import'");
  // How started_at was arrived at, because the dates in this archive are not
  // equally trustworthy and a bare date hides that. 'takeout' came from the
  // export, 'activity' from the activity log's own stamp, and 'placeholder' is
  // the moment the app first stored the conversation — a stand-in for a date
  // nothing knows, kept so a conversation captured from the panel is not
  // undateable forever, and marked so it is never mistaken for the real thing.
  // NULL means no date at all. Existing rows with a date got it from the export
  // or the activity log, and 'takeout' is the honest default for them: nothing
  // else could have written one before this column existed.
  ensureColumn('chats', 'date_basis', 'date_basis TEXT');
  // What an image is: 'generated', 'upload', or 'other' for a rich link
  // preview, a source-card thumbnail, or anything else the page put inline.
  //
  // Left NULL for everything captured before this existed, and NULL counts as
  // an image rather than as furniture. Backfilling it would mean guessing from
  // the URL, and both uploads and freshly generated images arrive as data: URIs
  // with no host to guess from — mislabelling a real generated image as a
  // preview would be worse than the over-count it replaces. Re-capturing a
  // conversation classifies its images properly.
  ensureColumn('assets', 'kind', 'kind TEXT');
  // Simhash of the thread's opening exchange, for matching one thread across
  // sources. Stored on both sides — written here for panel captures and kept on
  // each entry for the export — but nothing matches on it yet: a threshold
  // trades false matches against missed ones, and with ~300 threads still
  // uncaptured there are no real pairs to choose one against. Collecting it now
  // is what makes that choice possible later.
  ensureColumn('chats', 'text_fingerprint', 'text_fingerprint TEXT');
  db.exec("UPDATE chats SET date_basis = 'takeout' WHERE started_at IS NOT NULL AND date_basis IS NULL");
  db.exec('CREATE INDEX IF NOT EXISTS chats_list_rank ON chats(list_rank);');

  fts5Available = probeFts5(db);
  // Logged rather than assumed: which SQLite build Electron ships changes
  // with the Electron version, so this can flip under us on an upgrade and
  // silently downgrade search to the LIKE path.
  // eslint-disable-next-line no-console
  console.log(`[Notebook] sqlite FTS5 available: ${fts5Available}`);

  // Content-addressed, sharded by the first two hex characters so a few
  // thousand images don't all land in one directory.
  assetsDir = path.join(userDataPath, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
}

/** Adds a contributing source without losing the ones already recorded. */
/** Exported as noteChatSource for callers outside this module. */
export function noteChatSource(chatId: number, source: string): void {
  noteSource(chatId, source);
}

function noteSource(chatId: number, source: string): void {
  const row = db.prepare('SELECT sources FROM chats WHERE id = ?').get(chatId) as unknown as
    | { sources: string | null }
    | undefined;
  const set = new Set((row?.sources ?? '').split(',').filter(Boolean));
  set.add(source);
  db.prepare('UPDATE chats SET sources = ? WHERE id = ?').run([...set].join(','), chatId);
}

/**
 * A stored asset as a relative "assets/..." path, or null.
 *
 * Returns null for anything not actually inside the assets directory. Such a
 * path would come back with leading ".." segments and, resolved against the
 * assets base in the renderer, would point outside the archive entirely — so
 * the answer to "where is this image" becomes "somewhere else on this disk".
 * Nothing should produce one; that is the reason to refuse it here rather than
 * assume it cannot happen.
 */
export function assetHrefForPath(localPath: string): string {
  return assetHrefFor(localPath) ?? '';
}

function assetHrefFor(localPath: string | null): string | null {
  if (!localPath) return null;
  const relative = path.relative(getAssetsDir(), localPath).split(path.sep).join('/');
  if (relative === '' || relative.startsWith('../')) return null;
  return `assets/${relative}`;
}

export function getAssetsDir(): string {
  return assetsDir;
}

/* ---------------------------------------------------------------- folders */

interface FolderRow {
  id: number;
  parent_id: number | null;
  name: string;
  position: number;
}

export function listFolders(): Folder[] {
  const rows = db
    .prepare('SELECT id, parent_id, name, position FROM folders ORDER BY position, name')
    .all() as unknown as FolderRow[];
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    position: row.position,
  }));
}

export function createFolder(parentId: number | null, name: string): Folder {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)')
    .run(parentId, name, new Date().toISOString());
  return { id: Number(lastInsertRowid), parentId, name, position: 0 };
}

export function renameFolder(id: number, name: string): void {
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id);
}

// Walks up from the prospective parent looking for the folder being moved.
// Without this, dropping a folder onto one of its own descendants creates a
// parent_id cycle: the subtree vanishes from the tree (nothing reaches it
// from a root) while still sitting in the table, and every recursive walk
// over it spins forever.
function isDescendantOf(candidateId: number, ancestorId: number): boolean {
  const parentOf = db.prepare('SELECT parent_id FROM folders WHERE id = ?');
  let cursor: number | null = candidateId;
  while (cursor !== null) {
    if (cursor === ancestorId) return true;
    const row = parentOf.get(cursor) as unknown as { parent_id: number | null } | undefined;
    if (!row) return false;
    cursor = row.parent_id;
  }
  return false;
}

export function moveFolder(id: number, newParentId: number | null): void {
  if (newParentId !== null && isDescendantOf(newParentId, id)) {
    throw new Error('Cannot move a folder into itself or one of its own subfolders');
  }
  db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(newParentId, id);
}

// Nested folders cascade; the chats inside them do not — chats fall back to
// Unfiled via ON DELETE SET NULL. Deleting a folder is a filing decision, not
// a decision to throw away conversations that may be the only surviving copy.
export function deleteFolder(id: number): void {
  db.prepare('DELETE FROM folders WHERE id = ?').run(id);
}

/* ------------------------------------------------------------------ chats */

interface ChatSummaryRow {
  id: number;
  folder_id: number | null;
  title: string;
  started_at: string | null;
  date_basis: string | null;
  last_seen_at: string;
  message_count: number;
  image_count: number;
  preview_count: number;
  title_image: string | null;
  capture_attempts: number;
  source: string;
  sources: string;
  alt_turns: number | null;
  takeout_entries: number;
}

// COALESCE order is the display rule in one place: a title typed by hand wins
// over whatever was harvested, and an unnamed conversation still needs to
// render as something — being unnamed is the whole reason this app exists.
const CHAT_TITLE_SQL = "COALESCE(NULLIF(user_title, ''), NULLIF(title, ''), '(untitled)')";

const CHAT_SUMMARY_SQL = `
  SELECT c.id, c.folder_id, ${CHAT_TITLE_SQL} AS title, c.started_at, c.date_basis,
         c.last_seen_at,
         c.capture_attempts, c.source, COALESCE(c.sources, c.source) AS sources,
         -- Turn count of the other reading, when one was kept, so a
         -- disagreement between Takeout and the panel is visible instead of
         -- being resolved out of sight.
         (SELECT COUNT(*) FROM json_each(json_extract(c.raw_json, '$.takeout.turns'))) AS alt_turns,
         c.takeout_entries,
         (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
         -- DISTINCT sha256, not row count: every image is rendered twice by the
         -- page, so counting asset rows would report double.
         -- The conversation's own images. NULL kind is included: it means
         -- "captured before kinds existed", not "furniture".
         (SELECT COUNT(DISTINCT a.sha256) FROM assets a
           WHERE a.chat_id = c.id
             AND (a.kind IS NULL OR a.kind IN ('generated', 'upload', 'takeout')))
           AS image_count,
         -- Rich previews and source thumbnails. Kept, since nothing is
         -- discarded, but counted apart so 17 previews never read as 17 images.
         (SELECT COUNT(DISTINCT a.sha256) FROM assets a
           WHERE a.chat_id = c.id AND a.kind = 'other') AS preview_count,
         -- The image the conversation STARTED with, for the list thumbnail.
         -- Two restrictions, and an earlier version had neither, which is why
         -- conversations that begin with text were showing an unrelated picture:
         --
         -- 1. The opening turn pair only (seq 0 or 1) — the question's own
         --    upload, or the first picture generated in answer to it. Taking
         --    the earliest image anywhere meant a conversation whose seventh
         --    answer happened to contain a picture was represented by it.
         -- 2. A KNOWN kind. NULL means "captured before images were
         --    classified", which includes every rich link preview and
         --    source-card thumbnail from those captures — so the face of a
         --    text-only conversation became whichever preview came first.
         --    Unknown is not a licence to display: re-capturing a conversation
         --    classifies its images and a real one then appears.
         --
         -- Export images have no turn to sit in, and are allowed on their own
         -- terms: an entry that shipped a single image is exactly the case this
         -- is for, and 'takeout' says what it is.
         (SELECT a.local_path FROM assets a
            LEFT JOIN messages m ON m.id = a.message_id
           WHERE a.chat_id = c.id
             AND a.kind IN ('generated', 'upload', 'takeout')
             AND (a.message_id IS NULL OR m.seq <= 1)
           ORDER BY COALESCE(m.seq, -1) ASC, a.id ASC
           LIMIT 1) AS title_image
  FROM chats c
`;

function toSummary(row: ChatSummaryRow): ChatSummary {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    startedAt: row.started_at,
    dateBasis: row.date_basis,
    lastSeenAt: row.last_seen_at,
    messageCount: row.message_count,
    imageCount: row.image_count,
    previewCount: row.preview_count,
    // Relative, matching what is stored in turn HTML, so the renderer resolves
    // both the same way against the real assets directory.
    titleImage: assetHrefFor(row.title_image),
    captureAttempts: row.capture_attempts,
    source: row.source,
    sources: row.sources,
    altTurnCount: row.alt_turns ?? 0,
    takeoutEntryCount: row.takeout_entries ?? 0,
  };
}

// Re-exported rather than redeclared: the duplicate definition here drifted
// from the shared one the moment a scope was added, and the two disagreeing is
// exactly the kind of mismatch the type checker cannot see across an IPC hop.
export type { ChatScope };

export function listChats(scope: ChatScope): ChatSummary[] {
  // merged_into IS NULL everywhere: a chat merged away is kept (so the merge
  // stays undoable) but must not show up as a separate conversation.
  const base = `${CHAT_SUMMARY_SQL} WHERE c.merged_into IS NULL`;
  // Newest first, by the thread's own date — now that threads HAVE dates.
  //
  // This used to order by list_rank alone, Google's sidebar position, because
  // that was the only recency signal in existence: no timestamp was rendered
  // anywhere and a bulk harvest stamped last_seen_at identically across 300
  // rows. Both premises are now false. The export dates a thread to the second,
  // the panel to the day, and once dates are on screen an order that ignores
  // them reads as sorted backwards — which is what it looked like.
  //
  // A placeholder date is excluded from the first key on purpose. It says only
  // that the app saved the thread today, so sorting by it would float every
  // undated thread to the top of the list and push the genuinely recent ones
  // under it. Those fall through to sidebar position, which is still the best
  // guess available for them.
  const order = `
    ORDER BY CASE
               WHEN c.started_at IS NOT NULL AND COALESCE(c.date_basis, '') <> 'placeholder'
                 THEN 0 ELSE 1
             END,
             c.started_at DESC,
             CASE WHEN c.list_rank IS NULL THEN 1 ELSE 0 END,
             c.list_rank ASC,
             c.last_seen_at DESC`;

  if (scope.kind === 'all') {
    return (db.prepare(base + order).all() as unknown as ChatSummaryRow[]).map(toSummary);
  }
  if (scope.kind === 'unfiled') {
    return (
      db.prepare(`${base} AND c.folder_id IS NULL${order}`).all() as unknown as ChatSummaryRow[]
    ).map(toSummary);
  }
  // Orphans are raw entries, not conversations — they are listed by
  // orphanSourceEntries and rendered on their own. Returning nothing here
  // matters: without this branch the scope fell through to the folder query
  // and `scope.id` was undefined, which quietly matched no rows and looked
  // like "no orphans" rather than "wrong query".
  if (scope.kind === 'orphans') return [];
  // Threads the app knows of but holds nothing for. Ordered like the rest, so
  // the ones Google listed most recently come first — those are the ones a
  // capture is most likely to still find.
  if (scope.kind === 'empty') {
    return (
      db
        .prepare(
          `${base} AND NOT EXISTS (SELECT 1 FROM messages m2 WHERE m2.chat_id = c.id)${order}`,
        )
        .all() as unknown as ChatSummaryRow[]
    ).map(toSummary);
  }
  return (
    db.prepare(`${base} AND c.folder_id = ?${order}`).all(scope.id) as unknown as ChatSummaryRow[]
  ).map(toSummary);
}

export function getChat(id: number): ChatDetail | null {
  const row = db
    .prepare(`${CHAT_SUMMARY_SQL} WHERE c.id = ?`)
    .get(id) as unknown as (ChatSummaryRow & Record<string, unknown>) | undefined;
  if (!row) return null;

  const extra = db.prepare('SELECT external_id, url FROM chats WHERE id = ?').get(id) as unknown as
    | { external_id: string; url: string | null }
    | undefined;

  const messages = (
    db
      .prepare('SELECT id, seq, role, text, html FROM messages WHERE chat_id = ? ORDER BY seq')
      .all(id) as unknown as {
      id: number;
      seq: number;
      role: string;
      text: string;
      html: string | null;
    }[]
  ).map<Message>((m) => ({
    id: m.id,
    seq: m.seq,
    role: m.role === 'user' ? 'user' : 'ai',
    text: m.text,
    html: m.html,
  }));

  // Which of this thread's images are page furniture rather than content.
  //
  // The reader renders the stored HTML and cannot tell one <img> from another,
  // so a rich link preview came out at its natural size — a thread with thirteen
  // of them was mostly a column of giant YouTube buttons with the answer
  // squeezed between them. The kinds are known here, so the reader is told which
  // paths to render small.
  const previewPaths = (
    db
      .prepare("SELECT local_path FROM assets WHERE chat_id = ? AND kind = 'other'")
      .all(id) as unknown as { local_path: string }[]
  )
    .map((a) => assetHrefFor(a.local_path))
    .filter((href): href is string => href !== null);

  return {
    ...toSummary(row),
    externalId: extra?.external_id ?? '',
    url: extra?.url ?? null,
    messages,
    previewPaths,
  };
}

export function setChatFolder(chatId: number, folderId: number | null): void {
  db.prepare('UPDATE chats SET folder_id = ? WHERE id = ?').run(folderId, chatId);
}

export function setChatTitle(chatId: number, userTitle: string): void {
  db.prepare('UPDATE chats SET user_title = ? WHERE id = ?').run(userTitle, chatId);
}

export function deleteChat(id: number): void {
  db.prepare('DELETE FROM chats WHERE id = ?').run(id);
}

/* ---------------------------------------------------------------- harvest */

export interface UpsertResult {
  created: boolean;
  /** True when a row existed and its title changed. */
  titleChanged: boolean;
}

// The sidebar title IS the thread's opening query (confirmed during recon: a
// thread with three turns showed its first turn as both the title and the URL's
// q=). So it doubles as the content key for spotting Google's own duplicates —
// two threads started from the same prompt, which this history really contains.
function contentKeyFor(title: string): string {
  const normalised = title.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalised).digest('hex');
}

/**
 * Records a thread seen in the history list. Turns are not captured here — a
 * list harvest only learns that a conversation exists and what it is called.
 */
export function upsertThreadFromList(
  externalId: string,
  title: string,
  url: string | null,
  listRank: number,
): UpsertResult {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT id, title FROM chats WHERE external_id = ?')
    .get(externalId) as unknown as { id: number; title: string | null } | undefined;

  if (existing) {
    // last_seen_at moves on every sighting; title is refreshed in case Google
    // ever revises it, but user_title is never touched — a name typed by hand
    // must survive re-harvesting.
    // list_rank is refreshed too: a thread that gained a turn moves to the top
    // of Google's list, and that reordering is the whole change signal.
    db.prepare(
      'UPDATE chats SET title = ?, url = ?, last_seen_at = ?, list_rank = ? WHERE id = ?',
    ).run(title, url, now, listRank, existing.id);
    return { created: false, titleChanged: (existing.title ?? '') !== title };
  }

  db.prepare(
    `INSERT INTO chats
       (folder_id, external_id, content_key, url, title, started_at, last_seen_at, source,
        raw_json, list_rank)
     VALUES (NULL, ?, ?, ?, ?, NULL, ?, 'harvest', ?, ?)`,
  ).run(externalId, contentKeyFor(title), url, title, now, JSON.stringify({ title }), listRank);
  return { created: true, titleChanged: false };
}

/** external_ids already stored, so a harvest can tell new from seen. */
export function knownExternalIds(): Set<string> {
  const rows = db.prepare('SELECT external_id FROM chats').all() as unknown as {
    external_id: string;
  }[];
  return new Set(rows.map((r) => r.external_id));
}

/* ------------------------------------------------------------ turn capture */

export interface TurnToSave {
  seq: number;
  role: 'user' | 'ai';
  text: string;
  html: string | null;
}

export interface AssetToSave {
  messageSeq: number;
  /** 'generated' | 'upload' | 'other' — see the assets.kind note in initDb. */
  kind: string | null;
  originalUrl: string | null;
  sha256: string;
  mime: string;
  localPath: string;
  bytes: number;
}

/**
 * Replaces a conversation's turns wholesale, in one transaction.
 *
 * Deliberately delete-then-insert rather than upsert per turn: a re-capture may
 * find FEWER turns than are stored (a deleted turn, or a partial render), and an
 * upsert would silently keep the stale extras, leaving a conversation that never
 * existed in that form. Replacing means what is stored is always a whole
 * snapshot of one reading.
 *
 * Assets cascade from messages, so their rows go with the old turns; the files
 * on disk are content-addressed and shared, so they are left alone.
 */
export function replaceTurns(chatId: number, turns: TurnToSave[], assets: AssetToSave[]): void {
  db.exec('BEGIN');
  try {
    // A conversation read from the panel has no date anywhere: the sidebar list
    // carries none, and the panel's own timestamp is adaptive display text with
    // no machine-readable value behind it (see aiModeDriver.ts). Rather than
    // leave it undateable forever, record when the app first stored it — which
    // is a real fact, just not the one wanted — and mark it as a stand-in so it
    // is never read as the conversation's own date. A later export supplies the
    // real one and replaces this.
    db.prepare(
      `UPDATE chats
          SET started_at = ?, date_basis = 'placeholder'
        WHERE id = ? AND started_at IS NULL`,
    ).run(new Date().toISOString(), chatId);
    // Computed from the turns about to be written, so it describes what is
    // stored rather than what was stored before.
    db.prepare('UPDATE chats SET text_fingerprint = ? WHERE id = ?').run(
      openingFingerprint(turns.map((t) => ({ role: t.role, text: t.text }))),
      chatId,
    );
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
    const insertMessage = db.prepare(
      'INSERT INTO messages (chat_id, seq, role, text, html) VALUES (?, ?, ?, ?, ?)',
    );
    const messageIdBySeq = new Map<number, number>();
    for (const turn of turns) {
      const { lastInsertRowid } = insertMessage.run(
        chatId,
        turn.seq,
        turn.role,
        turn.text,
        turn.html,
      );
      messageIdBySeq.set(turn.seq, Number(lastInsertRowid));
    }

    const insertAsset = db.prepare(
      `INSERT OR IGNORE INTO assets
         (chat_id, message_id, original_url, sha256, mime, local_path, bytes, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const asset of assets) {
      insertAsset.run(
        chatId,
        messageIdBySeq.get(asset.messageSeq) ?? null,
        asset.originalUrl,
        asset.sha256,
        asset.mime,
        asset.localPath,
        asset.bytes,
        asset.kind,
      );
    }

    // source moves to 'capture': this content came from the panel, uploads and
    // images included, so it no longer wants a refresh.
    db.prepare("UPDATE chats SET last_seen_at = ?, source = 'capture' WHERE id = ?").run(
      new Date().toISOString(),
      chatId,
    );
    noteSource(chatId, 'capture');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// There is deliberately no clearTurns(). Clearing before a re-capture is what
// let a failed re-read wipe a conversation it was supposed to refresh —
// replaceTurns already swaps old for new inside one transaction, so nothing
// needs to delete first, and having the function around invites the same
// mistake again.

export function getChatForCapture(chatId: number): ChatToCapture | null {
  const row = db
    .prepare(`SELECT id, external_id, ${CHAT_TITLE_SQL} AS title FROM chats WHERE id = ?`)
    .get(chatId) as unknown as { id: number; external_id: string; title: string } | undefined;
  return row ? { id: row.id, externalId: row.external_id, title: row.title } : null;
}

export interface ChatToCapture {
  id: number;
  externalId: string;
  title: string;
}

/**
 * Conversations still wanting a sidebar capture, in Google's own recency order
 * so the most recent are archived first — that is what a partial run should
 * leave you with.
 *
 * Two kinds qualify. Ones with no turns at all, and ones whose text came from
 * Takeout: that import gives complete text and exact timestamps but few images,
 * and none of the original uploads. Only the sidebar path restores those, and
 * only while Google still lists the conversation — so a Takeout-sourced chat
 * stays queued until it has been pulled from the panel.
 */
export function chatsWithoutTurns(limit: number): ChatToCapture[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.external_id, ${CHAT_TITLE_SQL} AS title
       FROM chats c
       WHERE c.merged_into IS NULL
         AND (
           NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)
           OR c.source = 'takeout'
         )
         -- Excluded: conversations that exist only in Takeout. They have no
         -- Google thread id, so the panel cannot open them however many times
         -- it tries, and queueing them would mark genuinely unrecoverable
         -- conversations as "capture failed" — which reads as a bug rather than
         -- as Google having dropped them.
         AND c.external_id NOT LIKE 'takeout:%'
       -- Never-attempted conversations first, then by Google's recency order.
       -- Without this, a long unattended run re-tries the same early failures
       -- ahead of hundreds of conversations it has never even looked at, and
       -- successive runs make no progress.
       ORDER BY c.capture_attempts ASC,
                CASE WHEN c.list_rank IS NULL THEN 1 ELSE 0 END,
                c.list_rank ASC
       LIMIT ?`,
    )
    .all(limit) as unknown as { id: number; external_id: string; title: string }[];
  return rows.map((r) => ({ id: r.id, externalId: r.external_id, title: r.title }));
}

/** Counted, so a conversation that keeps failing sinks in the queue. */
export function recordCaptureFailure(chatId: number): void {
  db.prepare('UPDATE chats SET capture_attempts = capture_attempts + 1 WHERE id = ?').run(chatId);
}

export function countChatsWithoutTurns(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM chats c
       WHERE c.merged_into IS NULL
         AND (
           NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)
           OR c.source = 'takeout'
         )
         AND c.external_id NOT LIKE 'takeout:%'`,
    )
    .get() as unknown as { n: number };
  return row.n;
}

/* ---------------------------------------------------------------- takeout */

// Third copy of a shared type found this session, re-exported rather than
// redeclared for the same reason as the other two: the renderer parses these
// rows and the main process consumes them, so a member added on one side and
// missing on the other is invisible to the type checker across the IPC hop.
export type { TakeoutImportRow };

export interface TakeoutImportResult {
  created: number;
  updatedText: number;
  skipped: number;
}

export interface ActivityImportResult {
  inserted: number;
  duplicates: number;
  skipped: number;
}

/**
 * Records Takeout entries as activity. Creates no conversations, renames
 * nothing, and cannot pollute the archive — so a wrong parse costs nothing and
 * needs no undo.
 */
export function importActivity(rows: TakeoutImportRow[]): ActivityImportResult {
  const result: ActivityImportResult = { inserted: 0, duplicates: 0, skipped: 0 };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO activity (query, query_key, occurred_at, href)
     VALUES (?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const query = row.query.trim();
      if (!query) {
        // An entry with no query is still evidence that something happened, but
        // there is nothing to match it on, so it is counted rather than stored.
        result.skipped += 1;
        continue;
      }
      const changes = insert.run(query, contentKeyFor(query), row.timestamp, row.href).changes;
      if (Number(changes) > 0) result.inserted += 1;
      else result.duplicates += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return result;
}

export interface TakeoutConversationResult {
  entries: number;
  conversations: number;
  created: number;
  extended: number;
  mergedIntoHarvested: number;
  /**
   * Openings shared by more than one entry in this import. None of them were
   * matched to an existing conversation — see the loop below — so this is the
   * count of conversations left for a person to glue by hand.
   */
  ambiguousOpenings: number;
  /**
   * Links an earlier import made that this one removed, because the entry it
   * pointed at no longer describes the conversation. Non-zero means a previous
   * run's wrong grouping was repaired, which is worth reporting rather than
   * doing quietly.
   */
  regrouped: number;
  /** Entries whose date text the parser could not read. */
  unreadableDates: number;
  /**
   * Entries kept but attached to nothing, because nothing here can say where
   * they belong. They are listed under Orphan entries — never dropped.
   */
  orphaned: number;
  turnsWritten: number;
}

/**
 * An export entry's identity — the one place this shape is written down.
 *
 * Three places need it: the loop that stores entries, the placement decision,
 * and the image attachment that has to find the entry again afterwards. Three
 * copies of the arithmetic would eventually disagree, and the symptom would be
 * an image silently attaching to nothing.
 *
 * Keyed on the opening prompt plus the timestamp, so two conversations that
 * begin identically at different times stay distinct. An entry with no opening
 * prompt is keyed on its payload instead: there is nothing to identify it by, so
 * every one of them would otherwise collide with every other.
 */
export function takeoutEntryRef(
  opening: string,
  timestamp: string | null,
  payload: { turns: unknown; images: unknown; href: unknown },
  entryId?: string | null,
  fingerprints?: { long: string; short: string; empty: string },
): string {
  // Google's own token when the record has one. Preferred over anything derived
  // from the content for a reason that has already bitten: a content hash moves
  // whenever the parser changes, so fixing a parsing bug renames every entry and
  // the next import duplicates all of them rather than updating them. The turn
  // splitter changed exactly that way.
  if (entryId) return `mstk:${entryId}`;
  // The cell's own markup, for the records with no token. Measured on a real
  // export: unique across all 1059 of them when paired with the timestamp, where
  // the timestamp alone loses six. Preferred over anything derived from the
  // parsed content for the same reason the token is — it does not move when the
  // parser is fixed.
  if (fingerprints?.long) return `cell:${timestamp ?? 'nodate'}:${fingerprints.long}`;
  if (opening.trim()) return `${contentKeyFor(opening)}@${timestamp ?? 'nodate'}`;
  // The timestamp is part of the identity, not decoration. An empty cell — no
  // prompt, no turns, no images — has a payload identical to every other empty
  // cell, so hashing the payload alone gave all 259 of them the same reference
  // and INSERT OR IGNORE kept exactly one. The date is the only thing that tells
  // them apart, and they are supposed to be preserved.
  //
  // Two cells with the same content AND the same timestamp are genuinely
  // indistinguishable, and collapsing those is right.
  return `payload:${contentKeyFor(JSON.stringify(payload))}@${timestamp ?? 'nodate'}`;
}

/** Where one entry would land, decided without writing anything. */
export interface EntryPlacement {
  /** Identity of the raw entry: opening prompt plus its timestamp. */
  ref: string;
  /** Hash of the opening prompt. Shared by entries that merely start alike. */
  key: string;
  /** This opening is shared by another entry in the same import. */
  ambiguous: boolean;
  /** Already stored from an earlier import of the same export. */
  knownEntry: boolean;
  /**
   * An existing conversation the app learned about some other way — a sidebar
   * listing or a panel capture — that this entry would enrich. Null when there
   * is no such conversation, when the opening is ambiguous, or when the
   * candidate's turns already contradict this entry's.
   */
  enrich: { id: number; source: string } | null;
  /** The export-owned conversation for this entry, and whether it exists yet. */
  ownExternalId: string;
  ownChatId: number | null;
}

/**
 * Decides where an entry belongs, reading the database but writing nothing.
 *
 * Extracted so the sweep and the import cannot disagree. A preview that
 * reimplements the rule is worse than no preview: it would describe an import
 * that never happens, and the discrepancy would surface as data loss rather
 * than as a wrong number.
 */
export function placeEntry(
  row: TakeoutImportRow,
  openingCount: number,
): EntryPlacement {
  const opening = row.turns.find((t) => t.role === 'user')?.text ?? row.query;
  const key = contentKeyFor(opening);
  // Must be computed exactly as the storing loop computes it, token included.
  // A ref that differs between the two would make every entry look unknown, so
  // nothing would ever be recognised as already imported.
  const ref = takeoutEntryRef(
    opening,
    row.timestamp,
    { turns: row.turns, images: row.imageFiles, href: row.href },
    row.entryId,
    row.fingerprints,
  );
  const ambiguous = openingCount > 1;

  const known =
    (db
      .prepare("SELECT 1 AS n FROM source_entries WHERE kind = 'takeout' AND external_ref = ?")
      .get(ref) as unknown as { n: number } | undefined) !== undefined;

  // An entry already attached to a conversation stays there. This has to come
  // first, and skipping it was a bug: an entry that enriched a harvested
  // conversation on the first import found, on the second, that the candidate
  // query now excluded that conversation — correctly, since it already holds an
  // export entry — while its own takeout: row had never been created. So it
  // created a standalone duplicate of a conversation it had already enriched,
  // and every re-import would have made another.
  //
  // The importer's own link is preferred over one made by hand, because that is
  // the one it is entitled to rewrite; a hand-glued conversation may hold
  // several entries and is not this entry's alone to overwrite.
  const placed = db
    .prepare(
      `SELECT cs.chat_id AS id FROM source_entries e
         JOIN chat_sources cs ON cs.source_entry_id = e.id
         JOIN chats c ON c.id = cs.chat_id
        WHERE e.kind = 'takeout' AND e.external_ref = ? AND c.merged_into IS NULL
          -- Only conversations the app learned about some other way. An
          -- export-owned row is deliberately NOT rescued here: when an earlier
          -- import grouped two entries into one of those, the link is the
          -- mistake, and honouring it would send the entry straight back into
          -- the grouping the re-import exists to undo.
          AND c.external_id NOT LIKE 'takeout:%' AND c.external_id NOT LIKE 'entry:%'
        ORDER BY CASE cs.linked_by WHEN 'import' THEN 0 ELSE 1 END
        LIMIT 1`,
    )
    .get(ref) as { id: number } | undefined;
  if (placed) {
    return {
      ref,
      key,
      ambiguous,
      knownEntry: known,
      enrich: null,
      ownExternalId: `takeout:${key.slice(0, 16)}:${row.timestamp ?? 'nodate'}`,
      ownChatId: placed.id,
    };
  }

  // An entry may attach to a conversation the app learned about some OTHER way
  // — a sidebar listing, or a panel capture. That is the enrichment case, and
  // it is the whole reason for matching: the export carries text and a date,
  // the panel carries the images, and together they describe one conversation.
  //
  // It may NOT attach to a conversation that came from another export entry.
  // Two entries opening with the same prompt are indistinguishable from outside
  // — one conversation logged twice, the same question asked twice, or a clone
  // Google made on its own — and an earlier version of this check verified only
  // that the second entry's prompts STARTED the same way, which is true in all
  // three cases. The first entry's turns were then deleted and replaced by the
  // second's, so a 2-turn conversation and a 4-turn one became a single 4-turn
  // one and the shorter reading was gone.
  //
  // And the match must be unambiguous on both sides. When several entries in
  // one import share an opening, at most one of them is that conversation and
  // nothing here can tell which — so none of them claim it.
  const candidates = ambiguous
    ? []
    : (db
        .prepare(
          `SELECT id, source FROM chats
            WHERE content_key = ? AND merged_into IS NULL
              AND external_id NOT LIKE 'takeout:%' AND external_id NOT LIKE 'entry:%'
              AND NOT EXISTS (
                    SELECT 1 FROM chat_sources cs
                      JOIN source_entries e ON e.id = cs.source_entry_id
                     WHERE cs.chat_id = chats.id AND e.kind = 'takeout'
                  )
            LIMIT 2`,
        )
        .all(key) as unknown as { id: number; source: string }[]);

  const agreesWith = (candidateId: number): boolean => {
    const existing = db
      .prepare("SELECT text FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY seq LIMIT 2")
      .all(candidateId) as unknown as { text: string }[];
    // No turns stored yet (a bare sidebar listing) — nothing to contradict.
    if (existing.length === 0) return true;
    const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
    const mine = row.turns.filter((t) => t.role === 'user').map((t) => norm(t.text));
    const theirs = existing.map((t) => norm(t.text));
    // Compare as far as both go. Divergence at the second prompt means two
    // different conversations that happen to open alike, and merging them would
    // fabricate a conversation that never existed.
    return theirs.every((t, i) => mine[i] === undefined || mine[i] === t);
  };

  const enrich =
    candidates.length === 1 && agreesWith(candidates[0].id) ? candidates[0] : null;

  // Distinguished by timestamp as well as opening, so two conversations that
  // begin identically get separate rows instead of overwriting each other —
  // including Google's own clones.
  const ownExternalId = `takeout:${key.slice(0, 16)}:${row.timestamp ?? 'nodate'}`;
  const own = db.prepare('SELECT id FROM chats WHERE external_id = ?').get(ownExternalId) as
    | { id: number }
    | undefined;

  return {
    ref,
    key,
    ambiguous,
    knownEntry: known,
    enrich,
    ownExternalId,
    ownChatId: own?.id ?? null,
  };
}

/**
 * Groups entries that are successive snapshots of ONE conversation.
 *
 * The export records a snapshot per submission, each holding the conversation
 * so far, so ~300 conversations arrive as thousands of entries. Importing one
 * conversation per entry is the bug that turned 981 entries into 736 phantom
 * chats; grouping them by opening prompt alone is the opposite bug, since two
 * conversations can open identically and Google sometimes clones one outright.
 *
 * Neither is necessary, because snapshots of one conversation are not merely
 * similar — they are PREFIX-CONSISTENT. Every turn of the earlier snapshot
 * appears, identical and in order, at the start of the later one. That is a
 * fact about the text rather than a judgement about intent, so it can be
 * decided here.
 *
 * When two entries share an opening and then diverge, they are different
 * conversations and each gets its own. That is the case nothing can resolve
 * automatically, and it stays a manual glue.
 */
export interface ConversationPlan {
  key: string;
  /** Every snapshot, shortest first. All of them are recorded as source entries. */
  snapshots: TakeoutImportRow[];
  /** The furthest along, and therefore the conversation itself. */
  best: TakeoutImportRow;
}

/** A row's turns as comparable text, so snapshots can be matched exactly. */
function turnKeys(row: TakeoutImportRow): string[] {
  return row.turns.map((t) => `${t.role}:${t.text.toLowerCase().replace(/\s+/g, ' ').trim()}`);
}

function isPrefixOf(shorter: string[], longer: string[]): boolean {
  if (shorter.length > longer.length) return false;
  return shorter.every((turn, index) => turn === longer[index]);
}

export function planConversations(rows: TakeoutImportRow[]): ConversationPlan[] {
  const byKey = new Map<string, TakeoutImportRow[]>();
  for (const row of rows) {
    const opening = row.turns.find((t) => t.role === 'user')?.text ?? row.query;
    if (!opening.trim()) continue;
    const key = contentKeyFor(opening);
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }

  const plans: ConversationPlan[] = [];
  for (const [key, group] of byKey) {
    // Shortest first, so each entry either extends a chain already seen or
    // starts one. Walking longest-first would need the same comparisons in
    // reverse and makes the "extend" case harder to see.
    const ordered = [...group].sort((a, b) => a.turns.length - b.turns.length);
    const chains: { keys: string[]; plan: ConversationPlan }[] = [];
    for (const row of ordered) {
      const keys = turnKeys(row);
      const chain = chains.find((c) => isPrefixOf(c.keys, keys));
      if (chain) {
        chain.keys = keys;
        chain.plan.snapshots.push(row);
        chain.plan.best = row;
      } else {
        const plan: ConversationPlan = { key, snapshots: [row], best: row };
        chains.push({ keys, plan });
        plans.push(plan);
      }
    }
  }
  return plans;
}

/** How many entries in one import open with each prompt. */
export function openingCounts(rows: TakeoutImportRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const opening = row.turns.find((t) => t.role === 'user')?.text ?? row.query;
    if (!opening.trim()) continue;
    const key = contentKeyFor(opening);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface TakeoutPreview {
  entries: number;
  /** Conversations those entries describe — far fewer, and the figure that matters. */
  conversations: number;
  /** Earlier snapshots folded into a later one, rather than made into conversations. */
  snapshotsFolded: number;
  /**
   * Entries with no opening prompt. They are still stored — nothing is dropped —
   * and become orphans for review rather than conversations.
   */
  wouldOrphan: number;
  /** Already stored by an earlier import of the same export. */
  alreadyKnown: number;
  /** Would attach to a conversation harvested or captured from the panel. */
  wouldEnrich: number;
  /** Would update a conversation an earlier import of this export created. */
  wouldUpdate: number;
  /** Would create a conversation of its own. */
  wouldCreate: number;
  /** Openings shared by several entries, so none of them claim a match. */
  ambiguous: number;
  /** Existing conversations that would be touched. */
  chatsTouched: number;
}

/**
 * The sweep: what an import would do, before it does any of it.
 *
 * Reads only. Uses placeEntry, so it describes the import that will actually
 * run rather than a second implementation of the same intent.
 */
export function previewTakeoutImport(rows: TakeoutImportRow[]): TakeoutPreview {
  // Counted over CONVERSATIONS, exactly as the import counts them. Reporting
  // entries here was wrong and misleading in the way that matters: 1779 "new
  // threads" for an account with about 300, because the export records one
  // entry per submission and most entries are earlier snapshots of a
  // conversation another entry already describes.
  const plans = planConversations(rows);
  const counts = new Map<string, number>();
  for (const plan of plans) counts.set(plan.key, (counts.get(plan.key) ?? 0) + 1);

  const preview: TakeoutPreview = {
    entries: rows.length,
    conversations: plans.length,
    snapshotsFolded: plans.reduce((n, plan) => n + plan.snapshots.length - 1, 0),
    wouldOrphan: 0,
    alreadyKnown: 0,
    wouldEnrich: 0,
    wouldUpdate: 0,
    wouldCreate: 0,
    ambiguous: 0,
    chatsTouched: 0,
  };
  for (const row of rows) {
    const opening = row.turns.find((t) => t.role === 'user')?.text ?? row.query;
    if (!opening.trim()) preview.wouldOrphan += 1;
  }

  const touched = new Set<number>();
  for (const plan of plans) {
    const placement = placeEntry(plan.best, counts.get(plan.key) ?? 1);
    // Known when every snapshot of it is already stored; a conversation that has
    // grown since the last import is not "already known".
    if (placement.knownEntry) preview.alreadyKnown += 1;
    if (placement.ambiguous) preview.ambiguous += 1;
    if (placement.enrich) {
      preview.wouldEnrich += 1;
      touched.add(placement.enrich.id);
    } else if (placement.ownChatId !== null) {
      preview.wouldUpdate += 1;
      touched.add(placement.ownChatId);
    } else {
      preview.wouldCreate += 1;
    }
  }
  preview.chatsTouched = touched.size;
  return preview;
}

/**
 * Imports Takeout entries as conversations, with their turns.
 *
 * Takeout is the base and the panel extends it: an export holds the complete
 * text of every conversation including ones Google has since dropped, while
 * only the panel still has the original uploads and generated images.
 *
 * Nothing is grouped automatically — see the note in the body, and placeEntry
 * for where each entry lands. A conversation the app already knows about from
 * the sidebar or the panel is EXTENDED rather than duplicated, keeping its
 * Google thread id, which is the only real identifier in the system and the
 * thing that makes a later panel capture possible.
 */
export function importTakeoutConversations(
  rows: TakeoutImportRow[],
): TakeoutConversationResult {
  const result: TakeoutConversationResult = {
    entries: rows.length,
    conversations: 0,
    created: 0,
    extended: 0,
    mergedIntoHarvested: 0,
    ambiguousOpenings: 0,
    regrouped: 0,
    unreadableDates: 0,
    orphaned: 0,
    turnsWritten: 0,
  };

  // NO automatic grouping. Successive snapshots of one conversation, the same
  // query asked twice, and Google's own clones are indistinguishable without
  // judgement, and every automatic rule tried here was wrong in one of those
  // three cases — collapsing distinct conversations, or discarding one
  // outright. Each entry is therefore imported in full and kept reviewable, and
  // gluing them together is a deliberate action (see mergeChats).
  //
  // The cost is more rows than conversations; the benefit is that nothing is
  // silently lost or silently welded, and the duplicates are visible.
  //
  // What IS grouped is a conversation with its own earlier snapshots, because
  // that needs no judgement: the export records one entry per submission, each
  // holding the conversation so far, so an earlier snapshot's turns are a
  // prefix of a later one's. See planConversations. Entries that share an
  // opening and then diverge stay separate, which is the case a person has to
  // decide.
  const plans = planConversations(rows);
  result.conversations = plans.length;

  // Preserve every entry first, before any interpretation of it. If the
  // grouping below is wrong, this is what makes it fixable without going back
  // to the export.
  const keepEntry = db.prepare(
    `INSERT OR IGNORE INTO source_entries
       (kind, external_ref, query, query_key, occurred_at, href, payload_json, imported_at)
     VALUES ('takeout', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const findEntry = db.prepare(
    "SELECT id FROM source_entries WHERE kind = 'takeout' AND external_ref = ?",
  );
  const entryIdByRef = new Map<string, number>();
  db.exec('BEGIN');
  try {
    const now = new Date().toISOString();
    for (const row of rows) {
      const opening = row.turns.find((t) => t.role === 'user')?.text ?? row.query;
      // EVERY entry is stored, including ones with no opening prompt. They used
      // to be skipped here, before being written at all — which is a loss, and
      // the one thing this design does not permit. An entry nothing can place
      // becomes an orphan: kept verbatim, attached to nothing, listed under
      // Orphan entries and reviewable there. Unplaceable is a statement about
      // what can be worked out, not a licence to discard.
      //
      // Its identity is the payload rather than the opening, since there is no
      // opening to key on and every such entry would otherwise collide with
      // every other. Content-addressed, so re-importing the same export
      // recognises them instead of piling up copies.
      const ref = takeoutEntryRef(
    opening,
    row.timestamp,
    { turns: row.turns, images: row.imageFiles, href: row.href },
    row.entryId,
    row.fingerprints,
  );
      if (!opening.trim()) result.orphaned += 1;
      // A row with date text but no parsed timestamp is a parser failure, not
      // a gap in the export, and the two need different responses — so it is
      // counted separately and the raw text is kept on the entry so it can be
      // read back and the pattern fixed.
      if (row.timestamp === null && row.timestampText) result.unreadableDates += 1;
      keepEntry.run(
        ref,
        row.query,
        opening.trim() ? contentKeyFor(opening) : null,
        row.timestamp,
        row.href,
        JSON.stringify({
          turns: row.turns,
          images: row.imageFiles,
          timestampText: row.timestampText ?? null,
          // Kept on the entry so the openings can be compared later without
          // re-parsing the export — and so a future matching pass can use the
          // opening EXCHANGE rather than the opening prompt. Measured on a real
          // export: 132 records share an opening prompt while only 2 share an
          // opening prompt AND its answer, so the prompt alone over-reports the
          // clone case by a factor of sixty-five.
          fingerprints: row.fingerprints ?? null,
          entryId: row.entryId ?? null,
          // The cross-source key, computed the same way on both sides. See
          // src/shared/fingerprint.ts for why it is text and not markup: an
          // image arrives re-encoded and renamed, and the export's own token
          // does not exist outside the export.
          textFingerprint: openingFingerprint(row.turns),
        }),
        now,
      );
      const found = findEntry.get(ref) as unknown as { id: number } | undefined;
      if (found) entryIdByRef.set(ref, found.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  // An opening shared by several entries cannot identify any one of them, so it
  // disqualifies automatic matching outright rather than handing the
  // conversation to whichever entry the loop happens to reach last.
  // Counted over CONVERSATIONS, not entries. Several snapshots of one
  // conversation share an opening by definition and say nothing about ambiguity;
  // two distinct conversations sharing one is the case where neither may claim a
  // harvested thread.
  const counts = new Map<string, number>();
  for (const plan of plans) counts.set(plan.key, (counts.get(plan.key) ?? 0) + 1);

  db.exec('BEGIN');
  try {
    for (const plan of plans) {
      // The furthest-along snapshot IS the conversation; the shorter ones are
      // its history, recorded as source entries against it.
      const row = plan.best;
      const members = plan.snapshots.length;
      const key = plan.key;
      const opening = row.turns.find((t) => t.role === 'user')?.text ?? row.query;

      // One shared rule, so the sweep cannot promise an import that differs
      // from the one that runs.
      const placement = placeEntry(row, counts.get(key) ?? 1);
      if (placement.ambiguous) result.ambiguousOpenings += 1;

      let chatId: number;
      if (placement.enrich) {
        chatId = placement.enrich.id;
        if (placement.enrich.source === 'capture') {
          // The panel version wins on content: it has the uploads and generated
          // images Takeout lacks, and Takeout's text is rougher.
          //
          // But the Takeout reading is KEPT rather than dropped. They are two
          // independent readings of the same conversation, and where they differ
          // that is worth knowing — a truncated capture, a turn Google has since
          // edited, or an image that only one of them saw. Silently preferring
          // one would hide the disagreement. raw_json exists for exactly this.
          const existingRaw = db.prepare('SELECT raw_json FROM chats WHERE id = ?').get(chatId) as
            | { raw_json: string }
            | undefined;
          let merged: Record<string, unknown> = {};
          try {
            merged = existingRaw ? JSON.parse(existingRaw.raw_json) : {};
          } catch {
            merged = {};
          }
          merged.takeout = { href: row.href, timestamp: row.timestamp, turns: row.turns };
          db.prepare(
            `UPDATE chats
                SET started_at = CASE
                      WHEN ? IS NOT NULL AND (started_at IS NULL OR date_basis = 'placeholder')
                        THEN ?
                      ELSE started_at
                    END,
                    date_basis = CASE
                      WHEN ? IS NOT NULL AND (started_at IS NULL OR date_basis = 'placeholder')
                        THEN 'takeout'
                      ELSE date_basis
                    END,
                    raw_json = ?, takeout_entries = ?
              WHERE id = ?`,
          ).run(
            row.timestamp,
            row.timestamp,
            row.timestamp,
            JSON.stringify(merged),
            members,
            chatId,
          );
          noteSource(chatId, 'takeout-alt');
          result.mergedIntoHarvested += 1;
          continue;
        }
        result.extended += 1;
      } else {
        const externalId = placement.ownExternalId;
        if (placement.ownChatId !== null) {
          chatId = placement.ownChatId;
          result.extended += 1;
        } else {
          const { lastInsertRowid } = db
            .prepare(
              `INSERT INTO chats
                 (folder_id, external_id, content_key, url, title, started_at, last_seen_at,
                  source, raw_json, list_rank)
               VALUES (NULL, ?, ?, NULL, ?, ?, ?, 'takeout', ?, NULL)`,
            )
            .run(
              externalId,
              key,
              opening.slice(0, 300),
              row.timestamp,
              new Date().toISOString(),
              JSON.stringify({ takeout: { href: row.href } }),
            );
          chatId = Number(lastInsertRowid);
          result.created += 1;
        }
      }

      db.prepare(
        `UPDATE chats
            SET started_at = COALESCE(?, started_at),
                date_basis = CASE WHEN ? IS NOT NULL THEN 'takeout' ELSE date_basis END,
                takeout_entries = ?
          WHERE id = ?`,
      ).run(row.timestamp, row.timestamp, members, chatId);
      // Replace wholesale: this snapshot is a complete reading, and a partial
      // upsert would leave stale turns from an earlier, shorter snapshot.
      db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
      const insert = db.prepare(
        'INSERT INTO messages (chat_id, seq, role, text, html) VALUES (?, ?, ?, ?, ?)',
      );
      row.turns.forEach((turn, index) => {
        // html is kept so emphasis and links survive; the reader sanitises it
        // before rendering, as it does for panel captures.
        insert.run(chatId, index, turn.role, turn.text, turn.html || null);
      });
      result.turnsWritten += row.turns.length;
      noteSource(chatId, 'takeout');
      const openingRef = `${key}@${row.timestamp ?? 'nodate'}`;
      const entryId = entryIdByRef.get(openingRef);
      if (entryId !== undefined) {
        // The turns above were written from this one entry, so this is the only
        // entry the import can claim describes this conversation. Any other
        // link the IMPORT made is a grouping an earlier run got wrong, and
        // leaving it would show a conversation as built from entries whose
        // turns are no longer in it. Links made by hand are untouched: gluing
        // is the owner's decision and re-running an import must not reverse it.
        // Every snapshot of this conversation, not only the one whose turns
        // were written: they are the record of how it got here, and the reason
        // a wrong grouping can be taken apart later.
        const snapshotIds = plan.snapshots
          .map((snapshot) => {
            const opening =
              snapshot.turns.find((t) => t.role === 'user')?.text ?? snapshot.query;
            return entryIdByRef.get(
              takeoutEntryRef(
                opening,
                snapshot.timestamp,
                {
                  turns: snapshot.turns,
                  images: snapshot.imageFiles,
                  href: snapshot.href,
                },
                snapshot.entryId,
                snapshot.fingerprints,
              ),
            );
          })
          .filter((id): id is number => id !== undefined);
        const keepList = snapshotIds.length > 0 ? snapshotIds : [entryId];
        const placeholders = keepList.map(() => '?').join(',');
        const { changes } = db
          .prepare(
            `DELETE FROM chat_sources
               WHERE chat_id = ? AND source_entry_id NOT IN (${placeholders})
                 AND linked_by = 'import'`,
          )
          .run(chatId, ...keepList);
        result.regrouped += Number(changes);
        const link = db.prepare(
          `INSERT INTO chat_sources (chat_id, source_entry_id, linked_by)
           VALUES (?, ?, 'import')
           ON CONFLICT (chat_id, source_entry_id) DO NOTHING`,
        );
        for (const id of keepList) link.run(chatId, id);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return result;
}

/**
 * Glues conversations together: the losers are marked as merged into the
 * keeper rather than deleted.
 *
 * Deliberately manual. Deciding whether two conversations that open with the
 * same prompt are one conversation, two separate attempts, or a clone Google
 * made is a judgement about intent, and every automatic rule attempted here got
 * one of those three wrong. Reversible for the same reason: merged_into is set,
 * nothing is destroyed, so a wrong glue can be undone.
 */
export function mergeChats(keepId: number, mergeIds: number[]): { merged: number } {
  const ids = mergeIds.filter((id) => id !== keepId);
  if (ids.length === 0) return { merged: 0 };
  db.exec('BEGIN');
  try {
    const placeholders = ids.map(() => '?').join(',');
    // Folder and hand-typed title survive on the keeper; the merged rows keep
    // their own turns so the glue can be inspected and reversed.
    db.prepare(`UPDATE chats SET merged_into = ? WHERE id IN (${placeholders})`).run(keepId, ...ids);

    // The data entries move to the keeper, and this is the substance of the
    // glue rather than bookkeeping after it: one conversation with several
    // entries attached to it IS what gluing means, and the keeper's entry list
    // is where those entries are seen and taken apart again.
    //
    // Leaving them behind broke both ends. The keeper listed only its own
    // entry, so a glue of three showed one. And a merged-away conversation is
    // hidden from every list, so an entry attached only to one was held by
    // something unreachable and never appeared among the orphans either —
    // present in the database and absent from the app.
    //
    // Which entries moved is recorded on each loser so unmerging is an exact
    // reversal rather than a guess at what was there before.
    const moveLinks = db.prepare(
      'UPDATE OR IGNORE chat_sources SET chat_id = ? WHERE chat_id = ?',
    );
    const dropLeftovers = db.prepare('DELETE FROM chat_sources WHERE chat_id = ?');
    for (const id of ids) {
      const moved = (
        db
          .prepare('SELECT source_entry_id AS id FROM chat_sources WHERE chat_id = ?')
          .all(id) as unknown as { id: number }[]
      ).map((r) => r.id);
      moveLinks.run(keepId, id);
      // UPDATE OR IGNORE leaves behind any row whose (keeper, entry) pair
      // already existed — the entry is on the keeper either way, and the
      // duplicate on the loser would otherwise survive the glue.
      dropLeftovers.run(id);
      const raw = db.prepare('SELECT raw_json FROM chats WHERE id = ?').get(id) as
        | { raw_json: string }
        | undefined;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? JSON.parse(raw.raw_json) : {};
      } catch {
        parsed = {};
      }
      parsed.glue = { into: keepId, movedEntries: moved };
      db.prepare('UPDATE chats SET raw_json = ? WHERE id = ?').run(JSON.stringify(parsed), id);
    }
    noteSource(keepId, 'glued');
    db.exec('COMMIT');
    return { merged: ids.length };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Reverses a glue, giving the conversation back the entries it brought. */
export function unmergeChat(chatId: number): void {
  db.exec('BEGIN');
  try {
    const raw = db.prepare('SELECT raw_json FROM chats WHERE id = ?').get(chatId) as
      | { raw_json: string }
      | undefined;
    let moved: number[] = [];
    try {
      const parsed = raw ? (JSON.parse(raw.raw_json) as { glue?: { movedEntries?: number[] } }) : {};
      moved = parsed.glue?.movedEntries ?? [];
    } catch {
      moved = [];
    }
    // Read before clearing it: merged_into IS the record of which conversation
    // to take the entries back from, so clearing it first loses the answer.
    const keeper = db.prepare('SELECT merged_into FROM chats WHERE id = ?').get(chatId) as
      | { merged_into: number | null }
      | undefined;
    db.prepare('UPDATE chats SET merged_into = NULL WHERE id = ?').run(chatId);
    // Taken off the keeper as well: after unmerging, the entry describes this
    // conversation and not the one it was glued into. An entry deliberately
    // attached to both by hand is a separate decision and is made again by
    // hand — guessing which of the two a link was would be worse than either.
    const give = db.prepare(
      `INSERT INTO chat_sources (chat_id, source_entry_id, linked_by)
       VALUES (?, ?, 'manual')
       ON CONFLICT (chat_id, source_entry_id) DO UPDATE SET linked_by = 'manual'`,
    );
    const takeBack = db.prepare('DELETE FROM chat_sources WHERE chat_id = ? AND source_entry_id = ?');
    for (const entryId of moved) {
      give.run(chatId, entryId);
      if (keeper?.merged_into != null) takeBack.run(keeper.merged_into, entryId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export interface SourceEntryView {
  id: number;
  kind: string;
  occurredAt: string | null;
  href: string | null;
  query: string | null;
  turnCount: number;
  imageCount: number;
  linked: boolean;
  /**
   * How many conversations this entry is attached to. Normally one, but the
   * link table is many-to-many on purpose and that is not a case to design
   * away: one export entry can be evidence for two conversations that Google
   * cloned apart, and the same entry can legitimately be cited by both until
   * someone decides otherwise. A count above one is a fact worth showing, not
   * a corruption to repair.
   */
  chatCount: number;
  /**
   * The date as the export wrote it, kept when it could not be parsed. Present
   * only in that case, so an entry showing no date says which kind of no-date
   * it is: nothing to read, or something we failed to read.
   */
  dateText: string | null;
  /**
   * Where this entry's images ended up, as relative "assets/..." paths. An
   * orphan has no thread to render through, so this is the only way its picture
   * can be seen — and for a Lens record the picture is the entire content.
   */
  imagePaths: string[];
}

/**
 * The data entries behind a conversation, and the unlinked ones that share its
 * opening prompt.
 *
 * A conversation is a view over these: each contributes different fields — one
 * may carry the only timestamp, another the only image, a third the fullest
 * text — so which entries are attached is the substance of the record, not
 * metadata about it. Unlinked candidates are listed alongside so attaching one
 * is a decision made with everything in sight.
 */
export function sourceEntriesForChat(chatId: number): SourceEntryView[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.kind, e.occurred_at, e.href, e.query, e.payload_json,
              (SELECT COUNT(*) FROM chat_sources cs WHERE cs.source_entry_id = e.id) AS chat_count,
              EXISTS (
                SELECT 1 FROM chat_sources cs
                 WHERE cs.source_entry_id = e.id AND cs.chat_id = ?
              ) AS linked
         FROM source_entries e
        WHERE EXISTS (
                SELECT 1 FROM chat_sources cs
                 WHERE cs.source_entry_id = e.id AND cs.chat_id = ?
              )
           OR e.query_key = (SELECT content_key FROM chats WHERE id = ?)
        ORDER BY linked DESC, e.occurred_at`,
    )
    .all(chatId, chatId, chatId) as unknown as {
    id: number;
    kind: string;
    occurred_at: string | null;
    href: string | null;
    query: string | null;
    payload_json: string;
    linked: number;
    chat_count: number;
  }[];

  return rows.map((row) => {
    let turnCount = 0;
    let imageCount = 0;
    let dateText: string | null = null;
    let imagePaths: string[] = [];
    try {
      const payload = JSON.parse(row.payload_json) as {
        turns?: unknown[];
        images?: unknown[];
        timestampText?: string | null;
        storedImages?: string[];
      };
      turnCount = payload.turns?.length ?? 0;
      imageCount = payload.images?.length ?? 0;
      dateText = payload.timestampText ?? null;
      imagePaths = payload.storedImages ?? [];
    } catch {
      // A payload that will not parse is still worth listing: its existence is
      // the point, and hiding it would make the record look complete.
    }
    return {
      id: row.id,
      kind: row.kind,
      occurredAt: row.occurred_at,
      href: row.href,
      query: row.query,
      turnCount,
      imageCount,
      linked: row.linked === 1,
      chatCount: row.chat_count,
      dateText,
      imagePaths,
    };
  });
}

/**
 * Attaches a data entry to a conversation by hand — the entry-level glue.
 *
 * Does not detach anything it displaces. An entry may end up attached to
 * several conversations, and that is allowed: see SourceEntryView.chatCount.
 */
export function linkSourceEntry(chatId: number, entryId: number): void {
  db.prepare(
    `INSERT INTO chat_sources (chat_id, source_entry_id, linked_by)
     VALUES (?, ?, 'manual')
     ON CONFLICT (chat_id, source_entry_id) DO UPDATE SET linked_by = 'manual'`,
  ).run(chatId, entryId);
}

/** Writes an entry's own reading of the conversation as the chat's turns. */
function writeTurnsFromEntries(chatId: number, entryIds: number[]): number {
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
  if (entryIds.length === 0) return 0;
  const insert = db.prepare(
    'INSERT INTO messages (chat_id, seq, role, text, html) VALUES (?, ?, ?, ?, ?)',
  );
  const get = db.prepare('SELECT payload_json FROM source_entries WHERE id = ?');
  let seq = 0;
  for (const entryId of entryIds) {
    const row = get.get(entryId) as unknown as { payload_json: string } | undefined;
    if (!row) continue;
    let turns: { role: string; text: string; html?: string }[] = [];
    try {
      turns = (JSON.parse(row.payload_json) as { turns?: typeof turns }).turns ?? [];
    } catch {
      continue;
    }
    for (const turn of turns) {
      insert.run(chatId, seq, turn.role, turn.text, turn.html || null);
      seq += 1;
    }
  }
  return seq;
}

/**
 * Ungluing: detaches one data entry and gives it a conversation of its own.
 *
 * The case this exists for is two entries that were glued together only
 * because they open with the same prompt — the same question asked twice, or a
 * clone Google made — which is a mistake nothing but a person can recognise.
 * So it is a manual action, and it produces a real conversation: its own
 * internal id, its own external id, and its own link to the entry. Merely
 * dropping the link would leave the entry attached to nothing, which loses the
 * reading it carries.
 *
 * The entry keeps the identity: the new external id is derived from the entry
 * row, so ungluing the same entry twice reuses the conversation it already
 * made rather than piling up near-duplicates.
 *
 * The conversation left behind is rebuilt from whatever entries remain — the
 * "conversation is a view over its entries" rule actually applied — unless it
 * has been read from the panel, which is a better reading than any export and
 * must not be overwritten by one.
 */
export function unglueSourceEntry(chatId: number, entryId: number): { chatId: number } {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM chat_sources WHERE chat_id = ? AND source_entry_id = ?').run(
      chatId,
      entryId,
    );
    const folder = db.prepare('SELECT folder_id FROM chats WHERE id = ?').get(chatId) as
      | { folder_id: number | null }
      | undefined;
    const newChatId = adoptEntry(entryId, folder?.folder_id ?? null, chatId);

    // The conversation left behind is rebuilt from whatever entries remain —
    // the "conversation is a view over its entries" rule actually applied —
    // unless it has been read from the panel, which is a fuller reading than
    // any export and must not be overwritten by one.
    const remaining = (
      db
        .prepare(
          `SELECT cs.source_entry_id AS id FROM chat_sources cs
             JOIN source_entries e ON e.id = cs.source_entry_id
            WHERE cs.chat_id = ? ORDER BY e.occurred_at`,
        )
        .all(chatId) as unknown as { id: number }[]
    ).map((r) => r.id);
    const left = db.prepare('SELECT sources FROM chats WHERE id = ?').get(chatId) as
      | { sources: string | null }
      | undefined;
    if (remaining.length > 0 && !(left?.sources ?? '').split(',').includes('capture')) {
      writeTurnsFromEntries(chatId, remaining);
    }
    db.prepare('UPDATE chats SET takeout_entries = ? WHERE id = ?').run(remaining.length, chatId);

    db.exec('COMMIT');
    return { chatId: newChatId };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Gives one entry a conversation of its own. Caller holds the transaction.
 *
 * The entry keeps the identity: the external id is derived from the entry row,
 * so adopting the same entry twice reuses the conversation it already made
 * rather than piling up near-duplicates.
 */
function adoptEntry(entryId: number, folderId: number | null, from?: number): number {
  const entry = db
    .prepare(
      'SELECT id, kind, query, query_key, occurred_at, href FROM source_entries WHERE id = ?',
    )
    .get(entryId) as unknown as
    | {
        id: number;
        kind: string;
        query: string | null;
        query_key: string | null;
        occurred_at: string | null;
        href: string | null;
      }
    | undefined;
  if (!entry) throw new Error(`No source entry ${entryId}`);

  const externalId = `entry:${entry.id}`;
  let chatId: number;
  const existing = db.prepare('SELECT id FROM chats WHERE external_id = ?').get(externalId) as
    | { id: number }
    | undefined;
  if (existing) {
    chatId = existing.id;
    // A previous split of this entry was merged away; splitting again is a
    // reversal of that, so bring it back rather than making a third row.
    db.prepare('UPDATE chats SET merged_into = NULL WHERE id = ?').run(chatId);
  } else {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO chats
           (folder_id, external_id, content_key, url, title, started_at, last_seen_at,
            source, raw_json, list_rank)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        folderId,
        externalId,
        entry.query_key,
        (entry.query ?? '(untitled)').slice(0, 300),
        entry.occurred_at,
        new Date().toISOString(),
        entry.kind,
        JSON.stringify({ adopted: { from: from ?? null, entry: entry.id, href: entry.href } }),
      );
    chatId = Number(lastInsertRowid);
  }

  db.prepare(
    `INSERT INTO chat_sources (chat_id, source_entry_id, linked_by)
     VALUES (?, ?, 'manual')
     ON CONFLICT (chat_id, source_entry_id) DO UPDATE SET linked_by = 'manual'`,
  ).run(chatId, entryId);
  writeTurnsFromEntries(chatId, [entryId]);
  // Both: where the content came from, and how this conversation came to
  // exist. Recording only the latter would make an unglued conversation look
  // like it had no source at all.
  noteSource(chatId, entry.kind);
  noteSource(chatId, from === undefined ? 'adopted' : 'unglued');
  return chatId;
}

/**
 * The conversation an entry is attached to, by the entry's own reference.
 *
 * Uses the link table, so it answers the question the same way the rest of the
 * app does rather than re-deriving it from the entry's contents.
 */
export function chatIdForEntry(ref: string): number | null {
  const row = db
    .prepare(
      `SELECT cs.chat_id AS id FROM source_entries e
         JOIN chat_sources cs ON cs.source_entry_id = e.id
         JOIN chats c ON c.id = cs.chat_id
        WHERE e.kind = 'takeout' AND e.external_ref = ? AND c.merged_into IS NULL
        ORDER BY CASE cs.linked_by WHEN 'import' THEN 0 ELSE 1 END
        LIMIT 1`,
    )
    .get(ref) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Records an image shipped in the export against its conversation.
 *
 * Without this the export's images were copied into the asset store and then
 * abandoned: files on disk with no row pointing at them, so the app could not
 * count them, show them, or find them again. Bytes kept and knowledge of them
 * thrown away, which is the same loss as deleting them.
 *
 * message_id is null: the export puts its images in a cell of their own, beside
 * the conversation rather than inside a turn, so there is no turn to attribute
 * them to without guessing.
 */
export function attachExportImage(
  chatId: number,
  asset: { sha256: string; mime: string; localPath: string; bytes: number },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO assets
       (chat_id, message_id, original_url, sha256, mime, local_path, bytes, kind)
     VALUES (?, NULL, NULL, ?, ?, ?, ?, 'takeout')`,
  ).run(chatId, asset.sha256, asset.mime, asset.localPath, asset.bytes);
}

/**
 * Records where an entry's image was stored, on the entry itself.
 *
 * An entry that belongs to no thread — a Lens search is a date and an image and
 * nothing else — has no chat row to hang an asset off, and assets.chat_id cannot
 * be null. Without this the file was copied to disk and the only thing naming it
 * was the export's own filename, so the orphan list could say an image existed
 * and never show it.
 */
/**
 * A date read off the panel, for a thread that has none.
 *
 * The panel's own timestamp element is adaptive display text — "17:05" for a turn
 * from today, "August 22, 2026" for an older one — and it is not rendered for
 * every turn, which is why it was recorded as unusable and thrown away. That was
 * too strong: when it does say a date, it is a real one, and a real date to the
 * day beats a placeholder saying only that the app saved the thread today.
 *
 * Only ever improves on a placeholder or on nothing. An export's date wins,
 * because it is precise to the second while this is precise to the day, and a
 * coarser fact must not overwrite a finer one.
 */
export function setPanelDate(chatId: number, isoDate: string): void {
  db.prepare(
    `UPDATE chats
        SET started_at = ?, date_basis = 'panel'
      WHERE id = ?
        AND (started_at IS NULL OR date_basis = 'placeholder')`,
  ).run(isoDate, chatId);
}

export function attachEntryImage(ref: string, relativePath: string): void {
  const row = db
    .prepare("SELECT id, payload_json FROM source_entries WHERE kind = 'takeout' AND external_ref = ?")
    .get(ref) as { id: number; payload_json: string } | undefined;
  if (!row) return;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    return;
  }
  const stored = Array.isArray(payload.storedImages) ? (payload.storedImages as string[]) : [];
  if (stored.includes(relativePath)) return;
  stored.push(relativePath);
  payload.storedImages = stored;
  db.prepare('UPDATE source_entries SET payload_json = ? WHERE id = ?').run(
    JSON.stringify(payload),
    row.id,
  );
}

export interface EntryToOpen {
  id: number;
  href: string | null;
  query: string | null;
  /** The export's own reading, to check the page against. */
  fingerprint: string | null;
  chatId: number | null;
}

/** An entry's link and its own reading, for opening it in the panel. */
export function getEntryToOpen(entryId: number): EntryToOpen | null {
  const row = db
    .prepare(
      `SELECT e.id, e.href, e.query, e.payload_json,
              (SELECT cs.chat_id FROM chat_sources cs
                 JOIN chats c ON c.id = cs.chat_id
                WHERE cs.source_entry_id = e.id AND c.merged_into IS NULL
                LIMIT 1) AS chat_id
         FROM source_entries e WHERE e.id = ?`,
    )
    .get(entryId) as
    | { id: number; href: string | null; query: string | null; payload_json: string; chat_id: number | null }
    | undefined;
  if (!row) return null;
  let fingerprint: string | null = null;
  try {
    const payload = JSON.parse(row.payload_json) as { textFingerprint?: string };
    fingerprint = payload.textFingerprint ?? null;
  } catch {
    fingerprint = null;
  }
  return {
    id: row.id,
    href: row.href,
    query: row.query,
    fingerprint,
    chatId: row.chat_id,
  };
}

/** Gives an orphan entry a conversation of its own. */
export function adoptSourceEntry(entryId: number, folderId: number | null): { chatId: number } {
  db.exec('BEGIN');
  try {
    const chatId = adoptEntry(entryId, folderId);
    db.exec('COMMIT');
    return { chatId };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Entries attached to no conversation at all.
 *
 * These are the ones with nowhere to be seen from: an import that could not
 * decide where an entry belonged, or an entry left behind when a wrong glue was
 * taken apart. Without a list of them they would be present in the database and
 * absent from the app, which is the worst of both — stored, and lost.
 */
export function orphanSourceEntries(): SourceEntryView[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.kind, e.occurred_at, e.href, e.query, e.payload_json
         FROM source_entries e
        WHERE NOT EXISTS (SELECT 1 FROM chat_sources cs WHERE cs.source_entry_id = e.id)
        ORDER BY e.occurred_at DESC, e.id DESC`,
    )
    .all() as unknown as {
    id: number;
    kind: string;
    occurred_at: string | null;
    href: string | null;
    query: string | null;
    payload_json: string;
  }[];
  return rows.map((row) => {
    let turnCount = 0;
    let imageCount = 0;
    let dateText: string | null = null;
    let imagePaths: string[] = [];
    try {
      const payload = JSON.parse(row.payload_json) as {
        turns?: unknown[];
        images?: unknown[];
        timestampText?: string | null;
        storedImages?: string[];
      };
      turnCount = payload.turns?.length ?? 0;
      imageCount = payload.images?.length ?? 0;
      dateText = payload.timestampText ?? null;
      imagePaths = payload.storedImages ?? [];
    } catch {
      // Listed regardless — see sourceEntriesForChat.
    }
    return {
      id: row.id,
      kind: row.kind,
      occurredAt: row.occurred_at,
      href: row.href,
      query: row.query,
      turnCount,
      imageCount,
      linked: false,
      chatCount: 0,
      dateText,
      imagePaths,
    };
  });
}

/**
 * One entry's full stored reading — what it actually says, not a summary of it.
 * Reviewing an entry before deciding where it belongs needs the whole thing.
 */
export function sourceEntryTurns(entryId: number): Message[] {
  const row = db.prepare('SELECT payload_json FROM source_entries WHERE id = ?').get(entryId) as
    | { payload_json: string }
    | undefined;
  if (!row) return [];
  try {
    const turns =
      (JSON.parse(row.payload_json) as { turns?: { role: string; text: string; html?: string }[] })
        .turns ?? [];
    return turns.map((turn, index) => ({
      id: index,
      seq: index,
      role: turn.role === 'user' ? 'user' : 'ai',
      text: turn.text,
      html: turn.html || null,
    }));
  } catch {
    return [];
  }
}

/** Conversations sharing this one's opening prompt — glue candidates, not facts. */
export function similarChats(chatId: number): ChatSummary[] {
  const row = db.prepare('SELECT content_key FROM chats WHERE id = ?').get(chatId) as unknown as
    | { content_key: string | null }
    | undefined;
  if (!row?.content_key) return [];
  const rows = db
    .prepare(`${CHAT_SUMMARY_SQL} WHERE c.content_key = ? AND c.id != ? ORDER BY c.started_at`)
    .all(row.content_key, chatId) as unknown as ChatSummaryRow[];
  return rows.map(toSummary);
}

export interface ActivityMatchResult {
  matchedToChat: number;
  matchedToTurn: number;
  ambiguous: number;
  orphans: number;
}

/**
 * Matches activity to real conversations, strongest evidence first, and dates
 * what it can.
 *
 * Rerunnable and purely additive: matching improves as capture progresses,
 * because a conversation with turns offers far more to match against than a
 * title alone.
 */
export function matchActivity(): ActivityMatchResult {
  db.exec('BEGIN');
  try {
    db.exec('UPDATE activity SET matched_chat_id = NULL, matched_message_id = NULL, match_kind = NULL');

    // 1. Query equals a conversation's opening query, which is its title. Only
    //    when exactly one conversation matches — the duplicate-prompt groups
    //    match several by construction and must stay unresolved rather than be
    //    attributed by coin flip.
    db.exec(`
      UPDATE activity
         SET matched_chat_id = (
               SELECT c.id FROM chats c
                WHERE c.content_key = activity.query_key AND c.merged_into IS NULL
             ),
             match_kind = 'title'
       WHERE matched_chat_id IS NULL
         AND (
           SELECT COUNT(*) FROM chats c
            WHERE c.content_key = activity.query_key AND c.merged_into IS NULL
         ) = 1
    `);

    // 2. Query equals the text of a captured user turn. This is where Takeout
    //    earns its place: it dates individual turns, which AI Mode renders
    //    nowhere.
    db.exec(`
      UPDATE activity
         SET matched_message_id = (
               SELECT m.id FROM messages m
                WHERE m.role = 'user' AND TRIM(LOWER(m.text)) = TRIM(LOWER(activity.query))
             ),
             matched_chat_id = COALESCE(matched_chat_id, (
               SELECT m.chat_id FROM messages m
                WHERE m.role = 'user' AND TRIM(LOWER(m.text)) = TRIM(LOWER(activity.query))
             )),
             match_kind = COALESCE(match_kind, 'turn')
       WHERE matched_message_id IS NULL
         AND (
           SELECT COUNT(*) FROM messages m
            WHERE m.role = 'user' AND TRIM(LOWER(m.text)) = TRIM(LOWER(activity.query))
         ) = 1
    `);

    // 3. A matched conversation with no date of its own inherits the earliest
    //    activity time that points at it — its opening turn.
    db.exec(`
      UPDATE chats
         SET started_at = (
               SELECT MIN(a.occurred_at) FROM activity a
                WHERE a.matched_chat_id = chats.id AND a.occurred_at IS NOT NULL
             ),
             date_basis = 'activity'
       WHERE (started_at IS NULL OR date_basis = 'placeholder')
         AND EXISTS (
           SELECT 1 FROM activity a
            WHERE a.matched_chat_id = chats.id AND a.occurred_at IS NOT NULL
         )
    `);

    const one = (sql: string) => Number((db.prepare(sql).get() as unknown as { n: number }).n);
    const result: ActivityMatchResult = {
      matchedToChat: one("SELECT COUNT(*) AS n FROM activity WHERE match_kind = 'title'"),
      matchedToTurn: one("SELECT COUNT(*) AS n FROM activity WHERE match_kind = 'turn'"),
      ambiguous: one(`
        SELECT COUNT(*) AS n FROM activity a
         WHERE a.matched_chat_id IS NULL
           AND (SELECT COUNT(*) FROM chats c WHERE c.content_key = a.query_key) > 1
      `),
      orphans: one(`
        SELECT COUNT(*) AS n FROM activity a
         WHERE a.matched_chat_id IS NULL
           AND (SELECT COUNT(*) FROM chats c WHERE c.content_key = a.query_key) = 0
      `),
    };
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export interface ActivityStats {
  total: number;
  matched: number;
  orphans: number;
  dated: number;
}

export function activityStats(): ActivityStats {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN matched_chat_id IS NOT NULL THEN 1 ELSE 0 END) AS matched,
              SUM(CASE WHEN matched_chat_id IS NULL THEN 1 ELSE 0 END) AS orphans,
              SUM(CASE WHEN occurred_at IS NOT NULL THEN 1 ELSE 0 END) AS dated
         FROM activity`,
    )
    .get() as unknown as { total: number; matched: number; orphans: number; dated: number };
  return {
    total: row.total ?? 0,
    matched: row.matched ?? 0,
    orphans: row.orphans ?? 0,
    dated: row.dated ?? 0,
  };
}

/**
 * Removes everything a Takeout import created, leaving harvested conversations
 * untouched.
 *
 * Exists because the first import was wrong in a way that cannot be corrected
 * in place: Takeout logs one entry per QUERY, not per conversation, so it
 * created a chat per turn. Rolling back has to be possible without discarding
 * the sidebar harvest alongside it — hence the synthetic "takeout:" external_id
 * prefix, which makes imported rows identifiable.
 *
 * Rows the import merely annotated (an existing harvested conversation given a
 * timestamp) keep their content; only the timestamp attribution is dropped.
 */
export function undoTakeoutImport(): { deleted: number; reverted: number } {
  db.exec('BEGIN');
  try {
    const deleted = db
      .prepare("DELETE FROM chats WHERE external_id LIKE 'takeout:%'")
      .run().changes;
    // Harvested conversations that the import touched: forget the imported
    // date, and put them back in the capture queue.
    const reverted = db
      .prepare(
        `UPDATE chats
           SET started_at = NULL, source = 'harvest'
         WHERE source = 'takeout' AND external_id NOT LIKE 'takeout:%'`,
      )
      .run().changes;
    db.exec('COMMIT');
    return { deleted: Number(deleted), reverted: Number(reverted) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/* --------------------------------------------------------------- dev seed */

// Lives here rather than in a script because the database is inside the app's
// userData directory, which is awkward to reach from outside a running app
// (and different on every platform). Gated on NOTEBOOK_DEV_SEED and idempotent
// via the external_id unique constraint, so it can't corrupt a real archive by
// accident. The point is to exercise the tree, the reader and the image path
// before the harvester exists.
export function seedDevData(): void {
  const now = new Date().toISOString();

  // A 1x1 red PNG as a data: URI — enough to prove the reader renders images
  // from stored HTML without the asset pipeline being built yet.
  const pixel =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const folders: [string, string | null][] = [
    ['Infra', null],
    ['nginx', 'Infra'],
    ['Postgres', 'Infra'],
    ['Cooking', null],
  ];
  const folderIdByName = new Map<string, number>();
  for (const [name, parentName] of folders) {
    const parentId = parentName ? (folderIdByName.get(parentName) ?? null) : null;
    const existing = db
      .prepare('SELECT id FROM folders WHERE name = ? AND parent_id IS ?')
      .get(name, parentId) as unknown as { id: number } | undefined;
    folderIdByName.set(name, existing ? existing.id : createFolder(parentId, name).id);
  }

  const samples: { ext: string; title: string | null; folder: string | null; turns: string[] }[] = [
    {
      ext: 'seed-tls-renewal',
      title: null, // deliberately unnamed — the actual problem this app solves
      folder: 'nginx',
      turns: [
        'how do I renew a lets encrypt cert behind nginx without downtime',
        `<p>Use the webroot plugin so nginx never stops:</p>
         <pre>certbot renew --webroot -w /var/www/html</pre>
         <p>Then reload rather than restart:</p>
         <pre>systemctl reload nginx</pre>
         <p><img src="${pixel}" alt="diagram" width="120" height="40"></p>`,
      ],
    },
    {
      ext: 'seed-vacuum',
      title: 'Postgres autovacuum tuning',
      folder: 'Postgres',
      turns: [
        'when should I tune autovacuum_vacuum_scale_factor',
        '<p>Lower it for large, heavily-updated tables — the default 0.2 means a 50M-row table waits for 10M dead tuples before vacuuming.</p>',
      ],
    },
    {
      ext: 'seed-unfiled',
      title: null,
      folder: null, // exercises the Unfiled view
      turns: ['what temperature for a medium rare ribeye', '<p>Pull it at 52–54°C internal.</p>'],
    },
  ];

  const insertChat = db.prepare(
    `INSERT OR IGNORE INTO chats
       (folder_id, external_id, url, title, started_at, last_seen_at, source, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, 'seed', '{}')`,
  );
  const insertMessage = db.prepare(
    'INSERT OR IGNORE INTO messages (chat_id, seq, role, text, html) VALUES (?, ?, ?, ?, ?)',
  );

  for (const sample of samples) {
    insertChat.run(
      sample.folder ? (folderIdByName.get(sample.folder) ?? null) : null,
      sample.ext,
      `https://www.google.com/search?udm=50#${sample.ext}`,
      sample.title,
      now,
      now,
    );
    const chat = db.prepare('SELECT id FROM chats WHERE external_id = ?').get(sample.ext) as unknown as
      | { id: number }
      | undefined;
    if (!chat) continue;
    sample.turns.forEach((turn, index) => {
      const isUser = index % 2 === 0;
      insertMessage.run(
        chat.id,
        index,
        isUser ? 'user' : 'ai',
        turn.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
        isUser ? null : turn,
      );
    });
  }

  // Reading it straight back through the same functions the UI uses. The
  // renderer reaches these over IPC, so without this a broken query only
  // shows up as an empty pane with the error stranded in a console nobody is
  // watching.
  const all = listChats({ kind: 'all' });
  const first = all[0] ? getChat(all[0].id) : null;
  // eslint-disable-next-line no-console
  console.log(
    `[Notebook] dev seed: ${listFolders().length} folders, ${all.length} chats, ` +
      `${listChats({ kind: 'unfiled' }).length} unfiled, ` +
      `first chat "${first?.title}" has ${first?.messages.length ?? 0} turns`,
  );

  // The cycle guard is the one bit of tree logic that fails silently and
  // destructively — a cycle makes the subtree unreachable from any root while
  // it still sits in the table, so it looks like data loss and hangs any
  // recursive walk. Cheap to check here, so check it: Infra > nginx must not
  // be re-parentable under nginx.
  const infra = folderIdByName.get('Infra');
  const nginx = folderIdByName.get('nginx');
  if (infra !== undefined && nginx !== undefined) {
    let rejected = false;
    try {
      moveFolder(infra, nginx);
    } catch {
      rejected = true;
    }
    // eslint-disable-next-line no-console
    console.log(`[Notebook] dev seed: cycle guard rejected self-nesting move: ${rejected}`);
  }
}
