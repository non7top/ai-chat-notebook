import { BrowserWindow, WebContentsView, session, WebContents } from 'electron';
import path from 'node:path';
import type { AiModeStatus } from '../shared/types';

// UNVERIFIED (2026-08-07): research says AI Mode is reached by adding udm=50
// to a Search URL, and that past conversations sit behind a history icon in
// the page's top-left — but this exact landing URL has not been checked
// against the live site yet. Overridable so the recon spike (and anyone
// debugging later) can point the view somewhere else without a rebuild;
// pointing it at about:blank is also the quickest way to tell an app bug
// apart from a Google-page bug, the same trick ../sprite-manager/README.md
// documents for perchance.
export const AI_MODE_URL =
  process.env.NOTEBOOK_AI_MODE_URL ?? 'https://www.google.com/search?udm=50';

// udm=50 is what makes a Search URL an AI Mode URL, and it survives opening a
// thread (which only adds mtid), so it is a reliable "are we on the right
// page" test.
const AI_MODE_URL_PATTERN = /[?&]udm=50\b/;

// Unlike PromptLoom, the app's own UI is the main event here — reading an
// archived conversation needs real width, and the live panel is only wanted
// while harvesting, resuming or asking something new. So this is a split
// rather than a narrow sidebar, and the panel starts hidden.
//
// Must match --sidebar-fraction in src/index.css: this positions the native
// view to start exactly where the app's own pane ends, and nothing enforces
// the two agreeing.
export const SIDEBAR_FRACTION = 0.55;

let view: WebContentsView | undefined;
let lastStatus: AiModeStatus = { connected: false };
let mainWindowRef: BrowserWindow | undefined;
let hidden = true;

function computeBounds(mainWindow: BrowserWindow) {
  const [width, height] = mainWindow.getContentSize();
  const x = Math.round(width * SIDEBAR_FRACTION);
  return {
    x,
    y: 0,
    width: Math.max(width - x, 0),
    height,
  };
}

export function createAiModeView(mainWindow: BrowserWindow): WebContentsView {
  const newView = new WebContentsView({
    webPreferences: {
      // A named partition, so the Google login survives app restarts — the
      // whole point of embedding the page rather than scripting a throwaway
      // browser. Note this makes the app's userData directory hold live
      // Google session cookies.
      session: session.fromPartition('persist:google'),
      preload: path.join(__dirname, '../preload/aiModePreload.js'),
      // Deliberately NOT enabling nodeIntegrationInSubFrames. PromptLoom
      // needed it because perchance runs its generator in a nested iframe;
      // whether AI Mode does the same is unknown, so this stays off until
      // the recon spike proves it's required.
    },
  });
  view = newView;
  mainWindowRef = mainWindow;
  mainWindow.contentView.addChildView(newView);
  newView.webContents.loadURL(AI_MODE_URL);

  // Google's own links open in new tabs — "See your Search history" is a
  // target=_blank to myactivity. Left alone, Electron answers that with a bare
  // BrowserWindow: no address bar, no back button, its own lifecycle, and
  // outside the panel the driver and harvester know about. Navigate the panel
  // instead, so there is exactly one browsing surface in this app.
  newView.webContents.setWindowOpenHandler(({ url }) => {
    newView.webContents.loadURL(url);
    return { action: 'deny' };
  });

  // Unlike a top-level BrowserWindow, a WebContentsView doesn't apply
  // Ctrl+scroll-wheel zoom automatically — 'zoom-changed' fires the request,
  // but applying it is left to the app.
  newView.webContents.on('zoom-changed', (_event, zoomDirection) => {
    const current = newView.webContents.getZoomFactor();
    const delta = zoomDirection === 'in' ? 0.1 : -0.1;
    newView.webContents.setZoomFactor(Math.min(Math.max(current + delta, 0.25), 3));
  });

  const updateBounds = () => {
    // A WebContentsView is a native compositor layer drawn on top of the
    // app's own web contents regardless of DOM z-index, so "hidden" has to
    // mean zero-sized. Handled here rather than skipped, so a resize while
    // hidden can't reassert real bounds and pop the panel back into view.
    newView.setBounds(hidden ? { x: 0, y: 0, width: 0, height: 0 } : computeBounds(mainWindow));
  };
  updateBounds();
  mainWindow.on('resize', updateBounds);

  return newView;
}

export function setAiModeViewHidden(nextHidden: boolean): void {
  if (!view || !mainWindowRef) return;
  hidden = nextHidden;
  view.setBounds(hidden ? { x: 0, y: 0, width: 0, height: 0 } : computeBounds(mainWindowRef));
}

/**
 * Reveals the panel and tells the renderer, so its own toggle does not end up
 * claiming the panel is hidden while it is plainly on screen.
 */
export function showAiModePanel(): void {
  if (!view || !mainWindowRef) return;
  if (!hidden) return;
  setAiModeViewHidden(false);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('aiMode:visibility', true);
  }
}

export function isAiModeViewHidden(): boolean {
  return hidden;
}

export interface AiModeNavState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export function getAiModeNavState(): AiModeNavState {
  if (!view) return { url: '', canGoBack: false, canGoForward: false };
  const { webContents } = view;
  // navigationHistory rather than the webContents.canGoBack()/goBack() pair,
  // which Electron deprecated.
  return {
    url: webContents.getURL(),
    canGoBack: webContents.navigationHistory.canGoBack(),
    canGoForward: webContents.navigationHistory.canGoForward(),
  };
}

