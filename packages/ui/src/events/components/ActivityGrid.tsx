import type { ReactNode } from 'react';
import type { AnyActivityEvent } from '../types.js';
import {
  computeActivityDigest,
  type ActivityBandWithGroups,
  type ActivityDigest,
  type ActivityDigestOptions,
  type ActivityRow,
} from '../digest.js';
import { ActivityGridRow } from './ActivityGridRow.js';

export interface ActivityGridProps {
  /**
   * The unified event stream — `sandbox.history()` and/or a live buffer
   * (see `useActivityStream`). The grid folds it into the banded digest
   * internally. Mutually exclusive with `digest`.
   */
  events?: readonly AnyActivityEvent[];
  /**
   * A precomputed digest from `useActivityDigest` / `computeActivity
   * Digest`. Pass this when the host already memoizes the fold (so the
   * grid doesn't recompute). Mutually exclusive with `events`.
   */
  digest?: ActivityDigest;
  /** Grouping / ordering options, forwarded to the reducer when the grid
   *  folds `events` itself. Ignored when `digest` is supplied. */
  options?: ActivityDigestOptions & { now?: number };
  /** The selected row id (`data-pyric-selected`). */
  selectedId?: string;
  onSelect?: (row: ActivityRow) => void;
  /** Clamp rows shown per band; the rest collapse into a "N more" stub.
   *  Independent of the reducer's `rowsPerBand` (which trims the data) —
   *  this is a pure display clamp that keeps the true count visible.
   *  Default: show all rows. */
  maxRowsPerBand?: number;
  /** Render the per-band overflow stub. Default renders a
   *  `[data-pyric-band-more]` element reading "N more {label}". */
  renderBandMore?: (band: ActivityBandWithGroups, hidden: number) => ReactNode;
  /** Override the `when` column rendering. */
  formatWhen?: (at: number, now: number) => string;
  /** "Now" anchor for `formatWhen`. */
  now?: number;
  /** Shown when the digest has no rows. */
  emptyState?: ReactNode;
  className?: string;
  /** Render a leading column-header row (`target change for lens when`).
   *  Default true — matches the mock's `.colhead`. */
  showColumnHeader?: boolean;
}

const COLUMN_HEADERS = ['target', 'change', 'for', 'as', 'when'] as const;

/**
 * Headless activity grid over the unified `SandboxEvent` stream. Folds
 * events into category bands (Denied / Added / Updated / Removed /
 * Signed in / …), each band a `target · change · for · lens · when`
 * column grid grouped under a `label · count · attribution` header.
 * Denials lead (lead-with-consequence) and are flagged first-class.
 *
 * Ships ZERO styling — the host (Pyric Studio) applies the rigid column
 * grid + band typography via the `data-pyric-*` contract:
 * - `[data-pyric-ui="activity-grid"]` — the root.
 * - `[data-pyric-band]` — a band header, with `data-pyric-band-key`,
 *   `data-pyric-band-count`, `data-pyric-band-denied` (on the denied
 *   band). Children: `[data-pyric-band-label]`, `[data-pyric-band-n]`,
 *   `[data-pyric-band-attr]` (omitted when attribution is mixed).
 * - `[data-pyric-band-rows]` — the row container; with grouping,
 *   `[data-pyric-band-subgroup]` (+ `data-pyric-subgroup-key`) wraps
 *   each pivot bucket.
 * - `[data-pyric-band-more]` — the "N more" overflow stub.
 * - the `<ActivityGridRow>` contract for each row.
 */
export function ActivityGrid({
  events,
  digest,
  options,
  selectedId,
  onSelect,
  maxRowsPerBand,
  renderBandMore,
  formatWhen,
  now,
  emptyState,
  className,
  showColumnHeader = true,
}: ActivityGridProps): ReactNode {
  const model: ActivityDigest =
    digest ?? computeActivityDigest(events ?? [], options ?? {});

  if (model.total === 0) {
    return (
      <div
        className={className}
        data-pyric-ui="activity-grid"
        data-pyric-empty=""
      >
        {emptyState}
      </div>
    );
  }

  const renderRow = (row: ActivityRow): ReactNode => (
    <ActivityGridRow
      key={row.id}
      row={row}
      selected={row.id === selectedId}
      onSelect={onSelect}
      formatWhen={formatWhen}
      now={now}
    />
  );

  const renderBandBody = (band: ActivityBandWithGroups): ReactNode => {
    const shown =
      maxRowsPerBand !== undefined
        ? band.rows.slice(0, maxRowsPerBand)
        : band.rows;
    const hidden = band.count - shown.length;

    // Grouped: render pivot buckets, preserving the band's row order
    // within each. We re-bucket the *shown* rows so the display clamp
    // and the pivot compose.
    let body: ReactNode;
    if (band.subgroups) {
      const shownIds = new Set(shown.map((r) => r.id));
      const buckets = band.subgroups
        .map((g) => ({
          ...g,
          rows: g.rows.filter((r) => shownIds.has(r.id)),
        }))
        .filter((g) => g.rows.length > 0);
      body = buckets.map((g) => (
        <div
          key={g.key}
          data-pyric-band-subgroup=""
          data-pyric-subgroup-key={g.key}
          data-pyric-subgroup-count={g.count}
        >
          {g.rows.map(renderRow)}
        </div>
      ));
    } else {
      body = shown.map(renderRow);
    }

    return (
      <div data-pyric-band-rows="">
        {body}
        {hidden > 0
          ? renderBandMore
            ? renderBandMore(band, hidden)
            : (
                <div data-pyric-band-more="">
                  {hidden} more {band.label.toLowerCase()}
                </div>
              )
          : null}
      </div>
    );
  };

  return (
    <div className={className} data-pyric-ui="activity-grid">
      {showColumnHeader ? (
        <div data-pyric-event-colhead="">
          {COLUMN_HEADERS.map((h) => (
            <span key={h} data-pyric-event-col={h}>
              {h}
            </span>
          ))}
        </div>
      ) : null}

      {model.bands.map((band) => (
        <section
          key={band.key}
          data-pyric-band-section=""
          data-pyric-band-key={band.key}
        >
          <header
            data-pyric-band=""
            data-pyric-band-key={band.key}
            data-pyric-band-count={band.count}
            data-pyric-band-denied={band.key === 'denied' ? '' : undefined}
          >
            <span data-pyric-band-label="">{band.label}</span>
            <span data-pyric-band-n="">{band.count}</span>
            {band.attribution ? (
              <span data-pyric-band-attr="">{band.attribution}</span>
            ) : null}
          </header>
          {renderBandBody(band)}
        </section>
      ))}
    </div>
  );
}
