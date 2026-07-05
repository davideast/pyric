import type { ReactNode } from 'react';
import type { ActivityRow } from '../digest.js';
import { defaultFormatWhen } from './format.js';

export interface ActivityGridRowProps {
  row: ActivityRow;
  /** Marks the row as the active selection (`data-pyric-selected`). */
  selected?: boolean;
  onSelect?: (row: ActivityRow) => void;
  /** Override the `when` rendering. Receives `(at, now)`; default is the
   *  session-relative duration. */
  formatWhen?: (at: number, now: number) => string;
  /** The "now" anchor passed to `formatWhen` (and `row.when` is used as
   *  a fallback when omitted). */
  now?: number;
  className?: string;
}

/**
 * One activity grid row — the `target · change · for · lens · when`
 * column contract from `c-result.html`, plus a trailing drill affordance
 * column. Headless: every cell is a `data-pyric-event-*` span the host
 * styles into the rigid column grid.
 *
 * Styling / data contract:
 * - `[data-pyric-event-row]` — the row, with `data-pyric-event-band`,
 *   `data-pyric-event-service`, `data-pyric-event-lens`,
 *   `data-pyric-event-denied` (present only on denials), and
 *   `data-pyric-selected` when active.
 * - `[data-pyric-event-target]` / `-change` / `-for` / `-lens` / `-when`
 *   — the five columns, in order.
 */
export function ActivityGridRow({
  row,
  selected,
  onSelect,
  formatWhen,
  now,
  className,
}: ActivityGridRowProps): ReactNode {
  const when = formatWhen
    ? formatWhen(row.at, now ?? Date.now())
    : row.when || defaultFormatWhen(row.at, now ?? Date.now());

  return (
    <button
      type="button"
      onClick={() => onSelect?.(row)}
      className={className}
      data-pyric-event-row=""
      data-pyric-event-band={row.band}
      data-pyric-event-service={row.service}
      data-pyric-event-lens={row.authLens.mode}
      data-pyric-event-actor={row.actor.kind}
      data-pyric-event-denied={row.denied ? '' : undefined}
      data-pyric-selected={selected ? '' : undefined}
    >
      <span data-pyric-event-target="">{row.target}</span>
      <span data-pyric-event-change="">{row.change}</span>
      <span data-pyric-event-for="">{row.for}</span>
      <span data-pyric-event-lens="">{row.lens}</span>
      <span data-pyric-event-when="">{when}</span>
    </button>
  );
}
