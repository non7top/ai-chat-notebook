import { BrowserWindow } from 'electron';
import * as db from './db';
import { hammingDistance, promptFingerprint } from '../shared/fingerprint.ts';
import { ensureOnAiMode, navigateAiMode } from './aiModeView';
import { assetHref, storeImage } from './assets';
import { rewriteImageSources } from '../shared/rewriteImages.ts';
import {
  ensureHistorySidebarOpen,
  recycleHistorySidebar,
  readPageKind,
  PageNotAiModeError,
  getListGeometry,
  readRenderedThreads,
  scrollListBy,
  scrollListToTop,
  openThreadById,
  ThreadNotListedError,
  readTurns,
  waitForTurnsToSettle,
  type CapturedTurn,
  type ThreadListEntry,
} from './aiModeDriver';
import type { CaptureProgress, HarvestProgress, SyncProgress } from '../shared/types';

// Driven from the main process, one scroll step per round trip, rather than as
// a single long injected script. That is what makes progress reporting and
// cancellation possible at all — an injected loop only reports once it is
// finished, which for ~300 threads is half a minute of apparent hang.
const SETTLE_MS = 700;
const STEP_FRACTION = 0.8;
/**
 * The furthest one step may jump, whatever the panel's height.
 *
 * This is the fix for a harvest that reported "150 / ~301 threads · INCOMPLETE".
 * Measured live, walking the real sidebar step by step: the scroll never stalls,
 * but Google renders about TEN ROWS per step regardless of how far the step
 * went. Rows obtained is therefore ~10 x steps taken, and steps taken is
 * scrollHeight / step — so a bigger step means FEWER rows, not the same rows
 * sooner.
 *
 *   panel 459px -> step 367px -> 33 steps -> ~330 rows -> complete
 *   panel 1000px -> step 800px -> 15 steps -> ~150 rows -> exactly the shortfall
 *
 * The old step was 0.8 x clientHeight with no ceiling, so how much of the
 * history a harvest found depended on how tall the window happened to be. 320px
 * is comfortably inside the ~400px Google renders per step, with margin for a
 * chunk that turns out smaller.
 */
const STEP_MAX_PX = 320;
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
  const harvestStartedAt = new Date().toISOString();

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
    // Closed and reopened before reading, because "open" cannot be tested for:
    // the scroller's display stays 'flex' either way, so ensureHistorySidebarOpen
    // reports alreadyOpen every time and never clicks anything. Measured live, a
    // list can sit at 10 rows of 300 — laid out, scrollHeight already sized for
    // all 300 — and no way of scrolling grows it. Two clicks on the history
    // toggle made the same list start yielding rows again.
    //
    // Done unconditionally: looking fine is precisely what the broken state
    // does, and a second and a half is nothing against a walk of minutes.
    // Recycled, and the result is CHECKED. A recycle that ended with the sidebar
    // shut used to be indistinguishable from one that worked: every read then
    // returns zero, and the run reported "10 / ~301 · INCOMPLETE" while walking
    // a list that was not on screen. Better to fail here naming the reason than
    // to publish a number that looks like a shortfall in the data.
    const recycled = await recycleHistorySidebar();
    if (recycled.rows === 0) {
      throw new Error(
        'The history sidebar holds no threads after being reopened — nothing to ' +
          'harvest. The panel may not be signed in, or the list may still be loading.',
      );
    }
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
    let lastScrollHeight = geometry.scrollHeight;

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

    let steps = 0;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (cancelRequested) break;
      steps += 1;

      const before = seen.size;
      // Capped, so the walk cannot outrun the rendering. See STEP_MAX_PX.
      const scrolled = await scrollListBy(
        Math.min(geometry.clientHeight * STEP_FRACTION, STEP_MAX_PX),
      );
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      absorb(await readRenderedThreads());

      broadcast({
        phase: 'scanning',
        found: seen.size,
        expected: geometry.expectedTotal,
        created,
        updated,
      });

      // Growing scrollHeight means the list loaded more below: it was at its
      // bottom, and its bottom moved. Treating that as "no new rows three times,
      // stop" is how a lazy-loading list gets abandoned halfway — which is one
      // of the two explanations for a harvest that reported 150 of a list a
      // previous run had walked to 299.
      const grew = scrolled.scrollHeight > lastScrollHeight;
      lastScrollHeight = Math.max(lastScrollHeight, scrolled.scrollHeight);
      if (scrolled.atBottom && seen.size === before && !grew) {
        stagnantAtBottom += 1;
        if (stagnantAtBottom >= STAGNANT_AT_BOTTOM_LIMIT) break;
      } else {
        stagnantAtBottom = 0;
      }
    }

    // One last read. Rendering lags the scroll by a step — measured: eleven steps
    // passed before the first new rows appeared — so the final step's rows are
    // still arriving when the loop's own read happens.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    absorb(await readRenderedThreads());

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
    // The measurements behind the verdict, recorded with it. A bare "150 / ~301
    // INCOMPLETE" says a run fell short without saying whether the run or the
    // expectation was wrong, and those need opposite fixes.
    const geometryNote =
      `scrollHeight ${geometry.scrollHeight}px / pitch ${geometry.pitch}px ` +
      `(row ${geometry.rowHeight}px, ${geometry.rendered} rendered) = ~${geometry.expectedTotal}` +
      // clientHeight and the step, which are the numbers that decide how much of
      // the list a walk sees at all — and which I left out of the first version
      // of this note, so the run that reported "130 / ~301" could not be read.
      // The step is capped now, but a note that omits the deciding variable is
      // how the next surprise stays a surprise.
      ` · panel ${geometry.clientHeight}px, step ${Math.round(
        Math.min(geometry.clientHeight * STEP_FRACTION, STEP_MAX_PX),
      )}px, ${steps} steps`;
    const summary: HarvestSummary = {
      found: seen.size,
      expected: geometry.expectedTotal,
      created,
      updated,
      complete,
      cancelled: cancelRequested,
    };
    db.recordJob(
      'harvest',
      cancelRequested ? 'stopped' : complete ? 'finished' : 'failed',
      // The real start, not the moment the record is written. Passing
      // new Date() here made startedAt and endedAt identical — 09:07:17.951Z for
      // both on a walk that took minutes — so the record could not answer "did
      // it stop early or grind to the end", which is the first thing to ask of
      // an incomplete run.
      harvestStartedAt,
      { ...summary, geometry: geometryNote },
    );
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
async function captureOneChat(chat: { id: number; externalId: string; title: string }): Promise<{
  turns: number;
  images: number;
  skipped: number;
  failed: number;
}> {
  await ensureHistorySidebarOpen();
  await openThreadById(chat.externalId);
  return storeRenderedThread(chat.id);
}

