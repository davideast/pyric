import type { KeyboardEvent, ReactNode } from 'react';
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
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
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
  onKeyDown,
}: ActivityGridRowProps): ReactNode {
  const when = formatWhen
    ? formatWhen(row.at, now ?? Date.now())
    : row.when || defaultFormatWhen(row.at, now ?? Date.now());

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const root = e.currentTarget.closest('[data-pyric-ui="activity-grid"]');
      if (root) {
        const rows = Array.from(
          root.querySelectorAll<HTMLButtonElement>('[data-pyric-event-row]'),
        );
        const idx = rows.indexOf(e.currentTarget);
        if (idx >= 0 && idx < rows.length - 1) {
          rows[idx + 1].focus();
        }
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const root = e.currentTarget.closest('[data-pyric-ui="activity-grid"]');
      if (root) {
        const rows = Array.from(
          root.querySelectorAll<HTMLButtonElement>('[data-pyric-event-row]'),
        );
        const idx = rows.indexOf(e.currentTarget);
        if (idx > 0) {
          rows[idx - 1].focus();
        }
      }
    }
  };

  return (
    <button
      type="button"
      role="row"
      aria-selected={selected ? true : false}
      onClick={() => onSelect?.(row)}
      onKeyDown={handleKeyDown}
      className={className}
      data-pyric-event-row=""
      data-pyric-event-band={row.band}
      data-pyric-event-service={row.service}
      data-pyric-event-lens={row.authLens.mode}
      data-pyric-event-actor={row.actor.kind}
      data-pyric-event-denied={row.denied ? '' : undefined}
      data-pyric-selected={selected ? '' : undefined}
    >
      <span data-pyric-event-target="" role="gridcell">{row.target}</span>
      <span data-pyric-event-change="" role="gridcell">{row.change}</span>
      <span data-pyric-event-for="" role="gridcell">{row.for}</span>
      <span data-pyric-event-lens="" role="gridcell">{row.lens}</span>
      <span data-pyric-event-when="" role="gridcell">{when}</span>
    </button>
  );
}
