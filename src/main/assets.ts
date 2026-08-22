import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { session } from 'electron';
import { getAssetsDir } from './db';

// Images in an AI Mode conversation come in three forms, and each needs
// different handling. Established by recon against the live page:
//
//  - https://lens.usercontent.google.com/...  a generated image loaded from
//    history. Fetchable, but only with the panel's cookies.
//  - data:image/...                            a freshly generated image, or a
//    user's uploaded reference. Bytes are already here; no fetch at all.
//  - blob:https://www.google.com/<uuid>        Maps tiles. A blob URL is scoped
//    to the document that created it, so the main process CANNOT fetch it under
//    any session configuration. These are page furniture rather than
//    conversation content, so they are skipped deliberately rather than
//    failed on.
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

export interface StoredAsset {
  sha256: string;
  mime: string;
  localPath: string;
  bytes: number;
}

export type AssetOutcome =
  | { kind: 'stored'; asset: StoredAsset }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string };

function writeContentAddressed(buffer: Buffer, mime: string): StoredAsset {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const ext = EXTENSION_BY_MIME[mime] ?? 'bin';
  // Sharded by the first two hex characters: a few thousand images in one
  // directory makes every listing slow and some tools unhappy.
  const dir = path.join(getAssetsDir(), sha256.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  const localPath = path.join(dir, `${sha256}.${ext}`);
  // Content-addressed, so an existing file with this name is byte-identical and
  // rewriting it would be pure work. Skip it.
  if (!fs.existsSync(localPath)) {
    fs.writeFileSync(localPath, buffer);
  }
  return { sha256, mime, localPath, bytes: buffer.byteLength };
}

function storeDataUri(src: string): AssetOutcome {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
  if (!match) return { kind: 'failed', reason: 'Malformed data: URI' };
  const [, mime, base64Flag, payload] = match;
  const buffer = base64Flag
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  if (buffer.byteLength === 0) return { kind: 'failed', reason: 'Empty data: URI' };
  return { kind: 'stored', asset: writeContentAddressed(buffer, mime) };
}

async function fetchWithSession(src: string): Promise<AssetOutcome> {
  try {
    // Session.fetch, not net.fetch: the request has to go out on the panel's
    // own session so it carries the same cookies the page had.
    // lens.usercontent.google.com will not serve these anonymously, and
    // net.fetch has no session option at all — it would quietly fetch
    // anonymously and get an error page instead of an image.
    const response = await session.fromPartition('persist:google').fetch(src, {
      credentials: 'include',
    });
    if (!response.ok) {
      return { kind: 'failed', reason: `HTTP ${response.status}` };
    }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!mime.startsWith('image/')) {
      // An HTML error or consent page served with 200 would otherwise be stored
      // as if it were the image.
      return { kind: 'failed', reason: `Not an image (${mime || 'no content-type'})` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) return { kind: 'failed', reason: 'Empty response' };
    return { kind: 'stored', asset: writeContentAddressed(buffer, mime) };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function storeImage(src: string): Promise<AssetOutcome> {
  if (src.startsWith('data:')) return storeDataUri(src);
  if (src.startsWith('blob:')) {
    return { kind: 'skipped', reason: 'blob: URL — document-scoped, and map chrome rather than content' };
  }
  if (src.startsWith('http:') || src.startsWith('https:')) return fetchWithSession(src);
  return { kind: 'skipped', reason: `Unsupported scheme in ${src.slice(0, 24)}` };
}

/**
 * Rewrites an <img src> to the stored copy. Uses a relative assets/ path rather
 * than an absolute file:// URL so the archive survives being moved, with the
 * renderer resolving it at read time.
 */
export function assetHref(asset: StoredAsset): string {
  const relative = path.relative(getAssetsDir(), asset.localPath).split(path.sep).join('/');
  return `assets/${relative}`;
}
