import { contextBridge, ipcRenderer } from 'electron';
import type { AiModeStatus, HarvestProgress, NotebookApi } from './shared/types';

const api: NotebookApi = {
  harvestThreadList: () => ipcRenderer.invoke('harvest:threadList'),
  cancelHarvest: () => ipcRenderer.invoke('harvest:cancel'),
  onHarvestProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: HarvestProgress) =>
      callback(progress);
    ipcRenderer.on('harvest:progress', listener);
    return () => ipcRenderer.removeListener('harvest:progress', listener);
  },

  listFolders: () => ipcRenderer.invoke('folders:list'),
  createFolder: (parentId, name) => ipcRenderer.invoke('folders:create', parentId, name),
  renameFolder: (id, name) => ipcRenderer.invoke('folders:rename', id, name),
  moveFolder: (id, newParentId) => ipcRenderer.invoke('folders:move', id, newParentId),
  deleteFolder: (id) => ipcRenderer.invoke('folders:delete', id),

  listChats: (scope) => ipcRenderer.invoke('chats:list', scope),
  getChat: (id) => ipcRenderer.invoke('chats:get', id),
  setChatFolder: (chatId, folderId) => ipcRenderer.invoke('chats:setFolder', chatId, folderId),
  setChatTitle: (chatId, userTitle) => ipcRenderer.invoke('chats:setTitle', chatId, userTitle),
  deleteChat: (id) => ipcRenderer.invoke('chats:delete', id),

  getAiModeStatus: () => ipcRenderer.invoke('aiMode:getStatus'),
  setAiModeHidden: (hidden) => ipcRenderer.invoke('aiMode:setHidden', hidden),
  onAiModeStatus: (callback) => {
    // The view may have already fired its first load event before this
    // subscribes — fetch the cached status once up front so that event isn't
    // missed, then keep listening for future updates.
    ipcRenderer.invoke('aiMode:getStatus').then(callback);

    const listener = (_event: Electron.IpcRendererEvent, status: AiModeStatus) => callback(status);
    ipcRenderer.on('aiMode:status', listener);
    return () => ipcRenderer.removeListener('aiMode:status', listener);
  },
};

contextBridge.exposeInMainWorld('notebook', api);
