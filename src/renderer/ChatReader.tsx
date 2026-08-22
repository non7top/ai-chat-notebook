import { useEffect, useState } from 'react';
import type { ChatDetail } from '../shared/types';
import { sanitizeHtml } from './sanitize';

interface Props {
  chat: ChatDetail;
  onChange: () => void;
}

export default function ChatReader({ chat, onChange }: Props) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [assetsBase, setAssetsBase] = useState<string>('');

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