/**
 * Reads whatever thread the panel is currently showing and stores it.
 *
 * Split out so the Takeout-link route uses the same code as the sidebar route
 * rather than a second copy of it: the image pipeline, the settle check, the
 * date, and the refusal to store a half-rendered thread all have to behave
 * identically, and a parallel implementation would drift on the first one of
 * them that changed.
 */
async function storeRenderedThread(
  chatId: number,
  /**
   * Turns already read from the page, when the caller has them.
   *
   * The link route verifies a reading against the export before storing
   * anything, and without this it verified one reading and then took a SECOND
   * one to store — two reads of a live page with a check in between, so what was
   * approved and what was written were not guaranteed to be the same text. On a
   * page still settling, or one midway through re-running a prompt, they would
   * differ precisely when it matters. The reading that passed the check is the
   * reading that gets stored.
   */
  alreadyRead?: CapturedTurn[],
): Promise<{
  turns: number;
  images: number;
  skipped: number;
  failed: number;
}> {
  let turns = alreadyRead;
  if (!turns) {
    await waitForTurnsToSettle();
    turns = (await readTurns()).turns;
  }

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

  // The earliest date the panel shows for this thread. Turns arrive in order, so
  // the first one that carries a date is the thread's start. Anything that is not
  // a full date is skipped rather than guessed at: the element shows a bare time
  // for a turn from today, and today is exactly the value a placeholder already
  // means.
  const panelDate = (() => {
    for (const turn of turns) {
      const parsed = parsePanelStamp(turn.stamp);
      if (parsed) return parsed;
    }
    return null;
  })();

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
          kind: image.kind,
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

  db.replaceTurns(chatId, toSave, assets);
  // After the turns, because replaceTurns writes the placeholder date for a
  // thread that has none — and this is the better answer where the panel gave
  // one.
  if (panelDate) db.setPanelDate(chatId, panelDate);
  return { turns: toSave.length, images, skipped, failed };
}

/**
 * Re-reads one conversation, discarding what was stored for it first. Needed
 * whenever a capture is known to be wrong rather than missing — a parser fix
 * does not help conversations already in the database, and chatsWithoutTurns
 * deliberately skips anything that has turns.
 */
/**
 * A panel timestamp as an ISO date, or null.
 *
 * Accepts only the full-date form Google renders for older turns — "August 22,
 * 2026". The bare-time form ("17:05") is refused deliberately: it means today,
 * and stamping today's date as though the panel had told us is exactly the false
 * confidence the placeholder was introduced to avoid.
 *
 * Noon rather than midnight, so the day cannot slip backwards when a viewer in a
 * western timezone reads it — the whole point of a date-only value is the day.
 */
