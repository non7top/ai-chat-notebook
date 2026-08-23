import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';
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
export interface TakeoutImportSummary {
  entries: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  matchedToChat: number;
  matchedToTurn: number;
  ambiguous: number;
  orphans: number;
  imagesCopied: number;
  imagesMissing: number;
}

const EXTENSION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

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
  const stored = db.importActivity(rows);
  const matched = db.matchActivity();

  let imagesCopied = 0;
  let imagesMissing = 0;
  for (const row of rows) {
    for (const name of row.imageFiles) {
      const candidate = path.join(folder, name);
      if (!fs.existsSync(candidate)) {
        // Counted, not thrown: an export referencing images it does not contain
        // is normal here, and the text is what matters.
        imagesMissing += 1;
        continue;
      }
      if (copyIntoAssetStore(candidate)) imagesCopied += 1;
      else imagesMissing += 1;
    }
  }

  return {
    entries: rows.length,
    inserted: stored.inserted,
    duplicates: stored.duplicates,
    skipped: stored.skipped,
    matchedToChat: matched.matchedToChat,
    matchedToTurn: matched.matchedToTurn,
    ambiguous: matched.ambiguous,
    orphans: matched.orphans,
    imagesCopied,
    imagesMissing,
  };
}

/** Re-runs matching alone. Worth doing after a capture, which gives turns to match against. */
export function rematchActivity(): db.ActivityMatchResult {
  return db.matchActivity();
}
