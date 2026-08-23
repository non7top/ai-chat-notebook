import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSummary } from '../shared/types';
import { displayDate } from './dateDisplay';
import { highlight, matchesTitle, termsOf } from './findTitles';

interface Props {
  chats: ChatSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  query: string;
  onQueryChange: (query: string) => void;
}

// Only startedAt is a real conversation date. last_seen_at is when the
// harvester last saw the thread, which for a bulk harvest is "today" for every
// row — displaying that stamped the harvest date onto years of history and read
// as though every conversation happened at once. AI Mode exposes no per-thread
// date at all (see the notes in aiModeDriver.ts), so a date appears only once
// Takeout has supplied one.

export default function ChatList({ chats, selectedId, onSelect, query, onQueryChange }: Props) {
  const box = useRef<HTMLInputElement>(null);
  const [assetsBase, setAssetsBase] = useState('');

  // Thumbnails are stored as relative "assets/..." paths so the archive can be
  // moved; the renderer lives inside the app bundle and would otherwise look
  // for them there. Same resolution the reader does — see sanitize.ts.
  useEffect(() => {
    window.notebook.getAssetsBaseUrl().then(setAssetsBase);
  }, []);
  const terms = useMemo(() => termsOf(query), [query]);

  // Ctrl+F reaches the box. Autofocusing it instead would take the keyboard
  // away from the reader, which is where attention normally is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        event.preventDefault();
        box.current?.focus();
        box.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const shown = useMemo(
    () => (terms.length === 0 ? chats : chats.filter((c) => matchesTitle(c.title, terms))),
    [chats, terms],
  );

  // "Search threads" is Google's own wording for this, and the app follows it —
  // but "titles" stays in the placeholder, because a search that silently
  // ignores the body text is worse than one that admits it does.
  const find = (
    <div className="find">
      <input
        ref={box}
        className="find-input"
        type="search"
        value={query}
        placeholder="Search thread titles…"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onQueryChange('');
            box.current?.blur();
          }
        }}
      />
      {terms.length > 0 && (
        <span className="find-count">
          {shown.length} of {chats.length}
        </span>
      )}
    </div>
  );

  if (chats.length === 0) {
    return <p className="hint empty">No threads here yet.</p>;
  }

  return (
    <div className="chat-list">
      {find}
      {/* Said explicitly. An empty list under a filled search box reads as "this
          folder is empty", which is a different and more alarming claim. */}
      {shown.length === 0 && (
        <p className="hint empty">
          No title matches “{query}”. {chats.length} thread{chats.length === 1 ? '' : 's'} here.
        </p>
      )}
      {shown.map((chat) => {
        const started = displayDate(chat.startedAt);
        // Read from the live panel at some point, which is what separates a
        // conversation the app has really seen from one it only has the
        // export's account of.
        const enriched = chat.sources.split(',').includes('capture');
        return (
        <div
          key={chat.id}
          className={`chat-row${enriched ? ' enriched' : ''}${
            chat.id === selectedId ? ' selected' : ''
          }`}
          title={enriched ? 'Enriched from the panel — has the full text and real images' : undefined}
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
            {/* A column of its own, because most of this archive is image
                generation and the picture a conversation opened with identifies
                it far faster than 300 characters of prompt. Absent for
                text-only conversations, and the column collapses rather than
                leaving a hole. */}
            {chat.titleImage && assetsBase && (
              <img
                className="chat-thumb"
                src={assetsBase + chat.titleImage.slice('assets/'.length)}
                alt=""
                // Hundreds of rows, so decoding every thumbnail up front would
                // stall the list; the browser fetches them as they scroll in.
                loading="lazy"
              />
            )}
            <span className="chat-text">
            <span className={chat.title === '(untitled)' ? 'chat-title untitled' : 'chat-title'}>
              {/* Highlighted so it is obvious WHY a row survived the filter —
                  with prompts this long, the matched words are often well past
                  where the column is cut off. */}
              {highlight(chat.title, terms).map((seg) =>
                seg.hit ? (
                  <mark key={`${seg.at}h`}>{seg.text}</mark>
                ) : (
                  <span key={seg.at}>{seg.text}</span>
                ),
              )}
            </span>
            <span className="chat-meta">
              {/* Prefixed and titled because every date here is INFERRED: it
                  comes from matching a Takeout prompt against this
                  conversation's title or a captured turn, and that match is
                  textual, not an id. Presenting it as plain fact would overstate
                  what is known. */}
              {started ? (
                chat.dateBasis === 'placeholder' ? (
                  // Not the conversation's date at all — the date the app first
                  // saved it, standing in because nothing knows the real one.
                  // Faint and marked, so it reads as an open question rather
                  // than an answer, and no dot after it: it is not a fact
                  // sitting alongside the others.
                  <span
                    className="date-placeholder"
                    title="No real date is known for this thread. This is when the app first saved it — a stand-in until an export supplies the real one."
                  >
                    saved {started}
                    {' · '}
                  </span>
                ) : (
                  <span
                    className="date-inferred"
                    title={
                      chat.dateBasis === 'activity'
                        ? 'From the activity log, matched by prompt text — not from a thread id'
                        : 'Inferred by matching the Takeout prompt text — not from a thread id'
                    }
                  >
                    ~{started}
                    {' · '}
                  </span>
                )
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
                  title={`${chat.takeoutEntryCount} export entries were grouped into this thread`}
                >
                  {' · '}
                  {chat.takeoutEntryCount} entries
                </span>
              )}
              {chat.altTurnCount > 0 && chat.altTurnCount !== chat.messageCount && (
                <span
                  className="chat-mismatch"
                  title={`The other reading of this thread has ${chat.altTurnCount} turns, this one has ${chat.messageCount}`}
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
              {/* Counted apart and named for what they are. A conversation with
                  17 rich link previews and no generated picture reported "17
                  img", which told the reader the opposite of the truth. */}
              {chat.previewCount > 0 && (
                <span
                  className="chat-previews"
                  title={`${chat.previewCount} link preview(s) or source thumbnail(s) — not the thread's own images`}
                >
                  {' · '}
                  {chat.previewCount} preview{chat.previewCount === 1 ? '' : 's'}
                </span>
              )}
            </span>
            </span>
          </button>
        </div>
        );
      })}
    </div>
  );
}
