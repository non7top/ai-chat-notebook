import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSummary } from '../shared/types';
import { displayDate } from './dateDisplay';
import { highlight, matchesTitle, termsOf } from './findTitles';

interface Props {
  chats: ChatSummary[];
  /** The thread the reader is showing. One, always — reading is singular. */
  selectedId: number | null;
  onSelect: (id: number) => void;
  /**
   * The threads picked for filing, which is a different thing from the one being
   * read: you gather a dozen rows about one topic while reading none of them.
   * Owned by the parent so it survives a re-render of this list and so a folder
   * drop can clear it.
   */
  picked: ReadonlySet<number>;
  onPickedChange: (picked: ReadonlySet<number>) => void;
  query: string;
  onQueryChange: (query: string) => void;
}

// Only startedAt is a real conversation date. last_seen_at is when the
// harvester last saw the thread, which for a bulk harvest is "today" for every
// row — displaying that stamped the harvest date onto years of history and read
// as though every conversation happened at once. AI Mode exposes no per-thread
// date at all (see the notes in aiModeDriver.ts), so a date appears only once
// Takeout has supplied one.

export default function ChatList({
  chats,
  selectedId,
  onSelect,
  picked,
  onPickedChange,
  query,
  onQueryChange,
}: Props) {
  const box = useRef<HTMLInputElement>(null);
  // Where a shift-click measures from. Not the reader's selection: shift-click
  // must extend from the last row DELIBERATELY picked, and the reader's row
  // changes for reasons of its own.
  const anchor = useRef<number | null>(null);
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

  /**
   * A click on a row, with the modifiers that turn one pick into many.
   *
   * Plain click both opens the thread and resets the pick to it, which is what
   * makes the feature discoverable: a normal click behaves exactly as it always
   * did, and nothing has to be learned to keep using the app the old way.
   *
   * Ctrl/Cmd adds or removes one row and does NOT change what the reader shows —
   * gathering rows for a folder is not reading them, and having the reader jump
   * on every ctrl-click would make picking a dozen unusable.
   *
   * Shift takes the range over the rows CURRENTLY SHOWN, not over the whole
   * archive. With a filter applied, the rows between two visible ones are the
   * visible ones; extending over the hidden rows would file threads the person
   * never saw.
   */
  const clickRow = (chat: ChatSummary, event: React.MouseEvent) => {
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey && anchor.current !== null) {
      const from = shown.findIndex((c) => c.id === anchor.current);
      const to = shown.findIndex((c) => c.id === chat.id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        const next = new Set(additive ? picked : []);
        for (let i = lo; i <= hi; i += 1) next.add(shown[i].id);
        onPickedChange(next);
        return;
      }
    }
    if (additive) {
      const next = new Set(picked);
      if (next.has(chat.id)) next.delete(chat.id);
      else next.add(chat.id);
      anchor.current = chat.id;
      onPickedChange(next);
      return;
    }
    anchor.current = chat.id;
    onPickedChange(new Set([chat.id]));
    onSelect(chat.id);
  };

  // Ctrl+A picks everything currently listed, which is the operation that
  // actually empties a pile of 2846: filter to a topic, take the lot, drag it
  // once. Escape lets go.
  //
  // Scoped to `shown` rather than to the archive for the same reason the shift
  // range is: with a filter applied, "all" can only honestly mean what is on
  // screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLElement &&
        (event.target.tagName === 'INPUT' || event.target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && event.key === 'a' && !typing) {
        event.preventDefault();
        onPickedChange(new Set(shown.map((c) => c.id)));
      }
      if (event.key === 'Escape' && !typing) onPickedChange(new Set());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shown, onPickedChange]);

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
      {/* Only present while something is picked, and it says what to do with
          them. A multi-select nobody can see the extent of is worse than none:
          the whole risk of this feature is filing rows you did not know were
          held. */}
      {picked.size > 0 && (
        <div className="picked-bar">
          <span>
            {picked.size} picked — drag onto a folder
          </span>
          <button type="button" onClick={() => onPickedChange(new Set())}>
            Clear
          </button>
        </div>
      )}
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
          }${picked.has(chat.id) ? ' picked' : ''}`}
          title={enriched ? 'Enriched from the panel — has the full text and real images' : undefined}
          draggable
          onDragStart={(event) => {
            // Dragging a row that is part of the pick takes the whole pick;
            // dragging one that is not takes only itself, and replaces the pick
            // so the two can never disagree about what is being moved. Getting
            // this backwards is how a drag silently files eleven other threads.
            const ids = picked.has(chat.id) ? [...picked] : [chat.id];
            if (!picked.has(chat.id)) onPickedChange(new Set([chat.id]));
            event.dataTransfer.setData('application/json', JSON.stringify({ kind: 'chats', ids }));
          }}
        >
          <button
            type="button"
            className="chat-open"
            onClick={(event) => clickRow(chat, event)}
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
              {/* The thread's internal id, quotable. Without it a report can only
                  say "the one about sprites", and several threads open with the
                  same prompt — this is the number that finds exactly one row in
                  the database. */}
              <span className="chat-id">#{chat.id}</span>{' · '}
              {/* Where this thread belongs, on the thread. Answering "which
                  group is this in" used to mean clicking through the tree one
                  folder at a time, and the list is where the question is
                  actually asked. Nothing at all when unfiled — an explicit
                  "Unfiled" on 2846 rows is noise, and their being unmarked is
                  already the answer. */}
              {chat.folderName && (
                <span
                  className={`chat-folder${chat.folderColor ? ` c-${chat.folderColor}` : ''}`}
                  title={`In ${chat.folderName}`}
                >
                  {chat.folderIcon ? `${chat.folderIcon} ` : ''}
                  {chat.folderName}
                  {' · '}
                </span>
              )}
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
                      chat.dateBasis === 'panel'
                        ? "Read off the panel's own timestamp — the day only, no time"
                        : chat.dateBasis === 'activity'
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
                ) : chat.sources.split(',').includes('harvest') ? (
                  // Listed in the sidebar and not read yet — the one case where
                  // "not captured yet" is true and something can be done about
                  // it.
                  'not captured yet'
                ) : (
                  // A thread with no turns that is NOT waiting to be read. It
                  // came from a record the export never gave turns for: a Lens
                  // search, or a blank one. Saying "not captured yet" of these
                  // was a contradiction on its face — a thread showing an image
                  // and claiming nothing had been captured — and it also implied
                  // a capture would fix it, which nothing will: Google saved no
                  // prompt and no response, so there is nothing to fetch.
                  <span
                    className="chat-noturns"
                    title="The export holds no prompt or response for this record — a Lens search or a blank one. Capturing cannot add turns that were never saved."
                  >
                    {chat.imageCount > 0 ? 'image only' : 'no turns in the export'}
                  </span>
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
                  // The stored words are the schema's; these are the ones the
                  // glossary settled on. 'capture' is stored, 'threads' is what
                  // it means: read from Google's threads page. Translated at the
                  // point of display rather than migrated, because 1943 rows
                  // carry the string and several queries match on it.
                  .map((s) =>
                    s === 'capture'
                      ? 'threads'
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
