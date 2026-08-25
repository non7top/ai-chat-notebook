import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';
import {
  aiModeGoBack,
  aiModeGoForward,
  aiModeReload,
  getLastAiModeStatus,
  navigateAiMode,
  setAiModeViewHidden,
} from './aiModeView';
import { importTakeout, rematchActivity } from './takeout';
import {
  cancelCapture,
  cancelHarvest,
  captureTurns,
  harvestThreadList,
  captureFromEntryLink,
  fetchFromLinks,
  openChatInPanel,
  repairInlineImages,
  recaptureChat,
  syncArchive,
  cancelSync,
} from './harvest';
import type { ChatScope } from '../shared/types';

/**
 * Set by main once the window and its menu exist. A function rather than an
 * import because the template closes over the window it sends commands to, and
 * that window is created after this module is loaded.
 */
let rebuildMenu: (() => void) | null = null;

export function setMenuRebuilder(rebuild: () => void): void {
  rebuildMenu = rebuild;
}

export function registerIpcHandlers(): void {
  ipcMain.handle('folders:list', () => db.listFolders());
  ipcMain.handle('folders:create', (_event, parentId: number | null, name: string) =>
    db.createFolder(parentId, name),
  );
  ipcMain.handle('folders:rename', (_event, id: number, name: string) =>
    db.renameFolder(id, name),
  );
  // Lets the cycle guard's error reach the renderer as a rejected promise, so
  // an illegal drop surfaces to the user instead of failing silently.
  ipcMain.handle('folders:move', (_event, id: number, newParentId: number | null) =>
    db.moveFolder(id, newParentId),
  );
  ipcMain.handle('folders:delete', (_event, id: number) => db.deleteFolder(id));
  ipcMain.handle(
    'folders:style',
    (_event, id: number, color: string | null, icon: string | null) =>
      db.setFolderStyle(id, color, icon),
  );

  ipcMain.handle('chats:list', (_event, scope: ChatScope) => db.listChats(scope));
  ipcMain.handle('chats:counts', () => db.scopeCounts());
  // The menu's labels carry counts, and a count is only worth having if it is
  // current. Rebuilding is main's job — the template lives there — so the
  // renderer asks rather than rebuilds.
  ipcMain.handle('menu:refresh', () => rebuildMenu?.());
  ipcMain.handle('chats:get', (_event, id: number) => db.getChat(id));
  ipcMain.handle('chats:setFolder', (_event, chatIds: number[], folderId: number | null) =>
    db.setChatsFolder(chatIds, folderId),
  );
  ipcMain.handle('chats:setTitle', (_event, chatId: number, userTitle: string) =>
    db.setChatTitle(chatId, userTitle),
  );
  ipcMain.handle('chats:delete', (_event, id: number) => db.deleteChat(id));
  ipcMain.handle('chats:openInPanel', (_event, id: number) => openChatInPanel(id));
  ipcMain.handle('chats:sourceEntries', (_event, id: number) => db.sourceEntriesForChat(id));
  ipcMain.handle('chats:linkSource', (_event, chatId: number, entryId: number) =>
    db.linkSourceEntry(chatId, entryId),
  );
  ipcMain.handle('chats:unglueSource', (_event, chatId: number, entryId: number) =>
    db.unglueSourceEntry(chatId, entryId),
  );
  ipcMain.handle('entries:orphans', () => db.orphanSourceEntries());
  ipcMain.handle('entries:turns', (_event, entryId: number) => db.sourceEntryTurns(entryId));
  ipcMain.handle('entries:adopt', (_event, entryId: number, folderId: number | null) =>
    db.adoptSourceEntry(entryId, folderId),
  );
  // Navigates the live panel, so it needs the panel on screen — and it is the one
  // route with a history of doing harm if the link re-runs rather than opens.
  // captureFromEntryLink checks the page against the export's own reading before
  // storing anything; see the note on it.
  ipcMain.handle('entries:openLink', (_event, entryId: number) => captureFromEntryLink(entryId));
  ipcMain.handle('chats:suspectCopies', () => db.suspectCopies());
  ipcMain.handle('chats:similar', (_event, id: number) => db.similarChats(id));
  ipcMain.handle('chats:merge', (_event, keepId: number, mergeIds: number[]) =>
    db.mergeChats(keepId, mergeIds),
  );
  ipcMain.handle('chats:unmerge', (_event, id: number) => db.unmergeChat(id));

  // Routed through the main process rather than window.confirm. Electron does
  // support confirm(), but it does NOT support prompt() — that threw
  // "prompt() is not supported." out of the folder-create handler and made the
  // whole tree unusable. Keeping both confirmations and names off the window
  // dialogs entirely removes that class of surprise.
  ipcMain.handle('ui:confirm', async (_event, message: string, detail?: string) => {
    const window = BrowserWindow.getFocusedWindow();
    const options = {
      type: 'question' as const,
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      message,
      detail,
    };
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    return response === 1;
  });

  // Stored HTML holds relative "assets/<sha>.png" paths so the archive survives
  // being moved. The renderer loads from inside the app bundle, so a relative
  // path there would resolve against the bundle and every image would break —
  // it needs the real base to resolve against at read time.
  /**
   * Opens a captured citation in the user's own browser.
   *
   * Answers carry real sources — one measured answer cited 37 links — and until
   * now every one of them was inert: the reader swallows clicks to stop a link
   * navigating the app's own window away from the app, which leaves the archive
   * with no way out to a source.
   *
   * The scheme is checked here rather than trusted from the renderer. This hands
   * a string to the operating system's URL handler, and file: or a custom scheme
   * would be handing it something that runs rather than something that browses.
   */
  ipcMain.handle('shell:open', async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`Refusing to open ${url.slice(0, 40)} — only http and https.`);
    }
    await shell.openExternal(url);
  });

  ipcMain.handle('assets:baseUrl', () => `${pathToFileURL(db.getAssetsDir()).href}/`);

  // Takeout import is split in two so the parse is verifiable before anything
  // is written: 'pick' only reads the folder, 'apply' stores what the renderer
  // parsed from it.
  ipcMain.handle('takeout:pick', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = {
      title: 'Select the Takeout "My Activity/AI Mode" folder',
      properties: ['openDirectory'],
    };
    const { canceled, filePaths } = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (canceled || filePaths.length === 0) return null;

    const folder = filePaths[0];
    const names = fs.readdirSync(folder);
    const htmlName = names.find((n) => /MyActivity\.html?$/i.test(n));
    if (!htmlName) {
      throw new Error(`No MyActivity.html in ${folder}. Pick the "AI Mode" folder itself.`);
    }
    return {
      folder,
      html: fs.readFileSync(path.join(folder, htmlName), 'utf8'),
      // Local images sit beside the HTML, so nothing is fetched.
      imageFiles: names.filter((n) => /\.(jpe?g|png|webp|gif)$/i.test(n)),
    };
  });

  ipcMain.handle(
    'takeout:apply',
    (_event, folder: string, rows: db.TakeoutImportRow[]) => importTakeout(folder, rows),
  );

  // Reads only. Deliberately a separate call from 'apply' so the sweep can be
  // run and read before anything is written.
  ipcMain.handle('takeout:preview', (_event, rows: db.TakeoutImportRow[]) =>
    db.previewTakeoutImport(rows),
  );
  // Backing the archive up is the point of the archive. The source is a cloud
  // history that prunes and rewrites itself, so a copy that cannot leave the app
  // is one more single point of failure rather than a defence against one.
  ipcMain.handle('archive:export', () => runArchiveExport());
  ipcMain.handle('archive:import', () => runArchiveImport());

  ipcMain.handle('takeout:undo', () => db.undoTakeoutImport());
  ipcMain.handle('takeout:rematch', () => rematchActivity());
  ipcMain.handle('takeout:stats', () => db.activityStats());

  ipcMain.handle('capture:turns', (_event, limit: number, includeExhausted?: boolean) =>
    captureTurns(limit, includeExhausted ?? false),
  );
  ipcMain.handle('capture:cancel', () => cancelCapture());
  ipcMain.handle('capture:recapture', (_event, chatId: number) => recaptureChat(chatId));
  ipcMain.handle('capture:remaining', () => db.countChatsWithoutTurns());
  ipcMain.handle('capture:exhausted', () => db.countExhaustedCaptures());
  // The route to everything Google has rotated out of the sidebar. Drives the
  // live panel one page load at a time, and every page is checked against the
  // export's own reading before anything is stored.
  ipcMain.handle('links:fetch', (_event, limit: number) => fetchFromLinks(limit));
  ipcMain.handle('links:remaining', () => db.countThreadsWithLinksToFetch());
  ipcMain.handle('links:outcomes', () => db.linkOutcomes());
  ipcMain.handle('jobs:last', () => db.lastJobs());
  // Matching after the fact rather than during an import: only then is every
  // thread and every entry on the table at once.
  ipcMain.handle('entries:rematch', () => db.rematchEntriesToThreads());
  // Maintenance on an archive written before capture stopped keeping base64.
  // Reports through the archive channel, since it is minutes of work on
  // megabyte-sized rows.
  ipcMain.handle('archive:repairInlineImages', () =>
    repairInlineImages((done, total, phase) =>
      announceArchiveProgress({ phase: phase ?? 'copying', done, total }),
    ),
  );

  // The two flows. Everything they call is still reachable on its own from the
  // Threads menu — this is the order those steps have to go in, made pressable.
  ipcMain.handle('sync:run', (_event, mode: 'new' | 'all') => syncArchive(mode));
  ipcMain.handle('sync:cancel', () => cancelSync());
  ipcMain.handle('harvest:threadList', () => harvestThreadList());
  ipcMain.handle('harvest:cancel', () => cancelHarvest());

  ipcMain.handle('aiMode:getStatus', () => getLastAiModeStatus());
  ipcMain.handle('aiMode:setHidden', (_event, hidden: boolean) => setAiModeViewHidden(hidden));
  ipcMain.handle('aiMode:navigate', (_event, url: string) => navigateAiMode(url));
  ipcMain.handle('aiMode:back', () => aiModeGoBack());
  ipcMain.handle('aiMode:forward', () => aiModeGoForward());
  ipcMain.handle('aiMode:reload', () => aiModeReload());
}

