import { useEffect, useState } from 'react';
import type {
  ActivityStats,
  CaptureProgress,
  HarvestProgress,
  TakeoutImportRow,
  TakeoutPick,
} from '../shared/types';
import { type TakeoutEntry, parseTakeoutHtml } from './parseTakeout';

interface Props {
  /** Harvesting scrapes the live sidebar, so the panel has to be on screen. */
  onNeedPanel: () => void;
  onFinished: () => void;
  /**
   * How many conversations have no turns yet, owned by the parent so it tracks
   * the archive. It was previously read once on mount and then only updated by
   * capture progress, so a harvest that added 8 conversations — or a re-capture
   * from the reader — left it silently stale.
   */
  uncaptured: number;
  /**
   * Activity totals, owned by the parent for the same reason as uncaptured:
   * derived data kept in two places drifts.
   */
  activity: ActivityStats | null;
}

const CAPTURE_BATCH = 25;
// Far above any plausible history, so "all" means all.
const CAPTURE_ALL_LIMIT = 100_000;

/**
 * Parsed entries as import rows. Shared by the sweep and the apply — two copies
 * would let the preview describe rows the import never receives.
 */
function importRows(entries: TakeoutEntry[]): TakeoutImportRow[] {
  return entries.map((e) => ({
    query: e.query,
    timestamp: e.timestamp,
    timestampText: e.timestampText,
    href: e.href,
    turns: e.turns,
    imageFiles: e.images,
  }));
}

