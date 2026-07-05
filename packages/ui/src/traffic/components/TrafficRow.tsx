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
  /** Override the timestamp rendering. Default is `HH:MM:SS`. */
  formatTime?: (at: number) => string;
  className?: string;
}

/**
 * One headless traffic row — timestamp, method badge, path, result
 * badge, and an optional consumer classification slot. Latency is
 * intentionally absent: this is a local simulator, so `evalMs` lives
 * in `<TrafficDetail>` only.
 *
 * Styling hooks:
 * - `[data-pyric-traffic-row]` — the row button, with
 *   `data-pyric-result`, `data-pyric-origin`, `data-pyric-method`
 * - `[data-pyric-traffic-row][data-pyric-selected]` — active row
 * - `[data-pyric-traffic-time]` / `[data-pyric-traffic-path]`
 * - method + result render as `<Badge>` (`data-pyric-badge-kind`)
 */
export function TrafficRow({
  event,
  selected,
  onSelect,
  renderClassification,
  formatTime = defaultFormatTime,
  className,
}: TrafficRowProps) {
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
    >
      <span data-pyric-traffic-time="">{formatTime(event.at)}</span>
      <Badge kind={event.method}>{event.method}</Badge>
      <span data-pyric-traffic-path="">{event.path}</span>
      <Badge kind={event.result}>{event.result}</Badge>
      {renderClassification ? renderClassification(event) : null}
    </button>
  );
}