export async function runArchiveExport() {
  const window = BrowserWindow.getFocusedWindow();
  const options: Electron.OpenDialogOptions = {
    title: 'Choose an empty folder for the backup',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Back up here',
  };
  const { canceled, filePaths } = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (canceled || filePaths.length === 0) return null;
  // Awaited, and the progress callback passed. Neither happened before: the
  // spread of an un-awaited Promise type-checks and yields none of its fields, so
  // the handler returned an empty result the moment the dialog closed while the
  // copy carried on unobserved — which is precisely the "no progress" this was
  // supposed to fix.
  const result = await db.exportArchive(filePaths[0], announceArchiveProgress);
  return { folder: filePaths[0], ...result };
}

/**
 * Tells every window how a long archive operation is getting on.
 *
 * Broadcast rather than returned, because the menu starts these with no renderer
 * involved — and because the complaint that prompted it was not the wait but the
 * silence during it.
 */
function announceArchiveProgress(progress: db.ArchiveProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('archive:progress', progress);
  }
}

// Confirmed twice on purpose. A restore is the one action here that can destroy
// more than it repairs, and the person reaching for it is already having a bad
// day. What it replaces is moved aside rather than deleted.
export async function runArchiveImport() {
  const window = BrowserWindow.getFocusedWindow();
  const options: Electron.OpenDialogOptions = {
    title: 'Choose a backup folder to restore',
    properties: ['openDirectory'],
    buttonLabel: 'Restore this',
  };
  const { canceled, filePaths } = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (canceled || filePaths.length === 0) return null;

  const confirmOptions = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Replace the archive'],
    defaultId: 0,
    cancelId: 1,
    message: 'Replace everything in this app with that backup?',
    detail:
      'Every thread, folder and image currently stored is set aside into a dated ' +
      'folder and the backup takes its place. The app closes afterwards and must ' +
      'be started again.',
  };
  const { response } = window
    ? await dialog.showMessageBox(window, confirmOptions)
    : await dialog.showMessageBox(confirmOptions);
  if (response !== 1) return null;

  const result = await db.importArchive(
    filePaths[0],
    app.getPath('userData'),
    announceArchiveProgress,
  );
  // Quit rather than reopening in place. The database handle is closed and
  // every window is showing rows from the archive that was just replaced;
  // restarting is the only state that is certainly consistent.
  setTimeout(() => app.quit(), 250);
  return result;
}
