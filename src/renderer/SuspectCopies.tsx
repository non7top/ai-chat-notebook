import type { SuspectCopyGroup } from '../shared/types';

interface Props {
  groups: SuspectCopyGroup[];
  onOpenThread: (chatId: number) => void;
  onClose: () => void;
}

/**
 * Threads holding identical conversations.
 *
 * Exists to find the damage from one specific bug: clicking a sidebar row that
 * was not there did nothing and reported success, so a thread Google had rotated
 * out got stored with whatever the panel was still showing — the previously
 * captured thread. The result is two thread rows with the same conversation and
 * different ids, and nothing on screen that would ever hint at it.
 *
 * Reported as candidates, not as a verdict. Two threads genuinely can hold the
 * same opening exchange — the same question asked twice, or one of Google's own
 * clones — so this cannot say which is which. What it can do is put them side by
 * side, which is all a person needs to tell a duplicate from a coincidence.
 */
export default function SuspectCopies({ groups, onOpenThread, onClose }: Props) {
  return (
    <div className="report">
      <div className="report-head">
        <h2>Threads with identical conversations</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="report-body">
        {groups.length === 0 ? (
          <>
            <p className="report-figure new">Nothing found</p>
            <p className="report-note">
              No two threads hold the same conversation, so the sidebar-row bug did not
              cross-contaminate anything that is still stored.
            </p>
          </>
        ) : (
          <>
            <p className="report-figure warn">
              {groups.length} {groups.length === 1 ? 'group' : 'groups'}
              <span className="report-aside">
                {' '}
                — threads whose stored conversations are identical
              </span>
            </p>
            <p className="report-note">
              This is the signature of a capture that stored the wrong thread: clicking a
              sidebar row that no longer existed used to do nothing and report success,
              leaving the panel showing the previous thread. It is not proof — the same
              question asked twice looks the same from here — so compare them and decide.
              A group whose members were all captured in one run is the suspicious kind.
            </p>
            {groups.map((group) => (
              <div key={group.fingerprint} className="copy-group">
                {group.chatIds.map((id, index) => (
                  <button
                    key={id}
                    type="button"
                    className="copy-member"
                    onClick={() => onOpenThread(id)}
                    title="Open this thread to compare it"
                  >
                    <span className="chat-id">#{id}</span>{' '}
                    {group.titles[index] ?? '(untitled)'}
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
