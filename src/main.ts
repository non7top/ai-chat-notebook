import { app, BrowserWindow, dialog, Menu } from 'electron';
import path from 'node:path';
import contextMenu from 'electron-context-menu';
import * as db from './main/db';
import { initDb, seedDevData } from './main/db';
import {
  registerIpcHandlers,
  runArchiveExport,
  runArchiveImport,
  setMenuRebuilder,
} from './main/ipc';
import { startCdpProxy } from './main/cdpProxy';
import {
  createAiModeView,
  getAiModeNavState,
  openAiModeDevTools,
  setLastAiModeStatus,
} from './main/aiModeView';
import type { AiModeStatus } from './shared/types';
import { inlineImageLabel, inlineImagesWorthMoving } from './shared/inlineLabel';

// Electron shows no right-click menu anywhere by default (unlike a normal
// browser) — this adds the standard cut/copy/paste/inspect-element menu,
// including inside the embedded AI Mode view.
/**
 * Nothing in the main process fails silently.
 *
 * Electron's default for an uncaught exception is to print it to a console
 * nobody is looking at and, depending on where it happened, carry on in an
 * unknown state. An unhandled rejection is quieter still: with no handler the
 * process logs a warning and continues, so a broken long-running operation looks
 * exactly like one that finished.
 *
 * This app spends most of its time in operations that take minutes against a
 * live third-party page. "It stopped and said nothing" has been the report more
 * than once today, and every time the first job was to work out whether anything
 * had failed at all. Said out loud now, once, with the stack kept.
 */
function reportFatal(kind: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // eslint-disable-next-line no-console
  console.error(`[Notebook] ${kind}:`, detail);
  // A dialog rather than a silent log, because a log in a packaged app is a log
  // nobody reads. Guarded: showErrorBox before the app is ready throws, and a
  // failure in the reporter must not replace the failure being reported.
  try {
    if (app.isReady()) {
      dialog.showErrorBox(
        `AI Chat Notebook — ${kind}`,
        `${detail.slice(0, 1800)}\n\nThe archive is not damaged by this: every write ` +
          'goes through a transaction. Whatever was running has stopped, and can be run again.',
      );
    }
  } catch {
    /* Reporting must never be the thing that takes the app down. */
  }
}

