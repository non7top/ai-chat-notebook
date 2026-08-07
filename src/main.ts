import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import contextMenu from 'electron-context-menu';
import { initDb, seedDevData } from './main/db';
import { registerIpcHandlers } from './main/ipc';
import {
  createAiModeView,
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

function requestedDevtoolsPort(): string | undefined {
  const fromEnv = process.env.NOTEBOOK_REMOTE_DEBUGGING_PORT;
  if (fromEnv) return fromEnv;
  const flag = process.argv.find((arg) => arg.startsWith(DEVTOOLS_PORT_FLAG));
  return flag ? flag.slice(DEVTOOLS_PORT_FLAG.length) : undefined;
}

const devtoolsPort = requestedDevtoolsPort();
if (devtoolsPort) {
  app.commandLine.appendSwitch('remote-debugging-port', devtoolsPort);
  // Since Chromium 111 the CDP WebSocket handshake is rejected outright when
  // it carries an Origin header that isn't allow-listed. Local tools like
  // chrome://inspect send none and work without this; a remote client
  // (including anything proxied through a tunnel) generally does send one,
  // and fails with a bare 403 that gives no hint why.
  app.commandLine.appendSwitch('remote-allow-origins', '*');
  // eslint-disable-next-line no-console
  console.warn(
    `[Notebook] Remote debugging is ON at http://127.0.0.1:${devtoolsPort}/json ` +
      '— this is unauthenticated and the embedded panel holds a live Google ' +
      'session. Do not expose this port beyond a trusted tunnel.',
  );
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });

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
  aiModeView.webContents.on('did-finish-load', () => {
    sendStatus({ connected: true, url: aiModeView.webContents.getURL() });
  });
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
