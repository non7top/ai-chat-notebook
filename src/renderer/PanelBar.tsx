import { useEffect, useState } from 'react';
import type { AiModeStatus } from '../shared/types';

interface Props {
  status: AiModeStatus;
}

const AI_MODE_HOME = 'https://www.google.com/search?udm=50';
const MY_ACTIVITY = 'https://myactivity.google.com/search-services/history/search';

/**
 * Address bar for the embedded panel. Without it the panel is a one-way trip:
 * any link that navigates away leaves no route back, and there is no way to
 * point it somewhere deliberately.
 */
export default function PanelBar({ status }: Props) {
  const [draft, setDraft] = useState(status.url ?? '');
  const [editing, setEditing] = useState(false);

  // Follow the panel while the field is not being typed into — clobbering
  // a half-typed URL because the page navigated would be worse than a
  // momentarily stale display.
  useEffect(() => {
    if (!editing) setDraft(status.url ?? '');
  }, [status.url, editing]);

  const go = () => {
    setEditing(false);
    window.notebook.navigateAiMode(draft);
  };

  return (
    <div className="panel-bar">
      <button
        type="button"
        title="Back"
        disabled={!status.canGoBack}
        onClick={() => window.notebook.aiModeGoBack()}
      >
        ‹
      </button>
      <button
        type="button"
        title="Forward"
        disabled={!status.canGoForward}
        onClick={() => window.notebook.aiModeGoForward()}
      >
        ›
      </button>
      <button type="button" title="Reload" onClick={() => window.notebook.aiModeReload()}>
        ⟳
      </button>
      <input
        className="panel-url"
        value={draft}
        spellCheck={false}
        placeholder="Address"
        onChange={(e) => {
          setEditing(true);
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go();
          if (e.key === 'Escape') {
            setEditing(false);
            setDraft(status.url ?? '');
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setEditing(false)}
      />
      <button type="button" title="Go" onClick={go}>
        →
      </button>
      {/* Two shortcuts worth having permanently: the AI Mode home the
          harvester needs, and the activity page that carries the timestamps
          AI Mode never renders. */}
      <button
        type="button"
        title="AI Mode home"
        onClick={() => window.notebook.navigateAiMode(AI_MODE_HOME)}
      >
        AI Mode
      </button>
      <button
        type="button"
        title="My Activity — Search history"
        onClick={() => window.notebook.navigateAiMode(MY_ACTIVITY)}
      >
        Activity
      </button>
    </div>
  );
}
