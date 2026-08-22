import type { WebFrameMain } from 'electron';
import { getAiModeNavState, getAiModeWebContents } from './aiModeView';

// Google AI Mode page structure, confirmed by hand against a live signed-in
// session over CDP on 2026-08-21 (app 0.2.1, Chrome 150). Recorded here
// because none of it is documented anywhere and all of it is guessable-wrong —
// the same convention PromptLoom uses in perchanceDriver.ts.
//
// Page: https://www.google.com/search?udm=50
//
// THREAD LIST (the history sidebar)
// - Each thread is `button.qqMZif[data-thread-id]`, inside `li.j8c53`, inside
//   `ul.BqVL3e`. The scroll container is `div.cIl10d` (overflow-y: auto).
// - data-thread-id is stable and opaque, e.g. "rMyIarywKpDRwcsPh6rA6AY".
// - The button text is TRUNCATED. The full title is on a sibling
//   `button.fMed7[aria-label]` as "more options for <full title>".
// - Each row may also carry a thumbnail `img.RKMwI` from
//   lens.usercontent.google.com. These are SIDEBAR THUMBNAILS displayed at
//   24x24, not conversation content — an earlier pass mistook them for the
//   conversation's own images.
//
// THE LIST IS VIRTUALISED
// - Measured with the sidebar open: clientHeight 459, scrollHeight 12052, and
//   only ~20-40 thread buttons in the DOM at any instant. The rendered count is
//   a moving window, not a total: 10, 20, 40 and 60 were all observed on the
//   same list.
// - CONFIRMED by scrolling it end to end (scripts/probe-paginate.js): stepping
//   div.cIl10d down by 0.8 * clientHeight with ~700ms to settle, and
//   accumulating a UNION of data-thread-id across steps, yielded exactly 300
//   unique threads.
// - It is pure DOM virtualisation, not server-side paging: scrollHeight was
//   12052 at step 0 and still 12052 at the bottom, never growing. The container
//   is sized for the whole history up front and rows are recycled through it.
// - That gives a free completeness check, which matters more than it sounds:
//   expected total ≈ scrollHeight / rowHeight (12052 / ~40 = 300). So the
//   harvester can know how many threads it should end up with BEFORE it starts,
//   and treat a short result as a failure rather than as "done". Without it the
//   only stop signal is "no new ids for a while", which is exactly how a
//   virtualised list quietly yields a fraction of itself.
// - Accumulate by id across renders; never count what is rendered.
//
// VISIBILITY — the trap
// - `div.cIl10d` is `display: none` while the sidebar is closed, and the
//   thread buttons STAY IN THE DOM with zero-size boxes and offsetParent null.
//   Observed live as 60 total / 0 visible.
// - A blind querySelectorAll therefore reads as "found everything" while
//   capturing from a stale copy. Every read asserts the container is visible
//   and filters on offsetParent.
//
// RESUMING A THREAD — mtid URLs DO NOT WORK, and trying is destructive
// - The list buttons have no href anywhere. An open thread's URL does carry
//   /search?udm=50&mtid=<data-thread-id>&q=<first query>, which looked like an
//   address for that conversation. It is not.
// - TESTED against the live app: navigating to a constructed
//   ?udm=50&mtid=dRKJaoixPPWphvcPoYOp6QM&q=gpg+clearsign+specify+the+key did
//   NOT reopen that thread. Google ignored the supplied mtid, ran q= as a
//   fresh query, and issued a NEW thread id (Ij6Jau-DNIezhvcPmK_20Q4) — one
//   turn pair, no history. So mtid is session-bound state (it travels with
//   mstk), not a durable permalink.
// - Consequence, and it is a big one: the ONLY way to open a stored thread is
//   to click its button.qqMZif[data-thread-id] in the sidebar. Both turn
//   capture and Resume have to drive the virtualised list — scroll until the
//   row renders, then click. There is no URL shortcut.
// - Worse than merely not working: following such a URL CREATES a duplicate
//   conversation in the user's history. Doing it during the test added one.
//   So a constructed mtid URL must never be stored anywhere a click could
//   reach it, and must never be offered as "open in browser".
//
// SIDEBAR CONTROLS
// - Open/close: `button.SbLVJc[aria-label="AI Mode history"]`, and
//   `a.ilLN6b.FyY3Xc[title=" AI Mode history "]` (note the padding spaces).
//   "Open sidebar" / "Close sidebar" labels appear on `.xYn6Gf` elements.
// - New conversation: `button.UTNPFf[aria-label="New thread"]`.
// - Thread titles are mirrored into `.Se0jFd` and `.xYn6Gf.sJ0xEf` in the
//   sidebar. These are NOT turns — a long first query reads as a long title,
//   which is exactly how an earlier pass misidentified them.
//
// IMAGES — three kinds, and the one that matters is fetchable
// - AI-generated images: `img.HkNHyd` with alt="AI generated image", and the
//   src comes in TWO forms, so the pipeline must handle both:
//     * https://lens.usercontent.google.com/banana?agsi=... — seen on a
//       conversation reopened from history (1024x1024). Fetchable with
//       net.fetch bound to the persist:google session.
//     * data:image/jpeg;base64,... — seen immediately after generating an
//       image in the live session (896x1200). Already inline, no fetch.
//   Branch on the scheme rather than assuming a URL; an earlier note recorded
//   only the https form, which would have dropped every freshly generated
//   image on the floor.
// - User-uploaded (Lens) reference images: `img.taqkMe.Tbpky` with
//   alt="Visually searched image", src is a `data:image/jpeg;base64,...` URI
//   (1000x1000). The bytes are already in the DOM; no fetch at all.
// - Embedded Maps tiles: `blob:https://www.google.com/<uuid>` inside
//   `div.BOZmjd.Q6cQSe` ("Map data ©2026 Google"). blob: URLs are scoped to
//   the creating document, so the main process cannot fetch them under any
//   session config. Treat as page furniture and skip, or read in-page — but
//   they are map chrome, not conversation content.
// - Sidebar row thumbnails are `img.RKMwI` at 24x24 from the same
//   lens.usercontent.google.com host. Not conversation content.
//
// TURN STRUCTURE
// - `div.CKgc1d` is a turn-pair block; several exist per conversation.
// - USER turn: `div.ilZyRc.R7mRQb`
//     * `h2.iMqumd` is an accessible summary and states the shape outright,
//       e.g. "You sent: 1 image and said: <text>". Useful as a cross-check on
//       how many images a turn should have.
//     * text: `div.tbIZh.wQN2Jd.Odbbif` — take this, NOT the enclosing
//       `div.xEFZqe`, whose text also contains the button labels from
//       `div.SK38Xc` ("CopiedCopyEdit").
//     * images: `img.taqkMe.Tbpky`, inside `div.NyIrK.wcKEcb`.
//     * timestamp: `div.UYpEO > div.kwdzO`, e.g. "August 21, 2026" — the only
//       per-turn date seen anywhere, so this is where started_at comes from.
// - AI turn: the unclassed sibling `div` following the user turn, whose text
//   begins with the answer itself ("Here's your generated image.").
// - CHROME TO STRIP from any captured turn, all of which otherwise lands in
//   the text as run-together UI labels:
//     * `div.SK38Xc`        -> "CopiedCopyEdit"
//     * `div.NyIrK.wcKEcb`  -> "ShareDownload"
//     * `div.HvurC`         -> the feedback widget ("Saved time / Helpful /
//                              Comprehensive / Thanks for letting us know")
//     * `div.DBd2Wb`        -> disclaimers and share-link UI ("Images
//                              generated by AI may be inaccurate...",
//                              "Share public link")
// - Only the most recent exchange had images rendered while three earlier text
//   turns did not, so the conversation body may itself be lazily rendered.
//   Unconfirmed, and it matters for capture completeness.
//
// CONTINUING A THREAD: UPDATES IN PLACE, DOES NOT DUPLICATE
// - Observed on a thread with 3 user turns: the URL's q= and the sidebar title
//   both equal the FIRST user turn, not the latest, and the later two turns do
//   not appear as their own rows. So continuing appends to the same
//   data-thread-id, and the title is derived from the opening query and stays
//   put.
// - That makes data-thread-id a safe primary key and the title safe to store.
// - Caveat on how strongly to trust this: the list is virtualised, so "the
//   later turns have no row of their own" was checked against the ~20 rendered
//   rows, not all ~300. The title-equals-first-turn part is solid regardless.
//
// GOOGLE'S OWN DUPLICATES ARE REAL, AND THE PLAN'S content_key CATCHES THEM
// - Among 20 rendered rows: two threads share a 209-character title prefix
//   ("full-length character sprite of the identical athletic woman..."), three
//   more share 36 characters, and another pair shares 44.
// - A 209-character identical prefix is the same prompt submitted twice as two
//   separate threads — distinct ids, near-identical openings. Exactly the case
//   content_key (a hash of the normalised first user turn) is meant to flag for
//   a manual merge, now confirmed present in real data rather than assumed.
//
// CHANGE DETECTION
// - The list carries NO timestamp in the DOM. Checked every attribute: the row
//   has only class=j8c53, and the button has id (a "BAyyLe" prefix plus the
//   thread id), data-thread-id, class, and data-ved (an opaque tracking token).
//   No datetime, no data-ts, no "Today"/"Yesterday" group headers.
// - BUT the list is ordered by recent activity, and that is the signal.
//   CONFIRMED by experiment: a turn was added to thread
//   -CKIasHWF62phvcP7bHs4Ak while it sat at rank 8; after an app restart and a
//   fresh page load it was at rank 0, with every other thread keeping its
//   relative order and shifting down by one.
// - So "recent activity" means LAST TURN, not thread creation — that thread was
//   older than several it overtook. Google holds the timestamp server-side and
//   uses it to sort, while never rendering it (see TIMESTAMPS below).
// - So an incremental re-harvest does not need to re-open ~300 threads. Read
//   the list from the top and treat the leading run as changed; stop once
//   several consecutive already-known ids appear in their previous relative
//   order, since everything below that is older and untouched.
// - Design it to fail safe. If the ordering assumption is ever wrong the
//   fallback must be a slower full sweep, never silently skipped updates — so
//   pair it with a stored turn count and a hash of the last turn per chat, and
//   re-verify those whenever a thread is opened anyway (Resume, or asking
//   something new in it), which costs nothing extra.
// - THE LIST DOES NOT RE-SORT LIVE. Measured directly: a turn (with a newly
//   generated image) was added to thread -CKIasHWF62phvcP7bHs4Ak while the
//   sidebar was open, and afterwards that thread was still at rank 8 with
//   scrollTop 0 and an unchanged top row. Its data-thread-id and its q= were
//   also unchanged, so the update landed in place — the list simply does not
//   reflect it.
// - Consequence: position is stale the moment anything is added, but a RELOAD
//   fixes it. Both halves are measured — no live re-sort, correct order after a
//   fresh load. So an incremental harvest must reload before reading order, and
//   must never infer "nothing changed" from a list it has been sitting on.
// - Which makes the incremental shortcut sound: reload, read from the top, and
//   the new-or-updated threads are the leading prefix. Stop once several
//   consecutive known ids appear in their previous relative order.
// - Pair it with a stored turn count and last-turn hash anyway, re-verified
//   free whenever a thread is opened (Resume, or a new question in it), so a
//   future change in Google's ordering degrades to a slow full sweep rather
//   than to silently missed updates.
// - If real timestamps ever become necessary, the page links to
//   myactivity.google.com/search-services/history/search, which does render
//   dates per item. A different page with its own DOM, so a separate job.
// TIMESTAMPS: NOTHING MACHINE-READABLE EXISTS ON THE PAGE
// - div.UYpEO > div.kwdzO is an ADAPTIVE, display-only string: "17:05" for a
//   turn from today, "August 21, 2026" for an older one. An earlier note called
//   it date-only and therefore useless within a day, which was wrong — but it
//   is still only text, and today's form carries no date at all.
// - Searched for a precise value and there is none: div.kwdzO has no attributes
//   beyond class, div.UYpEO carries only a jsuid (a Google-internal element
//   handle), and the page contains zero <time> elements and nothing with
//   datetime / data-timestamp / data-ts / data-time. No title or aria-label
//   holds a date either.
// - Worse, it is not even rendered per turn: of four div.UYpEO in a two-turn
//   conversation, two were empty. So turn time is not reliably available at all.
// - The URL's sxsrf parameter ends in a millisecond epoch
//   (…:1787368726497), but that is when the PAGE loaded, not when a turn
//   happened. Useless for backfilling history.
// - The only real source of per-thread timestamps is the page's own link to
//   myactivity.google.com/search-services/history/search, which does render
//   them. Two caveats before treating that as the answer: it is a separate page
//   needing its own recon, and it is not obvious that it exposes
//   data-thread-id — if the only join key is the query text, that is a fuzzy
//   join and would silently attach wrong times to threads with similar
//   openings, which this history demonstrably has (see the duplicate-prefix
//   finding above).
// - Meanwhile the archive can always record its own capture time, which is
//   precise and trustworthy, just not retroactive.
//
// FRAMES / CONTEXTS
// - Conversation and history both live in the TOP-LEVEL frame. The only child
//   frame is an ogs.google.com account widget. So nodeIntegrationInSubFrames
//   stays off, unlike PromptLoom.
//
// STILL UNKNOWN — deliberately not guessed
// - Whether navigating to a constructed ?udm=50&mtid=<id>&q=<query> URL really
//   opens that thread (it is what an opened thread's URL looks like). Decides
//   whether Resume navigates or has to drive the sidebar.
// - Whether a long conversation's older turns are lazily rendered, which would
//   mean scrolling the conversation too, not just the thread list. Suspected:
//   in one conversation only the newest exchange had its images rendered.
//   (Both list ordering questions are now settled — see CHANGE DETECTION.)
//
// The harvester is not written until those are answered. The virtualisation
// and visibility findings above are why: both would have produced a harvester
// that looked like it worked while capturing a fraction of the data.

