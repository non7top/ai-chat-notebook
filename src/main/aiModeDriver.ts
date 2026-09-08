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
// CONVERSATIONS *ARE* ADDRESSABLE — via mstk, not mtid (corrected 2026-08-22)
// - A Google Takeout export of "My Activity > AI Mode" contains, per entry, a
//   link of the form:
//     https://www.google.com/?udm=50&mstk=<long token>&csuir=1&q=<query>&aep=146
// - Navigating to one OPENS THE EXISTING CONVERSATION. Verified: loading a
//   Takeout link produced mtid=_buEaoyBM8mUhvcP45aw2A4, and that id was already
//   in the archive from the sidebar harvest, with exactly one matching title. It
//   did not mint a new thread.
// - So mstk is the durable handle. The note below concluding it was "session
//   state" was wrong, and the failed experiment that produced it used the wrong
//   URL shape: mtid= plus q= with NO mstk. mtid alone is not an address.
//
// RESOLVED: TAKEOUT LINKS RE-RUN THE PROMPT. NEVER NAVIGATE TO THEM.
// - Following one on an image conversation produced the model replying "If you
//   referenced a specific original image for this character, please upload the
//   image so I can accurately match her face features..." — it re-executed the
//   prompt in a context where the uploaded reference no longer exists, and asked
//   for it back.
// - So an mstk link is not a permalink to a conversation's CONTENT. It restores
//   enough to look right (correct mtid, original date) while losing the uploads
//   the conversation depended on, and it appends a fresh answer.
// - CLICKING THE SIDEBAR ROW DOES NOT DO THIS. The same sprite conversation
//   opened by click yielded 9 pairs with the original img.taqkMe upload intact
//   and its generated results in place. That is the faithful path, and it is
//   what capture already uses.
// - Therefore: use Takeout for METADATA ONLY — query text and its exact
//   timestamp. Never navigate to its links, never offer them as "open", and do
//   not use them to build a Takeout-to-conversation key. Paying one page load
//   per entry for that key would re-run several hundred prompts.
//
// SUPERSEDED SPECULATION — kept as a record of a wrong turn: an earlier note
// treated addressability as an easy win and worried that click-opening might
// regenerate images too. The evidence above says the click path preserves
// originals, so capture by click is sound and the concern applied only to the
// link path.
//
// (earlier framing, now answered:)
// OPENING A CONVERSATION MAY RE-RUN IT
// - The app's owner reports that following these links makes Google execute the
//   query again, and on image conversations attempt to RE-CREATE the images.
// - The test above cannot confirm or deny that: it used a text-only query, so
//   there was nothing to regenerate. A previous version of this note cited
//   "anyGenerating: true" as evidence, which was worthless — that regex matches
//   Google's own "Images generated by AI may be inaccurate" disclaimer, present
//   on every page.
// - This may also explain two earlier observations that looked unrelated: a
//   generated image is a data: URI immediately after generation but an
//   https://lens.usercontent.google.com URL when a thread is reopened, and
//   Takeout ships far fewer images than the conversations contain. If generated
//   images are not durably stored, viewing an old thread would have to remake
//   them. Speculation, flagged as such.
// - Consequence: DO NOT treat URL navigation as a free read. It probably costs
//   generation quota and may replace an archived image with a fresh, different
//   one — an archive of regenerated images is not an archive of what was
//   originally produced. The same caution applies to opening a thread by
//   clicking its sidebar row, which is what capture already does; whether the
//   9 images captured so far are originals or regenerations is NOT known.
// - What the addressability does buy safely: an exact Takeout-to-conversation
//   key (open once, read the mtid, match on that) instead of joining on query
//   text, which cannot separate the five duplicate-prompt groups. That is worth
//   one page load per entry — but only if the regeneration question is settled
//   first, because otherwise the price of the key is mutating the history.
//
// SECURITY: these links reportedly open WITHOUT authentication. If so an mstk
// URL is a bearer capability for reading that conversation, so a Takeout export
// is sensitive well beyond its text, and storing these URLs means storing
// read-access tokens. Do not surface them in shareable output. (Reported by the
// app's owner; not independently verified from a signed-out session.)
//
// SUPERSEDED — kept because the failure it describes is real and instructive:
// constructing mtid= plus q= WITHOUT mstk does not reopen anything, and Google
// runs q= as a fresh query, which adds a duplicate conversation to the user's
// history. It did exactly that during testing. Never build that URL shape.
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
// - Source-citation favicons are `img.IpiY3d`, and they are the reason a thread
//   reported seventeen images with none of them the pictures it was about: 100x100
//   in the file, 18x18 on screen. One thread carried 173. The chip around one is
//   `div.S9OuHf`, holding the icon and the site's name — that is what AI Mode
//   draws as "YouTube Music +1" inline in the answer.
// - Hovering that chip opens `div.jR6h WaKIwf Q1xFeb HIe7pd FEKEgc` with
//   role="dialog", around 360x237, several links and images: the rich source card.
//   Not captured, and not worth capturing — it is a UI affordance over links the
//   answer text already names.
// - The lesson from all of the above: judge an image by the size the PAGE gives
//   it, not the size of the file. Every one of these is large in the file and
//   small on screen. Class names are minified and get reissued; a rendered box
//   does not lie and does not churn.
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

