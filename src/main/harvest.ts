import { BrowserWindow } from 'electron';
import * as db from './db';
import { ensureOnAiMode } from './aiModeView';
import { assetHref, storeImage } from './assets';
import {
  ensureHistorySidebarOpen,
  getListGeometry,
  readRenderedThreads,
  scrollListBy,
  scrollListToTop,
  openThreadById,
  readTurns,
  waitForTurnsToSettle,
  type CapturedTurn,
  type ThreadListEntry,
} from './aiModeDriver';
import type { CaptureProgress, HarvestProgress } from '../shared/types';

// Driven from the main process, one scroll step per round trip, rather than as
// a single long injected script. That is what makes progress reporting and
// cancellation possible at all — an injected loop only reports once it is
// finished, which for ~300 threads is half a minute of apparent hang.
const SETTLE_MS = 700;
const STEP_FRACTION = 0.8;
const MAX_STEPS = 200;
// The end condition is deliberately not "no new ids": a virtualised list
// produces nothing new for several steps in the middle of a run whenever the
// render window lags the scroll. Only a bottom that stays put counts.
const STAGNANT_AT_BOTTOM_LIMIT = 3;
// Between conversations. Not a rate limit so much as breathing room: this
// drives a real browser session, and hammering it back-to-back for hours is
// both more likely to be throttled and harder to interrupt.
const BETWEEN_CAPTURES_MS = 800;
// A run that fails this many times in a row has hit something systemic — signed
// out, offline, page restructured — and grinding through 300 conversations to
// fail at every one wastes hours and buries the cause.
const CONSECUTIVE_FAILURE_LIMIT = 10;

let cancelRequested = false;
let running = false;

export function cancelHarvest(): void {
  cancelRequested = true;
}

export function isHarvestRunning(): boolean {
  return running;
}

function broadcast(progress: HarvestProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('harvest:progress', progress);
  }
}

// Deliberately NOT storing a constructed ?mtid= URL.
//
// It looked like a permalink — an open thread's URL contains
// mtid=<data-thread-id> — but navigating to one was tested and does not reopen
// the thread. Google ignores the supplied mtid, treats q= as a fresh query, and
// mints a new thread id. So the URL is not merely useless: following it CREATES
// a duplicate conversation in the user's history, and storing it would put that
// one click away from anyone who saw the field.
//
// Threads are opened by clicking their sidebar row instead. See the notes in
// aiModeDriver.ts.
function threadUrl(_entry: ThreadListEntry): string | null {
  return null;
}

export interface HarvestSummary {
  found: number;
  expected: number;
  created: number;
  updated: number;
  complete: boolean;
  cancelled: boolean;
}

/**
 * Walks the history sidebar top to bottom and records every thread it finds.
 *
 * Only the list: titles and ids, no turns. That is a deliberate first slice —
 * it turns an unnavigable wall of unnamed chats into something filed and
 * searchable, without waiting on per-thread capture.
 */
