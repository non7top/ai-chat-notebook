import { useCallback, useEffect, useState } from 'react';
import type { AiModeStatus, ChatDetail, ChatScope, ChatSummary, Folder } from '../shared/types';
import ChatList from './ChatList';
import ChatReader from './ChatReader';
import FolderTree from './FolderTree';
import HarvestBar from './HarvestBar';
import PanelBar from './PanelBar';

export default function App() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [scope, setScope] = useState<ChatScope>({ kind: 'all' });
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [status, setStatus] = useState<AiModeStatus>({ connected: false });
  const [panelVisible, setPanelVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadFolders = useCallback(async () => {
    setFolders(await window.notebook.listFolders());
  }, []);

  const reloadChats = useCallback(async () => {
    setChats(await window.notebook.listChats(scope));
  }, [scope]);

  const reloadChat = useCallback(async () => {
    setChat(selectedId === null ? null : await window.notebook.getChat(selectedId));
  }, [selectedId]);

  const reloadAll = useCallback(() => {
    reloadFolders();
    reloadChats();
    reloadChat();
  }, [reloadFolders, reloadChats, reloadChat]);

  useEffect(() => {
    reloadFolders();
  }, [reloadFolders]);
  useEffect(() => {
    reloadChats();
  }, [reloadChats]);
  useEffect(() => {
    reloadChat();
  }, [reloadChat]);

  useEffect(() => window.notebook.onAiModeStatus(setStatus), []);
  // The main process reveals the panel when an operation needs it, so follow
  // that rather than letting the toggle claim it is hidden while it is visible.
  useEffect(() => window.notebook.onAiModeVisibility(setPanelVisible), []);

  useEffect(() => {
    // #app is static markup in index.html, outside this component's own root,
    // so the split is applied directly rather than through JSX. The native
    // panel is a separate compositor layer positioned by the main process —
    // this only shrinks the app's own pane to leave room for it.
    document.getElementById('app')?.classList.toggle('panel-visible', panelVisible);
    window.notebook.setAiModeHidden(!panelVisible);
  }, [panelVisible]);

  return (
    <div className="workspace">
      <div className="toolbar">
        <h1>AI Chat Notebook</h1>
        <button
          type="button"
          onClick={() => setPanelVisible((v) => !v)}
          title={panelVisible ? 'Hide the live AI Mode panel' : 'Show the live AI Mode panel'}
        >
          {panelVisible ? 'Hide panel' : 'Show panel'}
        </button>
      </div>

      <HarvestBar onNeedPanel={() => setPanelVisible(true)} onFinished={reloadAll} />

      {error && (
        <div className="banner error">
          {error}
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {panelVisible && <PanelBar status={status} />}
      {panelVisible && status.error && (
        <p className="status-line error">AI Mode panel failed to load: {status.error}</p>
      )}

      <div className="panes">
        <div className="pane pane-tree">
          <FolderTree
            folders={folders}
            scope={scope}
            onScopeChange={(next) => {
              setScope(next);
              setSelectedId(null);
            }}
            onChange={reloadAll}
            onError={setError}
          />
        </div>
        <div className="pane pane-list">
          <ChatList chats={chats} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <div className="pane pane-reader">
          {chat ? (
            <ChatReader chat={chat} onChange={reloadAll} />
          ) : (
            <p className="hint empty">Select a conversation to read it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
