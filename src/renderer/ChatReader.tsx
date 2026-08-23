import { useEffect, useState } from 'react';
import type { ChatDetail } from '../shared/types';
import { sanitizeHtml } from './sanitize';
import { displayDateTime } from './dateDisplay';

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
            placeholder="Name this conversation"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={commit}
          />
        ) : (
          <>
            <h2 className={chat.title === '(untitled)' ? 'untitled' : undefined}>{chat.title}</h2>
            {/* A parser fix cannot repair what is already stored, and the
                capture queue deliberately skips conversations that have turns —
                so re-reading one has to be reachable by hand. */}
            <button
              type="button"
              disabled={recapturing}
              title="Re-read this conversation from Google, replacing what is stored"
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
              {recapturing ? 'Re-capturing…' : 'Re-capture'}
            </button>
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
        <span title="Every source that contributed to this conversation">
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
        {chat.startedAt && (
          <span title="Inferred by matching the Takeout prompt text, not from a thread id">
            {' · ~'}
            {displayDateTime(chat.startedAt)} (inferred)
          </span>
        )}
        <span className="provenance-id"> · {chat.externalId || 'no id'}</span>
        {!chat.externalId.startsWith('takeout:') && (
          <button
            type="button"
            className="provenance-open"
            title="Find and open this conversation in the live panel"
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

      {/* Clicks are swallowed at the container: stored HTML can contain real
          external links, and following one inside the app's own renderer
          would navigate away from the app itself, replacing the UI with a web
          page and no way back. Opening them in a browser is a later job. */}
      <div className="reader-body" onClick={(event) => event.preventDefault()}>
        {chat.messages.map((message) => (
          <div key={message.id} className={`turn turn-${message.role}`}>
            <div className="turn-role">{message.role === 'user' ? 'You' : 'AI Mode'}</div>
            {message.html ? (
              // Sanitised immediately before insertion — see sanitize.ts for
              // why this is not left to capture time alone.
              <div
                className="turn-body"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(message.html, assetsBase) }}
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