function parsePanelStamp(stamp: string | null): string | null {
  if (!stamp) return null;
  const match = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(stamp.trim());
  if (!match) return null;
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const month = months.indexOf(match[1].toLowerCase());
  if (month < 0) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${match[3]}-${pad(month + 1)}-${pad(Number(match[2]))}T12:00:00`;
}

export async function recaptureChat(chatId: number): Promise<{ turns: number; images: number }> {
  const chat = db.getChatForCapture(chatId);
  if (!chat) throw new Error(`No chat with id ${chatId}`);
  await ensureOnAiMode();
  // NOT cleared first. An earlier version deleted the stored turns before
  // reading, so a re-capture that then failed — a slow load, a page that never
  // settled — left the conversation with nothing at all. It destroyed the copy
  // it was meant to improve.
  //
  // captureOneChat ends in replaceTurns, which deletes and inserts inside one
  // transaction, so the old turns survive right up to the moment new ones exist
  // to take their place.
  const result = await captureOneChat(chat);
  return { turns: result.turns, images: result.images };
}

/**
 * Re-captures a named list of threads, one after another.
 *
 * Exists because re-capture worked on any thread picked by hand while the bulk
 * paths attempted nothing — and the reason was always the QUEUE, never the
 * capture. This takes ids straight from the caller, so nothing decides on its
 * own what is worth reading: the reader offers a thread and everything it thinks
 * is similar, and the answer to "fetch these" is these.
 *
 * Reports on the same channel as every other capture, so the control strip shows
 * it and Stop works, rather than a second progress mechanism nobody watches.
 */
export async function recaptureMany(chatIds: number[]): Promise<CaptureSummary> {
  const startedAt = new Date().toISOString();
  if (capturing) throw new Error('A capture is already running');
  capturing = true;
  captureCancelled = false;
  const summary: CaptureSummary = {
    attempted: 0,
    captured: 0,
    unlisted: 0,
    turns: 0,
    images: 0,
    errors: 0,
    remaining: 0,
    cancelled: false,
    failures: [],
  };
  try {
    await ensureOnAiMode();
    // The same loaded list captureTurns uses, and for the same reason — which I
    // failed to apply here when I added it there. Every thread did its own full
    // walk of the sidebar hunting for its row: four threads, four sweeps of up
    // to a minute each, all of them finding nothing, and reported as "0 captured
    // · 3 no longer listed" after four minutes of the panel scrolling. From the
    // outside that is a loop, and it was reported as one.
    const listed = chatIds.length > 1 ? await loadSidebarIds() : null;
    for (const id of chatIds) {
      if (captureCancelled) break;
      const chat = db.getChatForCapture(id);
      // A thread that has gone — merged away, deleted — is skipped rather than
      // counted as a failure. The caller's list can be a moment out of date.
      if (!chat) continue;
      // Answered from the list rather than by sending the sidebar after it. Only
      // when the load succeeded — a list that would not load says nothing about
      // any particular thread.
      if (listed && !listed.has(chat.externalId)) {
        summary.attempted += 1;
        summary.unlisted += 1;
        db.recordThreadNotListed(chat.id);
        broadcastCapture({
          phase: 'capturing',
          done: summary.captured,
          attempted: summary.attempted,
          total: chatIds.length,
          errors: summary.errors,
          unlisted: summary.unlisted,
          current: `not listed: ${chat.title.slice(0, 46)}`,
        });
        continue;
      }
      summary.attempted += 1;
      broadcastCapture({
        phase: 'capturing',
        done: summary.captured,
        attempted: summary.attempted,
        total: chatIds.length,
        errors: summary.errors,
        unlisted: summary.unlisted,
        current: chat.title.slice(0, 60),
      });
      try {
        const result = await Promise.race([
          captureOneChat(chat),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`Gave up on this thread after ${CAPTURE_DEADLINE_MS / 1000}s`)),
              CAPTURE_DEADLINE_MS,
            ),
          ),
        ]);
        summary.captured += 1;
        summary.turns += result.turns;
        summary.images += result.images;
      } catch (error) {
        if (error instanceof ThreadNotListedError) {
          summary.unlisted += 1;
          db.recordThreadNotListed(chat.id);
        } else {
          summary.errors += 1;
          db.recordCaptureFailure(chat.id);
          summary.failures.push({
            title: chat.title.slice(0, 60),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, BETWEEN_CAPTURES_MS));
    }
    summary.cancelled = captureCancelled;
    summary.remaining = db.countChatsWithoutTurns();
    db.recordJob(
      'recapture',
      captureCancelled ? 'stopped' : summary.errors > 0 ? 'failed' : 'finished',
      startedAt,
      { ...summary, failures: summary.failures.slice(0, 20) },
    );
    broadcastCapture({
      phase: captureCancelled ? 'cancelled' : 'done',
      done: summary.captured,
      total: summary.attempted,
      errors: summary.errors,
      unlisted: summary.unlisted,
      turns: summary.turns,
      images: summary.images,
    });
    return summary;
  } finally {
    capturing = false;
    captureCancelled = false;
  }
}

/**
 * Shows a conversation in the live panel.
 *
 * Uses the sidebar-click path, which is the only faithful way in: a Takeout
 * link re-runs the prompt and loses the uploads, and a constructed mtid URL
 * mints a new conversation. Reads nothing and stores nothing — this is "take me
 * there", not a capture.
 */
/**
 * The page had not rendered its turns in time.
 *
 * Its own type because it must not count toward the systemic-failure abort. Each
 * of these is one slow page load, and a run of them means a slow network rather
 * than a broken session — conflating the two stopped a 500-thread run after nine
 * threads, which is what "it stops randomly" turned out to be.
 */
export class PageNotReadyError extends Error {
  constructor(turnsSeen: number) {
    super(`The page had not rendered its turns yet (${turnsSeen} seen)`);
    this.name = 'PageNotReadyError';
  }
}

export interface LinkCaptureResult {
  /** How far the page's own opening is from the export's reading, 0 to 64. */
  distance: number;
  /** Set when the page did not show the thread the entry describes. */
  rejected: string | null;
  chatId: number | null;
  turns: number;
  images: number;
}

/**
 * Opens an export entry by its own link and captures what the page shows.
 *
 * This route exists because the sidebar only lists a few hundred threads while
 * the export holds 2026 records with a link — so most of the archive is reachable
 * this way and no other. It is also the one route with a documented history of
 * doing harm: navigating one of these links was reported to RE-RUN the prompt
 * rather than open the thread, which costs a real query, produces a different
 * answer, and once created a duplicate conversation in the owner's live history.
 * The owner has since established that a properly authenticated session opens the
 * thread intact, generated images included, and the panel is authenticated.
 *
 * Both accounts are treated as possible, because the cost of being wrong lands in
 * someone's account rather than in a log. So the page is CHECKED against the
 * export's own reading before anything is stored: if the prompt was re-run the
 * answer differs, the opening fingerprints diverge, and the capture is rejected
 * with the distance reported rather than written as though it were the thread.
 *
 * The threshold is deliberately generous. The export's text is rougher than the
 * panel's, so a genuine match is not a small distance — measured on real
 * material, the same thread across the two sources sat at 14 while unrelated
 * threads sat at 24. Anything at or above 22 is treated as a different answer.
 */
/**
 * How far apart two openings may be and still be the same thread.
 *
 * Applied to the PROMPT, not the whole opening exchange. Measured against a real
 * archived thread: the page's answer ran to 6,689 characters where the export
 * held 1,775, so comparing answers put a genuine match at 28 of 64 bits — beyond
 * where unrelated threads sat — and the check refused a recovery it should have
 * allowed. The export truncates; the prompt is what the person typed and neither
 * source shortens it.
 */
const REJECT_AT_DISTANCE = 12;

export async function captureFromEntryLink(entryId: number): Promise<LinkCaptureResult> {
  const entry = db.getEntryToOpen(entryId);
  if (!entry) throw new Error(`No source entry ${entryId}`);
  if (!entry.href) {
    throw new Error('This entry has no link — Lens searches and blank records carry none.');
  }

  await navigateAiMode(entry.href);
  // Asked what the page IS before waiting for what it should contain. Google
  // answers these links with its own error page often enough to matter, and that
  // page has no turns — so the settle below waited 90 seconds and then 60 more
  // for content that was never coming, and called the result "slow". Caught live
  // on an mstk link: "internal server error ... try again later", no sidebar, no
  // turns.
  const kind = await readPageKind();
  if (!kind.isAiMode) {
    throw new PageNotAiModeError(
      kind.looksLikeServerError
        ? "Google's own error page — try again later"
        : `no AI Mode page here, ${kind.chars} characters of something else`,
    );
  }
  // Longer than a sidebar click gets, because this is a whole page load against
  // Google rather than a render inside a page already open — and tried twice.
  // A page that has not finished is the ordinary case here, not a fault, and
  // treating it as one is what stopped runs after nine threads.
  await waitForTurnsToSettle(90_000);
  let { turns } = await readTurns();
  if (turns.length === 0 || !turns.some((t) => t.role === 'ai')) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await waitForTurnsToSettle(60_000);
    turns = (await readTurns()).turns;
  }
  if (turns.length === 0 || !turns.some((t) => t.role === 'ai')) {
    // Thrown as a distinguishable type so the runner can tell "this page was not
    // ready" from "the session is broken". Ten slow pages in a row is a slow
    // network; ten navigation failures is something else entirely.
    throw new PageNotReadyError(turns.length);
  }

  const pageTurns = turns.map((t) => ({ role: t.role, text: t.text }));
  const seen = promptFingerprint(pageTurns);
  const distance = entry.promptFingerprint
    ? hammingDistance(entry.promptFingerprint, seen)
    : 64;

  // The strongest evidence available, and it costs nothing: the page states the
  // date of its own turns. An archived thread is dated when it happened; a page
  // that re-ran the prompt is dated today. Opening thread #2660 showed
  // "January 11, 2026", which is what settled the question of whether these links
  // open or re-run — after the answer-length comparison had suggested the wrong
  // answer. Where the page gives a date, it decides.
  const pageDate = (() => {
    for (const turn of turns) {
      const parsed = parsePanelStamp(turn.stamp);
      if (parsed) return parsed.slice(0, 10);
    }
    return null;
  })();
  const entryDate = entry.occurredAt ? entry.occurredAt.slice(0, 10) : null;
  const datesAgree = pageDate !== null && entryDate !== null && pageDate === entryDate;
  const datesDiffer = pageDate !== null && entryDate !== null && pageDate !== entryDate;

  // An entry with no stored fingerprint predates it being recorded, and there is
  // nothing to check against. Refused rather than trusted: the whole point of
  // this route is that it is only safe when verifiable.
  if (!entry.promptFingerprint) {
    return {
      distance,
      rejected:
        'This entry has no stored reading to check the page against, so there is no way ' +
        'to tell an opened thread from a re-run prompt. Re-import the export first.',
      chatId: null,
      turns: 0,
      images: 0,
    };
  }

  // A page dated differently from the record is not that record, whatever its
  // text resembles.
  if (datesDiffer) {
    return {
      distance,
      rejected:
        `The page's turns are dated ${pageDate} while this record is dated ${entryDate}. ` +
        'That is a different thread, or a prompt that has just been re-run, so nothing ' +
        'was stored.',
      chatId: null,
      turns: 0,
      images: 0,
    };
  }

  // Dates agreeing is near-conclusive on its own — a re-run cannot be dated in
  // the past — so a truncated or reworded answer no longer blocks a recovery.
  if (!datesAgree && distance >= REJECT_AT_DISTANCE) {
    // Recorded so the queue lets go of it. The verdict is about the link, not
    // about today, and a thread that keeps its place in the queue after being
    // rejected makes every subsequent run repeat the same work.
    if (entry.chatId !== null) db.setLinkState(entry.chatId, 'rejected');
    // On the entry too, because the entry is what the queue walks now. Without
    // this a rejected record stays in the queue forever and every run re-walks it.
    db.setEntryLinkState(entry.id, 'rejected');
    return {
      distance,
      rejected:
        `The page's answer differs too much from the export's (${distance} of 64 bits). ` +
        'That is what a re-run prompt looks like, so nothing was stored.',
      chatId: null,
      turns: 0,
      images: 0,
    };
  }

  // Only now is there a thread worth writing to.
  // Attach to the thread this record plainly belongs to, before considering a
  // new one. Adopting unconditionally is what doubled the archive: a run over
  // 383 records created 346 threads and every one of them was a duplicate of a
  // thread already there. Only when exactly one live thread shares the record's
  // opening prompt — with two or more it is genuinely ambiguous, and its own
  // thread is the honest answer.
  const sole = entry.chatId ?? db.soleThreadForEntry(entry.id);
  if (sole !== null && entry.chatId === null) db.linkSourceEntry(sole, entry.id);
  const chatId = sole ?? db.adoptSourceEntry(entry.id, null).chatId;
  // The very turns that were checked, not a fresh read of the page.
  const stored = await storeRenderedThread(chatId, turns);
  db.noteChatSource(chatId, 'link');
  db.setLinkState(chatId, 'fetched');
  db.setEntryLinkState(entry.id, 'fetched');
  return { distance, rejected: null, chatId, turns: stored.turns, images: stored.images };
}

