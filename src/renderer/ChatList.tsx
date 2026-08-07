import type { ChatSummary } from '../shared/types';

interface Props {
  chats: ChatSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

export default function ChatList({ chats, selectedId, onSelect }: Props) {
  if (chats.length === 0) {
    return <p className="hint empty">No conversations here yet.</p>;
  }

  return (
    <div className="chat-list">
      {chats.map((chat) => (
        <div
          key={chat.id}
          className={`chat-row${chat.id === selectedId ? ' selected' : ''}`}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(
              'application/json',
              JSON.stringify({ kind: 'chat', id: chat.id }),
            );
          }}
        >
          <button type="button" className="chat-open" onClick={() => onSelect(chat.id)}>
            <span className={chat.title === '(untitled)' ? 'chat-title untitled' : 'chat-title'}>
              {chat.title}
            </span>
            <span className="chat-meta">
              {when(chat.lastSeenAt)} · {chat.messageCount} turn
              {chat.messageCount === 1 ? '' : 's'}
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
