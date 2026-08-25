import { useMemo, useState } from 'react';
import type { ChatScope, Folder, ScopeCounts } from '../shared/types';

interface Props {
  folders: Folder[];
  /**
   * How many threads sit behind each row. Null until the first load, and the
   * rows render without numbers rather than with zeroes — a confident 0 beside
   * a folder that holds forty is the kind of wrong number that gets believed.
   */
  counts: ScopeCounts | null;
  scope: ChatScope;
  onScopeChange: (scope: ChatScope) => void;
  onChange: () => void;
  /** Called after threads land in a folder, so the pick can be let go of. */
  onChatsFiled: () => void;
  onError: (message: string) => void;
}

type DragPayload =
  | { kind: 'folder'; id: number }
  // A LIST, even for one thread. A single-id shape alongside a multi-id one is
  // two code paths for the same drop, and the one used less often is the one
  // that rots.
  | { kind: 'chats'; ids: number[] };

// Naming is done with an inline input rather than window.prompt, which Electron
// does not implement at all: calling it throws "prompt() is not supported."
// straight out of the click handler, so creating or renaming a folder failed
// silently and nothing could be filed anywhere.
type Editing =
  | { kind: 'root-new' }
  | { kind: 'child-new'; parentId: number }
  | { kind: 'rename'; id: number; current: string }
  | { kind: 'style'; id: number }
  | null;

// Mirrors FOLDER_COLORS in db.ts, which validates against the same list before
// storing. Duplicated rather than imported because db.ts is main-process code
// that pulls in node:sqlite — and the ORDER here is the swatch order, which is a
// presentation decision that does not belong in the schema.
const COLORS = ['slate', 'red', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'] as const;

function childrenOf(folders: Folder[], parentId: number | null): Folder[] {
  return folders.filter((folder) => folder.parentId === parentId);
}

function sameScope(a: ChatScope, b: ChatScope): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'folder' || b.kind !== 'folder' || a.id === b.id;
}

function NameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onCommit(trimmed);
    } else {
      onCancel();
    }
  };
  return (
    <input
      className="name-input"
      // Focused on appearance: the field only exists because the user just
      // asked to name something.
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onCancel();
      }}
      // Committing on blur rather than discarding: losing a typed name to a
      // stray click is worse than creating a folder that can be renamed.
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/**
 * A count, or nothing at all while the numbers are still loading.
 *
 * Rendered by the tree rather than folded into the name so it can be styled
 * apart and, more to the point, so a missing count is a missing element rather
 * than a zero.
 */
function Count({ n, title }: { n: number | undefined; title?: string }) {
  if (n === undefined) return null;
  return (
    <span className={n === 0 ? 'tree-count zero' : 'tree-count'} title={title}>
      {n}
    </span>
  );
}

