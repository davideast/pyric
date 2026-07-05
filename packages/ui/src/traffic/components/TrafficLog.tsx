import type { ReactNode } from 'react';
import { VirtualList } from '../../primitives/VirtualList.js';
import type { TrafficEvent } from '../types.js';
import type { TrafficLogItem } from '../hooks/useTrafficGroups.js';
import { TrafficRow } from './TrafficRow.js';
import { TrafficGroupRow } from './TrafficGroupRow.js';

export interface TrafficLogProps {
  /** Events to render, in display order. The hook layer decides the
   *  order — `<TrafficLog>` renders the array as given. */
  events: TrafficEvent[];
  /**
   * Grouped items from `useTrafficGroups`. When provided, the log
   * renders singles + collapsible group rows and does NOT
   * virtualize — grouping is itself the volume reducer (a 250-event
   * listener storm becomes one group row). `events` is ignored.
   */
  items?: TrafficLogItem[];
  /** The selected event's id, marked with `data-pyric-selected`. */
  selectedId?: string;
  onSelect?: (event: TrafficEvent) => void;
  /** Passed through to each `<TrafficRow>`. */
  renderClassification?: (event: TrafficEvent) => ReactNode;
  /** Passed through to each `<TrafficRow>`. */
  formatTime?: (at: number) => string;
  /**
   * Full escape hatch — render a row yourself instead of the default
   * `<TrafficRow>`. Receives the event and its selected state.
   * Applies to the flat (`events`) path only.
   */
  renderRow?: (event: TrafficEvent, selected: boolean) => ReactNode;
  emptyState?: ReactNode;
  className?: string;
  /**
   * Above this row count, the list virtualizes via `<VirtualList>`.
   * Default 100 — a `load-test`-shaped session can emit 100k+ events,
   * so virtualization is load-bearing, not polish.
   */
  virtualizeThreshold?: number;
  /** Estimated row height when virtualizing. Default 28. */
  rowHeight?: number | ((index: number) => number);
  /** Pixel height the virtualized scroll container fills. Default
   *  `'60vh'`. */
  virtualizedHeight?: number | string;
}

/**
 * Headless traffic log — a Chrome DevTools Network-panel-style event
 * stream. Below `virtualizeThreshold` it renders a plain `<ul>`;
 * above it, TanStack-Virtual via `<VirtualList>`.
 *
 * Styling hooks: `[data-pyric-ui="traffic-log"]`,
 * `[data-pyric-traffic-entry]` (the list item wrapper), plus the
 * `<TrafficRow>` hooks.
 */
export function TrafficLog({
  events,
  items,
  selectedId,
  onSelect,
  renderClassification,
  formatTime,
  renderRow,
  emptyState,
  className,
  virtualizeThreshold = 100,
  rowHeight = 28,
  virtualizedHeight = '60vh',
}: TrafficLogProps) {
  // Grouped mode — singles + collapsible group rows, no virtualization.
  if (items !== undefined) {
    if (items.length === 0) {
      return (
        <div
          className={className}
          data-pyric-ui="traffic-log"
          data-pyric-empty=""
        >
          {emptyState}
        </div>
      );
    }
    return (
      <div className={className} data-pyric-ui="traffic-log" data-pyric-grouped="">
        <ul data-pyric-traffic-log-items="">
          {items.map((item) =>
            item.type === 'group' ? (
              <li key={item.key} data-pyric-traffic-group-entry="">
                <TrafficGroupRow
                  group={item}
                  onSelect={onSelect}
                  selectedId={selectedId}
                  renderClassification={renderClassification}
                  formatTime={formatTime}
                />
              </li>
            ) : (
              <li
                key={item.event.id}
                data-pyric-traffic-entry=""
                data-pyric-traffic-id={item.event.id}
              >
                <TrafficRow
                  event={item.event}
                  selected={item.event.id === selectedId}
                  onSelect={onSelect}
                  renderClassification={renderClassification}
                  formatTime={formatTime}
                />
              </li>
            ),
          )}
        </ul>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className={className} data-pyric-ui="traffic-log" data-pyric-empty="">
        {emptyState}
      </div>
    );
  }

  const row = (event: TrafficEvent): ReactNode => {
    const selected = event.id === selectedId;
    if (renderRow) return renderRow(event, selected);
    return (
      <TrafficRow
        event={event}
        selected={selected}
        onSelect={onSelect}
        renderClassification={renderClassification}
        formatTime={formatTime}
      />
    );
  };

  const virtualized = events.length > virtualizeThreshold;

  return (
    <div
      className={className}
      data-pyric-ui="traffic-log"
      data-pyric-virtualized={virtualized ? '' : undefined}
    >
      {virtualized ? (
        <VirtualList
          items={events}
          estimateSize={rowHeight}
          height={virtualizedHeight}
          getItemKey={(event) => event.id}
          renderItem={(event) => (
            <div data-pyric-traffic-entry="" data-pyric-traffic-id={event.id}>
              {row(event)}
            </div>
          )}
        />
      ) : (
        <ul data-pyric-traffic-log-items="">
          {events.map((event) => (
            <li
              key={event.id}
              data-pyric-traffic-entry=""
              data-pyric-traffic-id={event.id}
            >
              {row(event)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
