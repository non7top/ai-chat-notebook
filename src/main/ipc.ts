import { ipcMain } from 'electron';
import * as db from './db';
import { getLastAiModeStatus, setAiModeViewHidden } from './aiModeView';
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

  ipcMain.handle('aiMode:getStatus', () => getLastAiModeStatus());
  ipcMain.handle('aiMode:setHidden', (_event, hidden: boolean) => setAiModeViewHidden(hidden));
}
