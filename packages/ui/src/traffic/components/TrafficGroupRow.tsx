import { useState, type ReactNode } from 'react';
import type { TrafficEvent } from '../types.js';
import type { TrafficGroup } from '../hooks/useTrafficGroups.js';
import { TrafficRow } from './TrafficRow.js';
import type { TrafficGroupKind } from '../hooks/useTrafficGroups.js';

/** Header text per group kind — the raw kind slug stays on the
 *  `data-pyric-group-kind` attributes for styling/tests. */
const GROUP_KIND_LABELS: Record<TrafficGroupKind, string> = {
  batch: 'batch write',
  transaction: 'transaction',
  'listener-run': 'listener re-evals',
};

export interface TrafficGroupRowProps {
  group: TrafficGroup;
  /** Whether the group starts expanded. Default false — grouping
   *  exists to collapse volume, so collapsed is the useful default. */
  defaultExpanded?: boolean;
  onSelect?: (event: TrafficEvent) => void;
  selectedId?: string;
  /** Passed through to each member `<TrafficRow>`. */
  renderClassification?: (event: TrafficEvent) => ReactNode;
  /** Passed through to each member `<TrafficRow>`. */
  formatTime?: (at: number) => string;
  className?: string;
}

/**
 * A collapsible group row — one header summarizing a batch,
 * transaction, or listener-run, expanding to the member rows. The
 * header carries `data-pyric-group-kind` and a `data-pyric-group-*`
 * count/deny rollup; expansion state is `data-pyric-expanded`.
 *
 * Styling hooks: `[data-pyric-traffic-group]`,
 * `[data-pyric-traffic-group-header]` (with `data-pyric-group-kind`),
 * `[data-pyric-traffic-group-members]`.
 */
export function TrafficGroupRow({
  group,
  defaultExpanded = false,
  onSelect,
  selectedId,
  renderClassification,
  formatTime,
  className,
}: TrafficGroupRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      className={className}
      data-pyric-traffic-group=""
      data-pyric-group-kind={group.kind}
      data-pyric-expanded={expanded ? '' : undefined}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        data-pyric-traffic-group-header=""
        data-pyric-group-kind={group.kind}
        aria-expanded={expanded}
      >
        <span data-pyric-group-kind-label="">{GROUP_KIND_LABELS[group.kind]}</span>
        <span data-pyric-group-count="">×{group.count}</span>
        {group.denies > 0 ? (
          <span data-pyric-group-denies="">{group.denies} denied</span>
        ) : null}
      </button>
      {expanded ? (
        <ul data-pyric-traffic-group-members="">
          {group.events.map((event) => (
            <li
              key={event.id}
              data-pyric-traffic-entry=""
              data-pyric-traffic-id={event.id}
            >
              <TrafficRow
                event={event}
                selected={event.id === selectedId}
                onSelect={onSelect}
                renderClassification={renderClassification}
                formatTime={formatTime}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
