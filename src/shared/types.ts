export interface AiModeStatus {
  connected: boolean;
  url?: string;
  error?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface Folder {
  id: number;
  parentId: number | null;
  name: string;
  position: number;
  /**
   * A palette key, not a hex value — the app owns the palette so the swatches
   * stay a set that works together and no folder can end up unreadable against
   * the row it marks. Null means unmarked.
   */
  color: string | null;
  /** One glyph, an emoji in practice. Null means none. */
  icon: string | null;
}

export interface ChatSummary {
  id: number;
  folderId: number | null;
  title: string;
  startedAt: string | null;
  /**
   * How startedAt was arrived at, because the dates here are not equally
   * trustworthy: 'takeout' from the export, 'activity' from the activity log,
   * 'placeholder' for the moment the app first stored a conversation nothing
   * can date. Null when there is no date at all.
   */
  dateBasis: string | null;
  lastSeenAt: string;
  messageCount: number;
  /** Distinct images archived, so an image-heavy conversation is findable. */
  imageCount: number;
  /**
   * Rich link previews and source-card thumbnails. Stored like anything else,
   * but counted apart: a conversation with 17 of these and no generated image
   * used to report "17 img", which is not what the reader was being told.
   */
  previewCount: number;
  /**
   * Citations in this thread's own stored reading. Shown beside each entry's
   * count, because the two readings cite differently and at least one link an
   * export kept is no longer on the live page at all.
   */
  linkCount: number;
  /**
   * The conversation's first image, as a relative "assets/..." path, or null.
   * Most of this archive is image generation, so the picture a conversation
   * opened with identifies it far faster than 300 characters of prompt.
   */
  titleImage: string | null;
  /** Failed capture attempts — distinguishes "failed" from "never tried". */
  captureAttempts: number;
  /**
   * Where this came from: 'harvest' (seen in the sidebar list), 'capture'
   * (turns read from the panel), 'takeout' (an export), 'seed' (dev data).
   * Shown in the UI because otherwise a conversation's origin is invisible.
   */
  source: string;
  /**
   * Every source that has contributed, comma-separated — so a conversation
   * imported from Takeout and later extended from the panel says both, rather
   * than only whichever wrote last.
   */
  sources: string;
  /**
   * Turns in the other reading, when both Takeout and the panel described this
   * conversation. Non-zero and different from messageCount means the two
   * disagree, which is worth seeing rather than resolving silently.
   */
  altTurnCount: number;
  /**
   * Export entries folded into this conversation. More than one means
   * successive snapshots were grouped, and seeing the number is how a wrong
   * grouping gets noticed.
   */
  takeoutEntryCount: number;
  /**
   * The folder this thread is in, denormalised onto the row so the list can show
   * where a thread belongs without the reader having to open it. Null when
   * unfiled — which, before any of this, was 2846 of 2848 of them.
   */
  folderName: string | null;
  folderColor: string | null;
  folderIcon: string | null;
}

export interface Message {
  id: number;
  seq: number;
  role: 'user' | 'ai';
  text: string;
  /** Sanitised snapshot, image URLs already local. Null for plain user turns. */
  html: string | null;
}

export interface ChatDetail extends ChatSummary {
  externalId: string;
  url: string | null;
  messages: Message[];
  /**
   * Relative paths of this thread's link previews and source thumbnails.
   *
   * The reader renders stored HTML and cannot tell a preview from a generated
   * image, so they came out at natural size — a thread with thirteen of them
   * read as a column of giant logos with the answer squeezed between. Kept and
   * still shown, just small: they are part of what the answer looked like.
   */
  previewPaths: string[];
  /**
   * Images belonging to the thread but to no particular turn.
   *
   * The export ships them in a cell beside the conversation, so nothing says
   * which exchange they came from. Shown as the thread's own strip rather than
   * guessed into a turn — and shown at all, which they were not: they were
   * stored and counted and never rendered.
   */
  unplacedImagePaths: string[];
}

/** Which conversations the list pane is showing. */
export type ChatScope =
  | { kind: 'all' }
  | { kind: 'unfiled' }
  /**
   * Everything placed in a folder, whichever one. The counterpart to unfiled:
   * a folder answers "what is in this folder", which is not the same question
   * as "what have I organised at all".
   */
  | { kind: 'filed' }
  /** Raw entries attached to no thread — not threads, so rendered apart. */
  | { kind: 'orphans' }
  /**
   * Threads with no turns stored. Harvested from the sidebar but never read, or
   * read and failed. Scattered through the full list they are invisible; as a
   * category they are the capture backlog.
   */
  | { kind: 'empty' }
  | { kind: 'folder'; id: number };

/**
 * How many threads sit behind each row of the tree.
 *
 * Every figure is produced by the same predicate as the query that fills the
 * pane it labels, so a count and its list can never disagree — see scopeCounts.
 */
export interface ScopeCounts {
  all: number;
  unfiled: number;
  filed: number;
  empty: number;
  /** Entries, not threads: the orphan pane lists a different kind of thing. */
  orphans: number;
  /** Threads directly in each folder, by folder id. Subfolders are not included. */
  byFolder: Record<number, number>;
}

export interface HarvestProgress {
  phase: 'scanning' | 'done' | 'cancelled' | 'error';
  found: number;
  /**
   * Approximate total, from the list's pre-sized scroll height divided by row
   * height — so a shortfall is visible. Near but not exact: measured live it
   * gave 301 for a list of 300, so never compare against it with equality.
   */
  expected: number;
  created: number;
  updated: number;
  complete?: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface HarvestSummary {
  found: number;
  expected: number;
  created: number;
  updated: number;
  complete: boolean;
  cancelled: boolean;
}

/**
 * Which step of a run is going, so a long sequence says where it is rather than
 * only how the current step is doing. The step's OWN detail still arrives on
 * harvest:progress and capture:progress — this is the outline over the top.
 */
export interface SyncProgress {
  running: boolean;
  step: string;
  index: number;
  steps: number;
}

export interface CaptureProgress {
  phase: 'capturing' | 'done' | 'cancelled' | 'error';
  done: number;
  total: number;
  errors: number;
  /** Threads Google no longer lists — not failures, and not retryable. */
  unlisted?: number;
  current?: string;
  stoppedEarly?: string;
  turns?: number;
  images?: number;
  remaining?: number;
  error?: string;
}

export interface SyncSummary {
  listed: number;
  captured: number;
  fetched: number;
  matched: number;
  errors: number;
  cancelled: boolean;
  stoppedEarly?: string;
}

export interface CaptureSummary {
  attempted: number;
  captured: number;
  /**
   * Threads Google no longer lists in the sidebar, so the panel cannot open
   * them. Counted apart from errors because nothing is wrong and nothing can be
   * retried — the thread has rotated out of the history and only an export still
   * holds it.
   */
  unlisted: number;
  turns: number;
  images: number;
  errors: number;
  remaining: number;
  cancelled: boolean;
  /** Kept rather than only counted — a bare error count is unactionable. */
  failures: { title: string; reason: string }[];
  /** Set when a run gave up early, e.g. on a run of consecutive failures. */
  stoppedEarly?: string;
}

export interface TakeoutPick {
  folder: string;
  html: string;
  imageFiles: string[];
}

export interface TakeoutImportRow {
  query: string;
  timestamp: string | null;
  /**
   * The date exactly as the export wrote it, kept even when it could not be
   * parsed. A row with no date is otherwise ambiguous between "the export had
   * none" and "we failed to read it", and those need different responses.
   */
  timestampText: string | null;
  href: string | null;
  /**
   * Google's own identifier for this record, from the link's mstk parameter.
   * Unique per cell where present; null for records with no link.
   */
  entryId: string | null;
  /**
   * Three fingerprints at three scopes. `long` is exact identity for the records
   * with no mstk token; `short` covers only the opening exchange, so it spots a
   * thread Google split and continued in a copy; `empty` is the timestamp and
   * image filenames, which for a Lens or blank record is all there is.
   */
  fingerprints: { long: string; short: string; empty: string };
  /** The conversation, split on Google's own "Your prompt:" / "Search's response:" labels. */
  turns: { role: 'user' | 'ai'; text: string; html: string }[];
  imageFiles: string[];
}

export interface TakeoutImportSummary {
  entries: number;
  conversations: number;
  createdChats: number;
  extendedChats: number;
  datedHarvested: number;
  /**
   * Entries whose opening prompt is shared by another entry in the same import.
   * None were matched to an existing conversation — nothing can tell which of
   * them it is — so each stands alone until someone glues them by hand.
   */
  ambiguousOpenings: number;
  /** Wrong groupings from an earlier import that this run repaired. */
  regrouped: number;
  /**
   * Entries carrying date text the parser could not read — a bug here, not a
   * gap in the export, and reported separately so the two are not confused.
   */
  unreadableDates: number;
  turnsWritten: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  matchedToChat: number;
  matchedToTurn: number;
  ambiguous: number;
  orphans: number;
  imagesCopied: number;
  imagesMissing: number;
  /**
   * Images copied but attached to no conversation, because their entry was not
   * placed. Non-zero means the bytes are kept and nothing points at them, which
   * is worth seeing rather than discovering later.
   */
  imagesOrphaned: number;
}

export interface ActivityMatchResult {
  matchedToChat: number;
  matchedToTurn: number;
  ambiguous: number;
  orphans: number;
}

export interface ActivityStats {
  total: number;
  matched: number;
  orphans: number;
  dated: number;
}

export interface SourceEntryView {
  id: number;
  kind: string;
  occurredAt: string | null;
  href: string | null;
  query: string | null;
  turnCount: number;
  imageCount: number;
  linked: boolean;
  /** Conversations this entry is attached to — the link is many-to-many. */
  chatCount: number;
  /** Citations in this entry's stored answer. */
  linkCount: number;
  /**
   * The date as the export wrote it, present only when it could not be parsed —
   * so an entry with no date says which kind of no-date it is.
   */
  dateText: string | null;
  /**
   * Where this entry's images were stored, as relative "assets/..." paths. An
   * orphan entry has no thread to render through, and for a Lens record the
   * image is the whole content.
   */
  imagePaths: string[];
}

export interface TakeoutPreview {
  entries: number;
  /**
   * Conversations those entries describe. The export records one entry per
   * submission, each holding the conversation so far, so this is far smaller
   * than `entries` — and it is the number that means anything.
   */
  conversations: number;
  /** Earlier snapshots folded into a later one instead of becoming conversations. */
  snapshotsFolded: number;
  /**
   * Entries with no opening prompt. Still stored — nothing is dropped — and
   * listed under Orphan entries for review rather than made into conversations.
   */
  wouldOrphan: number;
  /** Already stored by an earlier import of the same export. */
  alreadyKnown: number;
  /** Would attach to a conversation harvested or captured from the panel. */
  wouldEnrich: number;
  /** Would update a conversation an earlier import of this export created. */
  wouldUpdate: number;
  /** Would create a conversation of its own. */
  wouldCreate: number;
  /** Openings shared by several entries, so none of them claim a match. */
  ambiguous: number;
  /** Existing conversations that would be touched. */
  chatsTouched: number;
}

/**
 * Turns still holding base64 images, and how much of the archive that answer
 * has actually looked at.
 */
export interface InlineImageCount {
  inline: number;
  unexamined: number;
}

export interface ArchiveProgress {
  phase: 'database' | 'counting' | 'copying' | 'done';
  done: number;
  total: number;
}

export interface SuspectCopyGroup {
  fingerprint: string;
  chatIds: number[];
  titles: string[];
}

export interface LinkRunSummary {
  attempted: number;
  fetched: number;
  turns: number;
  images: number;
  /** Pages whose answer did not match the export's — a re-run, not the thread. */
  rejected: number;
  errors: number;
  /**
   * Pages that had not rendered their turns in time. Counted apart from errors
   * and left in the queue: each is one slow page load, and treating a run of them
   * as a broken session stopped a 500-thread run after nine.
   */
  notReady: number;
  remaining: number;
  cancelled: boolean;
  failures: { title: string; reason: string }[];
  stoppedEarly?: string;
}

export interface LinkCaptureResult {
  /** How far the page's opening is from the export's reading, 0 to 64. */
  distance: number;
  /** Set when the page did not show the thread the entry describes. */
  rejected: string | null;
  chatId: number | null;
  turns: number;
  images: number;
}

export interface NotebookApi {
  /** Reads the Takeout folder only — nothing is stored until applyTakeout. */
  pickTakeout(): Promise<TakeoutPick | null>;
  /**
   * The sweep: what an import would do, before it does any of it. Reads only,
   * and shares its decision with applyTakeout so it cannot promise a different
   * import from the one that runs.
   */
  previewTakeout(rows: TakeoutImportRow[]): Promise<TakeoutPreview>;
  applyTakeout(folder: string, rows: TakeoutImportRow[]): Promise<TakeoutImportSummary>;
  /**
   * Copies the whole archive — database and images — to a folder of the user's
   * choosing. Returns null if the dialog was cancelled.
   */
  /**
   * Moves that base64 into the asset store and rewrites the HTML. Moves rather
   * than drops: the markup is the only copy of those images.
   */
  repairInlineImages(): Promise<{
    turns: number;
    images: number;
    bytesFreed: number;
    failed: number;
    /** Turns that still hold base64 afterwards — a carrier not yet recognised. */
    stubborn: number;
  }>;
  /** Backup and restore progress. Broadcast, since the menu can start either. */
  onArchiveProgress(callback: (progress: ArchiveProgress) => void): () => void;
  exportArchive(): Promise<{
    folder: string;
    dbBytes: number;
    assetFiles: number;
    assetBytes: number;
  } | null>;
  /**
   * Replaces the archive with a backup, setting aside what it replaces and then
   * quitting. Returns null if cancelled at either prompt.
   */
  importArchive(): Promise<{ movedTo: string } | null>;
  /** Removes conversations a previous, broken import created; harvested chats survive. */
  undoTakeout(): Promise<{ deleted: number; reverted: number }>;
  /** Re-runs matching. Worth doing after a capture, which adds turns to match against. */
  rematchActivity(): Promise<ActivityMatchResult>;
  activityStats(): Promise<ActivityStats>;

  /**
   * Opens a captured citation in the user's own browser. Only http and https —
   * the main process refuses anything else rather than handing the OS a string
   * that might run instead of browse.
   */
  openExternal(url: string): Promise<void>;
  /** file:// base for resolving the relative asset paths in stored HTML. */
  getAssetsBaseUrl(): Promise<string>;
  captureTurns(limit: number): Promise<CaptureSummary>;
  cancelCapture(): Promise<void>;
  /** Re-reads one conversation, discarding what was stored for it. */
  recaptureChat(chatId: number): Promise<{ turns: number; images: number }>;
  onCaptureProgress(callback: (progress: CaptureProgress) => void): () => void;
  countChatsWithoutTurns(): Promise<number>;

  /**
   * Native confirmation dialog. Electron implements confirm() but NOT prompt(),
   * so dialogs go through the main process and names are edited inline.
   */
  confirm(message: string, detail?: string): Promise<boolean>;

  /**
   * The one-off actions live in the application menu, not the toolbar, and this
   * is how a menu click reaches the handler that runs it. Deliberately a command
   * NAME rather than a channel per action: the alternative is one IPC channel,
   * one preload entry and one type per menu item, for eight items that all do
   * the same thing — reach a handler that already exists.
   */
  onMenuCommand(callback: (name: string) => void): () => void;
  /** Rebuilds the menu so the counts in its labels match the archive. */
  refreshMenu(): Promise<void>;
  /**
   * The two flows that pull conversations in. 'new' refreshes the thread list
   * and reads what has no turns; 'all' goes on to the export's links and the
   * match afterwards. Same steps, same order — 'all' just does not stop early.
   */
  syncArchive(mode: 'new' | 'all'): Promise<SyncSummary>;
  cancelSync(): Promise<void>;
  onSyncProgress(callback: (progress: SyncProgress) => void): () => void;
  harvestThreadList(): Promise<HarvestSummary>;
  cancelHarvest(): Promise<void>;
  onHarvestProgress(callback: (progress: HarvestProgress) => void): () => void;

  listFolders(): Promise<Folder[]>;
  createFolder(parentId: number | null, name: string): Promise<Folder>;
  renameFolder(id: number, name: string): Promise<void>;
  /** Rejects a move into the folder's own subtree. */
  moveFolder(id: number, newParentId: number | null): Promise<void>;
  deleteFolder(id: number): Promise<void>;

  listChats(scope: ChatScope): Promise<ChatSummary[]>;
  /** Row counts for the tree, in one call. */
  scopeCounts(): Promise<ScopeCounts>;
  getChat(id: number): Promise<ChatDetail | null>;
  /**
   * Files threads into a folder, or out of every folder when folderId is null.
   * A list, not one id — see setChatsFolder in db.ts for why that is the shape.
   * Resolves to how many rows actually moved.
   */
  setChatsFolder(chatIds: number[], folderId: number | null): Promise<number>;
  /** A folder's colour (a palette key) and icon (one glyph). Either may be null. */
  setFolderStyle(id: number, color: string | null, icon: string | null): Promise<void>;
  setChatTitle(chatId: number, userTitle: string): Promise<void>;
  deleteChat(id: number): Promise<void>;
  /**
   * Opens a conversation in the live panel by clicking its sidebar row.
   * Deliberately not a URL: Takeout links re-run the prompt and constructed
   * mtid links create duplicate conversations.
   */
  openChatInPanel(chatId: number): Promise<void>;
  /** The data entries behind a conversation, plus unlinked candidates. */
  sourceEntries(chatId: number): Promise<SourceEntryView[]>;
  linkSourceEntry(chatId: number, entryId: number): Promise<void>;
  /** Detaches an entry into a conversation of its own, and returns its id. */
  unglueSourceEntry(chatId: number, entryId: number): Promise<{ chatId: number }>;
  /** Entries attached to no conversation — stored but otherwise unreachable. */
  orphanEntries(): Promise<SourceEntryView[]>;
  /** One entry's full stored reading, for review before deciding where it goes. */
  sourceEntryTurns(entryId: number): Promise<Message[]>;
  adoptSourceEntry(entryId: number, folderId: number | null): Promise<{ chatId: number }>;
  /**
   * Opens an entry by its own link in the live panel and captures the thread.
   *
   * The route to the threads the sidebar no longer lists — most of the archive.
   * Rejects the capture when the page's answer diverges from the export's, which
   * is what a re-run prompt looks like, and reports the distance either way.
   */
  captureFromEntryLink(entryId: number): Promise<LinkCaptureResult>;
  /**
   * Works through the threads only an export knows about, opening each by its
   * own link. For most of the archive this is the only route to the real thread,
   * since the sidebar lists a few hundred while the export holds thousands.
   */
  fetchFromLinks(limit: number): Promise<LinkRunSummary>;
  countLinksToFetch(): Promise<number>;
  /**
   * Every thread whose link has been tried and did not simply succeed, with the
   * reason. Exists because a run that stopped left no account of which threads it
   * had reached or how they went.
   */
  linkOutcomes(): Promise<{ chatId: number; title: string; state: string; note: string | null }[]>;
  /**
   * How each long job last ended, surviving a restart.
   *
   * Because "it stopped" and "it finished" looked identical: a progress line that
   * has ceased moving says nothing about which, and the summary died with the run.
   */
  lastJobs(): Promise<
    {
      job: string;
      outcome: string;
      startedAt: string;
      endedAt: string;
      detail: Record<string, unknown>;
    }[]
  >;
  /**
   * Matches stored entries to stored threads after the fact.
   *
   * Deciding during an import decides too early — only the threads that existed
   * then could be considered. Run afterwards, everything is on the table, which
   * is what makes "fetch the threads first, match second" work.
   */
  rematchEntries(): Promise<{
    attached: number;
    considered: number;
    declined: number;
    /** Links an earlier import should have made and did not. */
    relinked: number;
  }>;
  /**
   * Threads holding identical conversations. Detects the damage from a bug where
   * clicking a missing sidebar row silently stored the previously shown thread
   * under a different thread's id.
   */
  suspectCopies(): Promise<SuspectCopyGroup[]>;
  similarChats(chatId: number): Promise<ChatSummary[]>;
  mergeChats(keepId: number, mergeIds: number[]): Promise<{ merged: number }>;
  unmergeChat(chatId: number): Promise<void>;

  getAiModeStatus(): Promise<AiModeStatus>;
  navigateAiMode(url: string): Promise<void>;
  aiModeGoBack(): Promise<void>;
  aiModeGoForward(): Promise<void>;
  aiModeReload(): Promise<void>;
  setAiModeHidden(hidden: boolean): Promise<void>;
  onAiModeStatus(callback: (status: AiModeStatus) => void): () => void;
  /** Fires when the main process reveals the panel because it needed it. */
  onAiModeVisibility(callback: (visible: boolean) => void): () => void;
}
