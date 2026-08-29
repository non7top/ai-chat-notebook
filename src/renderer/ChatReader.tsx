import { useEffect, useState } from 'react';
import type { ChatDetail, ChatSummary, Message, SourceEntryView } from '../shared/types';
import { sanitizeHtml } from './sanitize';
import { displayDateTime } from './dateDisplay';

const KIND_LABELS: Record<string, string> = {
  takeout: 'Takeout export',
  capture: 'read from the panel',
  harvest: 'sidebar listing',
};

interface Props {
  chat: ChatDetail;
  onChange: () => void;
}

export default function ChatReader({ chat, onChange }: Props) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [assetsBase, setAssetsBase] = useState<string>('');
  const [recapturing, setRecapturing] = useState(false);
  const [recaptureError, setRecaptureError] = useState<string | null>(null);
  const [entries, setEntries] = useState<SourceEntryView[]>([]);
  // Which reading is on screen: what is stored for the thread, or one entry's
  // own account of it. They disagree, and which one is right depends on the
  // thread — the export is rougher but sometimes longer, a capture has the real
  // images but can be truncated. Nothing here should pick for the reader.
  const [reading, setReading] = useState<'stored' | number>('stored');
  const [entryTurns, setEntryTurns] = useState<Message[]>([]);
  const [candidates, setCandidates] = useState<ChatSummary[]>([]);
  const [showEntries, setShowEntries] = useState(false);
  const [fetching, setFetching] = useState(false);
  // The entry carrying a link, if any. An entry with none — a Lens search, a
  // blank record — cannot be fetched, and offering the action would be a dead
  // end.
  // ANY entry with a link, attached or not. Requiring `e.linked` meant a thread
  // whose only link sat on an unattached entry showed no fetch control anywhere —
  // see the per-entry Fetch button below for the case that exposed it.
  const linkEntry = entries.find((e) => e.href)?.id ?? null;

  // Reloaded on every chat change and after every link change: the entry list
  // is the record of what this conversation is made of, so a stale one would
  // misreport the thing it exists to show.
  const loadSources = () => {
    window.notebook.sourceEntries(chat.id).then(setEntries);
    window.notebook.similarChats(chat.id).then(setCandidates);
  };
  useEffect(loadSources, [chat.id]);

  // Back to the thread's own reading when the thread changes: an entry id from
  // the previous thread would show that thread's text under this one's title.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chat.id is the trigger, not an input
  useEffect(() => {
    setReading('stored');
    setEntryTurns([]);
  }, [chat.id]);

  useEffect(() => {
    if (reading === 'stored') {
      setEntryTurns([]);
      return;
    }
    window.notebook.sourceEntryTurns(reading).then(setEntryTurns);
  }, [reading]);

  const shown = reading === 'stored' ? chat.messages : entryTurns;

  useEffect(() => {
    window.notebook.getAssetsBaseUrl().then(setAssetsBase);
  }, []);

  const commit = () => {
    setRenaming(false);
    window.notebook.setChatTitle(chat.id, draft.trim()).then(onChange);
  };

  return (
    <div className="reader">
      <div className="reader-head">
        {renaming ? (
          <input
            className="name-input reader-name-input"
            // Focused on appearance: it only exists because Rename was just clicked.
            autoFocus
            value={draft}
            placeholder="Name this entry"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={commit}
          />
        ) : (
          <>
            {/* title= carries the whole thing, because the heading is clamped to
                two lines and a prompt can run to a paragraph. */}
            <h2
              className={chat.title === '(untitled)' ? 'untitled' : undefined}
              title={chat.title}
            >
              {chat.title}
            </h2>
            {/* Quotable, and the same number the list shows. */}
            <span className="chat-id" title="This thread's internal id">
              #{chat.id}
            </span>
            {/* A parser fix cannot repair what is already stored, and the
                capture queue deliberately skips conversations that have turns —
                so re-reading one has to be reachable by hand. */}
            <button
              type="button"
              disabled={recapturing}
              title="Re-reads this thread by clicking its row in Google's live sidebar. That reading has the fuller text and the original images — but only works while Google still lists the thread."
              onClick={async () => {
                setRecapturing(true);
                setRecaptureError(null);
                try {
                  await window.notebook.recaptureChat(chat.id);
                  onChange();
                } catch (err) {
                  // Previously swallowed: a failed re-capture looked exactly
                  // like a successful no-op, which is how an empty
                  // conversation got mistaken for "nothing changed".
                  setRecaptureError(err instanceof Error ? err.message : String(err));
                } finally {
                  setRecapturing(false);
                }
              }}
            >
              {/* Named for its SOURCE, which is the only thing that
                  distinguishes it from the button beside it. "Re-capture" and
                  "Fetch from link" both mean "read this thread again"; what
                  differs is where from, and that difference is the whole point
                  of keeping two readings. */}
              {recapturing ? 'Reading threads…' : 'Re-read from threads'}
            </button>
            {/* Beside the panel re-read, not a row below it. They are the same
                act from different sources — and they were on separate rows with
                names that hid that, so which one to press was a guess. */}
            {linkEntry !== null && (
              <button
                type="button"
                disabled={fetching}
                title="Re-reads this thread by loading the export's saved link. The only route once Google stops listing a thread, and it keeps second-precision dates and links the live page has since dropped. Refuses to store anything if the page does not match the export's own reading."
                onClick={async () => {
                  setFetching(true);
                  setRecaptureError(null);
                  try {
                    const result = await window.notebook.captureFromEntryLink(linkEntry);
                    if (result.rejected) setRecaptureError(`Not stored — ${result.rejected}`);
                    else onChange();
                  } catch (err) {
                    setRecaptureError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setFetching(false);
                  }
                }}
              >
                {fetching ? 'Reading link…' : 'Re-read from link'}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                // Starts from the current display title, but an empty commit
                // clears user_title so the harvested one shows through again.
                setDraft(chat.title === '(untitled)' ? '' : chat.title);
                setRenaming(true);
              }}
            >
              Rename
            </button>
          </>
        )}
      </div>

      {/* Provenance, because "where did this come from and how do I get back
          to it" had no answer in the UI at all. There is deliberately no link:
          a Takeout URL re-runs the prompt and loses the uploads, and a
          constructed mtid URL creates a duplicate conversation. Clicking the
          sidebar row is the only faithful route, so it is a button. */}
      <p className="provenance">
        <span title="Every source that contributed to this entry">
          {chat.sources
            .split(',')
            .filter(Boolean)
            .map((s) =>
              s === 'capture'
                ? 'captured from the panel'
                : s === 'harvest'
                  ? 'listed in the sidebar'
                  : s === 'takeout'
                    ? 'text from Takeout'
                    : s === 'takeout-date'
                      ? 'dated from Takeout'
                      : s,
            )
            .join(' + ')}
        </span>
        {chat.startedAt &&
          (chat.dateBasis === 'placeholder' ? (
            <span
              className="date-placeholder"
              title="No real date is known for this entry. This is when the app first saved it."
            >
              {' · saved '}
              {displayDateTime(chat.startedAt)} (no real date known)
            </span>
          ) : (
            <span title="Inferred by matching the Takeout prompt text, not from an id">
              {' · ~'}
              {displayDateTime(chat.startedAt)} (inferred)
            </span>
          ))}
        <span className="provenance-id"> · {chat.externalId || 'no id'}</span>
        {!chat.externalId.startsWith('takeout:') && (
          <button
            type="button"
            className="provenance-open"
            title="Find and open this thread in the live panel"
            onClick={async () => {
              setRecaptureError(null);
              try {
                await window.notebook.openChatInPanel(chat.id);
              } catch (err) {
                setRecaptureError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Open in panel
          </button>
        )}
      </p>

      {recaptureError && (
        <p className="status-line error">Re-capture failed: {recaptureError}</p>
      )}

      {/* The data entries behind this conversation. The conversation has one
          internal id; each entry is a separate observation of it, and they
          populate different fields — one carries the only timestamp, another
          the only image, a third the fullest text. Which entries are attached
          IS the record, so it is shown rather than kept as bookkeeping.

          Nothing is grouped automatically. Two entries with the same opening
          prompt may be one conversation snapshotted twice, the same question
          asked twice, or a clone Google made on its own — indistinguishable
          without judgement, so candidates are listed and the decision is a
          click. */}
      <div className="sources">
        <button type="button" className="sources-toggle" onClick={() => setShowEntries((v) => !v)}>
          {/* "conversations", not "data entries". Under the vocabulary the second
              column holds entries and each of these is one source's account of
              the exchange — calling them entries too was the confusion the
              glossary exists to end. */}
          {showEntries ? '▾' : '▸'} {entries.filter((e) => e.linked).length}{' '}
          {entries.filter((e) => e.linked).length === 1 ? 'conversation' : 'conversations'}
          {entries.some((e) => !e.linked) && (
            <span className="sources-hint">
              {' '}
              · {entries.filter((e) => !e.linked).length} unattached, same prompt
            </span>
          )}
          {candidates.length > 0 && (
            <span className="sources-hint">
              {' '}
              · {candidates.length} similar {candidates.length === 1 ? 'entry' : 'entries'}
            </span>
          )}
        </button>

        {/* This thread and everything the archive thinks is the same
            conversation, read from the panel in one go.

            The list comes from here rather than from a query in the main
            process, deliberately: these are CANDIDATES, judged by fingerprint
            and shown for exactly that reason — nothing is grouped
            automatically. Reading them is safe where merging them would not be,
            so the action that needs no judgement is the one offered in bulk.

            Re-capture on a single thread has always worked while the bulk paths
            attempted nothing, because the fault was never the capture, it was
            which threads the queue would hand over. This hands over a list. */}
        {candidates.length > 0 && (
          <button
            type="button"
            className="capture-similar"
            disabled={fetching}
            title="Reads this thread and every similar one from the live panel, one after another. Stop works at any point."
            onClick={async () => {
              setFetching(true);
              try {
                const ids = [chat.id, ...candidates.map((c) => c.id)];
                await window.notebook.recaptureMany(ids);
                loadSources();
                onChange();
              } finally {
                setFetching(false);
              }
            }}
          >
            {/* Same vocabulary as the two buttons in the header: "re-read",
                and the source named. Three controls that all re-read a thread
                should not use three different words for it. */}
            {fetching
              ? 'Reading threads…'
              : `Re-read ${candidates.length + 1} from threads`}
          </button>
        )}

        {showEntries && (
          <div className="sources-body">
            {entries.length === 0 && (
              <p className="sources-empty">
                No raw entries stored. Conversations imported before entries were kept, or
                harvested straight from the sidebar, have none — the turns are still here.
              </p>
            )}
            {entries.map((entry) => (
              <div key={entry.id} className={`source-entry${entry.linked ? '' : ' unlinked'}`}>
                {/* The entry's own id, distinct from the thread's. A thread and
                    the entries behind it are different rows and get reported as
                    different things, so both numbers have to be visible. */}
                <span className="chat-id">e#{entry.id}</span>
                <span className="source-kind">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
                <span className="source-facts">
                  {/* Only what this entry actually carries — a field it is
                      missing is said to be missing rather than filled in from
                      a sibling, which is how a gap gets noticed. */}
                  {entry.occurredAt ? (
                    displayDateTime(entry.occurredAt)
                  ) : entry.dateText ? (
                    // The export did carry a date; this parser could not read
                    // it. Quoted verbatim, because that text is what the
                    // pattern has to be fixed against.
                    <span
                      className="date-unread"
                      title="The export carried this date but it could not be parsed"
                    >
                      date unread: {entry.dateText}
                    </span>
                  ) : (
                    'no date'
                  )}
                  {' · '}
                  {entry.turnCount} {entry.turnCount === 1 ? 'turn' : 'turns'}
                  {' · '}
                  {entry.imageCount
                    ? `${entry.imageCount} ${entry.imageCount === 1 ? 'image' : 'images'}`
                    : 'no image'}
                  {/* The URL itself, not just whether there is one. It is the
                      thing that identifies a record to Google, so a report about
                      a bad entry needs it — and it was nowhere in the app.

                      Shown as TEXT, never as an anchor. Following one of these
                      re-runs the prompt rather than opening the thread: it costs
                      a real query, produces a different answer, and once created
                      a duplicate conversation in a live history. The Fetch button
                      is the only sanctioned way to visit it, because that path
                      checks the page against the export before storing anything. */}
                  {entry.href ? (
                    <>
                      {' · '}
                      <span className="entry-url" title={entry.href}>
                        {entry.href.replace(/^https?:\/\//, '').slice(0, 48)}…
                      </span>
                      <button
                        type="button"
                        className="entry-copy"
                        title="Copy this URL"
                        onClick={() => navigator.clipboard?.writeText(entry.href ?? '')}
                      >
                        copy
                      </button>
                    </>
                  ) : (
                    ' · no link'
                  )}
                  {/* Shown because the link is many-to-many by design: one
                      entry can be evidence for two conversations. A count
                      above one is a fact, not a fault. */}
                  {entry.chatCount > 1 && ` · also in ${entry.chatCount - 1} other`}
                </span>
                {/* On the entry that OWNS the link, unconditionally.

                    The header carries a "Fetch from link" too, but it required an
                    entry that was both attached AND had an href — and a thread
                    whose only link sits on an unattached entry therefore offered
                    nothing at all. Measured on a real thread: "0 data entries ·
                    2 unattached with the same prompt", one of them holding 13
                    turns, an image and a live mstk URL, and no button anywhere
                    would pull it. Six hours were spent looking for a control
                    that a condition had hidden.

                    Here there is nothing to hide behind: if a record carries a
                    link, the row that shows the link offers to pull it. */}
                {entry.href && (
                  <button
                    type="button"
                    className="entry-fetch"
                    disabled={fetching}
                    title={
                      entry.linked
                        ? "Loads this record by its link and stores the conversation into this entry. Refuses to store anything if the page's answer does not match the export's."
                        : "Loads this record by its link and stores the conversation. This conversation is not attached to this entry, so it becomes its own — Glue it first if it belongs here."
                    }
                    onClick={async () => {
                      setFetching(true);
                      setRecaptureError(null);
                      try {
                        const result = await window.notebook.captureFromEntryLink(entry.id);
                        if (result.rejected) {
                          setRecaptureError(`Not stored — ${result.rejected}`);
                        } else {
                          loadSources();
                          onChange();
                        }
                      } catch (err) {
                        setRecaptureError(err instanceof Error ? err.message : String(err));
                      } finally {
                        setFetching(false);
                      }
                    }}
                  >
                    {fetching ? '…' : 'Fetch'}
                  </button>
                )}
                {entry.linked ? (
                  <button
                    type="button"
                    title="Unglue: this entry is its own thread, glued here only because it opens the same way"
                    onClick={async () => {
                      const ok = await window.notebook.confirm(
                        'Unglue this entry?',
                        'It becomes a thread of its own, with its own id and its own link to this entry. Nothing is deleted.',
                      );
                      if (!ok) return;
                      await window.notebook.unglueSourceEntry(chat.id, entry.id);
                      loadSources();
                      onChange();
                    }}
                  >
                    Unglue
                  </button>
                ) : (
                  <button
                    type="button"
                    title="Glue: this conversation belongs to this entry"
                    onClick={async () => {
                      await window.notebook.linkSourceEntry(chat.id, entry.id);
                      loadSources();
                      onChange();
                    }}
                  >
                    Glue
                  </button>
                )}
              </div>
            ))}

            {candidates.map((other) => (
              <div key={`chat-${other.id}`} className="source-entry candidate">
                <span className="chat-id">#{other.id}</span>
                <span
                  className="source-kind"
                  title="A different entry in this archive that opens with the same prompt. Not a source of this one — a candidate, listed because nothing is grouped automatically."
                >
                  another entry, same prompt
                </span>
                <span className="source-facts">
                  {other.startedAt ? displayDateTime(other.startedAt) : 'no date'}
                  {' · '}
                  {other.messageCount} {other.messageCount === 1 ? 'turn' : 'turns'}
                  {' · '}
                  {other.sources}
                </span>
                <button
                  type="button"
                  title="Glue: fold this entry's conversations into this one. Reversible."
                  onClick={async () => {
                    const ok = await window.notebook.confirm(
                      'Glue these threads?',
                      'Its entries move here and it stops appearing in the list. Nothing is deleted — this can be undone.',
                    );
                    if (!ok) return;
                    await window.notebook.mergeChats(chat.id, [other.id]);
                    loadSources();
                    onChange();
                  }}
                >
                  Glue
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* The export's own images. Above the turns, because for many of these
          threads the picture IS the subject — and the caption says outright that
          their place in the conversation is unknown rather than implying they
          belong to the first turn. */}
      {chat.unplacedImagePaths.length > 0 && assetsBase && (
        <div className="unplaced-images">
          <p className="unplaced-caption">
            {chat.unplacedImagePaths.length} image
            {chat.unplacedImagePaths.length === 1 ? '' : 's'} from the export — it does not say
            which turn they belong to
          </p>
          <div className="unplaced-strip">
            {chat.unplacedImagePaths.map((relative) => (
              <img
                key={relative}
                src={assetsBase + relative.slice('assets/'.length)}
                alt=""
                loading="lazy"
              />
            ))}
          </div>
        </div>
      )}

      {/* Clicks are swallowed at the container: stored HTML can contain real
          external links, and following one inside the app's own renderer
          would navigate away from the app itself, replacing the UI with a web
          page and no way back. Opening them in a browser is a later job. */}
      {/* Only offered when there is something to switch to. A single reading
          needs no chooser, and an empty one would just be furniture. */}
      {entries.length > 0 && (
        <div className="reading-switch">
          <span className="reading-label">Reading</span>
          {/* Named for what it IS, not for where it lives. "stored" told the
              reader nothing, and the answer matters: this is the panel's reading
              wherever the thread has been captured, which is the better one —
              it has the real images and the full text. A capture overwrites the
              turns and an import onto a captured thread deliberately leaves them
              alone, so this is already the capture when one exists. It is the
              default for that reason. */}
          <button
            type="button"
            className={reading === 'stored' ? 'reading-on' : undefined}
            onClick={() => setReading('stored')}
            title={
              chat.sources.split(',').includes('capture')
                ? "Read from Google's threads page — the fullest text and the real images"
                : 'What is stored for this entry; it has not been read from threads yet'
            }
          >
            {chat.sources.split(',').includes('capture') ? 'from threads' : 'as imported'} ·{' '}
            {chat.messageCount} turns
            {/* Beside each reading, because neither contains the other's links —
                one export record kept three inline while the page carried
                thirty-seven, and at least one the export kept is no longer on the
                page at all. */}
            {chat.linkCount > 0 && ` · ${chat.linkCount} links`}
          </button>
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={reading === entry.id ? 'reading-on' : undefined}
              onClick={() => setReading(entry.id)}
              title={
                entry.linked
                  ? "This entry's own account of the thread"
                  : 'An entry that is not attached to this thread but opens the same way'
              }
            >
              e#{entry.id} · {entry.turnCount} turns
              {entry.linkCount > 0 && ` · ${entry.linkCount} links`}
              {entry.linked ? '' : ' (unattached)'}
            </button>
          ))}
        </div>
      )}

      {/* Clicks are still intercepted at the container — a stored link must never
          navigate the app's own window away from the app — but a citation now
          leaves for the system browser instead of doing nothing at all. Answers
          cite real sources, one measured answer carrying 37 of them, and an
          archive you cannot follow out of is a worse archive. */}
      <div
        className="reader-body"
        onClick={(event) => {
          event.preventDefault();
          const anchor = (event.target as HTMLElement).closest?.('a[href]');
          const href = anchor?.getAttribute('href');
          // The scheme is checked again in the main process; this is only to
          // avoid asking it about the local asset paths in the same markup.
          if (href && /^https?:\/\//i.test(href)) {
            window.notebook.openExternal(href).catch(() => {
              /* Refused by the main process; the click simply does nothing. */
            });
          }
        }}
      >
        {reading !== 'stored' && shown.length === 0 && (
          <p className="hint">That entry holds no turns.</p>
        )}
        {shown.map((message) => (
          <div key={message.id} className={`turn turn-${message.role}`}>
            <div className="turn-role">{message.role === 'user' ? 'You' : 'AI Mode'}</div>
            {message.html ? (
              // Sanitised immediately before insertion — see sanitize.ts for
              // why this is not left to capture time alone.
              <div
                className="turn-body"
                dangerouslySetInnerHTML={{
                  __html: sanitizeHtml(message.html, assetsBase, chat.previewPaths),
                }}
              />
            ) : (
              <div className="turn-body">{message.text}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
