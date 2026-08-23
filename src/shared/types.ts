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
}

/** Which conversations the list pane is showing. */
export type ChatScope =
  | { kind: 'all' }
  | { kind: 'unfiled' }
  /** Raw entries attached to no conversation — not chats, so rendered apart. */
  | { kind: 'orphans' }
  | { kind: 'folder'; id: number };

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

export interface CaptureProgress {
  phase: 'capturing' | 'done' | 'cancelled' | 'error';
  done: number;
  total: number;
  errors: number;
  current?: string;
  stoppedEarly?: string;
  turns?: number;
  images?: number;
  remaining?: number;
  error?: string;
}

export interface CaptureSummary {
  attempted: number;
  captured: number;
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
  /**
   * The date as the export wrote it, present only when it could not be parsed —
   * so an entry with no date says which kind of no-date it is.
   */
  dateText: string | null;
}

export interface TakeoutPreview {
  entries: number;
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
  /** Removes conversations a previous, broken import created; harvested chats survive. */
  undoTakeout(): Promise<{ deleted: number; reverted: number }>;
  /** Re-runs matching. Worth doing after a capture, which adds turns to match against. */
  rematchActivity(): Promise<ActivityMatchResult>;
  activityStats(): Promise<ActivityStats>;

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
  getChat(id: number): Promise<ChatDetail | null>;
  setChatFolder(chatId: number, folderId: number | null): Promise<void>;
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
