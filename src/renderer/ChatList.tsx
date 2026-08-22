import type { ChatSummary } from '../shared/types';

interface Props {
  chats: ChatSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

// Only startedAt is a real conversation date. last_seen_at is when the
// harvester last saw the thread, which for a bulk harvest is "today" for every
// row — displaying that stamped the harvest date onto years of history and read
// as though every conversation happened at once. AI Mode exposes no per-thread
// date at all (see the notes in aiModeDriver.ts), so until myactivity is
// scraped for real timestamps, showing nothing is the honest option.
function when(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

export default function ChatList({ chats, selectedId, onSelect }: Props) {
  if (chats.length === 0) {
    return <p className="hint empty">No conversations here yet.</p>;
  }

  return (
    <div className="chat-list">
      {chats.map((chat) => {
        const started = when(chat.startedAt);
        return (
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
          <button
            type="button"
            className="chat-open"
            onClick={() => onSelect(chat.id)}
            // Titles are long and the pane is narrow, so the full text has to
            // be reachable without opening the conversation.
            title={chat.title}
          >
            <span className={chat.title === '(untitled)' ? 'chat-title untitled' : 'chat-title'}>
              {chat.title}
            </span>
            <span className="chat-meta">
              {started ? `${started} · ` : ''}
              {chat.messageCount === 0 ? (
                // A conversation that has been tried and failed looked exactly
                // like one never attempted, so a stuck one was invisible.
                chat.captureAttempts > 0 ? (
                  <span className="chat-failed">
                    capture failed
                    {chat.captureAttempts > 1 ? ` (${chat.captureAttempts}×)` : ''}
                  </span>
                ) : (
                  'not captured yet'
                )
              ) : (
                `${chat.messageCount} turn${chat.messageCount === 1 ? '' : 's'}`
              )}
              {/* Most of this archive is image generation, so images are the
                  thing worth browsing by. */}
              {chat.imageCount > 0 && (
                <span className="chat-images" title={`${chat.imageCount} image(s) archived`}>
                  {' · '}
                  {chat.imageCount} img
                </span>
              )}
            </span>
          </button>
        </div>
        );
      })}
    </div>
  );
}
