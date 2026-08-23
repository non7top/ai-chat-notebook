import type { TakeoutPreview } from '../shared/types';
import type { TakeoutScan } from './parseTakeout';

export interface TakeoutReportData {
  folder: string;
  scan: TakeoutScan;
  sweep: TakeoutPreview;
  /**
   * Carried with the report so the decision sits next to what it is based on.
   * The import needs the picked folder and the parsed entries, which live where
   * the scan happened — passing them through the report would mean a second
   * copy of the rows the sweep already described.
   */
  apply: () => Promise<void>;
}

interface Props {
  report: TakeoutReportData;
  busy: boolean;
  onApply: () => void;
  onClose: () => void;
}

/**
 * What an export contains and what importing it would do.
 *
 * This used to be one line in the toolbar. It reached roughly four hundred
 * characters — counts, samples of unreadable dates, the whole sweep — inside a
 * span in a flex row, so most of it was simply cut off. The information was
 * being produced and then thrown away at the last step, which is worse than not
 * gathering it: it reads as though the app has nothing more to say.
 *
 * Threads come first because they are the decision. Everything below is why the
 * numbers are what they are.
 */
export default function TakeoutReport({ report, busy, onApply, onClose }: Props) {
  const { scan, sweep } = report;
  // A conversation already here that the import would re-read: matched to a
  // harvested or captured one, or updating one an earlier import created.
  const existing = sweep.wouldEnrich + sweep.wouldUpdate;
  const problems =
    scan.nestedCells +
    scan.emptyCells +
    scan.unparsedDateText +
    sweep.wouldOrphan +
    scan.multiStampEntries;

  return (
    <div className="report">
      <div className="report-head">
        <h2>Takeout export</h2>
        <button type="button" disabled={busy} onClick={onApply}>
          {busy ? 'Importing…' : 'Import'}
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="report-body">
        <p className="report-path" title={report.folder}>
          {report.folder}
        </p>

        {/* "Conversations", not "threads" and not "entries". The export records
            one entry per submission, so entry counts are several times larger
            than the number of conversations and reading them as threads is
            simply wrong — 1779 of them for an account holding about 300. */}
        <h3>Conversations</h3>
        <p className="report-figure new">+{sweep.wouldCreate} new</p>
        <p className="report-figure">
          ={existing} already here
          <span className="report-aside"> — re-read and refreshed, not duplicated</span>
        </p>
        <p className="report-note">
          From {sweep.entries} entries in the file, describing {sweep.conversations}{' '}
          conversations
          {sweep.snapshotsFolded > 0 && (
            <>
              {' '}— {sweep.snapshotsFolded} of those entries are earlier snapshots of a
              conversation another entry carries further, folded in rather than made into
              conversations of their own
            </>
          )}
          .
        </p>
        {sweep.ambiguous > 0 && (
          <p className="report-figure warn">
            {sweep.ambiguous} share an opening prompt
            <span className="report-aside">
              {' '}
              — nothing can tell which conversation is which, so each stands alone until
              you glue them
            </span>
          </p>
        )}
        {sweep.alreadyKnown > 0 && (
          <p className="report-note">
            {sweep.alreadyKnown} of these entries are already stored from an earlier import.
          </p>
        )}

        <h3>The file</h3>
        <dl className="report-facts">
          <dt>Entries</dt>
          <dd>
            {scan.entryCount} cells, {scan.aiModeEntries} of them AI Mode
          </dd>
          <dt>With a prompt</dt>
          <dd>{scan.withQuery}</dd>
          <dt>Turns</dt>
          <dd>
            {scan.turnCounts.total} across all entries — fewest {scan.turnCounts.min}, typical{' '}
            {scan.turnCounts.median}, most {scan.turnCounts.max}; {scan.multiTurnEntries} run
            past a single exchange
          </dd>
          <dt>Images</dt>
          <dd>
            {scan.withImages} entries reference one, {scan.imageRefsTotal} references in total
          </dd>
          <dt>Dated</dt>
          <dd>
            {scan.withTimestamp}
            {scan.noDateText > 0 && `, ${scan.noDateText} carry no date at all`}
          </dd>
        </dl>

        {/* Always shown. A real entry has one timestamp, one search link and at
            least one turn; anything else in this list is a cell that is not an
            entry, and every count above is then measuring the wrong thing. */}
        <h3>Cell shapes</h3>
        <ul className="report-shapes">
          {scan.cellShapes.map((row) => (
            <li key={row.shape}>
              <span className="report-shape-count">{row.count}</span> {row.shape}
            </li>
          ))}
        </ul>

        {problems > 0 && <h3>Worth knowing</h3>}

        {/* Must never be quiet. A nested cell means the same conversation is
            counted more than once and every number above inherits the error. */}
        {scan.nestedCells > 0 && (
          <p className="report-figure bad">
            {scan.nestedCells} cells sit inside another cell
            <span className="report-aside">
              {' '}
              — those conversations are counted twice and their turns are merged into the
              outer one. Do not import until this is fixed.
            </span>
          </p>
        )}

        {sweep.wouldOrphan > 0 && (
          <p className="report-figure">
            {sweep.wouldOrphan} entries have no prompt
            <span className="report-aside">
              {' '}
              — kept in full under Orphan entries rather than discarded, since nothing here
              can say which conversation they belong to
            </span>
          </p>
        )}

        {/* The decisive figure for a turn count that looks impossible. A
            submission carries exactly one timestamp and one search link, so a
            cell holding several holds several submissions — and only the first
            date and first query of those are recorded while every turn is glued
            together. */}
        {scan.multiStampEntries > 0 && (
          <p className="report-figure bad">
            {scan.multiStampEntries} cells contain more than one submission
            <span className="report-aside">
              {' '}
              — up to {scan.maxStamps} in one. Those conversations are run together: only
              the first date and first prompt of each cell are kept. Do not import until
              this is fixed.
            </span>
          </p>
        )}

        {/* Reported even when nothing is wrong, because it is the answer to
            "where does a 190-turn entry come from" — one timestamp and one link
            means one long conversation; more means several merged. */}
        {scan.largestEntry.turns > 2 * scan.turnCounts.median && (
          <p className="report-figure">
            Longest entry: {scan.largestEntry.turns} turns
            <span className="report-aside">
              {' '}
              — with {scan.largestEntry.stamps} timestamp
              {scan.largestEntry.stamps === 1 ? '' : 's'} and {scan.largestEntry.links} search
              link{scan.largestEntry.links === 1 ? '' : 's'} in the same cell.{' '}
              {scan.largestEntry.stamps <= 1 && scan.largestEntry.links <= 1
                ? 'One of each, so this is a single long conversation.'
                : 'More than one of either means separate submissions were merged into it.'}
            </span>
          </p>
        )}

        {scan.emptyCells > 0 && (
          <p className="report-figure">
            {scan.emptyCells} cells are empty
            <span className="report-aside"> — no prompt, no turns, no images</span>
          </p>
        )}

        {scan.unparsedDateText > 0 && (
          <>
            <p className="report-figure warn">
              {scan.unparsedDateText} dates could not be read
              <span className="report-aside">
                {' '}
                — the date is in the file and this parser does not understand its shape. A
                bug here, not a gap in the export.
              </span>
            </p>
            {/* Verbatim, because the pattern has to be fixed against real input
                rather than guessed at. Dates only — never conversation text. */}
            <ul className="report-samples">
              {scan.unparsedDateSamples.map((sample) => (
                <li key={sample}>{sample}</li>
              ))}
            </ul>
          </>
        )}

        {problems === 0 && <p className="report-note">Nothing unusual in this export.</p>}
      </div>
    </div>
  );
}
