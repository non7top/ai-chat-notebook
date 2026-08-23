import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import contextMenu from 'electron-context-menu';
import { initDb, seedDevData } from './main/db';
import { registerIpcHandlers } from './main/ipc';
import { startCdpProxy } from './main/cdpProxy';
import {
  createAiModeView,
  getAiModeNavState,
  openAiModeDevTools,
  setLastAiModeStatus,
} from './main/aiModeView';
import type { AiModeStatus } from './shared/types';

// Electron shows no right-click menu anywhere by default (unlike a normal
// browser) — this adds the standard cut/copy/paste/inspect-element menu,
// including inside the embedded AI Mode view.
contextMenu({
  showInspectElement: true,
});

// Container/Xvfb dev environments often can't launch any GPU process at all
// (even for software rasterization); only opt out there, not in the real
// packaged app.
if (process.env.NOTEBOOK_DISABLE_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// Opt-in only, and it matters more here than it did in PromptLoom: this opens
// an UNAUTHENTICATED CDP endpoint. Anyone who can reach it gets full control
// of this app's embedded view — which holds a live, logged-in Google session.
// There is no password, no token and no confirmation prompt on that endpoint.
//
// A CLI flag as well as an env var, because the normal way to run this is a
// double-clicked installed Windows app, where setting an env var means editing
// a shortcut or opening a terminal anyway:
//
//   "AI Chat Notebook.exe" --devtools-port=9222
//
// Chromium binds the port to loopback only, and that is left alone
// deliberately: reaching it from another machine should mean deciding to
// forward it (ssh -L, Tailscale, etc.), not flipping a flag that quietly
// publishes a logged-in browser to the local network.
const DEVTOOLS_PORT_FLAG = '--devtools-port=';

/**
 * The port CI's pull-request builds listen on with no flag at all.
 *
 * Those builds exist to be driven and inspected, and needing to remember a
 * command-line flag every time defeats that. A release is built without
 * __DEBUG_BUILD__ and keeps the opt-in, because there the flag IS the consent:
 * the endpoint is unauthenticated and the panel behind it is signed in.
 *
 * Baked in at build time rather than read from the environment, so a release
 * cannot be turned into a debug build by setting a variable, and a PR build
 * cannot lose the setting depending on how it was launched.
 */
const DEBUG_BUILD_PORT = '9222';

function requestedDevtoolsPort(): string | undefined {
  const fromEnv = process.env.NOTEBOOK_REMOTE_DEBUGGING_PORT;
  if (fromEnv) return fromEnv;
  const flag = process.argv.find((arg) => arg.startsWith(DEVTOOLS_PORT_FLAG));
  if (flag) return flag.slice(DEVTOOLS_PORT_FLAG.length);
  // An explicit flag or variable still wins, so a debug build can be moved to
  // another port when 9222 is taken.
  return __DEBUG_BUILD__ ? DEBUG_BUILD_PORT : undefined;
}

/**
 * Credentials for the proxy in front of the debugging port, as user:password.
 *
 * Weak on purpose. Chromium has no authentication on that endpoint and no flag
 * adds one, so anything here is better than the nothing that was there — and a
 * password nobody has to look up is a password that stays switched on. Override
 * with --devtools-auth=user:pass when it matters.
 */
const DEVTOOLS_AUTH_FLAG = '--devtools-auth=';
const DEFAULT_DEVTOOLS_AUTH = 'ai:ai';

/**
 * Address the authenticating proxy listens on. Loopback unless asked otherwise.
 *
 * --devtools-bind=0.0.0.0 exists because the app runs on Windows while the
 * tooling that drives it runs under WSL, and WSL's NAT makes Windows loopback
 * unreachable from there. The password is what makes that defensible; without
 * it this flag would be handing out a signed-in Google session.
 */
const DEVTOOLS_BIND_FLAG = '--devtools-bind=';

function devtoolsAuth(): { user: string; password: string } {
  const flag = process.argv.find((arg) => arg.startsWith(DEVTOOLS_AUTH_FLAG));
  const raw =
    flag?.slice(DEVTOOLS_AUTH_FLAG.length) ||
    process.env.NOTEBOOK_DEVTOOLS_AUTH ||
    DEFAULT_DEVTOOLS_AUTH;
  const at = raw.indexOf(':');
  return at === -1
    ? { user: raw, password: '' }
    : { user: raw.slice(0, at), password: raw.slice(at + 1) };
}

const devtoolsPort = requestedDevtoolsPort();
if (devtoolsPort) {
  // Chromium listens one port up and the proxy takes the port that was asked
  // for, so the port to forward is the one with the password on it. Deliberately
  // arithmetic rather than picked at random: the switch has to be set before the
  // app is ready, and a value discovered asynchronously would not be available
  // yet. It also keeps the pair predictable when something goes wrong.
  const internalPort = Number(devtoolsPort) + 1;
  app.commandLine.appendSwitch('remote-debugging-port', String(internalPort));
  // Since Chromium 111 the CDP WebSocket handshake is rejected outright when
  // it carries an Origin header that isn't allow-listed. Local tools like
  // chrome://inspect send none and work without this; a remote client
  // (including anything proxied through a tunnel) generally does send one,
  // and fails with a bare 403 that gives no hint why.
  app.commandLine.appendSwitch('remote-allow-origins', '*');

  const auth = devtoolsAuth();
  const bindFlag = process.argv.find((arg) => arg.startsWith(DEVTOOLS_BIND_FLAG));
  const bindAddress =
    bindFlag?.slice(DEVTOOLS_BIND_FLAG.length) ||
    process.env.NOTEBOOK_DEVTOOLS_BIND ||
    '127.0.0.1';
  // Started once the app is ready rather than at module load, so a failure to
  // bind is reported instead of taking the whole launch down with it.
  app.whenReady().then(() => {
    try {
      startCdpProxy({
        publicPort: Number(devtoolsPort),
        internalPort,
        bindAddress,
        user: auth.user,
        password: auth.password,
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[Notebook] Remote debugging is ON at http://127.0.0.1:${devtoolsPort}/json ` +
          `(${__DEBUG_BUILD__ ? 'debug build, on by default' : 'requested explicitly'}), ` +
          `on ${bindAddress}, behind Basic auth as ${auth.user}. ` +
          (bindAddress === '127.0.0.1'
            ? ''
            : 'REACHABLE FROM THE NETWORK — the password is the only thing in the way, ' +
              'and Basic auth over plain HTTP gives it to anyone watching. ') +
          `Forward THIS port — Chromium itself ` +
          `listens on ${internalPort} with no password at all, and any process on ` +
          'this machine can reach it. The panel behind it holds a live Google session.',
      );
    } catch (error) {
      // Said loudly rather than swallowed: without the proxy the only way in is
      // the unauthenticated port, and believing otherwise is the dangerous part.
      // eslint-disable-next-line no-console
      console.error(
        `[Notebook] Could not start the authenticating proxy on ${devtoolsPort}: ` +
          `${error instanceof Error ? error.message : String(error)}. Chromium is ` +
          `still listening on ${internalPort} WITHOUT a password.`,
      );
    }
  });
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });

  // A build listening on an unauthenticated CDP port should say so somewhere a
  // person actually looks. The startup warning goes to a console nobody sees
  // when the app was double-clicked, and these installers sit in a downloads
  // folder next to real releases with near-identical names.
  //
  // page-title-updated has to be intercepted rather than just setting a title:
  // the renderer's <title> overwrites the window title as soon as it loads, so
  // a title set here alone would last only until then.
  if (__DEBUG_BUILD__) {
    mainWindow.on('page-title-updated', (event, title) => {
      event.preventDefault();
      mainWindow.setTitle(`${title} — DEBUG BUILD (remote debugging on)`);
    });
  }

  // electron-vite sets ELECTRON_RENDERER_URL in dev (HMR dev server); in a
  // packaged build it's unset and the renderer is loaded from its built
  // output instead.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Right-click "Inspect Element" doesn't work inside a WebContentsView, and
  // Electron's default "Toggle Developer Tools" role only targets the focused
  // window's own webContents (this app's UI), not a child view — so replace
  // the default menu with one that also exposes DevTools for the AI Mode
  // panel directly. The recon spike depends on this.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Debug',
        submenu: [
          {
            label: 'Open AI Mode DevTools',
            click: () => openAiModeDevTools(),
          },
        ],
      },
    ]),
  );

  const aiModeView = createAiModeView(mainWindow);
  const sendStatus = (status: AiModeStatus) => {
    setLastAiModeStatus(status);
    mainWindow.webContents.send('aiMode:status', status);
  };
  const sendNavState = () => {
    const nav = getAiModeNavState();
    sendStatus({ connected: true, ...nav });
  };
  aiModeView.webContents.on('did-finish-load', sendNavState);
  // AI Mode rewrites its own URL without a page load — that is how mtid
  // appears when a thread is opened. Without this the address display would
  // sit on the landing URL forever and look broken.
  aiModeView.webContents.on('did-navigate', sendNavState);
  aiModeView.webContents.on('did-navigate-in-page', sendNavState);
  aiModeView.webContents.on(
    'did-fail-load',
    (_event, _code, errorDescription, _url, isMainFrame) => {
      // did-fail-load fires for any failed resource (ads, trackers, fonts,
      // subframes), not just the page itself — only surface this as a real
      // failure when the main frame is what failed.
      if (!isMainFrame) return;
      sendStatus({ connected: false, error: errorDescription });
    },
  );
};

app.on('ready', () => {
  initDb(app.getPath('userData'));
  // Idempotent, and only when explicitly asked for — lets the tree, the
  // reader and the image path be exercised before the harvester exists.
  if (process.env.NOTEBOOK_DEV_SEED) {
    seedDevData();
  }
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
