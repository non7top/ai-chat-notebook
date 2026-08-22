import type { WebFrameMain } from 'electron';
import { getAiModeWebContents } from './aiModeView';

// Google AI Mode page structure, confirmed by hand against a live signed-in
// session over CDP on 2026-08-21 (app 0.2.1, Chrome 150). Recorded here
// because none of it is documented anywhere and all of it is guessable-wrong —
// the same convention PromptLoom uses in perchanceDriver.ts.
//
// Page: https://www.google.com/search?udm=50 (the landing URL is right; the
// live tab also carried &atvm=2, which appears incidental).
//
// THREAD LIST (the history sidebar)
// - Each thread is `button.qqMZif[data-thread-id]`, inside `li.j8c53`, inside
//   `ul.BqVL3e`.
// - data-thread-id looks stable and opaque, e.g. "dRKJaoixPPWphvcPoYOp6QM".
//   This is the dedupe key; no content hashing fallback is needed.
// - The button's own text is TRUNCATED for display. The full title lives on a
//   sibling `button.fMed7[aria-label]` as "more options for <full title>" —
//   strip that prefix rather than reading the visibly-clipped text.
// - THREADS HAVE NO href ANYWHERE. Not on the button, not on an ancestor, not
//   on a descendant, and the page URL does not change to carry a thread id.
//   So Resume cannot navigate by URL: it has to click
//   `button.qqMZif[data-thread-id="..."]`. This was the single biggest open
//   question in the plan and the answer is the expensive one.
//
// SCROLLING / PAGINATION
// - The list's scroll container is `div.cIl10d` (overflow-y: auto). It is the
//   only scrollable element on the page containing threads.
// - 60 threads were in the DOM with the sidebar open, against a history of
//   several hundred. So the list paginates and `div.cIl10d` is what to scroll.
//
// VISIBILITY — the trap
// - `div.cIl10d` is `display: none` while the sidebar is closed, and the 60
//   thread buttons STAY IN THE DOM. querySelectorAll('[data-thread-id]')
//   therefore returns a full list of elements with zero-size boxes and
//   offsetParent === null, which reads as "found everything" while nothing is
//   actually on screen.
// - Observed live: 60 total, 0 visible. Every read must either assert the
//   container is visible or filter on offsetParent !== null. A harvester that
//   skipped this would appear to work and quietly capture from a stale,
//   never-updating copy.
//
// SIDEBAR CONTROLS
// - Open/close: `button.SbLVJc[aria-label="AI Mode history"]`, and
//   `a.ilLN6b.FyY3Xc[title=" AI Mode history "]` (note the padding spaces).
//   Labels "Open sidebar" / "Close sidebar" appear on `.xYn6Gf` elements.
// - New conversation: `button.UTNPFf[aria-label="New thread"]`.
// - Thread titles are also mirrored into `.Se0jFd` and `.xYn6Gf.sJ0xEf`
//   inside the sidebar. These are NOT conversation turns — mistaking them for
//   turns is easy, because a long first query becomes a long "title".
//
// IMAGES
// - Generated images are `img.RKMwI`, served from
//   https://lens.usercontent.google.com/image?vsrid=...
// - No `loading="lazy"`, no `data-src`, no srcset placeholder — the src is the
//   real URL and is already loaded by the time the turn is rendered.
// - Whether that host serves them without the session's cookies is NOT yet
//   established; the asset pipeline must be tested against it rather than
//   assumed (see the plan's note on fetching via net.fetch bound to the
//   persist:google session).
//
// FRAMES / CONTEXTS
// - The conversation and history both live in the TOP-LEVEL frame. The only
//   child frame of interest is an ogs.google.com account widget, which is
//   irrelevant. So nodeIntegrationInSubFrames stays off, unlike PromptLoom.
// - CDP evaluation landed in "Electron Isolated Context #2" (the preload's
//   isolated world) and could read the DOM fine, as expected — but page
//   globals would not be visible from there. executeJavaScript from the main
//   process runs in the main world, so this only matters for preload code.
//
// STILL UNKNOWN — deliberately not guessed
// - The per-turn DOM of an OPEN conversation: the wrapper element, and how a
//   user turn is distinguished from an AI turn. Every attempt to capture this
//   caught the page mid-change, and the classes that looked like turns
//   (.Se0jFd, .xYn6Gf.sJ0xEf) turned out to be sidebar titles.
// - Whether scrolling div.cIl10d actually appends more threads, and what the
//   end-of-list signal is.
//
// The harvester is not written until those two are answered, for exactly the
// reason the visibility trap above demonstrates.

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