process.on('uncaughtException', (error) => reportFatal('unexpected error', error));
process.on('unhandledRejection', (reason) => reportFatal('unhandled rejection', reason));

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
  //
  // The menu is also where the one-off actions live. The toolbar had grown to
  // eight of them beside the three that get used every day, and a disclosure
  // only hid the problem: refreshing the sidebar list, reading an export,
  // undoing one and the four repair actions are each done once and not thought
  // about again. A menu is what that is for.
  //
  // Each item sends a command NAME to the renderer rather than doing the work
  // here. The handlers already exist there, they report into the toolbar's own
  // status line, and several of them open a panel — none of which the main
  // process can reach. Doing the work here would mean a second implementation
  // of each, reporting into a dialog.
  const command = (name: string) => () => mainWindow.webContents.send('menu:command', name);

  // Rebuilt rather than built once, so the counts in the labels are current.
  // They are the reason those items are findable at all: "Move inline images"
  // says nothing about whether there is anything to move, and 2245 does.
  const buildMenu = () => {
    // Cheap now — both are index lookups. This was a scan of every byte of
    // stored markup until the has_inline flag replaced it, and putting THAT on
    // a menu rebuild would have re-created the ten-second freeze somewhere new.
    const inline = db.countMessagesWithInlineImages();
    const stuck = db.countExhaustedCaptures();
    // What a run would actually attempt. Without it "Read threads from the
    // panel" looked broken: every remaining thread had been given up on, so the
    // run finished instantly having attempted nothing, and the menu said the
    // same thing it says when there are three hundred waiting.
    const queued = db.countChatsWithoutTurns();
    // Threads with an unopened link plus orphan entries with one. The second
    // group was invisible to every bulk path until now — 379 of them.
    const links = db.countEntriesWithLinksToFetch();
    // Empty threads with a content-bearing twin. 37 on the real archive, and the
    // one duplicate case the fingerprint cannot judge because there is no answer
    // text on the empty side to compare.
    const husks = db.emptyDuplicateThreads().length;
    // Threads adopted from a record that already had a thread. 346 of these were
    // made by one link run before it learned to attach rather than adopt.
    const adopted = db.planAdoptedFold().length;
    // Groups that are the same conversation stored twice, settled by the start
    // instant rather than by the prompt alone.
    const sameInstant = db.planPromptInstantFold().reduce((n, g) => n + g.foldIds.length, 0);
    // Two different quantities, and adding them was exactly the mistake this
    // codebase keeps making: `inline` is turns known to hold base64, `unexamined`
    // is turns nobody has looked at yet. Summed, the label read "(23263)" on a
    // real archive that holds 2245 — it was reporting the size of the CHECK as
    // if it were the size of the work, in the wrong unit.
    //
    // So the number is shown only when it is known. While rows remain
    // unexamined it carries a "+", or no number at all when nothing has been
    // counted yet, and the tooltip says how many are still to be looked at. An
    // honest absence beats a confident wrong figure.
    const inlineLabel = inlineImageLabel(inline);

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Archive',
          submenu: [
            {
              // In the menu rather than the toolbar because it is rare and
              // deliberate, and because a backup is not part of the day's work —
              // it is what makes the day's work survivable.
              label: 'Back up to a folder…',
              click: () => {
                // Errors surfaced in a dialog: a menu click has nowhere else to
                // report to, and a backup that silently did nothing is worse than
                // one that failed loudly.
                runArchiveExport().catch((error) =>
                  dialog.showErrorBox('Backup failed', String(error?.message ?? error)),
                );
              },
            },
            {
              label: 'Restore from a backup…',
              click: () => {
                runArchiveImport().catch((error) =>
                  dialog.showErrorBox('Restore failed', String(error?.message ?? error)),
                );
              },
            },
            { type: 'separator' },
            { label: 'Read a Takeout export…', click: command('scanTakeout') },
            {
              label: 'Undo the Takeout import',
              click: command('undoImport'),
            },
          ],
        },
        {
          label: 'Threads',
          submenu: [
            // The steps the two toolbar flows run, each reachable on its own.
            // The flows exist because the ORDER matters and nothing on screen
            // said what it was; that is no reason to take away the ability to
            // run one step when one step is what is wanted.
            {
              label: 'Refresh the list from Google',
              click: command('harvest'),
            },
            {
              label:
                queued > 0
                  ? `Read threads from the panel (${queued})`
                  : 'Read threads from the panel',
              enabled: queued > 0,
              toolTip:
                queued > 0
                  ? `${queued} threads have no turns stored`
                  : stuck > 0
                    ? `Nothing waiting — but ${stuck} threads have been given up on, below`
                    : 'Every listed thread has been read',
              click: command('capture'),
            },
            {
              // The way back to the threads the flows have stopped taking. A
              // deliberate act on purpose: measured on the real archive, these
              // cost two minutes each to fail, so having them back in an
              // automatic run is exactly what this stopped.
              label:
                stuck > 0
                  ? `Retry the threads that gave up (${stuck})`
                  : 'Retry the threads that gave up',
              enabled: stuck > 0,
              click: command('retryStuck'),
            },
            {
              // Named for what it PRODUCES, not for what it does to a browser.
              // "Open the export's links" described the mechanism and read as
              // though it would merely navigate somewhere — the point is that
              // conversations come back into the archive, and it is the same act
              // as the item above it, from a different source. Parallel wording
              // says that; "open" hid it.
              label:
                links > 0
                  ? `Read threads from the export's links (${links})`
                  : "Read threads from the export's links",
              enabled: links > 0,
              toolTip:
                'Loads each record by its Takeout link and stores the conversation — ' +
                'the only route to threads Google no longer lists. Includes records ' +
                'that belong to no thread yet. Every page is checked against the ' +
                "export's own reading before anything is stored.",
              click: command('fetchLinks'),
            },
            {
              label: 'Match entries to threads',
              click: command('matchEntries'),
            },
            { type: 'separator' },
            {
              label: inlineLabel,
              toolTip:
                inline.unexamined > 0
                  ? `${inline.unexamined} turns have not been checked yet — ` +
                    'the first run checks them, then moves what it finds'
                  : 'Moves base64 images out of the stored text into the image store',
              // Enabled while anything is unexamined, because the answer is not
              // yet known — and disabled only when it IS known to be zero. An
              // item that comes and goes is one you cannot learn the place of.
              enabled: inlineImagesWorthMoving(inline),
              click: command('moveInlineImages'),
            },
            { type: 'separator' },
            {
              // Same opening prompt AND same start instant. The prompt alone is
              // ambiguous, which is why grouping is manual — but two separate
              // asks do not land on the same second, and 670 groups in this
              // archive were the same conversation imported twice.
              label:
                sameInstant > 0
                  ? `Fold ${sameInstant} threads imported twice`
                  : 'Fold threads imported twice',
              enabled: sameInstant > 0,
              toolTip:
                'Folds threads that share an opening prompt AND the same start instant — ' +
                'the same conversation stored twice. Keeps the one with a folder or a ' +
                'hand-typed title, else the fullest. Groups that start at DIFFERENT ' +
                'instants are separate asks and are left alone. Undoable.',
              click: command('foldSameInstant'),
            },
            {
              // The recovery for a link run that adopted records into new threads
              // instead of attaching them. Named with its count because the count
              // IS the reason to press it, and greyed out when there is nothing
              // to undo.
              label:
                adopted > 0
                  ? `Fold ${adopted} duplicate${adopted === 1 ? '' : 's'} from the link run`
                  : 'Fold duplicates from the link run',
              enabled: adopted > 0,
              toolTip:
                'Folds threads created by pulling a record whose thread already existed. ' +
                "Moves the pulled reading onto the original where it is fuller, keeps the " +
                'original\'s folder and title, and attaches the record. Undoable.',
              click: command('foldAdopted'),
            },
            {
              label:
                husks > 0
                  ? `Fold ${husks} empty duplicate${husks === 1 ? '' : 's'} into their twin`
                  : 'Fold empty duplicates into their twin',
              enabled: husks > 0,
              toolTip:
                'An empty thread that shares an opening prompt with a thread that has ' +
                'content holds nothing of its own — no turns, no images, no records, no ' +
                'link — so folding it in cannot lose anything. Undoable.',
              click: command('foldEmpty'),
            },
            {
              label: 'Check for identical threads',
              click: command('checkCopies'),
            },
            { label: 'Show link failures', click: command('linkFailures') },
          ],
        },
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
        {
          label: 'Help',
          submenu: [
            {
              // Where a version belongs. It spent a while in the toolbar, which
              // is permanent chrome answering a question asked about once a day
              // — in a window where the scarce thing is vertical space for the
              // archive itself.
              label: 'About AI Chat Notebook',
              click: () => {
                // Everything needed to say WHICH copy of the app this is and
                // where its data lives. The paths are here because they have
                // been guessed wrong before: the README documented an install
                // directory that did not exist, reasoned from productName
                // rather than from an actual install.
                const detail = [
                  `Build: ${__BUILD_ID__}`,
                  __DEBUG_BUILD__
                    ? 'Debug build — remote debugging is ON, and the embedded panel holds a live signed-in Google session.'
                    : 'Release build — remote debugging is off unless asked for explicitly.',
                  '',
                  `Archive: ${path.join(app.getPath('userData'), 'notebook.sqlite')}`,
                  `Images: ${path.join(app.getPath('userData'), 'assets')}`,
                ].join('\n');
                dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  title: 'About AI Chat Notebook',
                  message: 'AI Chat Notebook',
                  detail,
                  buttons: ['Close'],
                });
              },
            },
          ],
        },
      ]),
    );
  };
  buildMenu();
  setMenuRebuilder(buildMenu);

  /**
   * Fills in has_inline for turns stored before the column existed, in the
   * background, once.
   *
   * The flag exists so "how many turns hold base64" is an index lookup instead
   * of a scan of 780MB on the main thread — that scan was the ten seconds of
   * dead window on launch. But a flag nobody has computed answers 0, so until
   * this ran the menu could not name the number at all, and the only thing that
   * would compute it was the repair the number was meant to help you decide
   * about.
   *
   * Deliberately NOT on the startup path. It begins five seconds after the
   * window is up, takes fifty rows at a time, and yields for 50ms between
   * slices — node:sqlite is synchronous, so a slice IS a block, and the size of
   * the slice is the size of the stall. Around two minutes of low-priority work
   * on a real archive, after which the flag is permanent and this never runs
   * again.
   */
  const fillInlineFlags = () => {
    const slice = () => {
      let remaining: number;
      try {
        remaining = db.examineInlineImages(50).remaining;
      } catch {
        // A locked database or a failed read is not worth retrying forever; the
        // repair drains whatever is left when it runs.
        return;
      }
      if (remaining > 0) {
        setTimeout(slice, 50);
        return;
      }
      // Now the count is real, so the label can carry it.
      buildMenu();
      console.log('[Notebook] inline-image flags filled in');
    };
    setTimeout(slice, 5000);
  };
  fillInlineFlags();

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
