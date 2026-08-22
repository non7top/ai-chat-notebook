import { useEffect, useState } from 'react';
import type { CaptureProgress, HarvestProgress } from '../shared/types';

interface Props {
  /** Harvesting scrapes the live sidebar, so the panel has to be on screen. */
  onNeedPanel: () => void;
  onFinished: () => void;
}

const CAPTURE_BATCH = 25;

export default function HarvestBar({ onNeedPanel, onFinished }: Props) {
  const [progress, setProgress] = useState<HarvestProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [capture, setCapture] = useState<CaptureProgress | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);

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
          if (typeof next.remaining === 'number') setRemaining(next.remaining);
          onFinished();
        }
      }),
    [onFinished],
  );

  useEffect(() => {
    window.notebook.countChatsWithoutTurns().then(setRemaining);
  }, []);

  const startCapture = async () => {
    setCapturing(true);
    setCapture(null);
    // Capture drives the real sidebar, so the panel has to be on screen for the
    // same reason harvesting does.
    onNeedPanel();
    try {
      await window.notebook.captureTurns(CAPTURE_BATCH);
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

      <button type="button" onClick={startCapture} disabled={busy || capturing}>
        {capturing ? 'Capturing…' : `Capture ${CAPTURE_BATCH} conversations`}
      </button>
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
                }`}
        </span>
      ) : (
        remaining !== null &&
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