export interface LinkRunSummary {
  attempted: number;
  fetched: number;
  turns: number;
  images: number;
  /** Pages whose answer did not match the export's — a re-run, not the thread. */
  rejected: number;
  errors: number;
  /** Pages that had not rendered in time. Left in the queue for a later run. */
  notReady: number;
  remaining: number;
  cancelled: boolean;
  failures: { title: string; reason: string }[];
  stoppedEarly?: string;
}

/**
 * Works through the threads only an export knows about, opening each by its link.
 *
 * The counterpart to captureTurns, and for most of the archive the only route
 * there is: the sidebar lists a few hundred threads while the export holds 2026
 * with a link. Every page is verified against the export's own reading before
 * anything is stored, so a link that re-runs its prompt is refused rather than
 * written — see captureFromEntryLink.
 *
 * Rejections are counted apart from errors and do NOT stop the run. A refusal is
 * this working correctly, and if the links turn out to re-run rather than open,
 * the whole run refuses and stores nothing, which is the outcome to want.
 */
/**
 * The longest one thread may take before the run moves on.
 *
 * Two settle waits plus a page load plus its images, with room to spare. The run
 * stopped dead at thread 413 on an image URL that never answered, so this exists
 * to make that class of failure survivable rather than fatal, without needing to
 * know in advance which await was the one that hung.
 */
const PER_THREAD_DEADLINE_MS = 240_000;

/**
 * The longest ONE thread may hold up a capture.
 *
 * PER_THREAD_DEADLINE_MS above says "one thread must never be able to stop the
 * run", and it was wired into the link fetch and nowhere else. captureTurns had
 * no ceiling at all: a thread sat there for as long as its internal waits
 * allowed — a 60s settle, a page load, then its images — with nothing above to
 * cut it off. Observed on a real run, a single thread holding the counter still
 * for over a minute while eighteen more waited behind it.
 *
 * Shorter than the link fetch's, because this path has a bounded settle to begin
 * with: past two minutes a thread is not slow, it is not coming.
 */
