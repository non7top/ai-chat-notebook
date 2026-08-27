import { useCallback, useEffect, useState } from 'react';
import type {
  ActivityStats,
  ArchiveProgress,
  SuspectCopyGroup,
  AiModeStatus,
  ChatDetail,
  ChatScope,
  ChatSummary,
  Folder,
  ScopeCounts,
} from '../shared/types';
import ChatList from './ChatList';
import OrphanEntries from './OrphanEntries';
import TakeoutReport, { type TakeoutReportData } from './TakeoutReport';
import SuspectCopies from './SuspectCopies';
import ChatReader from './ChatReader';
import FolderTree from './FolderTree';
import HarvestBar from './HarvestBar';
import PanelBar from './PanelBar';

export default function App() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [counts, setCounts] = useState<ScopeCounts | null>(null);
  const [scope, setScope] = useState<ChatScope>({ kind: 'all' });
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Threads picked for filing. Separate from selectedId, which is the one being
  // READ: gathering a dozen rows about one topic and reading one of them are
  // different acts, and a single piece of state cannot be both.
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [query, setQuery] = useState('');
  const [report, setReport] = useState<TakeoutReportData | null>(null);
  const [copies, setCopies] = useState<SuspectCopyGroup[] | null>(null);
  const [archive, setArchive] = useState<ArchiveProgress | null>(null);

  // Shown as a banner rather than in the toolbar: a backup can be started from
  // the menu with no toolbar in the picture, and the complaint that prompted this
  // was not the wait but having nothing on screen during it.
  useEffect(
    () =>
      window.notebook.onArchiveProgress((progress) =>
        setArchive(progress.phase === 'done' ? null : progress),
      ),
    [],
  );
  const [applying, setApplying] = useState(false);
  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [status, setStatus] = useState<AiModeStatus>({ connected: false });
  const [panelVisible, setPanelVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncaptured, setUncaptured] = useState(0);
  const [activity, setActivity] = useState<ActivityStats | null>(null);

  const reloadFolders = useCallback(async () => {
    setFolders(await window.notebook.listFolders());
    // Loaded with the folders because it labels them, and because every action
    // that changes one changes the other: filing a thread, deleting a folder,
    // finishing an import.
    setCounts(await window.notebook.scopeCounts());
  }, []);

  const reloadChats = useCallback(async () => {
    setChats(await window.notebook.listChats(scope));
  }, [scope]);

  const reloadChat = useCallback(async () => {
    setChat(selectedId === null ? null : await window.notebook.getChat(selectedId));
  }, [selectedId]);

  const reloadUncaptured = useCallback(async () => {
    setUncaptured(await window.notebook.countChatsWithoutTurns());
    setActivity(await window.notebook.activityStats());
    // The menu carries counts in its labels now, and this runs after everything
    // that can change one. Cheap: the template is rebuilt from two index
    // lookups, and this fires on a finished run rather than on every keystroke.
    window.notebook.refreshMenu();
  }, []);

  const reloadAll = useCallback(() => {
    reloadFolders();
    reloadChats();
    reloadChat();
    reloadUncaptured();
  }, [reloadFolders, reloadChats, reloadChat, reloadUncaptured]);

  useEffect(() => {
    reloadFolders();
  }, [reloadFolders]);
  useEffect(() => {
    reloadUncaptured();
  }, [reloadUncaptured]);
  useEffect(() => {
    reloadChats();
  }, [reloadChats]);
  useEffect(() => {
    reloadChat();
  }, [reloadChat]);

  // Anything that fails without being caught reaches the banner instead of the
  // console. Several commands in the control strip used try/finally with no
  // catch, so a failing operation cleared its own busy flag and said nothing —
  // which is indistinguishable from one that did nothing because there was
  // nothing to do. The banner is already here for errors; this is what makes the
  // uncaught ones use it.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      setError(reason instanceof Error ? reason.message : String(reason));
    };
    const onError = (event: ErrorEvent) => setError(event.message);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);

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
      {/* A tab at the top of the pane's right edge, which is the boundary with
          the live panel — the panel is a native view painted alongside this one,
          so that edge is literally where it appears from.

          It was a labelled button in the left strip before, and the strip
          scrolls: showing the panel starts a run, the run's status filled the
          space, and the one control that puts the panel away went behind its own
          fold. A tab on the boundary cannot be pushed anywhere by anything —
          it is not in the flow at all.

          The chevron points the way the app pane will move: left when opening
          the panel (this pane gives up room), right when closing it. */}
      <button
        type="button"
        className="panel-tab"
        onClick={() => setPanelVisible((v) => !v)}
        aria-label={panelVisible ? 'Hide the live AI Mode panel' : 'Show the live AI Mode panel'}
        title={panelVisible ? 'Hide the live AI Mode panel' : 'Show the live AI Mode panel'}
      >
        {panelVisible ? '›' : '‹'}
      </button>
      {archive && (
        <div className="banner">
          {archive.phase === 'database'
            ? 'Backing up the database…'
            : archive.phase === 'counting'
              ? // Two operations report this phase and they count different
                // things — a backup counting image files, and the inline-image
                // repair examining stored turns. The totals say which, so the
                // banner names the work rather than guessing at it.
                archive.total > 0
                ? `Examining stored turns — ${archive.done} of ${archive.total}`
                : 'Counting images…'
              : `Copying images — ${archive.done} of ${archive.total}`}
        </div>
      )}

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
        {/* The left pane is the tree AND the controls, stacked. There used to
            be a horizontal toolbar across the top of the window; a row of
            chrome above three panes of list costs vertical space in the one
            direction this app never has enough of, to hold four buttons in a
            strip a thousand pixels wide. The tree scrolls, the controls stay
            put at the bottom. */}
        <div className="pane pane-tree">
          <div className="tree-scroll">
          <FolderTree
            folders={folders}
            counts={counts}
            scope={scope}
            onScopeChange={(next) => {
              setScope(next);
              setSelectedId(null);
              // Dropped with the scope. A pick made in one folder means nothing
              // in the next, and rows held invisibly across a change of view are
              // exactly what would file the wrong threads.
              setPicked(new Set());
              // Cleared with the scope: a filter left over from the last folder
              // makes the new one look emptier than it is.
              setQuery('');
            }}
            onChange={reloadAll}
            onChatsFiled={() => setPicked(new Set())}
            onError={setError}
          />
          </div>
          <div className="side-actions">
        <HarvestBar
          onReport={(next) => {
          setReport(next);
          // The native panel is a separate window-level view painted over the
          // app, so it would cover the report rather than sit beside it. Hiding
          // it is what makes the space available at all.
          if (next) {
            setPanelVisible(false);
            window.notebook.setAiModeHidden(true);
          }
        }}
          onCopies={(groups) => {
          setCopies(groups);
          // Takes the panes, like the export report: a list of threads to compare
          // needs the width, and the native panel would paint over it.
          setPanelVisible(false);
          window.notebook.setAiModeHidden(true);
        }}
          onNeedPanel={() => setPanelVisible(true)}
          onFinished={reloadAll}
          uncaptured={uncaptured}
          activity={activity}
        />

          </div>
        </div>
        {/* Orphan entries are not conversations, so they get the list and
            reader panes to themselves rather than being forced into a chat
            list that would have to lie about what they are. */}
        {copies ? (
          <div className="pane pane-report">
            <SuspectCopies
              groups={copies}
              onOpenThread={(id) => {
                setSelectedId(id);
                setCopies(null);
              }}
              onClose={() => setCopies(null)}
            />
          </div>
        ) : report ? (
          // Takes the list and reader panes together. The report is prose and a
          // table, and squeezed into a third of the width it would be the same
          // unreadable thing it was in the toolbar.
          <div className="pane pane-report">
            <TakeoutReport
              report={report}
              busy={applying}
              onApply={async () => {
                setApplying(true);
                try {
                  await report.apply();
                } finally {
                  setApplying(false);
                }
              }}
              onClose={() => setReport(null)}
            />
          </div>
        ) : scope.kind === 'orphans' ? (
          <div className="pane pane-orphans">
            <OrphanEntries onChange={reloadAll} onNeedPanel={() => setPanelVisible(true)} />
          </div>
        ) : (
          <>
            <div className="pane pane-list">
              <ChatList
                chats={chats}
                selectedId={selectedId}
                onSelect={setSelectedId}
                picked={picked}
                onPickedChange={setPicked}
                query={query}
                onQueryChange={setQuery}
              />
            </div>
            <div className="pane pane-reader">
              {chat ? (
                <ChatReader chat={chat} onChange={reloadAll} />
              ) : (
                <p className="hint empty">Select a thread to read it.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