// BACKSLASHES MUST BE DOUBLED in every script below. These are TS template
// literals, so a lone \s is not an escape JS recognises and collapses to a
// bare "s" — /\s+/g shipped as /s+/g and silently replaced every letter s in
// every captured message with a space ("Reset the AI's conversation state"
// became "Re et the AI'  conver ation  tate"). It reads as a page-structure
// problem, not a quoting one.
//
// Never throw inside injected code: executeJavaScript does not propagate the
// real JS error across the boundary, only a generic "Script failed to execute"
// wrapper. Every script below returns { ok, ... } and the real error is raised
// in TS. (Lesson inherited from perchanceDriver.ts.)
const SCRIPT_TIMEOUT_MS = 30_000;

async function run<T>(script: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<T> {
  const frame = await findAiModeFrame();
  // Time-bounded, because executeJavaScript can hang indefinitely rather than
  // reject: if the page navigates while the script is awaiting, the execution
  // context is torn down and the promise simply never settles. Without this a
  // single navigation mid-script would wedge the harvester forever.
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = (await Promise.race([
      frame.executeJavaScript(script),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Injected script timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ])) as { ok: boolean; error?: string } & T;
    if (!result.ok) {
      throw new Error(result.error ?? 'Injected script failed');
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs a script whose side effect is the point and whose result cannot be
 * awaited — a click that navigates destroys the context before the promise
 * resolves, so waiting for it is waiting for something that will never arrive.
 * Gives the page a moment to act on it and moves on.
 */
async function fireAndForget(script: string, graceMs = 2500): Promise<void> {
  const frame = await findAiModeFrame();
  await Promise.race([
    frame.executeJavaScript(script).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, graceMs)),
  ]);
}

export interface ThreadListEntry {
  externalId: string;
  title: string;
}

export interface ListGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** One row's own height. Kept for the report, and as a fallback for pitch. */
  rowHeight: number;
  /**
   * The distance from one row to the next — the number scrollHeight is actually
   * made of. Divided into it, rowHeight gave 301 for a list of 150.
   */
  pitch: number;
  /** Rows rendered right now, which for a virtualised list is a small window. */
  rendered: number;
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
 *
 * MEASURED 2026-08-26, and then CORRECTED the same day. First reading: the
 * scroller's `display` stayed `flex` across a close and a reopen, from which I
 * concluded it is never 'none' and this test is vacuous. Second reading, hours
 * later on the same machine: `display: none`, scrollHeight 0, zero rows. So the
 * test is real and my generalisation from one observation was wrong — the panel
 * does report itself closed, just not always when it looks closed.
 *
 * What holds from both readings is the weaker, more useful claim: display alone
 * cannot tell a LOADED list from a stub. The list can sit open holding ten rows
 * of three hundred —
 * observed holding 10 rows of 300, laid out, with scrollHeight already sized for
 * all 300 — and no amount of scrolling adds to it. A harvest against that reads
 * ten threads and calls it the history.
 *
 * So "open" is not a thing this can test for. What CAN be tested is whether the
 * list is LIVE: whether scrolling it produces rows. See recycleHistorySidebar
 * and the growth check in harvestThreadList.
 */
export async function ensureHistorySidebarOpen(): Promise<boolean> {
  const result = await run<{ alreadyOpen: boolean }>(OPEN_SIDEBAR_SCRIPT);
  if (!result.alreadyOpen) {
    // The panel animates in; the scroller has no usable geometry until it has.
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return result.alreadyOpen;
}

/**
 * Rebuilds the history list, and leaves it OPEN — verified, not assumed.
 *
 * The first version clicked the toggle exactly twice on the theory that the
 * sidebar starts open, so two clicks close it and open it again. It does not
 * always start open. Caught live: display 'none', scrollHeight 0, zero rows,
 * with a harvest reporting "10 / ~301 · INCOMPLETE" and the capture behind it
 * walking a list that was not on screen. Two blind clicks from a closed sidebar
 * leave it closed, and nothing here checked.
 *
 * So it reads the state, drives toward open, and CONFIRMS. Being open is also not
 * enough on its own — a list can be open and hold ten rows of three hundred with
 * no amount of scrolling adding to it, which is what the close-and-reopen is
 * for — so "did the rows come back" is part of the check.
 */
const RECYCLE_SIDEBAR_SCRIPT = `
(async () => {
  try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const toggle = document.querySelector(${JSON.stringify(HISTORY_TOGGLE_SELECTOR)});
    if (!toggle) return { ok: false, error: 'History toggle button not found' };

    const scroller = () => document.querySelector(${JSON.stringify(THREAD_LIST_SCROLLER)});
    const isOpen = () => {
      const s = scroller();
      return !!s && getComputedStyle(s).display !== 'none';
    };
    const rows = () =>
      document.querySelectorAll(${JSON.stringify(THREAD_BUTTON_SELECTOR)}).length;

    const startedOpen = isOpen();
    // Closed first if it is open, so the list is genuinely rebuilt rather than
    // merely revealed — a revealed stub stays a stub.
    if (startedOpen) {
      toggle.click();
      await wait(900);
    }
    // Then open, and keep trying until it is. A click landing during the panel's
    // own animation does nothing at all, which is how two blind clicks ended
    // with the sidebar shut.
    for (let attempt = 0; attempt < 4 && !isOpen(); attempt += 1) {
      toggle.click();
      await wait(1000);
    }
    if (!isOpen()) {
      return { ok: false, error: 'History sidebar would not open after four attempts' };
    }
    // Give the list a moment to populate before reporting what it holds.
    for (let i = 0; i < 12 && rows() === 0; i += 1) await wait(250);
    const s = scroller();
    return {
      ok: true,
      startedOpen: startedOpen,
      rows: rows(),
      scrollHeight: s ? s.scrollHeight : 0,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
`;

export async function recycleHistorySidebar(): Promise<{
  rows: number;
  scrollHeight: number;
  startedOpen: boolean;
}> {
  return run<{ rows: number; scrollHeight: number; startedOpen: boolean }>(
    RECYCLE_SIDEBAR_SCRIPT,
    30_000,
  );
}

const GEOMETRY_SCRIPT = `
(() => {
  try {
    const scroller = document.querySelector(${JSON.stringify(THREAD_LIST_SCROLLER)});
    if (!scroller) return { ok: false, error: 'Thread list scroller not found' };
    if (getComputedStyle(scroller).display === 'none') {
      return { ok: false, error: 'History sidebar is closed; the thread list in the DOM is stale' };
    }
    const rows = Array.from(
      document.querySelectorAll(${JSON.stringify(THREAD_BUTTON_SELECTOR)}),
    ).filter((el) => el.offsetParent !== null);
    const rowHeight = rows[0] ? Math.round(rows[0].getBoundingClientRect().height) : 0;

    // The PITCH from one row to the next, which is what scrollHeight is made
    // of — not the height of the button, which is what used to be divided into
    // it. They are the same number only while the row is nothing but its
    // button: add a wrapper, a margin or a date header and the estimate doubles.
    // A harvest reported "150 / ~301 threads · INCOMPLETE" on a sidebar that a
    // previous run had walked to rank 299 with no gaps, and 150 x 2 = 300 is
    // not a coincidence worth ignoring.
    //
    // The MEDIAN gap, so a date header inflating one interval does not move it.
    let pitch = 0;
    if (rows.length >= 3) {
      const tops = rows
        .map((el) => el.getBoundingClientRect().top)
        .sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < tops.length; i += 1) gaps.push(tops[i] - tops[i - 1]);
      gaps.sort((a, b) => a - b);
      pitch = Math.round(gaps[Math.floor(gaps.length / 2)]);
    }
    return {
      ok: true,
      scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      rowHeight,
      pitch,
      rendered: rows.length,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
`;

export async function getListGeometry(): Promise<ListGeometry> {
  const g = await run<Omit<ListGeometry, 'expectedTotal'>>(GEOMETRY_SCRIPT);
  // Pitch first, row height only as a fallback when too few rows are rendered to
  // measure a gap. Zero for both means nothing is laid out yet; refuse to invent
  // a total rather than divide by zero and "expect" nothing.
  const per = g.pitch > 0 ? g.pitch : g.rowHeight;
  const expectedTotal = per > 0 ? Math.round(g.scrollHeight / per) : 0;
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
        const full = label.replace(/^more options for\\s*/i, '').trim();
        return {
          externalId: el.getAttribute('data-thread-id'),
          title: full || (el.textContent || '').replace(/\\s+/g, ' ').trim(),
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
      // Reported so the caller can tell "the list ended" from "the list is still
      // loading". A lazy-loaded list is at its bottom repeatedly, each time with
      // more below it.
      scrollHeight: scroller.scrollHeight,
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
  /** Growing means more rows loaded — the bottom was not the end. */
  scrollHeight: number;
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

/* --------------------------------------------------- opening a conversation */

// Threads can only be opened by clicking their sidebar row (see the mtid notes
// above), and the list is virtualised, so the row may not exist in the DOM yet.
//
// Scrolling-to-find and clicking are deliberately SEPARATE steps. The click
// navigates, which destroys the execution context — so if the click were part
// of the same awaited script, that script's promise would never settle and the
// caller would hang. Learned by hanging.
const SCROLL_TO_THREAD_SCRIPT = (externalId: string) => `
(async () => {
  try {
    const wanted = ${JSON.stringify(externalId)};
    const scroller = document.querySelector(${JSON.stringify(THREAD_LIST_SCROLLER)});
    if (!scroller) return { ok: false, error: 'Thread list scroller not found' };
    if (getComputedStyle(scroller).display === 'none') {
      return { ok: false, error: 'History sidebar is closed' };
    }
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Quoted attribute selector: thread ids can begin with '-', which would be
    // an invalid identifier unquoted.
    const find = () => document.querySelector('button.qqMZif[data-thread-id="' + wanted + '"]');

    // The sidebar animates open, and until it has laid out clientHeight is 0.
    // Scrolling by 0.8 * 0 moves nothing, which an earlier version read as
    // "reached the bottom" and gave up on the first iteration — reporting a row
    // as missing while it sat in a list of 300. Wait for real geometry first.
    for (let i = 0; i < 20 && scroller.clientHeight === 0; i += 1) await wait(250);
    if (scroller.clientHeight === 0) {
      return { ok: false, error: 'Thread list never laid out (clientHeight stayed 0)' };
    }

    // Two passes: first forward from wherever the list already is, then from
    // the top. Captures run in list order, so the next thread is usually just
    // below the last one — rewinding to the top every time re-walks the whole
    // list and gets slower the deeper it goes. The wrap-around second pass is
    // what keeps it correct regardless of starting position.
    //
    // A wall-clock budget as well as a step budget, and the budget is why: two
    // passes of 220 steps at 350ms is 154 seconds, and run() gave up at 120. So
    // on a thread Google has rotated out of the sidebar the search never
    // reached its own conclusion — it was killed mid-search and reported
    // "Injected script timed out after 120000ms". Twenty of those in one run,
    // every one of them a thread that simply is not there any more.
    //
    // With this, the search always finishes and always says what it found.
    const deadline = Date.now() + 60000;
    let steps = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      if (pass === 1) {
        scroller.scrollTop = 0;
        await wait(400);
      }
      for (let step = 0; step < 220; step += 1) {
        if (Date.now() > deadline) {
          return { ok: true, found: false, steps: steps, reason: 'search budget spent' };
        }
        steps += 1;
        const el = find();
        if (el && el.offsetParent !== null) {
          el.scrollIntoView({ block: 'center' });
          await wait(150);
          return { ok: true, found: true, steps: steps, pass: pass };
        }
        // Bottom detected from geometry, not from "the scroll didn't move".
        // Those are different things, and conflating them is what broke this.
        const atBottom =
          scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
        if (atBottom) {
          // One last look: the final window may have rendered on this settle.
          await wait(400);
          const last = find();
          if (last && last.offsetParent !== null) {
            last.scrollIntoView({ block: 'center' });
            await wait(150);
            return { ok: true, found: true, steps: steps, pass: pass };
          }
          break;
        }
        scroller.scrollTop = Math.min(
          scroller.scrollTop + scroller.clientHeight * 0.8,
          scroller.scrollHeight,
        );
        await wait(350);
      }
    }
    // ok: TRUE. The search ran to completion and the row is not in the list —
    // which is an answer, not a malfunction. Returning ok:false made run() throw
    // a generic Error, indistinguishable from a broken injection, so a thread
    // Google had rotated out was recorded as a failure and retried.
    return { ok: true, found: false, steps: steps, reason: 'walked the list to the end' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
`;

/**
 * Is the row there at all? Asked separately, and awaited, before the click.
 *
 * The click itself cannot be awaited — it navigates, which tears down the
 * execution context so the promise never settles; that is why fireAndForget
 * exists. But something had to be awaited, because the old code clicked blind
 * and reported success either way, and that was the most damaging bug in this
 * file: a thread Google has rotated out of the sidebar has no row, so the click
 * did nothing, the panel went on showing the PREVIOUS thread, and the caller
 * read that and stored it under this thread's id. No error, no sign — one
 * thread quietly holding another thread's conversation.
 *
 * A query navigates nothing, so this one is safe to wait for.
 */
const FIND_THREAD_ROW_SCRIPT = (externalId: string) => `
(() => {
  const el = document.querySelector('button.qqMZif[data-thread-id="' + ${JSON.stringify(externalId)} + '"]');
  return { ok: true, found: !!el };
})();
`;

const CLICK_THREAD_SCRIPT = (externalId: string) => `
(() => {
  const el = document.querySelector('button.qqMZif[data-thread-id="' + ${JSON.stringify(externalId)} + '"]');
  if (el) el.click();
  return { ok: true };
})();
`;

/** Thrown when the thread has no row in the sidebar — Google no longer lists it. */
export class ThreadNotListedError extends Error {
  constructor(externalId: string) {
    super(
      `Google no longer lists this thread in the sidebar (${externalId}), so the panel ` +
        'cannot open it.',
    );
    this.name = 'ThreadNotListedError';
  }
}

/**
 * Is the panel on an AI Mode page at all?
 *
 * Google answers an export link with its own error page often enough to matter —
 * "internal server error ... try again later", caught live on an mstk link. That
 * page has no turns, so every caller waited out a 90-second settle and then a
 * 60-second retry for content that was never coming, and reported it as "slow",
 * which is what a page that IS merely loading also reports.
 *
 * Judged STRUCTURALLY rather than by the message. A real AI Mode page carries the
 * history sidebar container whether or not it is open; an error page, a consent
 * interstitial and a sign-in redirect all lack it. Keying on the English words
 * would work today and fail on the first localised error page.
 *
 * The message is still read when it is there, because a reason a person can act
 * on beats a category — but it is reported, not relied upon.
 */
const PAGE_KIND_SCRIPT = `
(() => {
  try {
    const hasSidebar = !!document.querySelector(${JSON.stringify(THREAD_LIST_SCROLLER)});
    const turns = document.querySelectorAll('div.CKgc1d').length;
    const text = (document.body ? document.body.textContent || '' : '').replace(/\\s+/g, ' ');
    return {
      ok: true,
      isAiMode: hasSidebar,
      turns: turns,
      // Reported for the message, not used for the verdict.
      looksLikeServerError: /internal server error|try again later/i.test(text),
      chars: text.length,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
`;

export interface PageKind {
  isAiMode: boolean;
  turns: number;
  looksLikeServerError: boolean;
  chars: number;
}

export async function readPageKind(): Promise<PageKind> {
  return run<PageKind>(PAGE_KIND_SCRIPT, 15_000);
}

/**
 * Google served something that is not the conversation.
 *
 * Distinguished from a page that is still rendering, because the two need
 * opposite handling: a slow page is worth waiting for, and this is worth
 * abandoning immediately and trying again another day. Both leave the record in
 * the queue — the fault is Google's and it is not permanent.
 */
export class PageNotAiModeError extends Error {
  constructor(detail: string) {
    super(`Google did not serve the conversation (${detail})`);
    this.name = 'PageNotAiModeError';
  }
}

export async function openThreadById(externalId: string): Promise<void> {
  // 90s against the script's own 60s budget, so the SCRIPT is what concludes,
  // not the timeout. The other way round — a 120s runner against a search that
  // could take 154s — is what turned "this thread is no longer in the sidebar"
  // into "Injected script timed out", twenty times in one run.
  const scan = await run<{ found: boolean; steps: number; reason?: string }>(
    SCROLL_TO_THREAD_SCRIPT(externalId),
    90_000,
  );
  // A completed search that found nothing is the answer, and it has a name.
  // Classifying it matters: captureTurns treats an unlisted thread as a fact
  // about that thread rather than a failure — no retry, and it does not count
  // toward the systemic-failure abort that stops the whole run.
  if (!scan.found) throw new ThreadNotListedError(externalId);
  // Checked again before clicking, and this is not defensive tidying: without it
  // the caller stores whatever thread the panel happens to be showing.
  const { found } = await run<{ found: boolean }>(FIND_THREAD_ROW_SCRIPT(externalId), 15_000);
  if (!found) throw new ThreadNotListedError(externalId);
  await fireAndForget(CLICK_THREAD_SCRIPT(externalId));
}

// Chrome that sits inside a turn and would otherwise be captured as part of the
// message. Each was seen welded onto real text during recon — reading the outer
// element yields "CopiedCopyEditможешь ей ноги..." and similar.
const TURN_CHROME_SELECTORS = [
  // Every control, by role rather than by class. This is the load-bearing rule:
  // a turn's text should never contain a button's label, and Google ships the
  // same Share/Download cluster under more than one class name — stripping
  // div.NyIrK.wcKEcb removed one and left an identical one under
  // div.h3dxKe.X0Xglb, so "ShareDownload" still landed in the captured answer.
  // Chasing class names loses; chasing buttons does not.
  'button',
  '[role="button"]',
  // Non-button chrome, which needs class names because it has no role.
  //
  // h2.iMqumd is an accessibility summary — "You sent: 1 image and said: <the
  // message>" — so rendering it repeats the message back with a prefix. It only
  // became visible once user turns started storing HTML. Stripped for display,
  // but still worth reading as a cross-check: it states how many images a turn
  // should have.
  'h2.iMqumd',
  'div.SK38Xc', // Copied / Copy / Edit wrapper
  'div.NyIrK.wcKEcb', // Share / Download wrapper
  'div.HvurC', // feedback widget ("Saved time / Helpful / ...")
  'div.DBd2Wb', // AI disclaimer + share-link UI (877 chars of it)
  'div.UYpEO', // the timestamp, captured separately
];

const READ_TURNS_SCRIPT = `
(() => {
  try {
    const clean = (el) => (el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
    const pairs = Array.from(document.querySelectorAll('div.CKgc1d'));
    if (pairs.length === 0) return { ok: false, error: 'No conversation turns rendered' };

    const chromeSel = ${JSON.stringify(TURN_CHROME_SELECTORS.join(','))};
    // Defined before stripped(), which depends on it.
    // What an image IS, not merely how big it is. Size alone was the whole
    // rule, and it let every rich link preview and source-card thumbnail
    // through: a conversation reported 17 images of which none were the
    // generated pictures the conversation was about. Classified from the
    // markers recorded in the findings above — img.HkNHyd with
    // alt="AI generated image" for generated, img.taqkMe for uploads — and
    // anything else is called 'other' rather than guessed at.
    const kindOf = (img) => {
      // FIRST, and that placement is the whole point: what the page itself drew
      // small is decoration whatever it is called. Measured live — a
      // source-citation favicon is img.IpiY3d, 100x100 in the file and 18x18 on
      // screen, and one thread carried 173 of them. Judging the FILE's size let
      // every one through.
      //
      // Deliberately not a class check, and deliberately ahead of the class
      // checks below. Those names are minified and Google reissues them; when
      // img.IpiY3d becomes something else this still holds, because it asks what
      // the page did rather than what it called the element. A zero-width box
      // means not laid out — the sidebar, a hidden turn — and says nothing about
      // the image, so it falls through to the names.
      const box = img.getBoundingClientRect();
      if (box.width > 0 && box.width < 64 && box.height > 0 && box.height < 64) {
        return 'other';
      }

      const cls = img.className || '';
      const alt = img.getAttribute('alt') || '';
      if (cls.indexOf('HkNHyd') !== -1 || alt === 'AI generated image') return 'generated';
      if (cls.indexOf('taqkMe') !== -1 || alt === 'Visually searched image') return 'upload';
      // img.fRm5F is the expand-wrapper copy of a real image. Still classified
      // as content, because when it is the ONLY copy it is the picture — but
      // redundantImages() drops it when a primary copy stands beside it, which
      // is what the store collapsing the bytes never did for the markup.
      if (cls.indexOf('fRm5F') !== -1) return 'generated';
      return 'other';
    };

    // Which <img> elements are REDUNDANT copies of a picture the turn already
    // holds. AI Mode renders every image twice: once in the answer, and once
    // inside the click-to-expand wrapper as img.fRm5F[data-deferred]. Google's
    // own stylesheet hides the second; the archive has no stylesheet, so both
    // showed, and every generated image appeared twice in the reader.
    //
    // The duplicate was already known here — the note below kept img.fRm5F on
    // the grounds that the content-addressed store collapses it. It does, for
    // the BYTES. The second <img> tag survived, and so did a second asset row
    // whenever Google served the expand copy re-encoded: measured on thread
    // #2842, an upload stored twice under two different hashes.
    //
    // Two rules, because the two cases differ:
    //  - identical src twice in one turn: the generated-image case, exact.
    //  - img.fRm5F alongside a primary copy: the upload case, where the expand
    //    copy is the same picture at a different encoding and the hashes differ.
    // An fRm5F with no primary beside it is KEPT — if Google ever renders only
    // the deferred copy, dropping it would lose the picture.
    const redundantImages = (root) => {
      const imgs = Array.from(root.querySelectorAll('img'));
      const isExpandCopy = (img) => (img.className || '').indexOf('fRm5F') !== -1;
      const hasPrimary = imgs.some((img) => {
        if (isExpandCopy(img)) return false;
        const cls = img.className || '';
        const alt = img.getAttribute('alt') || '';
        return (
          cls.indexOf('HkNHyd') !== -1 ||
          cls.indexOf('taqkMe') !== -1 ||
          alt === 'AI generated image' ||
          alt === 'Visually searched image'
        );
      });
      const skip = new Set();
      const seen = new Set();
      for (const img of imgs) {
        const src = img.currentSrc || img.getAttribute('src') || '';
        if (!src) continue;
        if (seen.has(src)) {
          skip.add(img);
          continue;
        }
        seen.add(src);
        if (hasPrimary && isExpandCopy(img)) skip.add(img);
      }
      return skip;
    };

    const imagesIn = (el) => {
      const redundant = redundantImages(el);
      return Array.from(el.querySelectorAll('img'))
        .filter((img) => !redundant.has(img))
        .map((img) => ({
          src: img.currentSrc || img.getAttribute('src') || '',
          alt: img.getAttribute('alt') || null,
          width: img.naturalWidth,
          height: img.naturalHeight,
          kind: kindOf(img),
        }))
        // A floor against spacers and 1px trackers only. It is NOT a way to
        // tell content from chrome, and the note that used to stand here — "120px
        // is above every UI glyph seen and below every real image" — was wrong:
        // site favicons are served at 256px and larger now, so they cleared the
        // bar comfortably and a thread came back reporting seventeen images of
        // which none were the pictures it was about. Size cannot answer this
        // question; kindOf can, which is why it exists.
        .filter((i) => i.src && (i.width >= 32 || i.height >= 32));
    };

    // Strip chrome from a COPY, so the live page is never modified — this runs
    // against the user's real session.
    //
    // script/style/noscript/template are removed too, and that is not
    // defensive tidying: textContent includes the SOURCE of inline scripts, so
    // without this a captured answer came back as
    // "sn._setImageSrc('img-XNmJav...','https://lens.usercontent...')" —
    // Google's own image-loading code stored as the AI's reply.
    const isCode = (el) =>
      el.tagName === 'SCRIPT' ||
      el.tagName === 'STYLE' ||
      el.tagName === 'NOSCRIPT' ||
      el.tagName === 'TEMPLATE';

    const stripped = (el) => {
      // querySelectorAll never matches the root itself, so a root that IS a
      // script would keep all of its source. Handle that case explicitly.
      if (isCode(el)) return document.createElement('div');

      // Which images are real content, decided on the LIVE element: a detached
      // clone reports naturalWidth 0 for everything, so size cannot be judged
      // there.
      const keep = new Set(imagesIn(el).map((i) => i.src));

      const copy = el.cloneNode(true);

      // COMMENTS, which are not markup anyone reads and are most of what gets
      // stored. Google leaves its own serialised page data in them —
      // <!--TgQPHd|[[null,null,["data:image/png;base64,...  — up to about 5KB
      // apiece, and a single answer can carry dozens.
      //
      // Measured on the real archive: 3,504 stored turns hold a data: image, all
      // of them inside comments and none inside an <img>, which is why "Move
      // inline images" ran repeatedly and moved nothing. It looks for
      // <img src="data:" and there has never been one to find; it counted them as
      // "a carrier the patterns do not know about" and said so, and I read that
      // as a failure to convert rather than as the answer.
      //
      // Nothing renders from a comment, so this loses no picture and no text.
      const comments = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
      const doomed = [];
      for (let c = comments.nextNode(); c; c = comments.nextNode()) doomed.push(c);
      for (const c of doomed) c.remove();

      for (const junk of Array.from(copy.querySelectorAll(chromeSel))) {
        // Controls are stripped for their labels, but Google puts real images
        // inside them — an uploaded reference image lives in a clickable
        // wrapper, and removing the control removed the picture too. The user
        // turn then had no <img> at all, so the subject of the whole
        // conversation was archived to disk and never rendered. Rescue the
        // images, drop the rest.
        const rescued = Array.from(junk.querySelectorAll('img')).filter((img) =>
          keep.has(img.currentSrc || img.getAttribute('src') || ''),
        );

        // Citations are rescued too, for the same reason the images are: Google
        // puts a source link inside a clickable chip, and removing the chip took
        // the link with it. Measured on one real answer — 37 anchors, 13 of them
        // inside controls — so a third of the sources a thread cited were being
        // dropped at capture.
        //
        // Not recoverable from the export, which carries its own three inline
        // anchors in the prose and not these. The two readings cite differently —
        // the export links words in the sentence, the panel puts chips beside it —
        // so each holds sources the other does not, and a chip dropped here is
        // dropped for good.
        //
        // Google's own links are NOT citations. support.google.com and
        // policies.google.com belong to the disclaimer, and rescuing those would
        // put boilerplate back into every answer. Host, not class, because the
        // classes churn.
        const rescuedLinks = Array.from(junk.querySelectorAll('a[href]')).filter((a) => {
          const href = a.getAttribute('href') || '';
          if (!/^https?:/i.test(href)) return false;
          try {
            const host = new URL(href).hostname;
            return !/(^|\.)google\.com$/i.test(host);
          } catch {
            return false;
          }
        });
        const survivors = rescued.concat(rescuedLinks);
        if (survivors.length > 0) {
          junk.replaceWith.apply(junk, survivors);
        } else {
          junk.remove();
        }
      }
      for (const code of Array.from(copy.querySelectorAll('script,style,noscript,template'))) {
        code.remove();
      }
      // After the chrome pass, so an image rescued out of a control is still
      // considered — and recomputed on the copy rather than mapped across the
      // clone, which is safe here because the rule reads class, alt and src and
      // all three survive cloneNode.
      for (const dup of Array.from(redundantImages(copy))) {
        dup.remove();
      }
      return copy;
    };

    const turns = [];
    pairs.forEach((pair) => {
      const userEl = pair.querySelector('div.ilZyRc.R7mRQb');
      if (userEl) {
        const body = userEl.querySelector('div.tbIZh.wQN2Jd.Odbbif');
        const copy = stripped(userEl);
        turns.push({
          role: 'user',
          // Prefer the precise body element; fall back to the de-chromed block.
          text: clean(body) || clean(copy),
          // HTML is kept for user turns too, not just answers. A question can
          // carry an uploaded reference image, and with html null its image had
          // nowhere to render — the file was archived but invisible, which for
          // an image-generation conversation loses the actual subject.
          html: copy.innerHTML,
          images: imagesIn(userEl),
          stamp: clean(userEl.querySelector('div.UYpEO div.kwdzO')) || null,
        });
      }
      // The AI answer is the pair's other child. It carries no class of its own,
      // so it is identified by CONTENT: the sibling with the most real text
      // once chrome and code are stripped.
      //
      // Code elements are excluded by tag, not just out-scored. A turn pair
      // observed live had three children — the user div, a bare <script>
      // carrying 357 characters of Google's image-loading source, and the real
      // answer. Scoring alone picked the script, because stripping the 877-char
      // disclaimer block out of the real answer dropped it BELOW the script.
      const aiEl = Array.from(pair.children)
        .filter((c) => c !== userEl && !isCode(c))
        .map((c) => ({ el: c, score: clean(stripped(c)).length + c.querySelectorAll('img').length }))
        .sort((a, b) => b.score - a.score)
        .filter((c) => c.score > 0)
        .map((c) => c.el)[0];
      if (aiEl) {
        const copy = stripped(aiEl);
        turns.push({
          role: 'ai',
          text: clean(copy),
          html: copy.innerHTML,
          images: imagesIn(aiEl),
          stamp: clean(aiEl.querySelector('div.UYpEO div.kwdzO')) || null,
        });
      }
    });

    return { ok: true, turns, pairCount: pairs.length, url: location.href };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
`;

export interface CapturedImage {
  /**
   * 'generated' | 'upload' | 'other'. 'other' is a rich link preview, a source
   * card thumbnail or anything else the page put inline — stored, because
   * nothing is discarded, but not counted as one of the conversation's images.
   */
  kind: string;
  src: string;
  alt: string | null;
  width: number;
  height: number;
}

export interface CapturedTurn {
  role: 'user' | 'ai';
  text: string;
  html: string | null;
  images: CapturedImage[];
  /** Display-only: "17:05" today, "August 21, 2026" older, often absent. */
  stamp: string | null;
}

export async function readTurns(): Promise<{ turns: CapturedTurn[]; url: string }> {
  const result = await run<{ turns: CapturedTurn[]; url: string }>(READ_TURNS_SCRIPT);
  return { turns: result.turns, url: result.url };
}

/**
 * Waits for a conversation to finish rendering after a click. Requires the turn
 * count to hold steady, not merely be non-zero: turns stream in, and reading at
 * the first sight of one captures a fragment.
 */
export async function waitForTurnsToSettle(timeoutMs = 60_000): Promise<number> {
  const started = Date.now();
  let last = -1;
  let stableFor = 0;
  // Ten consecutive identical readings at 500ms, so a count must hold still for
  // FIVE seconds before it is believed.
  //
  // It was two, which stored a 6-turn conversation as 1 turn — and because the
  // queue skips anything with turns, never went back. Then four, which is two
  // seconds. Measured on the live page since: the FIRST turn pair appears 3 to 6
  // seconds after the row is clicked. A stability window of two seconds is
  // shorter than the render it is policing, which is a thin bet on a page that
  // arrives turn by turn.
  //
  // Not measured, and worth saying: I could not record the shape of the ramp
  // between the first pair and the last. Clicking a row navigates, which destroys
  // the execution context of any script sampling it, so the interesting interval
  // is exactly the one a one-shot evaluator cannot see. Five seconds is therefore
  // a judgement, not a finding — chosen because the cost is bounded and known
  // (about three seconds a thread, twenty minutes across all 365) while the
  // failure it guards against is silent and permanent.
  const requiredStablePolls = 10;
  while (Date.now() - started < timeoutMs) {
    let count = 0;
    try {
      count = (
        await run<{ count: number }>(
          `
      (() => {
        try {
          return { ok: true, count: document.querySelectorAll('div.CKgc1d').length };
        } catch (err) {
          return { ok: false, error: String((err && err.message) || err) };
        }
      })();
    `,
          4000,
        )
      ).count;
    } catch {
      // Expected while the click's navigation is still in flight: the frame is
      // being replaced, so the probe fails rather than returning zero. Keep
      // polling instead of treating it as a failed capture.
      count = -1;
    }
    if (count > 0 && count === last) {
      stableFor += 1;
      if (stableFor >= requiredStablePolls) return count;
    } else {
      stableFor = 0;
    }
    last = count;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (last > 0) return last;
  throw new Error('Conversation did not render within the timeout');
}
