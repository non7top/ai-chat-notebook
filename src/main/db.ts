import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatDetail, ChatSummary, Folder, Message } from '../shared/types';

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

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Columns added after the first release need a real migration: the
  // CREATE TABLE above is IF NOT EXISTS, so it does nothing to a database that
  // already holds harvested rows.
  ensureColumn('chats', 'list_rank', 'list_rank INTEGER');
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
  last_seen_at: string;
  message_count: number;
}

// COALESCE order is the display rule in one place: a title typed by hand wins
// over whatever was harvested, and an unnamed conversation still needs to
// render as something — being unnamed is the whole reason this app exists.
const CHAT_TITLE_SQL = "COALESCE(NULLIF(user_title, ''), NULLIF(title, ''), '(untitled)')";

const CHAT_SUMMARY_SQL = `
  SELECT c.id, c.folder_id, ${CHAT_TITLE_SQL} AS title, c.started_at, c.last_seen_at,
         (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
  FROM chats c
`;

function toSummary(row: ChatSummaryRow): ChatSummary {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    messageCount: row.message_count,
  };
}

export type ChatScope = { kind: 'all' } | { kind: 'unfiled' } | { kind: 'folder'; id: number };

export function listChats(scope: ChatScope): ChatSummary[] {
  // merged_into IS NULL everywhere: a chat merged away is kept (so the merge
  // stays undoable) but must not show up as a separate conversation.
  const base = `${CHAT_SUMMARY_SQL} WHERE c.merged_into IS NULL`;
  // Google's sidebar is ordered by recent activity, and the harvester walks it
  // top to bottom, so list_rank preserves that order — the only recency
  // information that exists, since no timestamp is rendered anywhere.
  //
  // Ordering by last_seen_at instead looked random: a bulk harvest writes
  // essentially the same timestamp to all 300 rows, leaving the sort with
  // nothing to distinguish them. Rows with no rank yet (hand-seeded, or
  // captured live) sort last rather than jumbling in among the ranked ones.
  const order =
    ' ORDER BY CASE WHEN c.list_rank IS NULL THEN 1 ELSE 0 END, c.list_rank ASC, c.last_seen_at DESC';

  if (scope.kind === 'all') {
    return (db.prepare(base + order).all() as unknown as ChatSummaryRow[]).map(toSummary);
  }
  if (scope.kind === 'unfiled') {
    return (
      db.prepare(`${base} AND c.folder_id IS NULL${order}`).all() as unknown as ChatSummaryRow[]
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

  return {
    ...toSummary(row),
    externalId: extra?.external_id ?? '',
    url: extra?.url ?? null,
    messages,
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
