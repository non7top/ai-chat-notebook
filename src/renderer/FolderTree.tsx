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

function childrenOf(folders: Folder[], parentId: number | null): Folder[] {
  return folders.filter((folder) => folder.parentId === parentId);
}

function sameScope(a: ChatScope, b: ChatScope): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'folder' || b.kind !== 'folder' || a.id === b.id;
}

export default function FolderTree({ folders, scope, onScopeChange, onChange, onError }: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [dropTarget, setDropTarget] = useState<number | null | 'none'>('none');

  const roots = useMemo(() => childrenOf(folders, null), [folders]);

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const readPayload = (event: React.DragEvent): DragPayload | null => {
    try {
      return JSON.parse(event.dataTransfer.getData('application/json')) as DragPayload;
    } catch {
      return null;
    }
  };

  // A single handler for both kinds of drop: folders reparent, chats refile.
  // targetId null means the Unfiled root.
  const handleDrop = async (event: React.DragEvent, targetId: number | null) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget('none');
    const payload = readPayload(event);
    if (!payload) return;

    try {
      if (payload.kind === 'folder') {
        if (payload.id === targetId) return;
        await window.notebook.moveFolder(payload.id, targetId);
      } else {
        await window.notebook.setChatFolder(payload.id, targetId);
      }
      onChange();
    } catch (err) {
      // The main process rejects a move into the folder's own subtree; that
      // rejection has to be visible, or the drop just appears to do nothing.
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const renderFolder = (folder: Folder, depth: number) => {
    const kids = childrenOf(folders, folder.id);
    const isCollapsed = collapsed.has(folder.id);
    const isSelected = sameScope(scope, { kind: 'folder', id: folder.id });

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
          draggable
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
          <span className="tree-name">{folder.name}</span>
          <button
            type="button"
            className="row-action"
            title="Rename folder"
            onClick={(event) => {
              event.stopPropagation();
              const name = window.prompt('Rename folder', folder.name);
              if (name?.trim()) {
                window.notebook.renameFolder(folder.id, name.trim()).then(onChange);
              }
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
              const name = window.prompt('New subfolder name');
              if (name?.trim()) {
                window.notebook.createFolder(folder.id, name.trim()).then(onChange);
              }
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
              if (window.confirm(`Delete folder "${folder.name}"? Conversations inside it are kept and become Unfiled.`)) {
                window.notebook.deleteFolder(folder.id).then(onChange);
              }
            }}
          >
            ✕
          </button>
        </div>
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

      <button
        type="button"
        className="tree-add"
        onClick={() => {
          const name = window.prompt('New top-level folder name');
          if (name?.trim()) {
            window.notebook.createFolder(null, name.trim()).then(onChange);
          }
        }}
      >
        ＋ New folder
      </button>
    </div>
  );
}
