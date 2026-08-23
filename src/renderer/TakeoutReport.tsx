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
    scan.nestedCells + scan.emptyCells + scan.unparsedDateText + sweep.wouldOrphan;

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

        <h3>Threads</h3>
        <p className="report-figure new">+{sweep.wouldCreate} new</p>
        <p className="report-figure">
          ={existing} already here
          <span className="report-aside"> — re-read and refreshed, not duplicated</span>
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
