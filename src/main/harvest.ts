import { BrowserWindow } from 'electron';
import * as db from './db';
import { ensureOnAiMode } from './aiModeView';
import {
  ensureHistorySidebarOpen,
  getListGeometry,
  readRenderedThreads,
  scrollListBy,
  scrollListToTop,
  type ThreadListEntry,
} from './aiModeDriver';
import type { HarvestProgress } from '../shared/types';

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

// The URL an opened thread actually has. Stored so Resume can try navigating
// straight to it; the recon notes flag that this is not yet confirmed to work,
// which is why Resume must keep a click-through fallback.
function threadUrl(entry: ThreadListEntry): string {
  const params = new URLSearchParams({ udm: '50', mtid: entry.externalId, q: entry.title });
  return `https://www.google.com/search?${params.toString()}`;
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