export default function FolderTree({
  folders,
  counts,
  scope,
  onScopeChange,
  onChange,
  onChatsFiled,
  onError,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [dropTarget, setDropTarget] = useState<number | null | 'none'>('none');
  const [editing, setEditing] = useState<Editing>(null);

  const roots = useMemo(() => childrenOf(folders, null), [folders]);

  // Threads in a folder AND everything under it. Computed here rather than in
  // SQL because the renderer already has the whole tree and a recursive CTE for
  // a few dozen folders would be work for its own sake. Without it a collapsed
  // parent reads 0 while holding hundreds in its children, which is exactly the
  // moment a number stops being trusted.
  const subtree = useMemo(() => {
    const totals: Record<number, number> = {};
    const walk = (id: number): number => {
      let sum = counts?.byFolder[id] ?? 0;
      for (const kid of childrenOf(folders, id)) sum += walk(kid.id);
      totals[id] = sum;
      return sum;
    };
    for (const root of childrenOf(folders, null)) walk(root.id);
    return totals;
  }, [folders, counts]);

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = (work: Promise<unknown>) => {
    work
      .then(() => {
        setEditing(null);
        onChange();
      })
      .catch((err: unknown) => {
        setEditing(null);
        onError(err instanceof Error ? err.message : String(err));
      });
  };

  const readPayload = (event: React.DragEvent): DragPayload | null => {
    try {
      return JSON.parse(event.dataTransfer.getData('application/json')) as DragPayload;
    } catch {
      return null;
    }
  };

  // One handler for both kinds of drop: folders reparent, chats refile.
  // targetId null means Unfiled.
  const handleDrop = (event: React.DragEvent, targetId: number | null) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget('none');
    const payload = readPayload(event);
    if (!payload) return;
    if (payload.kind === 'folder') {
      if (payload.id === targetId) return;
      // The main process rejects a move into the folder's own subtree; that
      // rejection has to surface, or the drop just appears to do nothing.
      run(window.notebook.moveFolder(payload.id, targetId));
    } else {
      run(
        window.notebook.setChatsFolder(payload.ids, targetId).then(() => {
          // Cleared once they have landed, not before: a pick that survives its
          // own drop invites dropping it again somewhere else, and the rows have
          // already moved out from under it.
          onChatsFiled();
        }),
      );
    }
  };

  const deleteFolder = async (folder: Folder) => {
    const ok = await window.notebook.confirm(
      `Delete folder "${folder.name}"?`,
      'Conversations inside it are kept and become Unfiled.',
    );
    if (ok) run(window.notebook.deleteFolder(folder.id));
  };

  const renderFolder = (folder: Folder, depth: number) => {
    const kids = childrenOf(folders, folder.id);
    const isCollapsed = collapsed.has(folder.id);
    const isSelected = sameScope(scope, { kind: 'folder', id: folder.id });
    const renaming = editing?.kind === 'rename' && editing.id === folder.id;

    return (
      <div key={folder.id}>
        {/* Rows are click/drag targets; the per-row actions inside them are
            real buttons and remain keyboard-reachable. A properly
            keyboard-navigable treeview is a separate job. */}
        <div
          className={`tree-row${isSelected ? ' selected' : ''}${
            dropTarget === folder.id ? ' drop-target' : ''
          }`}
          style={{ paddingLeft: `${depth * 14 + 4}px` }}
          draggable={!renaming}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.setData(
              'application/json',
              JSON.stringify({ kind: 'folder', id: folder.id } satisfies DragPayload),
            );
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDropTarget(folder.id);
          }}
          onDragLeave={() => setDropTarget('none')}
          onDrop={(event) => handleDrop(event, folder.id)}
          onClick={() => onScopeChange({ kind: 'folder', id: folder.id })}
        >
          <button
            type="button"
            className="twisty"
            disabled={kids.length === 0}
            onClick={(event) => {
              event.stopPropagation();
              toggle(folder.id);
            }}
          >
            {kids.length === 0 ? '·' : isCollapsed ? '▸' : '▾'}
          </button>

          {renaming ? (
            <NameInput
              initial={folder.name}
              placeholder="Folder name"
              onCommit={(name) => run(window.notebook.renameFolder(folder.id, name))}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <>
              {/* The folder's own mark, shown where the folder is. A colour
                  set here and visible only on the threads would be a setting
                  with no visible subject. */}
              <span className={`folder-mark${folder.color ? ` c-${folder.color}` : ''}`}>
                {folder.icon ?? ''}
              </span>
              <span className={`tree-name${folder.color ? ` c-${folder.color}` : ''}`}>
                {folder.name}
              </span>
              {/* ONE number, not two. Two of them plus a mark plus four action
                  buttons left 49px for the folder's name in a 220px pane —
                  measured — so "pepperdoll" rendered as "pepp…". A collapsed
                  parent shows its subtree total, because that is the number
                  that matters when its children are hidden; expanded, it shows
                  its own, because the children are showing theirs. */}
              <Count
                n={
                  counts
                    ? isCollapsed && subtree[folder.id] > (counts.byFolder[folder.id] ?? 0)
                      ? subtree[folder.id]
                      : (counts.byFolder[folder.id] ?? 0)
                    : undefined
                }
                title={
                  isCollapsed && counts && subtree[folder.id] > (counts.byFolder[folder.id] ?? 0)
                    ? `${subtree[folder.id]} including subfolders — ${counts.byFolder[folder.id] ?? 0} directly in this one`
                    : 'Threads in this folder'
                }
              />
              {/* Out of the flow entirely. visibility: hidden still RESERVES the
                  space, so four buttons cost ~72px of every row whether or not
                  anyone was hovering — in a 220px pane that is a third of it
                  spent on controls that were not visible. They now sit over the
                  right end of the row when it is hovered. */}
              <span className="row-actions">
              <button
                type="button"
                className="row-action"
                title="Rename folder"
                onClick={(event) => {
                  event.stopPropagation();
                  setEditing({ kind: 'rename', id: folder.id, current: folder.name });
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className="row-action"
                title="New subfolder"
                onClick={(event) => {
                  event.stopPropagation();
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    next.delete(folder.id);
                    return next;
                  });
                  setEditing({ kind: 'child-new', parentId: folder.id });
                }}
              >
                ＋
              </button>
              <button
                type="button"
                className="row-action"
                title="Colour and icon"
                onClick={(event) => {
                  event.stopPropagation();
                  setEditing({ kind: 'style', id: folder.id });
                }}
              >
                ◐
              </button>
              <button
                type="button"
                className="row-action"
                title="Delete folder (threads inside become Unfiled)"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteFolder(folder);
                }}
              >
                ✕
              </button>
              </span>
            </>
          )}
        </div>

        {/* Under the row rather than over it: a popover floating above a tree
            that scrolls is a popover that ends up somewhere else, and this one
            has to stay next to the folder it is changing.

            Everything here commits on the spot and the row above updates as it
            does, so there is no OK button — because there is nothing to confirm.
            The first version had an icon field that saved on blur, which is the
            same thing without the feedback: it looked like a form nobody had
            told you how to submit. */}
        {editing?.kind === 'style' && editing.id === folder.id && (
          <div className="style-picker" style={{ marginLeft: `${(depth + 1) * 14 + 4}px` }}>
            <span className="picker-label">Colour</span>
            {COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`swatch c-${color}${folder.color === color ? ' chosen' : ''}`}
                title={color}
                onClick={() => run(window.notebook.setFolderStyle(folder.id, color, folder.icon))}
              />
            ))}
            <button
              type="button"
              className="swatch none"
              title="No colour"
              onClick={() => run(window.notebook.setFolderStyle(folder.id, null, folder.icon))}
            >
              ✕
            </button>

            <span className="picker-label">Icon</span>
            {/* A handful to click, because the useful case is one of these and
                nobody should have to know that Win+period opens an emoji
                picker. The field beside them takes anything else. */}
            {['📌', '⭐', '💡', '🔧', '📷', '🎨', '💬', '📁'].map((icon) => (
              <button
                key={icon}
                type="button"
                className={`icon-choice${folder.icon === icon ? ' chosen' : ''}`}
                onClick={() => run(window.notebook.setFolderStyle(folder.id, folder.color, icon))}
              >
                {icon}
              </button>
            ))}
            <input
              className="icon-input"
              defaultValue={folder.icon ?? ''}
              placeholder="or…"
              maxLength={4}
              title="Any emoji — saves as you type. Win+. opens the picker."
              // Saves on every keystroke, which is what makes it obvious that it
              // saves at all: the folder above changes under the cursor. An
              // emoji arrives as one paste or one pick, so there is no
              // half-typed state to protect against.
              onChange={(event) =>
                run(
                  window.notebook.setFolderStyle(
                    folder.id,
                    folder.color,
                    event.currentTarget.value || null,
                  ),
                )
              }
              onKeyDown={(event) => {
                if (event.key === 'Escape' || event.key === 'Enter') setEditing(null);
              }}
            />
            <button
              type="button"
              className="icon-choice"
              title="No icon"
              onClick={() => run(window.notebook.setFolderStyle(folder.id, folder.color, null))}
            >
              ✕
            </button>
            <button type="button" className="picker-done" onClick={() => setEditing(null)}>
              Done
            </button>
          </div>
        )}

        {editing?.kind === 'child-new' && editing.parentId === folder.id && (
          <div className="tree-row" style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}>
            <span className="twisty-spacer" />
            <NameInput
              initial=""
              placeholder="New subfolder"
              onCommit={(name) => run(window.notebook.createFolder(folder.id, name))}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}

        {!isCollapsed && kids.map((kid) => renderFolder(kid, depth + 1))}
      </div>
    );
  };

  return (
    <div className="folder-tree">
      <div
        className={`tree-row${sameScope(scope, { kind: 'all' }) ? ' selected' : ''}`}
        onClick={() => onScopeChange({ kind: 'all' })}
      >
        <span className="twisty-spacer" />
        <span className="tree-name">All threads</span>
        <Count n={counts?.all} title="Every thread, filed or not" />
      </div>
      <div
        className={`tree-row${sameScope(scope, { kind: 'unfiled' }) ? ' selected' : ''}${
          dropTarget === null ? ' drop-target' : ''
        }`}
        onClick={() => onScopeChange({ kind: 'unfiled' })}
        onDragOver={(event) => {
          event.preventDefault();
          setDropTarget(null);
        }}
        onDragLeave={() => setDropTarget('none')}
        onDrop={(event) => handleDrop(event, null)}
      >
        <span className="twisty-spacer" />
        <span className="tree-name">Unfiled</span>
        <Count n={counts?.unfiled} title="Threads in no folder — drop one here to unfile it" />
      </div>

      {/* The counterpart to Unfiled, and the reason both now carry a number:
          with almost everything unfiled, "All threads" and "Unfiled" listed
          nearly the same 2848 rows and nothing on screen said so. This is the
          pile you have actually sorted, across every folder at once — which no
          single folder can show. */}
      <div
        className={`tree-row${sameScope(scope, { kind: 'filed' }) ? ' selected' : ''}`}
        onClick={() => onScopeChange({ kind: 'filed' })}
      >
        <span className="twisty-spacer" />
        <span className="tree-name">Filed</span>
        <Count n={counts?.filed} title="Threads placed in some folder" />
      </div>

      {/* The capture backlog. A thread with no turns is indistinguishable from a
          full one in a list of hundreds, so the threads that still need reading
          — or that failed — are only findable as a category. */}
      <div
        className={`tree-row${sameScope(scope, { kind: 'empty' }) ? ' selected' : ''}`}
        onClick={() => onScopeChange({ kind: 'empty' })}
      >
        <span className="twisty-spacer" />
        <span className="tree-name">Empty threads</span>
        <Count n={counts?.empty} title="Threads the app knows of but holds no turns for" />
      </div>

      {/* Raw entries belonging to no conversation. Kept beside Unfiled rather
          than hidden behind a menu: an entry the app has stored but shows
          nowhere is stored and lost at the same time. */}
      <div
        className={`tree-row${sameScope(scope, { kind: 'orphans' }) ? ' selected' : ''}`}
        onClick={() => onScopeChange({ kind: 'orphans' })}
      >
        <span className="twisty-spacer" />
        <span className="tree-name">Orphan entries</span>
        <Count n={counts?.orphans} title="Export entries attached to no thread" />
      </div>

      <div className="tree-divider" />
      {roots.map((folder) => renderFolder(folder, 0))}

      {editing?.kind === 'root-new' ? (
        <div className="tree-row" style={{ paddingLeft: '4px' }}>
          <span className="twisty-spacer" />
          <NameInput
            initial=""
            placeholder="New folder"
            onCommit={(name) => run(window.notebook.createFolder(null, name))}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : (
        <button type="button" className="tree-add" onClick={() => setEditing({ kind: 'root-new' })}>
          ＋ New folder
        </button>
      )}
    </div>
  );
}
