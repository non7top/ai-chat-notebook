import { useEffect, useState } from 'react';
import type { ChatDetail, ChatSummary, SourceEntryView } from '../shared/types';
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
  const [candidates, setCandidates] = useState<ChatSummary[]>([]);
  const [showEntries, setShowEntries] = useState(false);

  // Reloaded on every chat change and after every link change: the entry list
  // is the record of what this conversation is made of, so a stale one would
  // misreport the thing it exists to show.
  const loadSources = () => {
    window.notebook.sourceEntries(chat.id).then(setEntries);
    window.notebook.similarChats(chat.id).then(setCandidates);
  };
  useEffect(loadSources, [chat.id]);

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
        {chat.startedAt &&
          (chat.dateBasis === 'placeholder' ? (
            <span
              className="date-placeholder"
              title="No real date is known for this conversation. This is when the app first saved it."
            >
              {' · saved '}
              {displayDateTime(chat.startedAt)} (no real date known)
            </span>
          ) : (
            <span title="Inferred by matching the Takeout prompt text, not from a thread id">
              {' · ~'}
              {displayDateTime(chat.startedAt)} (inferred)
            </span>
          ))}
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
          {showEntries ? '▾' : '▸'} {entries.filter((e) => e.linked).length} data{' '}
          {entries.filter((e) => e.linked).length === 1 ? 'entry' : 'entries'}
          {entries.some((e) => !e.linked) && (
            <span className="sources-hint">
              {' '}
              · {entries.filter((e) => !e.linked).length} unattached with the same prompt
            </span>
          )}
          {candidates.length > 0 && (
            <span className="sources-hint">
              {' '}
              · {candidates.length} similar {candidates.length === 1 ? 'conversation' : 'conversations'}
            </span>
          )}
        </button>

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
                  {entry.href ? ' · has link' : ' · no link'}
                  {/* Shown because the link is many-to-many by design: one
                      entry can be evidence for two conversations. A count
                      above one is a fact, not a fault. */}
                  {entry.chatCount > 1 && ` · also in ${entry.chatCount - 1} other`}
                </span>
                {entry.linked ? (
                  <button
                    type="button"
                    title="Unglue: this entry is its own conversation, glued here only because it opens the same way"
                    onClick={async () => {
                      const ok = await window.notebook.confirm(
                        'Unglue this entry?',
                        'It becomes a conversation of its own, with its own id and its own link to this entry. Nothing is deleted.',
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
                    title="Glue: this entry belongs to this conversation"
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
                <span className="source-kind">separate conversation</span>
                <span className="source-facts">
                  {other.startedAt ? displayDateTime(other.startedAt) : 'no date'}
                  {' · '}
                  {other.messageCount} {other.messageCount === 1 ? 'turn' : 'turns'}
                  {' · '}
                  {other.sources}
                </span>
                <button
                  type="button"
                  title="Glue: fold this conversation's entries into this one. Reversible."
                  onClick={async () => {
                    const ok = await window.notebook.confirm(
                      'Glue these conversations?',
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
