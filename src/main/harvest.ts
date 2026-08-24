import { BrowserWindow } from 'electron';
import * as db from './db';
import { hammingDistance, promptFingerprint } from '../shared/fingerprint.ts';
import { ensureOnAiMode, navigateAiMode } from './aiModeView';
import { assetHref, storeImage } from './assets';
import { rewriteImageSources } from '../shared/rewriteImages.ts';
import {
  ensureHistorySidebarOpen,
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
  const chatId = entry.chatId ?? db.adoptSourceEntry(entry.id, null).chatId;
  // The very turns that were checked, not a fresh read of the page.
  const stored = await storeRenderedThread(chatId, turns);
  db.noteChatSource(chatId, 'link');
  db.setLinkState(chatId, 'fetched');
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
  try {
    await ensureOnAiMode();
    const queue = db.threadsWithLinksToFetch(limit);
    let consecutiveErrors = 0;

    for (const item of queue) {
      if (captureCancelled) break;
      summary.attempted += 1;
      broadcastCapture({
        phase: 'capturing',
        done: summary.fetched,
        total: queue.length,
        errors: summary.errors,
        current: `link: ${item.title.slice(0, 60)}`,
      });
      try {
        const result = await captureFromEntryLink(item.entryId);
        if (result.rejected) {
          summary.rejected += 1;
          summary.failures.push({ title: item.title.slice(0, 60), reason: result.rejected });
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
        if (error instanceof PageNotReadyError) {
          summary.notReady += 1;
          await new Promise((resolve) => setTimeout(resolve, BETWEEN_CAPTURES_MS * 2));
          continue;
        }
        consecutiveErrors += 1;
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
    summary.remaining = db.countThreadsWithLinksToFetch();
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
export async function repairInlineImages(
  onProgress?: (done: number, total: number) => void,
): Promise<InlineRepairSummary> {
  const summary: InlineRepairSummary = {
    turns: 0,
    images: 0,
    bytesFreed: 0,
    failed: 0,
    stubborn: 0,
  };
  const total = db.countMessagesWithInlineImages();
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
    const queue = db.chatsWithoutTurns(limit);
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
      summary.attempted += 1;
      broadcastCapture({
        phase: 'capturing',
        done: summary.captured,
        total: queue.length + retryable.length,
        errors: summary.errors,
        unlisted: summary.unlisted,
        current: `${isRetry ? 'retry: ' : ''}${chat.title.slice(0, 60)}`,
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
        db.recordCaptureFailure(chat.id);
        summary.failures.push({
          title: chat.title.slice(0, 60),
          reason: error instanceof Error ? error.message : String(error),
        });

        // A thread Google no longer lists is a permanent fact about that thread,
        // not evidence that anything is broken — so it must not count toward the
        // systemic-failure abort and must not be retried. These arrive in runs,
        // because the queue is ordered by recency and the oldest threads are
        // exactly the ones rotated out, so ten in a row is the NORMAL shape of
        // reaching the end of what the sidebar still holds. Counting them
        // stopped a run with 123 threads left, most of which were capturable.
        if (error instanceof ThreadNotListedError) {
          summary.unlisted += 1;
          await new Promise((resolve) => setTimeout(resolve, BETWEEN_CAPTURES_MS));
          continue;
        }

        consecutiveFailures += 1;
        if (!isRetry) retryable.push(chat);
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
    broadcastCapture({
      phase: captureCancelled ? 'cancelled' : 'done',
      done: summary.captured,
      total: summary.attempted,
      errors: summary.errors,
      unlisted: summary.unlisted,
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
