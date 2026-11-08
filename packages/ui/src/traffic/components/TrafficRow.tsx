import type { ReactNode } from 'react';
import { Badge } from '../../primitives/Badge.js';
import type { TrafficEvent } from '../types.js';
import { defaultFormatTime } from './format.js';

export interface TrafficRowProps {
  event: TrafficEvent;
  /** Marks the row as the active selection (`data-pyric-selected`). */
  selected?: boolean;
  onSelect?: (event: TrafficEvent) => void;
  /**
   * Render-prop slot for a consumer-specific classification badge —
   * e.g. the playground's `expected`/`ambiguous`/`unexpected`
   * verdict, which is app-source analysis the library doesn't own.
   * Returns `null` to render nothing.
   */
  renderClassification?: (event: TrafficEvent) => ReactNode;
  /**
   * Render-prop slot after the time and before the service, such as what
   * served the op. A row with a lead (`data-pyric-lead`) renders its method
   * as plain text (`[data-pyric-traffic-method]`, the full name in `title`)
   * instead of a badge, so a consumer can lay every cell on one grid.
   */
  renderLead?: (event: TrafficEvent) => ReactNode;
  /** The method text a lead row shows. Default is the method as recorded. */
  formatMethod?: (method: string) => string;
  /**
   * Whether the row's detail is open under it (`aria-expanded`). Any boolean
   * marks the row as one that expands and adds a chevron
   * (`[data-pyric-traffic-chevron]`); absent means the row does not expand.
   */
  expanded?: boolean;
  /** Override the timestamp rendering. Default is `HH:MM:SS`. */
  formatTime?: (at: number) => string;
  className?: string;
}

function asRecorded(method: string): string {
  return method;
}

/**
 * One headless traffic row — timestamp, method badge, path, and an
 * optional consumer classification slot. The raw result is exposed as
 * `data-pyric-result` on the row (for tinting/filtering); rendering a
 * verdict/outcome label is the consumer's job via
 * `renderClassification` — the row itself draws no result chip, so a
 * consumer verdict never collides with a built-in one. Latency is
 * intentionally absent: this is a local simulator, so `evalMs` lives
 * in `<TrafficDetail>` only.
 *
 * Styling hooks:
 * - `[data-pyric-traffic-row]` — the row button, with
 *   `data-pyric-result`, `data-pyric-origin`, `data-pyric-method`
 * - `[data-pyric-traffic-row][data-pyric-selected]` — active row
 * - `[data-pyric-traffic-row][data-pyric-lead]` — a row with a lead slot
 * - `[data-pyric-traffic-time]` / `[data-pyric-traffic-path]`
 * - `[data-pyric-traffic-service]` — the service label (firestore / rtdb /
 *   storage / auth), rendered even when unknown (empty) so fixed-width
 *   styling keeps the columns aligned
 * - method renders as `<Badge>` (`data-pyric-badge-kind`), or on a lead row
 *   as `[data-pyric-traffic-method]`
 * - `[data-pyric-traffic-chevron]` — the disclosure mark of a row that expands
 */
export function TrafficRow({
  event,
  selected,
  onSelect,
  renderClassification,
  renderLead,
  formatMethod = asRecorded,
  expanded,
  formatTime = defaultFormatTime,
  className,
}: TrafficRowProps) {
  const path = event.path || '/';
  const hasLead = renderLead !== undefined;
  return (
    <button
      type="button"
      onClick={() => onSelect?.(event)}
      className={className}
      data-pyric-traffic-row=""
      data-pyric-result={event.result}
      data-pyric-origin={event.origin}
      data-pyric-method={event.method}
      data-pyric-selected={selected ? '' : undefined}
      data-pyric-lead={hasLead ? '' : undefined}
      aria-expanded={expanded}
    >
      <span data-pyric-traffic-time="">{formatTime(event.at)}</span>
      {hasLead ? renderLead(event) : null}
      <span data-pyric-traffic-service={event.service ?? ''}>{event.service ?? ''}</span>
      {hasLead ? (
        <span data-pyric-traffic-method="" title={event.method}>{formatMethod(event.method)}</span>
      ) : (
        <Badge kind={event.method}>{event.method}</Badge>
      )}
      <span data-pyric-traffic-path="" title={hasLead ? path : undefined}>{path}</span>
      {renderClassification ? renderClassification(event) : null}
      {expanded === undefined ? null : <span data-pyric-traffic-chevron="" aria-hidden="true" />}
    </button>
  );
}
