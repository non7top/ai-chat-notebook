import { BrowserWindow, dialog, ipcMain } from 'electron';
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
import { importTakeout } from './takeout';
import {
  cancelCapture,
  cancelHarvest,
  captureTurns,
  harvestThreadList,
  recaptureChat,
} from './harvest';
import type { ChatScope } from '../shared/types';

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

  ipcMain.handle('chats:list', (_event, scope: ChatScope) => db.listChats(scope));
  ipcMain.handle('chats:get', (_event, id: number) => db.getChat(id));
  ipcMain.handle('chats:setFolder', (_event, chatId: number, folderId: number | null) =>
    db.setChatFolder(chatId, folderId),
  );
  ipcMain.handle('chats:setTitle', (_event, chatId: number, userTitle: string) =>
    db.setChatTitle(chatId, userTitle),
  );
  ipcMain.handle('chats:delete', (_event, id: number) => db.deleteChat(id));

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

  ipcMain.handle('capture:turns', (_event, limit: number) => captureTurns(limit));
  ipcMain.handle('capture:cancel', () => cancelCapture());
  ipcMain.handle('capture:recapture', (_event, chatId: number) => recaptureChat(chatId));
  ipcMain.handle('capture:remaining', () => db.countChatsWithoutTurns());

  ipcMain.handle('harvest:threadList', () => harvestThreadList());
  ipcMain.handle('harvest:cancel', () => cancelHarvest());

  ipcMain.handle('aiMode:getStatus', () => getLastAiModeStatus());
  ipcMain.handle('aiMode:setHidden', (_event, hidden: boolean) => setAiModeViewHidden(hidden));
  ipcMain.handle('aiMode:navigate', (_event, url: string) => navigateAiMode(url));
  ipcMain.handle('aiMode:back', () => aiModeGoBack());
  ipcMain.handle('aiMode:forward', () => aiModeGoForward());
  ipcMain.handle('aiMode:reload', () => aiModeReload());
}
