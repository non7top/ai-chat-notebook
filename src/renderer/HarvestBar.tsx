import { useEffect, useState } from 'react';
import type {
  ActivityStats,
  SuspectCopyGroup,
  CaptureProgress,
  HarvestProgress,
  InlineImageCount,
  TakeoutImportRow,
  TakeoutPick,
} from '../shared/types';
import { type TakeoutEntry, parseTakeoutHtml } from './parseTakeout';
import type { TakeoutReportData } from './TakeoutReport';

interface Props {
  /**
   * Where the export report goes. Handed up rather than rendered here: it is
   * several paragraphs and a list, and this component is a single toolbar row —
   * which is exactly how four hundred characters of it ended up truncated in a
   * span.
   */
  onReport: (report: TakeoutReportData | null) => void;
  /** Harvesting scrapes the live sidebar, so the panel has to be on screen. */
  onNeedPanel: () => void;
  /** Opens the identical-conversations report; see SuspectCopies. */
  onCopies: (groups: SuspectCopyGroup[]) => void;
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
// Not bounded any more, matching Capture all. A 500-thread slice looked like a
// stop of its own once the run reached the end of it, and with ~1700 threads it
// meant four separate runs. The pacing already makes this leisurely, and Stop
// works at any point.
const LINK_FETCH_LIMIT = 100_000;

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
    entryId: e.entryId,
    fingerprints: e.fingerprints,
    turns: e.turns,
    imageFiles: e.images,
  }));
}

