import type { ChatScope } from '../shared/types';

/**
 * Where you were last: which scope, and which entry was open.
 *
 * The app forgot both on every restart, so a session began on "All threads" with
 * an empty reader and a scroll position at the top — and with 2868 entries,
 * finding your way back was the first task of every launch.
 *
 * Kept in localStorage rather than in the archive. This is where the window was
 * pointing, not something the archive knows: it is per-machine, it means nothing
 * to a backup, and putting it in the database would make it part of what gets
 * exported and restored.
 *
 * Every access is guarded. localStorage throws outright when site data is
 * blocked, and a stored value can be from an older shape of this type — so a
 * failure to remember must never be a failure to start.
 */
const KEY = 'notebook.lastPlace';

export interface LastPlace {
  scope: ChatScope;
  selectedId: number | null;
}

const DEFAULT: LastPlace = { scope: { kind: 'all' }, selectedId: null };

/** Narrow an unknown stored value, because it may predate the current type. */
function readScope(value: unknown): ChatScope | null {
  if (typeof value !== 'object' || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'all' || kind === 'unfiled' || kind === 'filed' || kind === 'orphans' || kind === 'empty') {
    return { kind };
  }
  if (kind === 'folder') {
    const id = (value as { id?: unknown }).id;
    // A folder that has since been deleted would leave an empty pane with no
    // explanation, so an id that is not a number falls back rather than being
    // trusted. A folder that no longer exists is handled by the list query
    // returning nothing, which reads as an empty folder — acceptable, and rarer
    // than a stale kind.
    if (typeof id === 'number' && Number.isSafeInteger(id)) return { kind: 'folder', id };
  }
  return null;
}

export function loadLastPlace(): LastPlace {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT;
    const scope = readScope((parsed as { scope?: unknown }).scope);
    const rawId = (parsed as { selectedId?: unknown }).selectedId;
    return {
      scope: scope ?? DEFAULT.scope,
      selectedId: typeof rawId === 'number' && Number.isSafeInteger(rawId) ? rawId : null,
    };
  } catch {
    return DEFAULT;
  }
}

export function saveLastPlace(place: LastPlace): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(place));
  } catch {
    /* Site data blocked, or full. Forgetting where you were is not worth an error. */
  }
}
