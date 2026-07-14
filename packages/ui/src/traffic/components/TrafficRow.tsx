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
 * - `[data-pyric-traffic-time]` / `[data-pyric-traffic-path]`
 * - `[data-pyric-traffic-service]` — the service label (firestore / rtdb /
 *   storage / auth), rendered even when unknown (empty) so fixed-width
 *   styling keeps the columns aligned
 * - method renders as `<Badge>` (`data-pyric-badge-kind`)
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
      <span data-pyric-traffic-service={event.service ?? ''}>{event.service ?? ''}</span>
      <Badge kind={event.method}>{event.method}</Badge>
      <span data-pyric-traffic-path="">{event.path || '/'}</span>
      {renderClassification ? renderClassification(event) : null}
    </button>
  );
}
