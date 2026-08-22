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
  lastSeenAt: string;
  messageCount: number;
  /** Distinct images archived, so an image-heavy conversation is findable. */
  imageCount: number;
  /** Failed capture attempts — distinguishes "failed" from "never tried". */
  captureAttempts: number;
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
export type ChatScope = { kind: 'all' } | { kind: 'unfiled' } | { kind: 'folder'; id: number };

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

export interface NotebookApi {
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
