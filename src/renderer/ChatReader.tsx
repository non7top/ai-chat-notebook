import type { ChatDetail } from '../shared/types';
import { sanitizeHtml } from './sanitize';

interface Props {
  chat: ChatDetail;
  onChange: () => void;
}

export default function ChatReader({ chat, onChange }: Props) {
  return (
    <div className="reader">
      <div className="reader-head">
        <h2 className={chat.title === '(untitled)' ? 'untitled' : undefined}>{chat.title}</h2>
        <button
          type="button"
          onClick={() => {
            const name = window.prompt('Name this conversation', chat.title);
            if (name !== null) {
              window.notebook.setChatTitle(chat.id, name.trim()).then(onChange);
            }
          }}
        >
          Rename
        </button>
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
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(message.html) }}
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