/**
 * Points the panel somewhere. A bare host is assumed to be https — typing
 * "myactivity.google.com/..." should just work, and Electron would otherwise
 * treat it as a relative path and fail obscurely.
 */
export function navigateAiMode(input: string): void {
  if (!view) return;
  const trimmed = input.trim();
  if (!trimmed) return;
  const url = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  view.webContents.loadURL(url);
}

/**
 * Loads AI Mode fresh, whatever the panel is currently showing.
 *
 * Extracted from ensureOnAiMode, which returns early when the URL already
 * matches — correct for "make sure we are there", useless for "start this page
 * over". Both now share one navigation-and-wait.
 */
function loadAiMode(timeoutMs: number): Promise<void> {
  if (!view) return Promise.reject(new Error('AI Mode view has not been created yet'));
  const webContents = view.webContents;
  return new Promise<void>((resolve, reject) => {
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onFailed = (
      _event: Electron.Event,
      _errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean,
    ) => {
      // did-fail-load fires for any failed subresource; only the main frame
      // failing means the navigation itself did not happen.
      if (!isMainFrame) return;
      cleanup();
      reject(new Error(`Could not load AI Mode: ${errorDescription}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out loading ${AI_MODE_URL}`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      webContents.removeListener('did-finish-load', onLoaded);
      webContents.removeListener('did-fail-load', onFailed);
    }
    webContents.once('did-finish-load', onLoaded);
    webContents.on('did-fail-load', onFailed);
    webContents.loadURL(AI_MODE_URL);
  });
}

/**
 * Starts AI Mode over from a fresh load.
 *
 * For the one case where being on the page is not enough: a history sidebar that
 * has stopped yielding rows. The app's own record shows a list sitting at a
 * fraction of its length with scrollHeight already sized for all of it and no
 * amount of scrolling growing it, and reopening the sidebar does not always
 * clear it.
 */
export async function reloadAiMode(timeoutMs = 25000): Promise<void> {
  if (!view) throw new Error('AI Mode view has not been created yet');
  showAiModePanel();
  await loadAiMode(timeoutMs);
}

/**
 * Puts the panel back on AI Mode if it has wandered — following a link to
 * myactivity, say. The harvester depends on this page being loaded, and making
 * it navigate itself is far better than failing with advice: the panel is a
 * general browser now, so being somewhere else is normal, not user error.
 *
 * Returns true if it had to navigate.
 */
export async function ensureOnAiMode(timeoutMs = 25000): Promise<boolean> {
  if (!view) throw new Error('AI Mode view has not been created yet');
  // MINIMISED WINDOW, refused up front rather than discovered per thread.
  //
  // The panel's bounds come from getContentSize(), so a minimised window sizes it
  // 0x0 — measured on the live app: the page's own innerHeight and innerWidth both
  // 0, the history scroller at clientHeight 0 with scrollHeight 12184, ten rows
  // rendered. Chromium does not render or lazily load into a view with no size, so
  // the list cannot grow however long it is scrolled, and every read succeeds while
  // describing a page nobody is showing.
  //
  // That is almost certainly what a walk finding 50 rows of 305 was: a run left to
  // get on with it, and a window minimised because it takes hours. Nothing said so.
  if (mainWindowRef?.isMinimized() || (mainWindowRef?.getContentSize()[1] ?? 0) === 0) {
    throw new Error(
      'The window is minimised, so the panel has no size and Google will not render ' +
        'its list into it. Restore the window — it can sit behind other windows, ' +
        'just not minimised — and start again.',
    );
  }
  // Anything that reads the page needs the panel laid out: while hidden it has
  // zero bounds, so clientHeight is 0 and the thread list has no geometry to
  // scroll. Re-capture failed with "Thread list never laid out" for exactly
  // this reason — it had no equivalent of the capture buttons' "show the panel
  // first" step. Arranging it here covers every caller instead of each one
  // remembering.
  showAiModePanel();
  if (AI_MODE_URL_PATTERN.test(view.webContents.getURL())) return false;
  await loadAiMode(timeoutMs);
  return true;
}

export function aiModeGoBack(): void {
  view?.webContents.navigationHistory.goBack();
}

export function aiModeGoForward(): void {
  view?.webContents.navigationHistory.goForward();
}

export function aiModeReload(): void {
  view?.webContents.reload();
}

export function getAiModeWebContents(): WebContents {
  if (!view) {
    throw new Error('AI Mode view has not been created yet');
  }
  return view.webContents;
}

// Right-click "Inspect Element" doesn't work for a WebContentsView, and the
// default "Toggle Developer Tools" menu role only targets the focused
// window's own webContents — so this is the only way to see console output
// from injected scripts, or to run diagnostic JS by hand against the real
// page. The recon spike lives or dies by it.
export function openAiModeDevTools(): void {
  getAiModeWebContents().openDevTools({ mode: 'detach' });
}

// The renderer's status listener may subscribe after the view has already
// fired its first load event — cache the latest status so a fresh subscriber
// can query it instead of missing that event.
export function getLastAiModeStatus(): AiModeStatus {
  return lastStatus;
}

export function setLastAiModeStatus(status: AiModeStatus): void {
  lastStatus = status;
}