export default function HarvestBar({ onNeedPanel, onFinished, uncaptured, activity }: Props) {
  const [progress, setProgress] = useState<HarvestProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [capture, setCapture] = useState<CaptureProgress | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [takeout, setTakeout] = useState<TakeoutPick | null>(null);
  const [takeoutNote, setTakeoutNote] = useState<string | null>(null);
  const [takeoutBusy, setTakeoutBusy] = useState(false);

  useEffect(
    () =>
      window.notebook.onHarvestProgress((next) => {
        setProgress(next);
        if (next.phase !== 'scanning') {
          setBusy(false);
          onFinished();
        }
      }),
    [onFinished],
  );

  useEffect(
    () =>
      window.notebook.onCaptureProgress((next) => {
        setCapture(next);
        if (next.phase !== 'capturing') {
          setCapturing(false);
          // onFinished reloads the archive, which refreshes the count via props
          // rather than keeping a second copy of it here.
          onFinished();
        }
      }),
    [onFinished],
  );

  // Two steps on purpose. Scanning reports what the parser found so a layout
  // change shows up as counts that look wrong, rather than as a silent import
  // of nothing — and it now also reports what an import WOULD do to what is
  // already stored, which is the question the counts alone cannot answer.
  const scanTakeout = async () => {
    setTakeoutBusy(true);
    setTakeoutNote(null);
    try {
      const picked = await window.notebook.pickTakeout();
      if (!picked) return;
      const { entries, scan } = parseTakeoutHtml(picked.html);
      setTakeout(picked);
      // The sweep. Reads only, and goes through the same placement rule the
      // import uses, so it describes the import that will actually run.
      const sweep = await window.notebook.previewTakeout(importRows(entries));
      setTakeoutNote(
        `${scan.entryCount} cells, ${scan.aiModeEntries} AI Mode · ` +
          `${scan.withTimestamp} dated · ${scan.withQuery} titled · ` +
          `turns ${scan.turnCounts.min}/${scan.turnCounts.median}/${scan.turnCounts.max} ` +
          `(${scan.turnCounts.total} total, ${scan.multiTurnEntries} multi-turn) · ` +
          `${scan.withImages} with images (${scan.imageRefsTotal})` +
          // Only shown when non-zero, so the ordinary line stays readable, and
          // spelled out because each of these means something different: a
          // nested cell is double-counting, unparsed date text is a bug here,
          // and an empty cell is not a conversation at all.
          (scan.nestedCells > 0 ? ` · ${scan.nestedCells} NESTED (double-counted)` : '') +
          (scan.emptyCells > 0 ? ` · ${scan.emptyCells} empty cells` : '') +
          (scan.noDateText > 0 ? ` · ${scan.noDateText} with no date at all` : '') +
          (scan.unparsedDateText > 0
            ? ` · ${scan.unparsedDateText} dates unread, e.g. ${scan.unparsedDateSamples
                .map((t) => `"${t}"`)
                .join(', ')}`
            : '') +
          `\nsweep: ${sweep.wouldCreate} new, ${sweep.wouldEnrich} would extend a ` +
          `conversation already here, ${sweep.wouldUpdate} would update one from an ` +
          `earlier import (${sweep.chatsTouched} existing touched) · ` +
          `${sweep.alreadyKnown} entries already stored · ` +
          `${sweep.ambiguous} share an opening, left to glue by hand` +
          (sweep.wouldOrphan > 0
            ? ` · ${sweep.wouldOrphan} with no prompt → kept as orphans`
            : ''),
      );
    } catch (err) {
      setTakeoutNote(err instanceof Error ? err.message : String(err));
    } finally {
      setTakeoutBusy(false);
    }
  };

  const applyTakeout = async () => {
    if (!takeout) return;
    setTakeoutBusy(true);
    try {
      const { entries } = parseTakeoutHtml(takeout.html);
      const summary = await window.notebook.applyTakeout(
        takeout.folder,
        importRows(entries),
      );
      setTakeoutNote(
        `${summary.entries} entries → ${summary.conversations} conversations ` +
          `(${summary.createdChats} new, ${summary.extendedChats} extended, ` +
          `${summary.datedHarvested} dated, ${summary.ambiguousOpenings} left to glue, ` +
          `${summary.regrouped} regrouped) · ` +
          (summary.unreadableDates > 0
            ? `${summary.unreadableDates} dates unreadable · `
            : '') +
          `${summary.turnsWritten} turns · ` +
          `${summary.inserted} activity recorded ` +
          `(${summary.duplicates} already known, ${summary.skipped} no query) · ` +
          `matched ${summary.matchedToChat} by title, ${summary.matchedToTurn} by turn · ` +
          `${summary.ambiguous} ambiguous · ${summary.orphans} orphaned · ` +
          `images ${summary.imagesCopied} copied`,
      );
      setTakeout(null);
      onFinished();
    } catch (err) {
      setTakeoutNote(err instanceof Error ? err.message : String(err));
    } finally {
      setTakeoutBusy(false);
    }
  };

  const startCapture = async (limit: number) => {
    setCapturing(true);
    setCapture(null);
    // Capture drives the real sidebar, so the panel has to be on screen for the
    // same reason harvesting does.
    onNeedPanel();
    try {
      await window.notebook.captureTurns(limit);
    } catch (err) {
      setCapture({
        phase: 'error',
        done: 0,
        total: 0,
        errors: 1,
        error: err instanceof Error ? err.message : String(err),
      });
      setCapturing(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setProgress(null);
    // The driver reads only visible rows — with the sidebar hidden the thread
    // buttons are still in the DOM but laid out at zero size, so a harvest
    // would "succeed" against a stale copy. Show the panel first.
    onNeedPanel();
    try {
      await window.notebook.harvestThreadList();
    } catch (err) {
      setProgress({
        phase: 'error',
        found: 0,
        expected: 0,
        created: 0,
        updated: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      setBusy(false);
    }
  };

  const pct =
    progress && progress.expected > 0
      ? Math.min(100, Math.round((progress.found / progress.expected) * 100))
      : 0;

  return (
    <div className="harvest-bar">
      <button type="button" onClick={start} disabled={busy}>
        {busy ? 'Harvesting…' : 'Harvest history'}
      </button>
      {busy && (
        <button type="button" onClick={() => window.notebook.cancelHarvest()}>
          Stop
        </button>
      )}

      {progress && (
        <span className={progress.phase === 'error' ? 'harvest-status error' : 'harvest-status'}>
          {progress.phase === 'error' ? (
            progress.error
          ) : (
            <>
              {progress.found}
              {progress.expected > 0 && ` / ~${progress.expected}`} threads
              {progress.created > 0 && ` · ${progress.created} new`}
              {progress.phase === 'cancelled' && ' · stopped'}
              {/* A virtualised list that yields a fraction of itself looks
                  identical to a finished one from the inside, so a shortfall is
                  called out rather than quietly reported as success. */}
              {progress.phase === 'done' &&
                (progress.complete
                  ? ' · complete'
                  : ` · INCOMPLETE, expected ~${progress.expected}`)}
            </>
          )}
        </span>
      )}

      <span className="harvest-sep" />

      <button type="button" onClick={scanTakeout} disabled={takeoutBusy || busy || capturing}>
        {takeoutBusy ? 'Reading…' : 'Scan Takeout…'}
      </button>
      {takeout && (
        <button type="button" onClick={applyTakeout} disabled={takeoutBusy}>
          Import it
        </button>
      )}
      <button
        type="button"
        title="Remove everything a Takeout import added. Harvested conversations are kept."
        disabled={takeoutBusy || busy || capturing}
        onClick={async () => {
          if (!(await window.notebook.confirm('Undo the Takeout import?', 'Conversations harvested from the panel are kept.'))) return;
          setTakeoutBusy(true);
          try {
            const r = await window.notebook.undoTakeout();
            setTakeoutNote(`undone: ${r.deleted} removed, ${r.reverted} reverted`);
            onFinished();
          } finally {
            setTakeoutBusy(false);
          }
        }}
      >
        Undo import
      </button>
      {/* Orphans are the point of keeping activity at all: prompts whose
          conversation Google no longer lists. Shown permanently rather than
          only after an import, since the number falls as capture progresses. */}
      {activity && activity.total > 0 && !takeoutNote && (
        <span className="harvest-status">
          {activity.total} activity · {activity.matched} matched ·{' '}
          <span className="orphan-count">{activity.orphans} orphaned</span>
        </span>
      )}
      {takeoutNote && <span className="harvest-status">{takeoutNote}</span>}

      <span className="harvest-sep" />

      <button type="button" onClick={() => startCapture(CAPTURE_BATCH)} disabled={busy || capturing}>
        {capturing ? 'Capturing…' : `Capture ${CAPTURE_BATCH}`}
      </button>
      {/* The backlog is hours long at ~30-60s per conversation, almost all of it
          Google's own load time. Clicking a 25-batch a dozen times is not a
          workflow, so this exists to be started and left. */}
      {uncaptured > 0 && (
        <button
          type="button"
          // NOT bounded by the displayed count. That number is a label, and a
          // stale one would silently stop the run short — "Capture all (296)"
          // leaving 7 conversations behind. The main process takes whatever is
          // actually uncaptured, up to this ceiling.
          onClick={() => startCapture(CAPTURE_ALL_LIMIT)}
          disabled={busy || capturing}
          title="Works through everything not yet captured. Safe to leave running; Stop works at any point."
        >
          Capture all ({uncaptured})
        </button>
      )}
      {capturing && (
        <button type="button" onClick={() => window.notebook.cancelCapture()}>
          Stop
        </button>
      )}
      {capture ? (
        <span className={capture.phase === 'error' ? 'harvest-status error' : 'harvest-status'}>
          {capture.phase === 'error'
            ? capture.error
            : capture.phase === 'capturing'
              ? `${capture.done}/${capture.total} · ${capture.current ?? ''}`
              : `${capture.done} captured · ${capture.turns ?? 0} turns · ${
                  capture.images ?? 0
                } images${capture.errors ? ` · ${capture.errors} failed` : ''}${
                  capture.remaining ? ` · ${capture.remaining} left` : ''
                }${capture.stoppedEarly ? ` — ${capture.stoppedEarly}` : ''}`}
        </span>
      ) : (
        uncaptured > 0 && <span className="harvest-status">{uncaptured} not captured</span>
      )}

      {busy && progress?.expected ? (
        <span className="harvest-track">
          <span className="harvest-fill" style={{ width: `${pct}%` }} />
        </span>
      ) : null}
    </div>
  );
}
