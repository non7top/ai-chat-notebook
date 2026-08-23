import type { ChatSummary } from '../shared/types';
import { displayDate } from './dateDisplay';

interface Props {
  chats: ChatSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

// Only startedAt is a real conversation date. last_seen_at is when the
// harvester last saw the thread, which for a bulk harvest is "today" for every
// row — displaying that stamped the harvest date onto years of history and read
// as though every conversation happened at once. AI Mode exposes no per-thread
// date at all (see the notes in aiModeDriver.ts), so a date appears only once
// Takeout has supplied one.

export default function ChatList({ chats, selectedId, onSelect }: Props) {
  if (chats.length === 0) {
    return <p className="hint empty">No conversations here yet.</p>;
  }

  return (
    <div className="chat-list">
      {chats.map((chat) => {
        const started = displayDate(chat.startedAt);
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
              {/* Prefixed and titled because every date here is INFERRED: it
                  comes from matching a Takeout prompt against this
                  conversation's title or a captured turn, and that match is
                  textual, not an id. Presenting it as plain fact would overstate
                  what is known. */}
              {started ? (
                <span
                  className="date-inferred"
                  title="Inferred by matching the Takeout prompt text — not from a thread id"
                >
                  ~{started}
                  {' · '}
                </span>
              ) : (
                ''
              )}
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
              {/* Where the row came from. Without it a Takeout prompt and a
                  fully captured conversation look identical in the list. */}
              {/* Every contributing source, not just the last writer: a
                  conversation imported from Takeout and later extended from the
                  panel should say so, since that determines whether it has the
                  original images. */}
              <span className={`chat-source src-${chat.source}`} title={`sources: ${chat.sources}`}>
                {' · '}
                {chat.sources
                  .split(',')
                  .filter(Boolean)
                  .map((s) =>
                    s === 'capture'
                      ? 'panel'
                      : s === 'harvest'
                        ? 'listed'
                        : s === 'takeout-date'
                          ? 'dated'
                          : s,
                  )
                  .join('+')}
              </span>
              {chat.takeoutEntryCount > 1 && (
                <span
                  className="chat-grouped"
                  title={`${chat.takeoutEntryCount} export entries were grouped into this conversation`}
                >
                  {' · '}
                  {chat.takeoutEntryCount} entries
                </span>
              )}
              {chat.altTurnCount > 0 && chat.altTurnCount !== chat.messageCount && (
                <span
                  className="chat-mismatch"
                  title={`The other reading of this conversation has ${chat.altTurnCount} turns, this one has ${chat.messageCount}`}
                >
                  {' · '}
                  differs
                </span>
              )}
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
