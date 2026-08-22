import type { WebFrameMain } from 'electron';
import { getAiModeWebContents } from './aiModeView';

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
//   only ~20 thread buttons in the DOM. At ~40px per row that scroll height
//   implies roughly 300 threads.
// - The rendered count is a moving window, not a total: 10, then 60, then 20
//   were observed at different moments on the same list.
// - So the full list can never be read in one pass. Harvesting must scroll
//   `div.cIl10d` and accumulate by data-thread-id across renders, and must not
//   treat "no new ids this pass" as the end without also checking scrollTop
//   against scrollHeight.
//
// VISIBILITY — the trap
// - `div.cIl10d` is `display: none` while the sidebar is closed, and the
//   thread buttons STAY IN THE DOM with zero-size boxes and offsetParent null.
//   Observed live as 60 total / 0 visible.
// - A blind querySelectorAll therefore reads as "found everything" while
//   capturing from a stale copy. Every read asserts the container is visible
//   and filters on offsetParent.
//
// RESUMING A THREAD — corrected
// - The list buttons genuinely have no href, on the button or any ancestor or
//   descendant. An earlier note concluded from that alone that Resume could
//   only ever click. That was wrong.
// - Once a thread is OPEN, the page URL carries it:
//     /search?udm=50&mtid=<data-thread-id>&q=<original query>&aep=26...
//   Verified: mtid=rMyIarywKpDRwcsPh6rA6AY matched that thread's
//   data-thread-id exactly, and q= held its first query.
// - So Resume most likely just navigates to that URL, and the click path is
//   the fallback rather than the only option. NOT yet confirmed by actually
//   navigating to a constructed URL — that is the one test still owed, and it
//   decides how much of the harvester needs to drive the sidebar at all.
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
// - AI-generated images: `img.HkNHyd` with alt="AI generated image", served
//   from https://lens.usercontent.google.com/banana?agsi=... at full
//   resolution (1024x1024 natural, displayed 423px). A normal HTTPS URL — so
//   net.fetch bound to the persist:google session is viable for the case that
//   actually matters. This was the open question and the answer is the cheap
//   one.
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
// - BUT the list is ordered by recent activity (per the app's owner, who has
//   watched it behave that way — Google clearly holds the date server-side even
//   though it never renders it). That is the signal, and it is a good one:
//   anything new or updated surfaces at the TOP.
// - So an incremental re-harvest does not need to re-open ~300 threads. Read
//   the list from the top and treat the leading run as changed; stop once
//   several consecutive already-known ids appear in their previous relative
//   order, since everything below that is older and untouched.
// - Design it to fail safe. If the ordering assumption is ever wrong the
//   fallback must be a slower full sweep, never silently skipped updates — so
//   pair it with a stored turn count and a hash of the last turn per chat, and
//   re-verify those whenever a thread is opened anyway (Resume, or asking
//   something new in it), which costs nothing extra.
// - Two things deliberately NOT concluded:
//     * Whether the sort updates live or only on reload. Opening two threads
//       did not visibly move them to the top, but the virtualised render window
//       makes any observed order unreliable, so the harvester should reload
//       before trusting position rather than assume live re-sorting.
//     * Whether "recent activity" means last turn or thread creation.
// - If real timestamps ever become necessary, the page links to
//   myactivity.google.com/search-services/history/search, which does render
//   dates per item. A different page with its own DOM, so a separate job.
// - The only per-turn date in AI Mode itself is div.UYpEO > div.kwdzO, and it
//   is a date with no time ("August 21, 2026") — enough to notice a change on a
//   different day, useless within one day.
//
// FRAMES / CONTEXTS
// - Conversation and history both live in the TOP-LEVEL frame. The only child
//   frame is an ogs.google.com account widget. So nodeIntegrationInSubFrames
//   stays off, unlike PromptLoom.
//
// STILL UNKNOWN — deliberately not guessed
// - Whether scrolling div.cIl10d actually appends more threads, and what the
//   end-of-list signal is. This is the last thing blocking the harvester.
// - Whether navigating to a constructed ?udm=50&mtid=<id>&q=<query> URL really
//   opens that thread (it is what an opened thread's URL looks like).
// - Whether a long conversation's older turns are lazily rendered, which would
//   mean scrolling the conversation too, not just the thread list.
//
// The harvester is not written until those are answered. The virtualisation
// and visibility findings above are why: both would have produced a harvester
// that looked like it worked while capturing a fraction of the data.

const THREAD_BUTTON_SELECTOR = 'button.qqMZif[data-thread-id]';
const THREAD_LIST_SCROLLER = 'div.cIl10d';
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
  throw new Error(
    'No frame contains the AI Mode thread list. Either not signed in, the ' +
      'history sidebar has never been opened in this session, or the page ' +
      'structure has changed (see the notes at the top of this file).',
  );
}

export interface ThreadListEntry {
  externalId: string;
  title: string;
}

// Never throw inside injected code: executeJavaScript does not propagate the
// real JS error across the boundary, only a generic "Script failed to execute"
// wrapper. Return a result object and raise in normal TS below. (Lesson
// inherited from perchanceDriver.ts.)
const LIST_THREADS_SCRIPT = `
(() => {
  try {
    const scroller = document.querySelector(${JSON.stringify(THREAD_LIST_SCROLLER)});
    if (!scroller) return { ok: false, error: 'Thread list scroller not found' };
    // The list stays in the DOM with the sidebar closed, so presence proves
    // nothing — refuse rather than return a stale, invisible list.
    if (!scroller.offsetParent && getComputedStyle(scroller).display === 'none') {
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
        const full = label.replace(/^more options for\\s*/i, '').trim();
        return {
          externalId: el.getAttribute('data-thread-id'),
          title: full || (el.textContent || '').replace(/\\s+/g, ' ').trim(),
        };
      })
      .filter((t) => t.externalId);
    return { ok: true, threads, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
`;

interface ListThreadsResult {
  ok: boolean;
  error?: string;
  threads?: ThreadListEntry[];
  scrollHeight?: number;
  clientHeight?: number;
}

/**
 * Reads the currently-loaded page of the history sidebar. Does not scroll or
 * paginate yet — see the "STILL UNKNOWN" notes above.
 */
export async function listVisibleThreads(): Promise<ThreadListEntry[]> {
  const frame = await findAiModeFrame();
  const result = (await frame.executeJavaScript(LIST_THREADS_SCRIPT)) as ListThreadsResult;
  if (!result.ok) {
    throw new Error(result.error ?? 'Failed to read the AI Mode thread list');
  }
  return result.threads ?? [];
}
