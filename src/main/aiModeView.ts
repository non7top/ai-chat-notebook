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
const AI_MODE_URL = process.env.NOTEBOOK_AI_MODE_URL ?? 'https://www.google.com/search?udm=50';

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