const THREAD_BUTTON_SELECTOR = 'button.qqMZif[data-thread-id]';
const THREAD_LIST_SCROLLER = 'div.cIl10d';
const HISTORY_TOGGLE_SELECTOR = 'button.SbLVJc[aria-label="AI Mode history"]';
const FRAME_SEARCH_RETRIES = 10;
const FRAME_SEARCH_RETRY_DELAY_MS = 500;

async function frameHasSelector(frame: WebFrameMain, selector: string): Promise<boolean> {
  try {
    return Boolean(
      await frame.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`),
    );
  } catch {
    // Cross-origin or destroyed frames can throw; treat as "not found".
    return false;
  }
}

async function findFrameWithSelector(selector: string): Promise<WebFrameMain | null> {
  const webContents = getAiModeWebContents();
  for (const frame of webContents.mainFrame.framesInSubtree) {
    // eslint-disable-next-line no-await-in-loop -- frames must be checked sequentially
    if (await frameHasSelector(frame, selector)) {
      return frame;
    }
  }
  return null;
}

export async function findAiModeFrame(): Promise<WebFrameMain> {
  for (let attempt = 0; attempt < FRAME_SEARCH_RETRIES; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- retries must happen sequentially
    const frame = await findFrameWithSelector(THREAD_BUTTON_SELECTOR);
    if (frame) return frame;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, FRAME_SEARCH_RETRY_DELAY_MS));
  }
  // Naming the URL matters: the panel is a general browser, so "wrong page" is
  // by far the likeliest cause and the least obvious from the symptom.
  throw new Error(
    `No AI Mode thread list found. The panel is showing ${getAiModeNavState().url || '(nothing)'}. ` +
      'Either it is not an AI Mode page, you are not signed in, or the page ' +
      'structure has changed (see the notes at the top of aiModeDriver.ts).',
  );
}

// Never throw inside injected code: executeJavaScript does not propagate the
// real JS error across the boundary, only a generic "Script failed to execute"
// wrapper. Every script below returns { ok, ... } and the real error is raised
// in TS. (Lesson inherited from perchanceDriver.ts.)
async function run<T>(script: string): Promise<T> {
  const frame = await findAiModeFrame();
  const result = (await frame.executeJavaScript(script)) as { ok: boolean; error?: string } & T;
  if (!result.ok) {
    throw new Error(result.error ?? 'Injected script failed');
  }
  return result;
}

export interface ThreadListEntry {
  externalId: string;
  title: string;
}

export interface ListGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  rowHeight: number;
  /**
   * How many threads the list should ultimately yield, from the container's
   * pre-sized scroll height. The list is virtualised and never holds more than
   * ~40 rows, so this is the only way to know a harvest finished rather than
   * merely stopped producing new ids.
   */
  expectedTotal: number;
}

const OPEN_SIDEBAR_SCRIPT = `
(() => {
  try {
    const scroller = document.querySelector(${JSON.stringify(THREAD_LIST_SCROLLER)});
    const visible = scroller && getComputedStyle(scroller).display !== 'none';
    if (visible) return { ok: true, alreadyOpen: true };
    const toggle = document.querySelector(${JSON.stringify(HISTORY_TOGGLE_SELECTOR)});
    if (!toggle) return { ok: false, error: 'History toggle button not found' };
    toggle.click();
    return { ok: true, alreadyOpen: false };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
`;

/**
 * The list stays in the DOM with the sidebar closed, so presence proves
 * nothing — every read has to happen against a visible container or it silently
 * scrapes a stale copy.
 */
export async function ensureHistorySidebarOpen(): Promise<boolean> {
  const result = await run<{ alreadyOpen: boolean }>(OPEN_SIDEBAR_SCRIPT);
  if (!result.alreadyOpen) {
    // The panel animates in; the scroller has no usable geometry until it has.
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return result.alreadyOpen;
}

const GEOMETRY_SCRIPT = `
(() => {
  try {
    const scroller = document.querySelector(${JSON.stringify(THREAD_LIST_SCROLLER)});
    if (!scroller) return { ok: false, error: 'Thread list scroller not found' };
    if (getComputedStyle(scroller).display === 'none') {
      return { ok: false, error: 'History sidebar is closed; the thread list in the DOM is stale' };
    }
    const row = document.querySelector(${JSON.stringify(THREAD_BUTTON_SELECTOR)});
    const rowHeight = row ? Math.round(row.getBoundingClientRect().height) : 0;
    return {
      ok: true,
      scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      rowHeight,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
`;

export async function getListGeometry(): Promise<ListGeometry> {
  const g = await run<Omit<ListGeometry, 'expectedTotal'>>(GEOMETRY_SCRIPT);
  // A rowHeight of 0 means nothing is laid out yet; refuse to invent a total
  // rather than divide by zero and "expect" nothing.
  const expectedTotal = g.rowHeight > 0 ? Math.round(g.scrollHeight / g.rowHeight) : 0;
  return { ...g, expectedTotal };
}

const READ_THREADS_SCRIPT = `
(() => {
  try {
    const scroller = document.querySelector(${JSON.stringify(THREAD_LIST_SCROLLER)});
    if (!scroller || getComputedStyle(scroller).display === 'none') {
      return { ok: false, error: 'History sidebar is closed; the thread list in the DOM is stale' };
    }
    const threads = Array.from(
      document.querySelectorAll(${JSON.stringify(THREAD_BUTTON_SELECTOR)}),
    )
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const row = el.closest('li') || el.parentElement;
        const overflow = row ? row.querySelector('button.fMed7[aria-label]') : null;
        const label = overflow ? overflow.getAttribute('aria-label') || '' : '';
        // The visible button text is clipped; this aria-label is not.
        const full = label.replace(/^more options for\s*/i, '').trim();
        return {
          externalId: el.getAttribute('data-thread-id'),
          title: full || (el.textContent || '').replace(/\s+/g, ' ').trim(),
        };
      })
      .filter((t) => t.externalId);
    return { ok: true, threads };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
`;

/** Reads only what is currently rendered — see the virtualisation notes. */
export async function readRenderedThreads(): Promise<ThreadListEntry[]> {
  const result = await run<{ threads: ThreadListEntry[] }>(READ_THREADS_SCRIPT);
  return result.threads;
}

const SCROLL_STEP_SCRIPT_PREFIX = `
(() => {
  try {
    const scroller = document.querySelector(${JSON.stringify(THREAD_LIST_SCROLLER)});
    if (!scroller || getComputedStyle(scroller).display === 'none') {
      return { ok: false, error: 'History sidebar closed mid-harvest' };
    }
    const before = scroller.scrollTop;
    scroller.scrollTop = Math.min(before + `;

const SCROLL_STEP_SCRIPT_SUFFIX = `, scroller.scrollHeight);
    return {
      ok: true,
      scrollTop: Math.round(scroller.scrollTop),
      moved: Math.round(scroller.scrollTop - before),
      atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
`;

export interface ScrollStepResult {
  scrollTop: number;
  moved: number;
  atBottom: boolean;
}

export async function scrollListBy(pixels: number): Promise<ScrollStepResult> {
  return run<ScrollStepResult>(
    SCROLL_STEP_SCRIPT_PREFIX + String(Math.round(pixels)) + SCROLL_STEP_SCRIPT_SUFFIX,
  );
}

export async function scrollListToTop(): Promise<void> {
  await run(`
    (() => {
      try {
        const s = document.querySelector(${JSON.stringify(THREAD_LIST_SCROLLER)});
        if (!s) return { ok: false, error: 'Thread list scroller not found' };
        s.scrollTop = 0;
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    })();
  `);
}