export default function HarvestBar({
  onReport,
  onCopies,
  onNeedPanel,
  onFinished,
  uncaptured,
  activity,
}: Props) {
  const [progress, setProgress] = useState<HarvestProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [capture, setCapture] = useState<CaptureProgress | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [takeout, setTakeout] = useState<TakeoutPick | null>(null);
  const [takeoutNote, setTakeoutNote] = useState<string | null>(null);
  const [takeoutBusy, setTakeoutBusy] = useState(false);
  // Only set while a run is in progress; the prop is the truth otherwise.
  const [remainingOverride, setRemainingOverride] = useState<number | null>(null);
  const [linksToFetch, setLinksToFetch] = useState(0);
  const [inline, setInline] = useState<InlineImageCount>({ inline: 0, unexamined: 0 });
  const [lastJob, setLastJob] = useState<{
    job: string;
    outcome: string;
    endedAt: string;
    detail: Record<string, unknown>;
  } | null>(null);
  const [more, setMore] = useState(false);
  const remaining = remainingOverride ?? uncaptured;

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

  // Refreshed alongside the other counts: this number only moves when an import
  // adds threads or a fetch consumes them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggers, not inputs — they mark when the count can have changed
  useEffect(() => {
    window.notebook.countLinksToFetch().then(setLinksToFetch);
    window.notebook.countInlineImages().then(setInline);
    window.notebook.lastJobs().then((jobs) => setLastJob(jobs[0] ?? null));
  }, [uncaptured, activity]);

  useEffect(
    () =>
      window.notebook.onCaptureProgress((next) => {
        setCapture(next);
        // The button's own count is refreshed as the run proceeds. It used to be
        // read once and then left alone until the run ended, so mid-run it named
        // a number that had already been worked through — observed reading 186
        // while the true remainder was 124. A count that is wrong for minutes at
        // a time is worse than no count, because it looks live.
        if (typeof next.remaining === 'number') setRemainingOverride(next.remaining);
        if (next.phase !== 'capturing') {
          setCapturing(false);
          setRemainingOverride(null);
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
      // Progress reported as it goes. A 30MB export takes seconds to read, and
      // with nothing on screen saying so the window reads as hung — which is the
      // complaint, more than the wait itself.
      const { entries, scan } = await parseTakeoutHtml(picked.html, (progress) => {
        setTakeoutNote(
          progress.phase === 'parsing'
            ? 'Reading the export…'
            : progress.total > 0
              ? `Reading ${progress.done} of ${progress.total} records…`
              : 'Reading the export…',
        );
      });
      setTakeoutNote('Checking against what is already here…');
      setTakeout(picked);
      // The sweep. Reads only, and goes through the same placement rule the
      // import uses, so it describes the import that will actually run.
      const sweep = await window.notebook.previewTakeout(importRows(entries));
      onReport({ folder: picked.folder, scan, sweep, apply: applyTakeout });
      // The toolbar keeps a single figure and the panel carries the rest. A
      // count is all that fits here, and pretending otherwise is what truncated
      // everything that mattered.
      setTakeoutNote(
        `${scan.aiModeEntries} entries, ${sweep.conversations} threads — see the report`,
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
      const { entries } = await parseTakeoutHtml(takeout.html, (progress) => {
        setTakeoutNote(
          progress.total > 0
            ? `Reading ${progress.done} of ${progress.total} records…`
            : 'Reading the export…',
        );
      });
      setTakeoutNote('Importing…');
      const summary = await window.notebook.applyTakeout(
        takeout.folder,
        importRows(entries),
      );
      // The panel is replaced by the outcome, so the report on screen never
      // describes an import that has already happened.
      onReport(null);
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
          `images ${summary.imagesCopied} copied` +
          (summary.imagesOrphaned > 0
            ? `, ${summary.imagesOrphaned} attached to nothing`
            : ''),
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
      {/* Two groups, because the bar had grown to eight controls and the two that
          get used were no easier to find than the six that do not.

          Out front: the runs that take minutes and get started repeatedly.
          Behind "More": refreshing the sidebar list, reading an export, undoing
          an import — each a deliberate one-off, and each still one click away.
          Anything mid-run stays visible regardless, since hiding a Stop button
          behind a disclosure would be indefensible. */}
      {(more || busy) && (
        <button type="button" onClick={start} disabled={busy}>
          {busy ? 'Harvesting…' : 'Harvest history'}
        </button>
      )}
      {busy && (
        <button type="button" onClick={() => window.notebook.cancelHarvest()}>
          Stop
        </button>
      )}

      {/* How the last long job ENDED, which is a different question from how it
          went and was not answerable at all: a progress line that stops moving
          looks the same whether the work finished or died, and the summary went
          away with the run. Persisted, so it survives a restart. */}
      {!busy && !capturing && lastJob && (
        <span
          className={lastJob.outcome === 'finished' ? 'job-mark done' : 'job-mark warn'}
          title={JSON.stringify(lastJob.detail).slice(0, 400)}
        >
          {lastJob.job} {lastJob.outcome} {lastJob.endedAt.slice(11, 16)}
          {typeof lastJob.detail.remaining === 'number' && ` · ${lastJob.detail.remaining} left`}
        </span>
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

      {(more || takeoutBusy || takeout) && <span className="harvest-sep" />}

      {(more || takeoutBusy) && (
        <button type="button" onClick={scanTakeout} disabled={takeoutBusy || busy || capturing}>
          {takeoutBusy ? 'Reading…' : 'Scan Takeout…'}
        </button>
      )}
      {/* Kept as a way back to the decision after the report was closed; the
          report itself carries the primary Import. */}
      {takeout && (
        <button type="button" onClick={applyTakeout} disabled={takeoutBusy}>
          Import it
        </button>
      )}
      {more && (
      <button
        type="button"
        title="Remove everything a Takeout import added. Harvested threads are kept."
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
      )}

      {/* Behind More because it is a diagnostic: run once after a capture that
          went oddly, not part of the day's work. Its results go to a panel
          rather than the status line — a list of thread ids has no business in a
          toolbar, as the export report demonstrated. */}
      {more && (
        <button
          type="button"
          title="Finds threads holding identical conversations — the trace left by a capture that stored the wrong thread"
          onClick={async () => {
            onCopies(await window.notebook.suspectCopies());
          }}
        >
          Check for copies
        </button>
      )}

      {/* What went wrong, on demand. A run's own summary vanishes with the run;
          this reads the record the fetch leaves behind. */}
      {more && (
        <button
          type="button"
          title="Threads whose link was tried and did not simply succeed, with the reason"
          onClick={async () => {
            const outcomes = await window.notebook.linkOutcomes();
            const byState = new Map<string, number>();
            for (const o of outcomes) byState.set(o.state, (byState.get(o.state) ?? 0) + 1);
            setTakeoutNote(
              outcomes.length === 0
                ? 'every link tried so far succeeded'
                : `${[...byState].map(([s, n]) => `${n} ${s}`).join(' · ')} — first: ` +
                  `#${outcomes[0].chatId} ${outcomes[0].note ?? ''}`.slice(0, 200),
            );
          }}
        >
          Link failures
        </button>
      )}

      {/* Only offered while there is something to repair, so it disappears once
          the archive is clean rather than sitting there inviting a no-op. */}
      {more && (inline.inline > 0 || inline.unexamined > 0) && (
        <button
          type="button"
          disabled={busy || capturing || takeoutBusy}
          title="Moves images stored as base64 inside the text into the image store, where they can be counted, deduplicated and shown as thumbnails"
          onClick={async () => {
            setTakeoutBusy(true);
            try {
              const r = await window.notebook.repairInlineImages();
              setTakeoutNote(
                `moved ${r.images} images out of ${r.turns} turns · ` +
                  `${(r.bytesFreed / 1024 / 1024).toFixed(1)} MB reclaimed` +
                  (r.failed ? ` · ${r.failed} could not be read` : '') +
                  // Surfaced rather than swallowed: a stubborn row means base64
                  // arrived in a form the patterns do not recognise, and the
                  // number is the only way that becomes known.
                  (r.stubborn ? ` · ${r.stubborn} still hold base64` : ''),
              );
              setInline(await window.notebook.countInlineImages());
              onFinished();
            } finally {
              setTakeoutBusy(false);
            }
          }}
        >
          Move inline images ({inline.inline}
          {inline.unexamined > 0 && '+'})
        </button>
      )}

      {/* The second half of "fetch the threads, then match". Matching during an
          import can only see the threads that existed then, so an entry imported
          before its thread was captured had nothing to match against. */}
      {more && (
        <button
          type="button"
          disabled={busy || capturing || takeoutBusy}
          title="Attaches stored export entries to the threads they belong to, using the answer rather than the prompt. Leaves ambiguous ones alone."
          onClick={async () => {
            setTakeoutBusy(true);
            try {
              const r = await window.notebook.rematchEntries();
              setTakeoutNote(
                `${r.relinked} links repaired · ${r.attached} threads glued of ${r.considered} ` +
                  `considered · ${r.declined} too close to call`,
              );
              onFinished();
            } finally {
              setTakeoutBusy(false);
            }
          }}
        >
          Match entries
        </button>
      )}

      {/* Last, so the controls it reveals appear to its left and nothing jumps
          under the pointer when it is used. */}
      <button
        type="button"
        className="harvest-more"
        onClick={() => setMore((v) => !v)}
        title={more ? 'Hide the one-off actions' : 'Harvest the sidebar list, read an export, undo an import'}
      >
        {more ? 'Less' : 'More…'}
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
      {remaining > 0 && (
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
          Capture all ({remaining})
        </button>
      )}
      {/* The only route to the threads Google no longer lists, and for this
          archive that is most of them: the sidebar holds a few hundred while the
          export holds thousands with a link. Each is verified against the
          export's own reading before anything is stored, so a link that re-runs
          its prompt is refused rather than written. */}
      {linksToFetch > 0 && (
        <button
          type="button"
          disabled={busy || capturing}
          title="Opens each thread by the link in the export and captures what the page shows. Refuses to store anything where the page's answer does not match the export's."
          onClick={async () => {
            onNeedPanel();
            setCapturing(true);
            try {
              const result = await window.notebook.fetchFromLinks(LINK_FETCH_LIMIT);
              setLinksToFetch(result.remaining);
              setTakeoutNote(
                `fetched ${result.fetched} · ${result.rejected} did not match · ` +
                  `${result.notReady} not ready yet · ${result.errors} errors · ` +
                  `${result.remaining} left` +
                  (result.stoppedEarly ? ` — ${result.stoppedEarly}` : ''),
              );
              onFinished();
            } finally {
              setCapturing(false);
            }
          }}
        >
          Fetch from links ({linksToFetch})
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
                } images${
                  // Reported apart from failures: a thread Google no longer
                  // lists is not a failure, it is a thread that has left the
                  // history, and calling it an error invites retrying something
                  // that can never work.
                  capture.unlisted ? ` · ${capture.unlisted} no longer listed` : ''
                }${capture.errors ? ` · ${capture.errors} failed` : ''}${
                  capture.remaining ? ` · ${capture.remaining} left` : ''
                }${capture.stoppedEarly ? ` — ${capture.stoppedEarly}` : ''}`}
        </span>
      ) : (
        remaining > 0 && <span className="harvest-status">{remaining} not captured</span>
      )}

      {busy && progress?.expected ? (
        <span className="harvest-track">
          <span className="harvest-fill" style={{ width: `${pct}%` }} />
        </span>
      ) : null}
    </div>
  );
}
