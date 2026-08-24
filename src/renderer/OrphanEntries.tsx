import { useEffect, useState } from 'react';
import type { Message, SourceEntryView } from '../shared/types';
import { sanitizeHtml } from './sanitize';
import { displayDateTime } from './dateDisplay';

interface Props {
  onChange: () => void;
  /** Opening a link drives the live panel, so it has to be on screen. */
  onNeedPanel: () => void;
}

/**
 * Raw data entries attached to no conversation.
 *
 * An entry gets here when an import could not tell where it belonged, or when a
 * wrong glue was taken apart and left it behind. They are the reason the raw
 * entries are stored separately at all: a conversation can be re-derived from
 * them, but only if they are reachable. Each one can be read in full before
 * anything is decided about it, and adopting one gives it its own conversation
 * with its own id.
 */
export default function OrphanEntries({ onChange, onNeedPanel }: Props) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [entries, setEntries] = useState<SourceEntryView[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [turns, setTurns] = useState<Message[]>([]);
  const [assetsBase, setAssetsBase] = useState('');

  const reload = () => {
    window.notebook.orphanEntries().then(setEntries);
  };
  useEffect(reload, []);
  useEffect(() => {
    window.notebook.getAssetsBaseUrl().then(setAssetsBase);
  }, []);
  useEffect(() => {
    if (openId === null) {
      setTurns([]);
      return;
    }
    window.notebook.sourceEntryTurns(openId).then(setTurns);
  }, [openId]);

  return (
    <div className="orphans">
      <p className="hint">
        {entries.length === 0
          ? 'No orphan entries — every stored entry belongs to a thread.'
          : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} attached to no thread.`}
      </p>
      {note && <p className="status-line">{note}</p>}
      {entries.map((entry) => (
        <div key={entry.id} className="orphan">
          <div className="orphan-head">
            <span className="chat-id">e#{entry.id}</span>
            <button
              type="button"
              className="orphan-open"
              onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
            >
              {openId === entry.id ? '▾' : '▸'} {entry.query || '(no prompt)'}
            </button>
            <span className="source-facts">
              {entry.occurredAt
                ? displayDateTime(entry.occurredAt)
                : entry.dateText
                  ? `date unread: ${entry.dateText}`
                  : 'no date'}
              {' · '}
              {entry.turnCount} {entry.turnCount === 1 ? 'turn' : 'turns'}
              {' · '}
              {entry.imageCount
                ? `${entry.imageCount} ${entry.imageCount === 1 ? 'image' : 'images'}`
                : 'no image'}
              {/* Text, never a link — following one re-runs the prompt. */}
              {entry.href && (
                <>
                  {' · '}
                  <span className="entry-url" title={entry.href}>
                    {entry.href.replace(/^https?:\/\//, '').slice(0, 40)}…
                  </span>
                </>
              )}
            </span>
            {/* Only for entries that HAVE a link. Lens searches and blank
                records carry none, and the button would be a dead end. */}
            {entry.href && (
              <button
                type="button"
                disabled={busy !== null}
                title="Open this entry's own link in the panel and capture the thread. Refuses to store anything if the page re-runs the prompt instead of opening the thread."
                onClick={async () => {
                  setBusy(entry.id);
                  setNote(null);
                  onNeedPanel();
                  try {
                    const result = await window.notebook.captureFromEntryLink(entry.id);
                    setNote(
                      result.rejected
                        ? `Not stored — ${result.rejected}`
                        : `Captured ${result.turns} turns, ${result.images} images ` +
                          `(matched the export at ${result.distance} of 64 bits apart).`,
                    );
                    if (!result.rejected) {
                      reload();
                      onChange();
                    }
                  } catch (err) {
                    setNote(err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === entry.id ? 'Opening…' : 'Open link'}
              </button>
            )}
            <button
              type="button"
              title="Adopt: give this entry a thread of its own"
              onClick={async () => {
                // Unfiled deliberately: filing it is a separate decision, and
                // guessing a folder here would bury it somewhere unexpected.
                await window.notebook.adoptSourceEntry(entry.id, null);
                reload();
                onChange();
              }}
            >
              Adopt
            </button>
          </div>
          {/* Shown without opening the entry. A Lens record IS its image — a
              date and a picture, with neither prompt nor response saved — so
              hiding it behind a disclosure would hide the whole content. */}
          {entry.imagePaths.length > 0 && assetsBase && (
            <div className="orphan-images">
              {entry.imagePaths.map((relative) => (
                <img
                  key={relative}
                  src={assetsBase + relative.slice('assets/'.length)}
                  alt=""
                  loading="lazy"
                />
              ))}
            </div>
          )}
          {openId === entry.id && (
            // Read in full — the whole point of keeping the entry. Same
            // click-swallowing and sanitising as the reader.
            <div className="reader-body" onClick={(event) => event.preventDefault()}>
              {turns.map((turn) => (
                <div key={turn.seq} className={`turn turn-${turn.role}`}>
                  <div className="turn-role">{turn.role === 'user' ? 'You' : 'AI Mode'}</div>
                  {turn.html ? (
                    <div
                      className="turn-body"
                      dangerouslySetInnerHTML={{ __html: sanitizeHtml(turn.html, assetsBase) }}
                    />
                  ) : (
                    <div className="turn-body">{turn.text}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
