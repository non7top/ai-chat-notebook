import { useMemo, useState } from 'react';
import type { ChatScope, Folder } from '../shared/types';

interface Props {
  folders: Folder[];
  scope: ChatScope;
  onScopeChange: (scope: ChatScope) => void;
  onChange: () => void;
  onError: (message: string) => void;
}

type DragPayload = { kind: 'folder'; id: number } | { kind: 'chat'; id: number };

// Naming is done with an inline input rather than window.prompt, which Electron
// does not implement at all: calling it throws "prompt() is not supported."
// straight out of the click handler, so creating or renaming a folder failed
// silently and nothing could be filed anywhere.
type Editing =
  | { kind: 'root-new' }
  | { kind: 'child-new'; parentId: number }
  | { kind: 'rename'; id: number; current: string }
  | null;

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

export default function FolderTree({ folders, scope, onScopeChange, onChange, onError }: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [dropTarget, setDropTarget] = useState<number | null | 'none'>('none');
  const [editing, setEditing] = useState<Editing>(null);

  const roots = useMemo(() => childrenOf(folders, null), [folders]);

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
      run(window.notebook.setChatFolder(payload.id, targetId));
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
              <span className="tree-name">{folder.name}</span>
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
                title="Delete folder (conversations inside become Unfiled)"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteFolder(folder);
                }}
              >
                ✕
              </button>
            </>
          )}
        </div>

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
        <span className="tree-name">All conversations</span>
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
