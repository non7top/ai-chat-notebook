import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiModeStatus,
  ArchiveProgress,
  CaptureProgress,
  HarvestProgress,
  NotebookApi,
  SyncProgress,
} from './shared/types';

const api: NotebookApi = {
  confirm: (message, detail) => ipcRenderer.invoke('ui:confirm', message, detail),

  pickTakeout: () => ipcRenderer.invoke('takeout:pick'),
  applyTakeout: (folder, rows) => ipcRenderer.invoke('takeout:apply', folder, rows),
  previewTakeout: (rows) => ipcRenderer.invoke('takeout:preview', rows),
  onArchiveProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ArchiveProgress) =>
      callback(progress);
    ipcRenderer.on('archive:progress', listener);
    return () => ipcRenderer.removeListener('archive:progress', listener);
  },
  repairInlineImages: () => ipcRenderer.invoke('archive:repairInlineImages'),
  exportArchive: () => ipcRenderer.invoke('archive:export'),
  importArchive: () => ipcRenderer.invoke('archive:import'),
  undoTakeout: () => ipcRenderer.invoke('takeout:undo'),
  rematchActivity: () => ipcRenderer.invoke('takeout:rematch'),
  activityStats: () => ipcRenderer.invoke('takeout:stats'),
  getAssetsBaseUrl: () => ipcRenderer.invoke('assets:baseUrl'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  captureTurns: (limit, includeExhausted) =>
    ipcRenderer.invoke('capture:turns', limit, includeExhausted),
  countExhaustedCaptures: () => ipcRenderer.invoke('capture:exhausted'),
  cancelCapture: () => ipcRenderer.invoke('capture:cancel'),
  recaptureChat: (chatId) => ipcRenderer.invoke('capture:recapture', chatId),
  recaptureMany: (chatIds) => ipcRenderer.invoke('capture:recaptureMany', chatIds),
  rereadAllFromThreads: (limit) => ipcRenderer.invoke('capture:rereadAll', limit),
  recoverTakeoutLinks: () => ipcRenderer.invoke('links:recover'),
  countChatsWithoutTurns: () => ipcRenderer.invoke('capture:remaining'),
  onCaptureProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: CaptureProgress) =>
      callback(progress);
    ipcRenderer.on('capture:progress', listener);
    return () => ipcRenderer.removeListener('capture:progress', listener);
  },

  onMenuCommand: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, name: string) => callback(name);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
  refreshMenu: () => ipcRenderer.invoke('menu:refresh'),

  syncArchive: (mode) => ipcRenderer.invoke('sync:run', mode),
  cancelSync: () => ipcRenderer.invoke('sync:cancel'),
  onSyncProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SyncProgress) =>
      callback(progress);
    ipcRenderer.on('sync:progress', listener);
    return () => ipcRenderer.removeListener('sync:progress', listener);
  },
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
  scopeCounts: () => ipcRenderer.invoke('chats:counts'),
  getChat: (id) => ipcRenderer.invoke('chats:get', id),
  setChatsFolder: (chatIds, folderId) => ipcRenderer.invoke('chats:setFolder', chatIds, folderId),
  setFolderStyle: (id, color, icon) => ipcRenderer.invoke('folders:style', id, color, icon),
  setChatTitle: (chatId, userTitle) => ipcRenderer.invoke('chats:setTitle', chatId, userTitle),
  deleteChat: (id) => ipcRenderer.invoke('chats:delete', id),
  openChatInPanel: (chatId) => ipcRenderer.invoke('chats:openInPanel', chatId),
  sourceEntries: (chatId) => ipcRenderer.invoke('chats:sourceEntries', chatId),
  linkSourceEntry: (chatId, entryId) => ipcRenderer.invoke('chats:linkSource', chatId, entryId),
  unglueSourceEntry: (chatId, entryId) =>
    ipcRenderer.invoke('chats:unglueSource', chatId, entryId),
  orphanEntries: () => ipcRenderer.invoke('entries:orphans'),
  sourceEntryTurns: (entryId) => ipcRenderer.invoke('entries:turns', entryId),
  adoptSourceEntry: (entryId, folderId) =>
    ipcRenderer.invoke('entries:adopt', entryId, folderId),
  captureFromEntryLink: (entryId) => ipcRenderer.invoke('entries:openLink', entryId),
  fetchFromLinks: (limit) => ipcRenderer.invoke('links:fetch', limit),
  countLinksToFetch: () => ipcRenderer.invoke('links:remaining'),
  linkOutcomes: () => ipcRenderer.invoke('links:outcomes'),
  lastJobs: () => ipcRenderer.invoke('jobs:last'),
  rematchEntries: () => ipcRenderer.invoke('entries:rematch'),
  suspectCopies: () => ipcRenderer.invoke('chats:suspectCopies'),
  similarChats: (chatId) => ipcRenderer.invoke('chats:similar', chatId),
  mergeChats: (keepId, mergeIds) => ipcRenderer.invoke('chats:merge', keepId, mergeIds),
  unmergeChat: (chatId) => ipcRenderer.invoke('chats:unmerge', chatId),
  foldEmptyDuplicates: () => ipcRenderer.invoke('chats:foldEmpty'),
  foldAdoptedDuplicates: () => ipcRenderer.invoke('chats:foldAdopted'),
  foldSameInstantDuplicates: () => ipcRenderer.invoke('chats:foldSameInstant'),

  getAiModeStatus: () => ipcRenderer.invoke('aiMode:getStatus'),
  navigateAiMode: (url) => ipcRenderer.invoke('aiMode:navigate', url),
  aiModeGoBack: () => ipcRenderer.invoke('aiMode:back'),
  aiModeGoForward: () => ipcRenderer.invoke('aiMode:forward'),
  aiModeReload: () => ipcRenderer.invoke('aiMode:reload'),
  setAiModeHidden: (hidden) => ipcRenderer.invoke('aiMode:setHidden', hidden),
  onAiModeVisibility: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
    ipcRenderer.on('aiMode:visibility', listener);
    return () => ipcRenderer.removeListener('aiMode:visibility', listener);
  },
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