const CAPTURE_DEADLINE_MS = 120_000;

export async function fetchFromLinks(limit: number): Promise<LinkRunSummary> {
  const summary: LinkRunSummary = {
    attempted: 0,
    fetched: 0,
    turns: 0,
    images: 0,
    rejected: 0,
    errors: 0,
    notReady: 0,
    remaining: 0,
    cancelled: false,
    failures: [],
  };
  captureCancelled = false;
  const startedAt = new Date().toISOString();
  try {
    await ensureOnAiMode();
    // One queue, per RECORD. The thread-based queue it replaces reported 1
    // outstanding against 380: it could not see records attached to no thread, it
    // skipped any thread already read from the panel, and it counted one job per
    // thread where a thread can hold several records each with its own link.
    const queue = db.entriesWithLinksToFetch(limit);
    let consecutiveErrors = 0;

    for (const item of queue) {
      if (captureCancelled) break;
      summary.attempted += 1;
      broadcastCapture({
        phase: 'capturing',
        done: summary.fetched,
        // The tallies travel as FIELDS, not as text inside `current`.
        //
        // They used to be formatted into current, which was the only way to get
        // them on screen — and then the shared progress line grew counters of its
        // own, so the strip read "3/35 · 2 failed · #6 of 35 · 3 ok · 0 no match ·
        // 2 slow · 2 errors". The same run, reported twice, in two vocabularies.
        // A field can be rendered once; a sentence cannot be un-formatted.
        attempted: summary.attempted,
        total: queue.length,
        errors: summary.errors,
        rejected: summary.rejected,
        notReady: summary.notReady,
        current: item.title.slice(0, 44),
      });
      try {
        // A hard ceiling per thread, whatever the cause. The image fetch is
        // bounded now, but the lesson generalises: one thread must never be able
        // to stop the run, and the run must not depend on having predicted every
        // way a page can fail to finish.
        const result = await Promise.race([
          captureFromEntryLink(item.entryId),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new PageNotReadyError(-1)),
              PER_THREAD_DEADLINE_MS,
            ),
          ),
        ]);
        if (result.rejected) {
          summary.rejected += 1;
          summary.failures.push({ title: item.title.slice(0, 60), reason: result.rejected });
          // captureFromEntryLink records the rejection itself where it knows the
          // thread; this covers the case where the entry had no thread yet.
          db.setLinkState(item.chatId, 'rejected', result.rejected.slice(0, 200));
        } else {
          summary.fetched += 1;
          summary.turns += result.turns;
          summary.images += result.images;
        }
        // A rejection is a verdict, not a fault: the check did its job. Only a
        // thrown error suggests the run itself is in trouble.
        consecutiveErrors = 0;
      } catch (error) {
        summary.errors += 1;
        summary.failures.push({
          title: item.title.slice(0, 60),
          reason: error instanceof Error ? error.message : String(error),
        });
        // A page that was not ready is not evidence about the session. It stays
        // in the queue for a later run — nothing was stored and nothing was
        // marked — and it does not push the run toward giving up.
        // Google served something that is not the conversation — its own error
        // page, most often. Treated like a page that was not ready, because the
        // handling is the same: nothing stored, nothing marked, stays in the
        // queue, and it says nothing about the session so it must not push the
        // run toward giving up. Counted apart so a run of them reads as "Google
        // is having a bad day" rather than as an archive problem.
        if (error instanceof PageNotAiModeError) {
          summary.notReady += 1;
          if (item.chatId) db.setLinkState(item.chatId, 'error', error.message.slice(0, 200));
          await new Promise((resolve) => setTimeout(resolve, BETWEEN_CAPTURES_MS * 2));
          continue;
        }
        if (error instanceof PageNotReadyError) {
          summary.notReady += 1;
          db.setLinkState(
            item.chatId,
            'error',
            error.message.includes('(-1') ? 'Took too long; will be tried again' : error.message,
          );
          await new Promise((resolve) => setTimeout(resolve, BETWEEN_CAPTURES_MS * 2));
          continue;
        }
        consecutiveErrors += 1;
        db.setLinkState(
          item.chatId,
          'error',
          error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        );
        if (consecutiveErrors >= CONSECUTIVE_FAILURE_LIMIT) {
          summary.stoppedEarly =
            `Stopped after ${consecutiveErrors} consecutive errors — something systemic ` +
            '(signed out, offline, or the page changed) rather than awkward threads.';
          break;
        }
      }
      // Slower than the sidebar route on purpose: each of these is a full page
      // load against Google rather than a click within an app already open.
      await new Promise((resolve) => setTimeout(resolve, BETWEEN_CAPTURES_MS * 2));
    }

    summary.cancelled = captureCancelled;
    // The same count the button shows, or the run's own summary would disagree
    // with the label that started it.
    summary.remaining = db.countEntriesWithLinksToFetch();
    // Written before the broadcast, so a record exists even if the window has
    // gone away by the time the run ends — which for an hour-long job is not a
    // remote possibility.
    db.recordJob(
      'links',
      captureCancelled ? 'stopped' : summary.stoppedEarly ? 'failed' : 'finished',
      startedAt,
      { ...summary, failures: summary.failures.slice(0, 20) },
    );
    broadcastCapture({
      phase: captureCancelled ? 'cancelled' : 'done',
      done: summary.fetched,
      total: summary.attempted,
      errors: summary.errors + summary.rejected,
      turns: summary.turns,
      images: summary.images,
      remaining: summary.remaining,
      stoppedEarly: summary.stoppedEarly,
    });
    return summary;
  } catch (error) {
    db.recordJob('links', 'failed', startedAt, {
      ...summary,
      error: error instanceof Error ? error.message : String(error),
    });
    broadcastCapture({
      phase: 'error',
      done: summary.fetched,
      total: summary.attempted,
      errors: summary.errors + 1,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export interface InlineRepairSummary {
  turns: number;
  images: number;
  bytesFreed: number;
  failed: number;
  /** Turns that still hold base64 afterwards — a carrier not yet recognised. */
  stubborn: number;
}

/**
 * Moves inline base64 images out of stored HTML and into the asset store.
 *
 * The repair for a measured problem: 452 turns holding 63.9 MB of base64 in a
 * 198 MB database, one of them 1.29 MB of HTML around 2,810 characters of text.
 * Those images were never written to the store, so the markup was the only copy
 * of them — which is why they are MOVED rather than dropped. Dropping would
 * reclaim the same bytes and lose the pictures.
 *
 * Content-addressed on the way in, so the same image appearing in several turns
 * collapses to one file, which the inline form could never do.
 *
 * Capture no longer produces this: an image that fails the size filter has its
 * element removed rather than its base64 kept. This is for archives written
 * before that.
 */
/* ------------------------------------------------------------------ sync */

/**
 * The two flows, in place of the six buttons that used to be the whole of it.
 *
 * There were three ways to pull conversations in — refresh the sidebar list,
 * capture turns from the panel, open the export's links — plus a 25-at-a-time
 * variant, plus matching afterwards, and every one of them was a separate button
 * that had to be pressed in the right order to be any use. Nothing on screen said
 * what that order was. In practice there are only two things anyone wants:
 *
 *   'new' — what arrived since last time. Refresh the list, read what has no
 *           turns. Minutes, run often.
 *   'all' — everything still outstanding, including the thousands of threads
 *           Google has rotated out of the sidebar and only the export still
 *           links to. Hours, run once and leave it.
 *
 * They are the same steps in the same order; 'all' simply does not stop early.
 * That is the point — a repeated path and a catch-up path that differ in how far
 * they go, not in what they do, so doing one does not undo the other.
 */
export type SyncMode = 'new' | 'all';

export interface SyncSummary {
  listed: number;
  captured: number;
  fetched: number;
  matched: number;
  errors: number;
  cancelled: boolean;
  stoppedEarly?: string;
}

/**
 * Cancellation at the level of the WHOLE run, which the per-step flags cannot
 * express: each step resets its own flag when it starts, so a Stop pressed
 * between two steps would be forgotten by the next one and the run would carry
 * on after being told not to.
 */
let syncCancelled = false;
let syncRunning = false;

export function cancelSync(): void {
  syncCancelled = true;
  cancelHarvest();
  cancelCapture();
}

export function isSyncRunning(): boolean {
  return syncRunning;
}

function broadcastSync(progress: SyncProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('sync:progress', progress);
  }
}

// Far above any plausible history, so "all" means all. The steps below are
// bounded by what is actually outstanding, not by this.
const NO_LIMIT = 100_000;

export async function syncArchive(mode: SyncMode): Promise<SyncSummary> {
  if (syncRunning) throw new Error('A run is already going');
  syncRunning = true;
  syncCancelled = false;
  const startedAt = new Date().toISOString();
  const summary: SyncSummary = {
    listed: 0,
    captured: 0,
    fetched: 0,
    matched: 0,
    errors: 0,
    cancelled: false,
  };

  // Named here rather than inside each step so the count is right in the first
  // progress message, before any step has run. "Step 1 of 4" that turns out to
  // be step 1 of 2 is worse than no step count.
  const steps =
    mode === 'new'
      ? ['Refreshing the thread list', 'Reading from threads']
      : [
          'Refreshing the thread list',
          'Reading from threads',
          'Reading from links',
          'Matching entries to threads',
        ];
  let index = 0;
  const step = (name: string) => {
    index += 1;
    broadcastSync({ running: true, step: name, index, steps: steps.length });
  };

  try {
    step(steps[0]);
    // A step that fails does not take the run down with it. The list refresh
    // needs the sidebar and the panel on screen; the link fetch needs neither,
    // and a run that gave up on step one would leave the long work undone for a
    // reason that has nothing to do with it.
    try {
      const listed = await harvestThreadList();
      summary.listed = listed.created;
    } catch (error) {
      summary.errors += 1;
      summary.stoppedEarly = error instanceof Error ? error.message : String(error);
    }

    if (!syncCancelled) {
      step(steps[1]);
      // 'all' takes the threads that have been given up on too, and that is what
      // the button means. The attempt cap exists to stop the REPEATED path
      // grinding on the same doomed threads every time it runs — it was never
      // meant to put them out of reach, and it did: with the queue empty and 18
      // threads held back, "capture everything" attempted nothing at all while
      // Re-capture on any one of them worked first time.
      const captured = await captureTurns(NO_LIMIT, mode === 'all');
      summary.captured = captured.captured;
      summary.errors += captured.errors;
    }

    if (mode === 'all' && !syncCancelled) {
      step(steps[2]);
      const links = await fetchFromLinks(NO_LIMIT);
      summary.fetched = links.fetched;
      summary.errors += links.errors;
    }

    // Last on purpose: matching can only see the threads that exist when it
    // runs, so an entry whose thread was captured earlier in THIS run has
    // nothing to match against until now. That ordering was the reason "Match
    // entries" existed as a button at all.
    if (mode === 'all' && !syncCancelled) {
      step(steps[3]);
      const matched = db.rematchEntriesToThreads();
      summary.matched = matched.attached + matched.relinked;
    }

    summary.cancelled = syncCancelled;
    db.recordJob(
      `sync-${mode}`,
      syncCancelled ? 'stopped' : summary.stoppedEarly ? 'failed' : 'finished',
      startedAt,
      { ...summary },
    );
    return summary;
  } finally {
    syncRunning = false;
    syncCancelled = false;
    broadcastSync({ running: false, step: '', index: 0, steps: steps.length });
  }
}

export async function repairInlineImages(
  onProgress?: (done: number, total: number, phase?: 'counting' | 'copying') => void,
): Promise<InlineRepairSummary> {
  const summary: InlineRepairSummary = {
    turns: 0,
    images: 0,
    bytesFreed: 0,
    failed: 0,
    stubborn: 0,
  };
  // The flag backfill is drained first. It is one pass over every stored turn —
  // the same pass that used to run on startup and froze the window for ten
  // seconds — so it is done here, inside an operation that already takes minutes
  // and shows progress, rather than on the way to painting a window.
  //
  // Reported as 'counting', not as the repair's own progress. Sharing the
  // repair's counter would have put "Copying images — 0 of 23285" on screen for
  // a minute while nothing was being copied and the number never moved.
  const unexamined = db.countMessagesWithInlineImages().unexamined;
  let examinedSoFar = 0;
  while (examinedSoFar < unexamined) {
    const { examined, remaining } = db.examineInlineImages(400);
    examinedSoFar = unexamined - remaining;
    onProgress?.(examinedSoFar, unexamined, 'counting');
    // examined === 0 with rows still unexamined would be a loop that cannot
    // finish. Break rather than spin — the same failure that once read
    // "3200 of 480".
    if (remaining === 0 || examined === 0) break;
    // Yields to the event loop between slices, so the window keeps painting.
    await new Promise((resolve) => setImmediate(resolve));
  }
  const total = db.countMessagesWithInlineImages().inline;
  // Taken in batches rather than all at once: the rows are megabytes each, and
  // holding 452 of them in memory to save a query would be its own problem.
  //
  // Paged by id, so a row that cannot be fully cleaned is passed over rather than
  // selected again next round. Re-querying the LIKE each time made this loop
  // endless on a real archive — the counter read "3200 of 480".
  let afterId = 0;
  for (;;) {
    const rows = db.messagesWithInlineImages(20, afterId);
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;

    for (const row of rows) {
      const before = row.html.length;
      const replacements = new Map<string, string>();
      // Only the src attributes, and only data: ones. A regex over the whole
      // document would also match base64 that happens to sit in text.
      for (const match of row.html.matchAll(/<img\b[^>]*\bsrc="(data:[^"]+)"/gi)) {
        const src = match[1];
        if (replacements.has(src)) continue;
        const outcome = await storeImage(src);
        if (outcome.kind === 'stored') {
          replacements.set(src, assetHref(outcome.asset));
          db.addAssetForMessage(row.chatId, row.id, outcome.asset, 'generated');
          summary.images += 1;
        } else {
          summary.failed += 1;
        }
      }

      const rewritten = rewriteImageSources(row.html, replacements);
      db.replaceMessageHtml(row.id, rewritten);
      summary.turns += 1;
      summary.bytesFreed += before - rewritten.length;
      // Counted rather than retried. A row still holding base64 after the rewrite
      // is a carrier the patterns do not know about, and the useful response is a
      // number to investigate — not another pass that will fail the same way.
      if (rewritten.includes('data:image')) summary.stubborn += 1;
      onProgress?.(summary.turns, total);
    }

    // Hand the thread back: this writes megabytes per row and would otherwise
    // freeze every window for the duration, which is the mistake three earlier
    // operations in this file already made.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return summary;
}

export async function openChatInPanel(chatId: number): Promise<void> {
  const chat = db.getChatForCapture(chatId);
  if (!chat) throw new Error(`No chat with id ${chatId}`);
  if (chat.externalId.startsWith('takeout:')) {
    throw new Error(
      'This entry came from a Takeout export and has no Google thread id, so it cannot be opened.',
    );
  }
  await ensureOnAiMode();
  await ensureHistorySidebarOpen();
  await openThreadById(chat.externalId);
}

export interface CaptureSummary {
  attempted: number;
  captured: number;
  /** Threads Google no longer lists; see the note in shared/types.ts. */
  unlisted: number;
  turns: number;
  images: number;
  errors: number;
  remaining: number;
  /**
   * Threads deliberately left alone, having failed too many times already. See
   * MAX_CAPTURE_ATTEMPTS — reported rather than silently dropped.
   */
  exhausted?: number;
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
/**
 * Loads the sidebar list once and returns every thread id it holds.
 *
 * The fix for a capture run that "just scrolls the panel". Each capture calls
 * openThreadById, which walks the entire virtualised list hunting for its row —
 * visibly, for up to its 60-second budget — and most of a Catch-up queue is
 * threads Google no longer lists, so most of those walks were never going to
 * find anything. Twenty-one threads, twenty-one full sweeps of the sidebar, and
 * from the outside it is a loop that scrolls and never ends.
 *
 * One walk up front costs about twenty seconds and answers the question for the
 * whole run: a thread whose id is not in a fully loaded list is not there, and
 * saying so takes no scrolling at all.
 *
 * Returns null when the list could not be loaded, and the caller must then fall
 * back to searching per thread rather than declaring everything missing. "The
 * sidebar would not load" and "the thread is gone" are opposite conclusions, and
 * confusing them would mark a whole queue as unrecoverable.
 */
async function loadSidebarIds(): Promise<Set<string> | null> {
  try {
    await ensureHistorySidebarOpen();
    const recycled = await recycleHistorySidebar();
    // No rows means no list. Null sends the caller down the "cannot tell" path
    // rather than declaring every thread in the queue missing — the sidebar
    // being shut says nothing about any particular thread.
    if (recycled.rows === 0) return null;
    await scrollListToTop();
    const geometry = await getListGeometry();
    if (geometry.clientHeight === 0) return null;

    const ids = new Set<string>();
    const absorb = async () => {
      for (const entry of await readRenderedThreads()) ids.add(entry.externalId);
    };
    await absorb();
    let stagnant = 0;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (captureCancelled) break;
      const before = ids.size;
      const scrolled = await scrollListBy(
        Math.min(geometry.clientHeight * STEP_FRACTION, STEP_MAX_PX),
      );
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      await absorb();
      if (scrolled.atBottom && ids.size === before) {
        stagnant += 1;
        if (stagnant >= STAGNANT_AT_BOTTOM_LIMIT) break;
      } else {
        stagnant = 0;
      }
    }
    // Rendering lags the scroll, so the last step's rows are still arriving.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    await absorb();
    return ids;
  } catch {
    // Same reasoning as the null above: a failure here says nothing about any
    // individual thread.
    return null;
  }
}

export async function captureTurns(
  limit: number,
  /**
   * Take the threads the automatic flows have given up on. Only ever set by the
   * menu item that exists to do exactly that — a deliberate act, because these
   * are threads with a measured history of costing two minutes each to fail.
   */
  includeExhausted = false,
): Promise<CaptureSummary> {
  const captureStartedAt = new Date().toISOString();
  if (capturing) throw new Error('A capture is already running');
  capturing = true;
  captureCancelled = false;

  const summary: CaptureSummary = {
    attempted: 0,
    captured: 0,
    unlisted: 0,
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
    const queue = db.chatsWithoutTurns(limit, includeExhausted);
    // The sidebar list, once, instead of once per thread — see loadSidebarIds.
    // Only worth the twenty seconds when there is more than one thread to place;
    // a single re-capture can just go and look.
    const listed = queue.length > 1 ? await loadSidebarIds() : null;
    // Said out loud rather than silently skipped. A queue that quietly shrinks
    // from 18 to 0 with nothing captured looks exactly like finishing the work.
    const exhausted = includeExhausted ? 0 : db.countExhaustedCaptures();
    summary.exhausted = exhausted;
    let consecutiveFailures = 0;
    // Conversations that failed this pass, retried once at the end. Most
    // failures here are transient — a page that took longer than 60s to settle
    // — so without a retry "Capture all" reliably leaves a tail behind and the
    // name is misleading. One extra pass, not a loop: retrying until success
    // would spin forever on a conversation that genuinely cannot be read.
    const retryable: db.ChatToCapture[] = [];
    let isRetry = false;
    const runPass = async (chats: db.ChatToCapture[]) => {
    for (const chat of chats) {
      if (captureCancelled) break;
      // Answered from the list already loaded rather than by sending the sidebar
      // on another fruitless walk. Only when the load succeeded: a list that
      // would not load says nothing about any particular thread, and treating
      // those two as the same would mark the whole queue as gone.
      if (listed && !listed.has(chat.externalId)) {
        summary.attempted += 1;
        summary.unlisted += 1;
        db.recordThreadNotListed(chat.id);
        broadcastCapture({
          phase: 'capturing',
          done: summary.captured,
          attempted: summary.attempted,
          total: queue.length + retryable.length,
          errors: summary.errors,
          unlisted: summary.unlisted,
          current: `not listed: ${chat.title.slice(0, 46)}`,
        });
        continue;
      }
      summary.attempted += 1;
      broadcastCapture({
        phase: 'capturing',
        // The number that MOVES. done is the captured count, and on a run where
        // every thread fails it never changes — observed sitting at "3/21" while
        // the run worked through thread after thread, which from the outside is
        // indistinguishable from a loop. The attempt count is the honest measure
        // of progress; captured and failed are reported beside it.
        done: summary.captured,
        attempted: summary.attempted,
        total: queue.length + retryable.length,
        errors: summary.errors,
        unlisted: summary.unlisted,
        current: `${isRetry ? 'retry: ' : ''}${chat.title.slice(0, 60)}`,
      });
      try {
        const result = await Promise.race([
          captureOneChat(chat),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`Gave up on this thread after ${CAPTURE_DEADLINE_MS / 1000}s`)),
              CAPTURE_DEADLINE_MS,
            ),
          ),
        ]);
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
        // A thread Google no longer lists is a permanent fact about that thread,
        // not evidence that anything is broken — so it must not count toward the
        // systemic-failure abort and must not be retried. These arrive in runs,
        // because the queue is ordered by recency and the oldest threads are
        // exactly the ones rotated out, so ten in a row is the NORMAL shape of
        // reaching the end of what the sidebar still holds. Counting them
        // stopped a run with 123 threads left, most of which were capturable.
        //
        // Checked FIRST, and that is the fix. The error tally and the failure
        // list were both filled in before this branch, so an unlisted thread was
        // counted twice — a real run reported "unlisted=16 errors=18" when there
        // were exactly two errors, and listed all sixteen among the failures.
        // "Counted apart from errors" was the stated intention and the code did
        // the opposite.
        if (error instanceof ThreadNotListedError) {
          summary.unlisted += 1;
          // Taken out of the queue now rather than after three more walks of the
          // sidebar. The search reached the end of the list and the row was not
          // in it, which is a fact about the thread, not a miss.
          db.recordThreadNotListed(chat.id);
          await new Promise((resolve) => setTimeout(resolve, BETWEEN_CAPTURES_MS));
          continue;
        }

        // One unreadable conversation must not abort the run — with hundreds
        // queued, stopping on the first oddity would make the feature useless.
        // The reason is kept, not just counted: "7 errors" is unactionable,
        // whereas knowing they were all load timeouts points straight at the
        // fix.
        summary.errors += 1;
        db.recordCaptureFailure(chat.id);
        summary.failures.push({
          title: chat.title.slice(0, 60),
          reason: error instanceof Error ? error.message : String(error),
        });

        consecutiveFailures += 1;
        // Retried only if this thread has not already failed several times on
        // earlier runs. The retry pass is for a page that took longer than usual
        // to settle; a thread on its seventh attempt is not being unlucky, and
        // retrying it inside the run is what turned 18 doomed threads into 26
        // attempts and the better part of an hour.
        if (!isRetry && chat.attempts < 2) retryable.push(chat);
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
    };

    await runPass(queue);
    // Second and final pass over this run's failures. Their earlier failure
    // already counted, so the totals reflect attempts rather than pretending
    // the first try never happened.
    if (!captureCancelled && retryable.length > 0) {
      isRetry = true;
      consecutiveFailures = 0;
      const toRetry = [...retryable];
      retryable.length = 0;
      await runPass(toRetry);
    }

    summary.cancelled = captureCancelled;
    summary.remaining = db.countChatsWithoutTurns();
    db.recordJob(
      'capture',
      captureCancelled ? 'stopped' : summary.stoppedEarly ? 'failed' : 'finished',
      captureStartedAt,
      { ...summary, failures: summary.failures.slice(0, 20) },
    );
    broadcastCapture({
      phase: captureCancelled ? 'cancelled' : 'done',
      done: summary.captured,
      total: summary.attempted,
      errors: summary.errors,
      unlisted: summary.unlisted,
      exhausted: summary.exhausted,
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