export async function harvestThreadList(): Promise<HarvestSummary> {
  if (running) {
    throw new Error('A harvest is already running');
  }
  running = true;
  cancelRequested = false;

  try {
    // The panel doubles as a browser, so it may well be parked on myactivity or
    // anywhere else. Go to AI Mode rather than failing with instructions.
    const navigated = await ensureOnAiMode();
    if (navigated) {
      // A freshly loaded list is also a correctly ordered one — Google sorts by
      // recent activity on load and never re-sorts live.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await ensureHistorySidebarOpen();
    await scrollListToTop();

    const geometry = await getListGeometry();
    if (geometry.expectedTotal === 0) {
      throw new Error(
        'The thread list has no measurable height yet — the sidebar may still be opening',
      );
    }

    const seen = new Map<string, string>();
    const known = db.knownExternalIds();
    let created = 0;
    let updated = 0;
    let stagnantAtBottom = 0;

    const absorb = (entries: ThreadListEntry[]) => {
      for (const entry of entries) {
        if (seen.has(entry.externalId)) continue;
        // seen.size before insertion is this thread's position in Google's
        // own ordering, because the scroll walks the list from the top.
        const rank = seen.size;
        seen.set(entry.externalId, entry.title);
        const result = db.upsertThreadFromList(
          entry.externalId,
          entry.title,
          threadUrl(entry),
          rank,
        );
        if (result.created) {
          created += 1;
        } else if (known.has(entry.externalId)) {
          updated += 1;
        }
      }
    };

    absorb(await readRenderedThreads());
    broadcast({
      phase: 'scanning',
      found: seen.size,
      expected: geometry.expectedTotal,
      created,
      updated,
    });

    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (cancelRequested) break;

      const before = seen.size;
      const scrolled = await scrollListBy(geometry.clientHeight * STEP_FRACTION);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      absorb(await readRenderedThreads());

      broadcast({
        phase: 'scanning',
        found: seen.size,
        expected: geometry.expectedTotal,
        created,
        updated,
      });

      if (scrolled.atBottom && seen.size === before) {
        stagnantAtBottom += 1;
        if (stagnantAtBottom >= STAGNANT_AT_BOTTOM_LIMIT) break;
      } else {
        stagnantAtBottom = 0;
      }
    }

    // Compared against the pre-measured expectation rather than just reported.
    // A virtualised list that yields 40 of 300 looks exactly like a finished one
    // from the inside, so a short result has to be visible as a shortfall.
    //
    // The comparison is deliberately fuzzy. expectedTotal is scrollHeight
    // divided by a rounded row height, so it lands near the truth but not on
    // it: measured live, 12052 / 40 gives 301 for a list that really holds 300.
    // An exact `>=` would therefore have reported every single complete harvest
    // as incomplete — caught only by running the real numbers. Padding on the
    // container or a fractional row height can push it either way, so allow a
    // small margin and reserve the warning for a genuine shortfall.
    const complete = seen.size >= Math.floor(geometry.expectedTotal * 0.95);
    const summary: HarvestSummary = {
      found: seen.size,
      expected: geometry.expectedTotal,
      created,
      updated,
      complete,
      cancelled: cancelRequested,
    };
    broadcast({ phase: cancelRequested ? 'cancelled' : 'done', ...summary });
    return summary;
  } catch (error) {
    broadcast({
      phase: 'error',
      found: 0,
      expected: 0,
      created: 0,
      updated: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    running = false;
    cancelRequested = false;
  }
}


/* ----------------------------------------------------------- turn capture */

let captureCancelled = false;
let capturing = false;

export function cancelCapture(): void {
  captureCancelled = true;
}

function broadcastCapture(progress: CaptureProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('capture:progress', progress);
  }
}

// Rewrites every <img src> in a turn's HTML to its stored copy. Done by string
// replacement on the exact original src rather than by parsing: the main process
// has no DOM, and the src values came from that same HTML moments earlier so
// they match verbatim.
function rewriteImageSources(html: string, replacements: Map<string, string>): string {
  let out = html;
  for (const [original, href] of replacements) {
    out = out.split(original).join(href);
  }
  return out;
}

async function captureOneChat(chat: { id: number; externalId: string; title: string }): Promise<{
  turns: number;
  images: number;
  skipped: number;
  failed: number;
}> {
  await ensureHistorySidebarOpen();
  await openThreadById(chat.externalId);
  await waitForTurnsToSettle();
  const { turns } = await readTurns();

  // A conversation that shows user turns but no answer is still rendering, not a
  // conversation without answers. Refusing it leaves it in the queue for the
  // next run; storing it would mark it done forever at whatever fraction had
  // loaded. Two real multi-turn conversations were stored as a single turn
  // before this check existed.
  if (turns.length === 0 || !turns.some((t) => t.role === 'ai')) {
    throw new Error(
      `Conversation had no answer turns yet (${turns.length} turn(s) seen) — still loading`,
    );
  }

  const toSave: db.TurnToSave[] = [];
  const assets: db.AssetToSave[] = [];
  let images = 0;
  let skipped = 0;
  let failed = 0;

  for (const [index, turn] of turns.entries()) {
    const replacements = new Map<string, string>();
    for (const image of turn.images) {
      const outcome = await storeImage(image.src);
      if (outcome.kind === 'stored') {
        images += 1;
        replacements.set(image.src, assetHref(outcome.asset));
        assets.push({
          messageSeq: index,
          // A data: URI is the payload itself, so recording it as the "original
          // URL" would duplicate the whole image into the database.
          originalUrl: image.src.startsWith('data:') ? null : image.src,
          sha256: outcome.asset.sha256,
          mime: outcome.asset.mime,
          localPath: outcome.asset.localPath,
          bytes: outcome.asset.bytes,
        });
      } else if (outcome.kind === 'skipped') {
        skipped += 1;
      } else {
        failed += 1;
      }
    }
    toSave.push({
      seq: index,
      role: turn.role,
      text: turn.text,
      html: turn.html ? rewriteImageSources(turn.html, replacements) : null,
    });
  }

  db.replaceTurns(chat.id, toSave, assets);
  return { turns: toSave.length, images, skipped, failed };
}

/**
 * Re-reads one conversation, discarding what was stored for it first. Needed
 * whenever a capture is known to be wrong rather than missing — a parser fix
 * does not help conversations already in the database, and chatsWithoutTurns
 * deliberately skips anything that has turns.
 */
export async function recaptureChat(chatId: number): Promise<{ turns: number; images: number }> {
  const chat = db.getChatForCapture(chatId);
  if (!chat) throw new Error(`No chat with id ${chatId}`);
  await ensureOnAiMode();
  db.clearTurns(chatId);
  const result = await captureOneChat(chat);
  return { turns: result.turns, images: result.images };
}

export interface CaptureSummary {
  attempted: number;
  captured: number;
  turns: number;
  images: number;
  errors: number;
  remaining: number;
  cancelled: boolean;
  failures: { title: string; reason: string }[];
  stoppedEarly?: string;
}

/**
 * Captures turns for conversations that have none yet.
 *
 * Bounded by `limit` rather than always running the whole backlog: opening a
 * thread means clicking through a virtualised list and waiting for it to render,
 * so this is seconds per conversation, not milliseconds. A bounded, resumable
 * run beats one that has to be left alone for an hour.
 */
export async function captureTurns(limit: number): Promise<CaptureSummary> {
  if (capturing) throw new Error('A capture is already running');
  capturing = true;
  captureCancelled = false;

  const summary: CaptureSummary = {
    attempted: 0,
    captured: 0,
    turns: 0,
    images: 0,
    errors: 0,
    remaining: 0,
    cancelled: false,
    failures: [],
  };

  try {
    await ensureOnAiMode();
    // The queue is taken ONCE, so each conversation gets one attempt per run.
    // Re-reading it in a loop would retry the same failure forever in an
    // unattended run; a fresh run picks failures up again, ordered behind
    // anything never tried.
    const queue = db.chatsWithoutTurns(limit);
    let consecutiveFailures = 0;
    for (const chat of queue) {
      if (captureCancelled) break;
      summary.attempted += 1;
      broadcastCapture({
        phase: 'capturing',
        done: summary.captured,
        total: queue.length,
        errors: summary.errors,
        current: chat.title.slice(0, 60),
      });
      try {
        const result = await captureOneChat(chat);
        summary.captured += 1;
        consecutiveFailures = 0;
        summary.turns += result.turns;
        summary.images += result.images;
      } catch (error) {
        // One unreadable conversation must not abort the run — with hundreds
        // queued, stopping on the first oddity would make the feature useless.
        // The reason is kept, not just counted: "7 errors" is unactionable,
        // whereas knowing they were all load timeouts points straight at the
        // fix.
        summary.errors += 1;
        consecutiveFailures += 1;
        db.recordCaptureFailure(chat.id);
        summary.failures.push({
          title: chat.title.slice(0, 60),
          reason: error instanceof Error ? error.message : String(error),
        });
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          summary.stoppedEarly =
            `Stopped after ${consecutiveFailures} consecutive failures — ` +
            'something systemic (signed out, offline, or the page changed) ' +
            'rather than awkward conversations.';
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, BETWEEN_CAPTURES_MS));
    }

    summary.cancelled = captureCancelled;
    summary.remaining = db.countChatsWithoutTurns();
    broadcastCapture({
      phase: captureCancelled ? 'cancelled' : 'done',
      done: summary.captured,
      total: summary.attempted,
      errors: summary.errors,
      turns: summary.turns,
      images: summary.images,
      remaining: summary.remaining,
      stoppedEarly: summary.stoppedEarly,
    });
    return summary;
  } catch (error) {
    broadcastCapture({
      phase: 'error',
      done: summary.captured,
      total: summary.attempted,
      errors: summary.errors + 1,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    capturing = false;
    captureCancelled = false;
  }
}
