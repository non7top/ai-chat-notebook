import { useEffect, useRef, useState } from 'react';
import type {
  ActivityStats,
  SuspectCopyGroup,
  CaptureProgress,
  HarvestProgress,
  SyncProgress,
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

// The 25-at-a-time capture is gone. It existed because a full run had no
// progress and no Stop and had to be taken in bites; both of those have been
// true for a while, and a second button doing a smaller version of the same
// thing was one of the ten this bar had grown to.
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
  // Threads the repeated path has stopped taking. Counted into "Catch up"
  // because that button means everything outstanding, and they are outstanding.
  const [stuck, setStuck] = useState(0);
  const [sync, setSync] = useState<SyncProgress | null>(null);
  // Which flow is going, or null. Kept apart from `sync` because the button has
  // to say "Getting new…" the instant it is pressed, before the first progress
  // message has come back — a button that looks unpressed for two seconds gets
  // pressed twice.
  const [syncing, setSyncing] = useState<'new' | 'all' | null>(null);
  const [lastJob, setLastJob] = useState<{
    job: string;
    outcome: string;
    endedAt: string;
    detail: Record<string, unknown>;
  } | null>(null);
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
    window.notebook.countExhaustedCaptures().then(setStuck);
    window.notebook.lastJobs().then((jobs) => setLastJob(jobs[0] ?? null));
  }, [uncaptured, activity]);

  useEffect(() => window.notebook.onSyncProgress(setSync), []);

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
          // Named rather than buried: a non-zero count here means records were
          // detached because their identity could not be recomputed, not
          // because the import judged them to belong elsewhere.
          (summary.unidentified > 0
            ? `${summary.unidentified} could not be re-identified · `
            : '') +
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

  const undoImport = async () => {
    if (
      !(await window.notebook.confirm(
        'Undo the Takeout import?',
        'Conversations harvested from the panel are kept.',
      ))
    ) {
      return;
    }
    setTakeoutBusy(true);
    try {
      const r = await window.notebook.undoTakeout();
      setTakeoutNote(`undone: ${r.deleted} removed, ${r.reverted} reverted`);
      onFinished();
    } finally {
      setTakeoutBusy(false);
    }
  };

  /**
   * Threads holding identical conversations — the trace left by a capture that
   * stored the wrong thread. Results go to a panel rather than the status line:
   * a list of thread ids has no business in a toolbar, as the export report
   * demonstrated.
   */
  const checkCopies = async () => {
    onCopies(await window.notebook.suspectCopies());
  };

  /**
   * What went wrong, on demand. A run's own summary vanishes with the run; this
   * reads the record the fetch leaves behind.
   */
  const linkFailures = async () => {
    const outcomes = await window.notebook.linkOutcomes();
    const byState = new Map<string, number>();
    for (const o of outcomes) byState.set(o.state, (byState.get(o.state) ?? 0) + 1);
    setTakeoutNote(
      outcomes.length === 0
        ? 'every link tried so far succeeded'
        : `${[...byState].map(([s, n]) => `${n} ${s}`).join(' · ')} — first: ` +
          `#${outcomes[0].chatId} ${outcomes[0].note ?? ''}`.slice(0, 200),
    );
  };

  const moveInlineImages = async () => {
    setTakeoutBusy(true);
    try {
      const r = await window.notebook.repairInlineImages();
      setTakeoutNote(
        `moved ${r.images} images out of ${r.turns} turns · ` +
          `${(r.bytesFreed / 1024 / 1024).toFixed(1)} MB reclaimed` +
          (r.failed ? ` · ${r.failed} could not be read` : '') +
          // Surfaced rather than swallowed: a stubborn row means base64 arrived
          // in a form the patterns do not recognise, and the number is the only
          // way that becomes known.
          (r.stubborn ? ` · ${r.stubborn} still hold base64` : ''),
      );
      // No count kept here any more. The menu label is the only place that
      // shows one, main computes it when it rebuilds the template, and
      // onFinished triggers exactly that — a second copy in this component is
      // how a number starts disagreeing with itself.
      onFinished();
    } finally {
      setTakeoutBusy(false);
    }
  };

  /**
   * The second half of "fetch the threads, then match". Matching during an
   * import can only see the threads that existed then, so an entry imported
   * before its thread was captured had nothing to match against.
   */
  const matchEntries = async () => {
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
  };

  /**
   * The export's links, on their own.
   *
   * The only route to the threads Google no longer lists, and for this archive
   * that is most of them: the sidebar holds a few hundred while the export holds
   * thousands with a link. Every page is checked against the export's own
   * reading before anything is stored, so a link that re-runs its prompt is
   * refused rather than written.
   */
  const fetchLinks = async () => {
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
  };

  /**
   * How much is left for "Catch up" to do: threads with no turns, threads the
   * repeated path has given up on, and threads whose export link has not been
   * opened. All three are outstanding, so all three are counted.
   *
   * The given-up ones belong here specifically because leaving them out is what
   * made the button appear broken — it read "Catch up (2)" while eighteen
   * capturable threads sat behind a cap meant only to keep the REPEATED path
   * from grinding on them.
   *
   * A label, not a bound: the main process takes whatever is actually
   * outstanding. A stale number used as a limit is how "Capture all (296)"
   * would have left seven behind.
   */
  const outstanding = remaining + stuck + linksToFetch;

  // Anything at all going on. The flows drive the same panel every other
  // operation does, so starting one on top of another means two runs clicking
  // the same sidebar.
  const running = busy || capturing || takeoutBusy || syncing !== null;

  const runSync = async (mode: 'new' | 'all') => {
    setSyncing(mode);
    setSync(null);
    // Both flows drive the real sidebar, so the panel has to be on screen for
    // the same reason a bare harvest does — with it hidden the thread rows are
    // in the DOM but laid out at zero size, and the run would "succeed" against
    // a stale copy.
    onNeedPanel();
    try {
      const result = await window.notebook.syncArchive(mode);
      setTakeoutNote(
        `${result.listed} new in the list · ${result.captured} read · ` +
          (mode === 'all' ? `${result.fetched} from links · ${result.matched} matched · ` : '') +
          `${result.errors} error${result.errors === 1 ? '' : 's'}` +
          (result.cancelled ? ' — stopped' : '') +
          (result.stoppedEarly ? ` — ${result.stoppedEarly}` : ''),
      );
      setLinksToFetch(await window.notebook.countLinksToFetch());
      onFinished();
    } catch (err) {
      setTakeoutNote(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(null);
      setSync(null);
    }
  };

  const startCapture = async (limit: number, includeExhausted = false) => {
    setCapturing(true);
    setCapture(null);
    // Capture drives the real sidebar, so the panel has to be on screen for the
    // same reason harvesting does.
    onNeedPanel();
    try {
      await window.notebook.captureTurns(limit, includeExhausted);
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

  /**
   * The menu is the other way in, and it runs the SAME handlers the toolbar
   * buttons ran — not a second copy of the work. Every one of these reports into
   * this component's status line, which a menu click has no way to reach from
   * the main process.
   *
   * Held in a ref refreshed after every render, because the listener is
   * registered once: a handler captured at mount would close over the first
   * render's state, and "Import it" would forever see whatever export was loaded
   * when the window opened.
   */
  const commands = useRef<Record<string, () => void>>({});
  useEffect(() => {
    commands.current = {
      harvest: start,
      capture: () => startCapture(CAPTURE_ALL_LIMIT),
      retryStuck: () => startCapture(CAPTURE_ALL_LIMIT, true),
      // Reports through the capture strip like every other capture, rather
      // than into the status note. It broadcasts the same progress events, so a
      // hand-written summary here was a second account of one run — and the one
      // that could not show a live count during a run measured in hours.
      rereadAll: async () => {
        setCapturing(true);
        setCapture(null);
        onNeedPanel();
        try {
          await window.notebook.rereadAllFromThreads(CAPTURE_ALL_LIMIT);
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
      },
      fetchLinks,
      recoverLinks: async () => {
        setTakeoutBusy(true);
        try {
          const r = await window.notebook.recoverTakeoutLinks();
          setTakeoutNote(
            `${r.records} link${r.records === 1 ? '' : 's'} written down as records` +
              (r.urls ? ` · ${r.urls} entries given their own url` : '') +
              (r.skipped ? ` · ${r.skipped} payloads held no usable link` : '') +
              ' — Read from links can see them now',
          );
          onFinished();
        } finally {
          setTakeoutBusy(false);
        }
      },
      scanTakeout,
      applyTakeout,
      undoImport,
      checkCopies,
      foldSameInstant: async () => {
        setTakeoutBusy(true);
        try {
          const r = await window.notebook.foldSameInstantDuplicates();
          setTakeoutNote(
            `${r.folded} thread${r.folded === 1 ? '' : 's'} folded across ${r.groups} ` +
              `group${r.groups === 1 ? '' : 's'}` +
              (r.turnsMoved ? ` · ${r.turnsMoved} turns moved onto the keepers` : ''),
          );
          onFinished();
        } finally {
          setTakeoutBusy(false);
        }
      },
      foldAdopted: async () => {
        setTakeoutBusy(true);
        try {
          const r = await window.notebook.foldAdoptedDuplicates();
          setTakeoutNote(
            `${r.folded} duplicate${r.folded === 1 ? '' : 's'} folded · ` +
              `${r.turnsMoved} turns and ${r.imagesMoved} images moved onto the originals`,
          );
          onFinished();
        } finally {
          setTakeoutBusy(false);
        }
      },
      foldEmpty: async () => {
        setTakeoutBusy(true);
        try {
          const r = await window.notebook.foldEmptyDuplicates();
          setTakeoutNote(`${r.folded} empty duplicate${r.folded === 1 ? '' : 's'} folded in`);
          onFinished();
        } finally {
          setTakeoutBusy(false);
        }
      },
      linkFailures,
      moveInlineImages,
      matchEntries,
    };
  });
  useEffect(
    () =>
      window.notebook.onMenuCommand((name) => {
        const run = commands.current[name];
        // A menu item naming a command that does not exist is a wiring mistake,
        // and a silent no-op is exactly how it would go unnoticed.
        if (!run) {
          setTakeoutNote(`no such command: ${name}`);
          return;
        }
        // Caught HERE as well as globally. Several of these handlers use
        // try/finally with no catch, so a failure cleared the busy flag and said
        // nothing — and the strip is where the person is looking, not a banner
        // at the top of the window.
        try {
          const result = run() as unknown;
          if (result instanceof Promise) {
            result.catch((err: unknown) =>
              setTakeoutNote(
                `${name} failed — ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        } catch (err) {
          setTakeoutNote(`${name} failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    [],
  );

  const pct =
    progress && progress.expected > 0
      ? Math.min(100, Math.round((progress.found / progress.expected) * 100))
      : 0;

  return (
    <div className="harvest-bar">
      {/* What is left here are the RUNS: the operations that take minutes, get
          started repeatedly, and need somewhere to report progress to.

          Everything else moved to the menu — refreshing the sidebar list,
          reading an export, undoing one, and the four repair and diagnostic
          actions. Each is a deliberate one-off done once and not thought about
          again, and eight of them sharing a row with the buttons actually used
          every day made neither easy to find. They run the same handlers from
          there, and still report into the status line at the end of this bar.

          Anything mid-run stays visible regardless: hiding a Stop button in a
          menu would be indefensible. */}
      {busy && (
        <>
          <span className="harvest-status">Harvesting…</span>
          <button type="button" onClick={() => window.notebook.cancelHarvest()}>
            Stop
          </button>
        </>
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

      {(takeoutBusy || takeout) && <span className="harvest-sep" />}

      {/* Not moved to the menu, because it is not a one-off: it is the
          follow-through of a flow already under way, and it only exists while an
          export is loaded and waiting for a decision. The report itself carries
          the primary Import; this is the way back to that decision once the
          report has been closed. */}
      {takeout && (
        <button type="button" onClick={applyTakeout} disabled={takeoutBusy}>
          Import it
        </button>
      )}
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

      {/* Two buttons, in place of the six that used to stand here.

          There were three separate ways to pull conversations in — refresh the
          sidebar list, capture turns from the panel, open the export's links —
          plus a 25-at-a-time variant of one of them, plus a match afterwards,
          and every one was its own button that had to be pressed in the right
          order to be any use. Nothing on screen said what that order was.

          In practice there are two things anyone wants: what arrived since last
          time, and everything still outstanding. Same steps in the same order;
          the second simply does not stop early. Each step is still reachable on
          its own from the Threads menu, for when one specific thing is wanted.

          Deliberately NOT bounded by the counts beside them. Those numbers are
          labels and a stale one would silently stop a run short — the reason
          "Capture all (296)" was never allowed to pass 296 to the main
          process. */}
      <button
        type="button"
        onClick={() => runSync('new')}
        disabled={running}
        title="Refreshes the thread list from Google and reads anything new. Minutes."
      >
        {syncing === 'new' ? 'Getting new…' : 'Get new'}
      </button>
      {outstanding > 0 && (
        <button
          type="button"
          onClick={() => runSync('all')}
          disabled={running}
          title="Everything still outstanding, including the threads Google no longer lists and only the export links to. Hours — safe to leave running, and Stop works at any point."
        >
          {syncing === 'all' ? 'Catching up…' : `Catch up (${outstanding})`}
        </button>
      )}
      {syncing && (
        <button type="button" onClick={() => window.notebook.cancelSync()}>
          Stop
        </button>
      )}
      {/* The outline over the top of whatever the current step is reporting. A
          four-step run that only ever showed the step it was on gave no way to
          tell "nearly done" from "just started". */}
      {sync?.running && (
        <span className="harvest-status">
          {sync.step} — step {sync.index} of {sync.steps}
        </span>
      )}
      {/* A capture started on its own from the menu has its own Stop. Hidden
          while a sync is running, which has one of its own that stops the whole
          sequence rather than only the step it is on. */}
      {capturing && !syncing && (
        <button type="button" onClick={() => window.notebook.cancelCapture()}>
          Stop
        </button>
      )}
      {capture ? (
        <span className={capture.phase === 'error' ? 'harvest-status error' : 'harvest-status'}>
          {capture.phase === 'error'
            ? capture.error
            : capture.phase === 'capturing'
              ? // Attempts first, because that is the number that moves. Showing
                // captured alone read "3/21" for minutes on a run that was
                // working through all 21 and failing them — which looks exactly
                // like a loop, and was reported as one.
                // One line, each number once. Attempts first because that is
                // the figure that always moves; everything else appears only
                // when it is non-zero, so a clean run stays short.
                `${capture.attempted ?? capture.done}/${capture.total}` +
                (capture.attempted && capture.attempted !== capture.done
                  ? ` · ${capture.done} ok`
                  : '') +
                (capture.rejected ? ` · ${capture.rejected} no match` : '') +
                (capture.notReady ? ` · ${capture.notReady} slow` : '') +
                (capture.errors ? ` · ${capture.errors} failed` : '') +
                (capture.unlisted ? ` · ${capture.unlisted} gone` : '') +
                ` · ${capture.current ?? ''}`
              : `${capture.done} captured · ${capture.turns ?? 0} turns · ${
                  capture.images ?? 0
                } images${
                  // Reported apart from failures: a thread Google no longer
                  // lists is not a failure, it is a thread that has left the
                  // history, and calling it an error invites retrying something
                  // that can never work.
                  capture.unlisted ? ` · ${capture.unlisted} no longer listed` : ''
                }${capture.errors ? ` · ${capture.errors} failed` : ''}${
                  // Named rather than left as a silently smaller queue. These
                  // are threads the run chose not to attempt, which is a
                  // different thing from threads it finished.
                  capture.exhausted ? ` · ${capture.exhausted} given up on` : ''
                }${
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
