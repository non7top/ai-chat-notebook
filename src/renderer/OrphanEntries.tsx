import { useEffect, useState } from 'react';
import type { Message, SourceEntryView } from '../shared/types';
import { sanitizeHtml } from './sanitize';
import { displayDateTime } from './dateDisplay';

interface Props {
  onChange: () => void;
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
export default function OrphanEntries({ onChange }: Props) {
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
          ? 'No orphan entries — every stored entry belongs to a conversation.'
          : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} attached to no conversation.`}
      </p>
      {entries.map((entry) => (
        <div key={entry.id} className="orphan">
          <div className="orphan-head">
            <button
              type="button"
              className="orphan-open"
              onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
            >
              {openId === entry.id ? '▾' : '▸'} {entry.query || '(no prompt)'}
            </button>
            <span className="source-facts">
              {entry.occurredAt ? displayDateTime(entry.occurredAt) : 'no date'}
              {' · '}
              {entry.turnCount} {entry.turnCount === 1 ? 'turn' : 'turns'}
              {' · '}
              {entry.imageCount
                ? `${entry.imageCount} ${entry.imageCount === 1 ? 'image' : 'images'}`
                : 'no image'}
            </span>
            <button
              type="button"
              title="Adopt: give this entry a conversation of its own"
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
