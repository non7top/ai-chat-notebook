import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';
import type { TakeoutImportSummary } from '../shared/types';
import { getAssetsDir } from './db';

/**
 * Stores parsed Takeout entries, copying any referenced images into the
 * content-addressed store.
 *
 * Images are best-effort by explicit decision: Takeout ships far fewer than the
 * conversations contain, and the owner's priority is the text — old images can
 * be regenerated, whereas text that Google has dropped cannot be recovered from
 * anywhere else.
 */
// Re-exported rather than redeclared. The copy that used to live here drifted
// from the shared one the moment a field was added, and because the renderer
// reads the shared type while the main process satisfied this one, the type
// checker could not see that the two disagreed across the IPC hop.
export type { TakeoutImportSummary };

const EXTENSION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * An entry's own reference, matching the one the import writes.
 *
 * Duplicated arithmetic would be a bug waiting to happen, so this exists to be
 * the one place the shape is written down outside db.ts — the import derives the
 * same string, and if they ever disagree an image silently attaches to nothing.
 */
function entryRefFor(row: db.TakeoutImportRow): string {
  const opening = row.turns.find((t) => t.role === 'user')?.text ?? row.query;
  return db.takeoutEntryRef(
    opening,
    row.timestamp,
    { turns: row.turns, images: row.imageFiles, href: row.href },
    row.entryId,
    row.fingerprints,
  );
}

/**
 * IMAGES CANNOT BE MATCHED ACROSS SOURCES. Measured, not assumed.
 *
 * The export ships its own re-encoding: 599x1334 baseline JPEG, median 57 KB
 * across 1041 files. The panel holds the originals — 1000x1000 uploads and
 * 1024x1024 generated images, per the findings in aiModeDriver.ts. So the same
 * picture arrives with a different filename, different dimensions AND different
 * bytes.
 *
 * Three consequences, all of which have to be lived with rather than solved:
 *
 * - The content-addressed store cannot collapse them. Two copies of one picture
 *   are two assets, and a thread that has both counts two images. That is
 *   honest — they really are two different files — but it is not the count a
 *   person would give.
 * - No image-derived value can be a cross-source key: not the filename, which
 *   Takeout invents from the export time, and not the hash, which the
 *   re-encoding changes. Matching a Takeout record to a panel capture has to be
 *   done on text.
 * - The panel's copy is the better one and should win wherever a choice is made.
 *   The export's is a reduced screenshot-sized re-encode.
 *
 * Only a perceptual hash — dHash or pHash — could match these, since it survives
 * re-encoding and resizing. That is a real option if it is ever needed, and it
 * brings false positives with it: two different screenshots of the same app
 * would collide. Nothing here needs it today.
 */
function copyIntoAssetStore(sourcePath: string): { sha256: string; localPath: string; bytes: number; mime: string } | null {
  try {
    const buffer = fs.readFileSync(sourcePath);
    if (buffer.byteLength === 0) return null;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const ext = path.extname(sourcePath).toLowerCase();
    const dir = path.join(getAssetsDir(), sha256.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    const localPath = path.join(dir, `${sha256}${ext || '.bin'}`);
    // Content-addressed, so an existing file is byte-identical already.
    if (!fs.existsSync(localPath)) fs.writeFileSync(localPath, buffer);
    return { sha256, localPath, bytes: buffer.byteLength, mime: EXTENSION_MIME[ext] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

export function importTakeout(
  folder: string,
  rows: db.TakeoutImportRow[],
): TakeoutImportSummary {
  // Activity first, then matching. Nothing here creates a conversation: an
  // export has no thread id, so it cannot identify one, and the version that
  // tried invented 736 conversations from 981 entries.
  // Conversations first — Takeout is the base — then activity for the
  // per-submission timestamps, then matching for anything still unattached.
  const conversations = db.importTakeoutConversations(rows);
  const stored = db.importActivity(rows);
  const matched = db.matchActivity();

  let imagesCopied = 0;
  let imagesMissing = 0;
  let imagesOrphaned = 0;
  for (const row of rows) {
    if (row.imageFiles.length === 0) continue;
    // Which conversation this entry landed on, asked of the link table rather
    // than re-derived, so an image follows its entry wherever the entry went.
    const ref = entryRefFor(row);
    const chatId = db.chatIdForEntry(ref);
    for (const name of row.imageFiles) {
      const candidate = path.join(folder, name);
      if (!fs.existsSync(candidate)) {
        // Counted, not thrown: an export referencing images it does not contain
        // is normal here, and the text is what matters.
        imagesMissing += 1;
        continue;
      }
      const asset = copyIntoAssetStore(candidate);
      if (!asset) {
        imagesMissing += 1;
        continue;
      }
      imagesCopied += 1;
      // The bytes used to be written and then abandoned — no row pointed at
      // them, so the app could neither count nor show them. A file on disk that
      // nothing references is lost in every sense that matters.
      //
      // Recorded on the ENTRY either way, not only on the thread: a Lens record
      // belongs to no thread and is a date plus an image, so the entry is the
      // only place its picture can be found again.
      db.attachEntryImage(ref, db.assetHrefForPath(asset.localPath));
      if (chatId !== null) db.attachExportImage(chatId, asset);
      else imagesOrphaned += 1;
    }
  }

  return {
    entries: rows.length,
    conversations: conversations.conversations,
    createdChats: conversations.created,
    extendedChats: conversations.extended,
    datedHarvested: conversations.mergedIntoHarvested,
    ambiguousOpenings: conversations.ambiguousOpenings,
    regrouped: conversations.regrouped,
    unidentified: conversations.unidentified,
    unreadableDates: conversations.unreadableDates,
    turnsWritten: conversations.turnsWritten,
    inserted: stored.inserted,
    duplicates: stored.duplicates,
    skipped: stored.skipped,
    matchedToChat: matched.matchedToChat,
    matchedToTurn: matched.matchedToTurn,
    ambiguous: matched.ambiguous,
    orphans: matched.orphans,
    imagesCopied,
    imagesMissing,
    imagesOrphaned,
  };
}

/** Re-runs matching alone. Worth doing after a capture, which gives turns to match against. */
export function rematchActivity(): db.ActivityMatchResult {
  return db.matchActivity();
}
