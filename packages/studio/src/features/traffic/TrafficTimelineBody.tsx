/**
 * Timeline subview of the Traffic surface: volume-over-time histogram,
 * verdict + Firestore database filter strip, standalone inspector disclosure,
 * and grouped request stream.
 */

import type { ReactNode } from 'react';
import {
  TrafficGroupRow,
  TrafficRow,
  TrafficTimeline,
  defaultFormatTime,
  type TrafficLogItem,
  type TimeWindow,
} from '@pyric/ui/traffic';
import { DEFAULT_FIRESTORE_DATABASE } from 'pyric/firestore/internal';
import type { LiveHostStatus } from 'pyric/sandbox/internal';
import { STUDIO_EVENT_CAP } from '../../shell/studio-events.js';
import type { FirestoreDatabaseFilter } from './firestore-database-filter.js';
import {
  opensLiveRulesInspector,
  opensRulesInspector,
  rowNavigationTarget,
  verdictFor,
  verdictLabel,
  VERDICT_FILTERS,
  type StudioTrafficEvent,
  type VerdictFilter,
} from './verdict.js';
import { TrafficInspectedDetail } from './TrafficLiveRulesDetail.js';
import {
  TrafficTimeFocusBanner,
  formatTrafficWindowRange,
  type TrafficFocusedInterval,
} from './TrafficNotices.js';
import {
  LiveRowDetail,
  LiveTrafficRow,
  StandaloneDetail,
  VerdictCell,
} from './TrafficLiveRow.js';

/** A coarse "Nm ago" for the timeline's left axis tick. */
function relAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Whether a row's click opens the rules view in place. */
export function opensTrafficRowDetail(event: StudioTrafficEvent): boolean {
  return opensRulesInspector(event) || opensLiveRulesInspector(event);
}

function isRowInteractive(event: StudioTrafficEvent): boolean {
  return opensTrafficRowDetail(event) || rowNavigationTarget(event) !== null;
}

function emptyTrafficMessage(hasFocus: boolean, verdictFilter: VerdictFilter): string {
  if (hasFocus) {
    if (verdictFilter === 'all') return 'No requests occurred in the selected interval.';
    return `No ${verdictFilter} traffic occurred in the selected interval.`;
  }
  if (verdictFilter === 'all') {
    return 'No requests yet. Reads, writes, and listeners against the sandbox stream in live.';
  }
  return `No ${verdictFilter} traffic in this session.`;
}

function renderTrafficEntryItem(
  item: TrafficLogItem,
  expandedId: string | null,
  isLiveHost: boolean,
  liveHost: LiveHostStatus | null,
  events: StudioTrafficEvent[],
  onRowSelect: (event: StudioTrafficEvent) => void,
  closeInspect: () => void,
  verdictBadge: (event: StudioTrafficEvent) => ReactNode,
): ReactNode {
  if (item.type === 'group') {
    return (
      <li key={item.key} data-pyric-traffic-group-entry="">
        <TrafficGroupRow
          group={item}
          onSelect={(e) => onRowSelect(e as StudioTrafficEvent)}
          renderClassification={(event) => verdictBadge(event as StudioTrafficEvent)}
          formatTime={defaultFormatTime}
        />
      </li>
    );
  }

  const studioEvent = item.event as StudioTrafficEvent;
  const isExpanded = studioEvent.id === expandedId;
  const rowClassName = isRowInteractive(studioEvent) ? undefined : 'traffic__row--inert';

  let rowNode: ReactNode;
  if (isLiveHost) {
    rowNode = (
      <LiveTrafficRow
        event={studioEvent}
        selected={isExpanded}
        expanded={isExpanded}
        onSelect={onRowSelect}
      />
    );
  } else {
    rowNode = (
      <TrafficRow
        event={item.event}
        selected={isExpanded}
        className={rowClassName}
        onSelect={(e) => onRowSelect(e as StudioTrafficEvent)}
        renderClassification={(event) => verdictBadge(event as StudioTrafficEvent)}
        formatTime={defaultFormatTime}
      />
    );
  }

  let detailNode: ReactNode = null;
  if (isExpanded && isLiveHost) {
    detailNode = (
      <LiveRowDetail key={expandedId} event={studioEvent} live={liveHost} onClose={closeInspect} />
    );
  } else if (isExpanded && opensTrafficRowDetail(studioEvent)) {
    detailNode = (
      <TrafficInspectedDetail
        key={expandedId}
        eventId={expandedId}
        events={events}
        onClose={closeInspect}
      />
    );
  }

  return (
    <li
      key={studioEvent.id}
      data-pyric-traffic-entry=""
      data-pyric-traffic-id={studioEvent.id}
      data-verdict={verdictFor(studioEvent) ?? undefined}
    >
      {rowNode}
      {detailNode}
    </li>
  );
}

export interface TrafficTimelineBodyProps {
  readonly events: StudioTrafficEvent[];
  readonly window: TimeWindow;
  readonly timeFocus: TimeWindow | null;
  readonly onBrush: (nextWindow: TimeWindow) => void;
  readonly focusedInterval: TrafficFocusedInterval | null;
  readonly hasFocusedTraffic: boolean;
  readonly atCap: boolean;
  readonly denied: number;
  readonly verdictFilter: VerdictFilter;
  readonly onVerdictFilterChange: (next: VerdictFilter) => void;
  readonly databaseFilter: FirestoreDatabaseFilter;
  readonly namedDatabases: readonly string[];
  readonly onDatabaseFilterChange: (next: FirestoreDatabaseFilter) => void;
  readonly expandedId: string | null;
  readonly expandedRowVisible: boolean;
  readonly isLiveHost: boolean;
  readonly liveHost: LiveHostStatus | null;
  readonly itemsCount: number;
  readonly visibleItems: readonly TrafficLogItem[];
  readonly hiddenCount: number;
  readonly pageSize: number;
  readonly onShowMore: () => void;
  readonly onRowSelect: (event: StudioTrafficEvent) => void;
  readonly onCloseInspect: () => void;
}

export function TrafficTimelineBody({
  events,
  window,
  timeFocus,
  onBrush,
  focusedInterval,
  hasFocusedTraffic,
  atCap,
  denied,
  verdictFilter,
  onVerdictFilterChange,
  databaseFilter,
  namedDatabases,
  onDatabaseFilterChange,
  expandedId,
  expandedRowVisible,
  isLiveHost,
  liveHost,
  itemsCount,
  visibleItems,
  hiddenCount,
  pageSize,
  onShowMore,
  onRowSelect,
  onCloseInspect,
}: TrafficTimelineBodyProps) {
  const now = window.end;
  const verdictBadge = (event: StudioTrafficEvent) => <VerdictCell event={event} />;

  let denyFilterButton: ReactNode = null;
  if (denied > 0) {
    const nextDenyFilter: VerdictFilter = verdictFilter === 'deny' ? 'all' : 'deny';
    denyFilterButton = (
      <button
        type="button"
        className="traffic__tl-deny"
        aria-pressed={verdictFilter === 'deny'}
        onClick={() => onVerdictFilterChange(nextDenyFilter)}
        title="Filter the stream to denied requests"
      >
        {denied} denied
      </button>
    );
  }

  let databaseFiltersNode: ReactNode = null;
  if (namedDatabases.length > 0 || databaseFilter !== 'all') {
    const dbOptions = ['all', DEFAULT_FIRESTORE_DATABASE, ...namedDatabases] as const;
    databaseFiltersNode = (
      <>
        <span className="traffic__filters-label" aria-hidden="true">
          database
        </span>
        {dbOptions.map((dbOpt) => (
          <button
            key={`db-${dbOpt}`}
            type="button"
            className="traffic__filter"
            data-firestore-database-filter={dbOpt}
            aria-pressed={databaseFilter === dbOpt}
            onClick={() => onDatabaseFilterChange(dbOpt)}
          >
            {dbOpt}
          </button>
        ))}
      </>
    );
  }

  let standaloneDetailNode: ReactNode = null;
  if (expandedId && !expandedRowVisible) {
    standaloneDetailNode = (
      <StandaloneDetail
        key={expandedId}
        eventId={expandedId}
        events={events}
        live={liveHost}
        onClose={onCloseInspect}
      />
    );
  }

  let showMoreButton: ReactNode = null;
  if (hiddenCount > 0) {
    showMoreButton = (
      <button type="button" className="traffic__show-more" onClick={onShowMore}>
        Show {Math.min(hiddenCount, pageSize)} more ({hiddenCount} hidden)
      </button>
    );
  }

  let logBodyNode: ReactNode;
  if (itemsCount === 0) {
    logBodyNode = (
      <p className="traffic__empty">{emptyTrafficMessage(hasFocusedTraffic, verdictFilter)}</p>
    );
  } else {
    logBodyNode = (
      <div
        className="traffic__log"
        data-pyric-ui="traffic-log"
        data-pyric-grouped=""
        data-pyric-time-focused={hasFocusedTraffic ? '' : undefined}
      >
        <ul data-pyric-traffic-log-items="">
          {visibleItems.map((item) =>
            renderTrafficEntryItem(
              item,
              expandedId,
              isLiveHost,
              liveHost,
              events,
              onRowSelect,
              onCloseInspect,
              verdictBadge,
            ),
          )}
        </ul>
        {showMoreButton}
      </div>
    );
  }

  const capSuffix = atCap ? ` (capped at ${STUDIO_EVENT_CAP}/lane)` : '';
  let focusBannerNode: ReactNode = null;
  if (focusedInterval) {
    focusBannerNode = <TrafficTimeFocusBanner focus={focusedInterval} />;
  }

  return (
    <>
      <TrafficTimeline
        events={events}
        window={window}
        brush={timeFocus ?? undefined}
        onBrush={onBrush}
        liveAt={window.end}
        bucketCount={36}
        className="traffic__timeline"
        header={
          <div className="traffic__tl-header">
            <span className="traffic__tl-count">
              {events.length} requests{capSuffix}
            </span>
            {denyFilterButton}
            <span className="traffic__tl-live">live</span>
          </div>
        }
        axis={(w) => (
          <div className="traffic__tl-axis">
            <span>{relAgo(w.start, now)}</span>
            <span>now</span>
          </div>
        )}
        renderBucketSummary={(bucket) => {
          const noun = bucket.count === 1 ? 'request' : 'requests';
          return (
            <div className="traffic__bucket-summary">
              <span>{formatTrafficWindowRange(bucket)}</span>
              <strong>
                {bucket.count} {noun}
              </strong>
              <span>{bucket.denies} denied</span>
            </div>
          );
        }}
        emptyState={<p className="traffic__empty">No requests in this window yet.</p>}
      />

      {focusBannerNode}

      <div className="traffic__filters" role="group" aria-label="Traffic filters">
        <span className="traffic__filters-label" aria-hidden="true">
          verdict
        </span>
        {VERDICT_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className="traffic__filter"
            aria-pressed={verdictFilter === f}
            onClick={() => onVerdictFilterChange(f)}
          >
            {verdictLabel(f)}
          </button>
        ))}
        {databaseFiltersNode}
      </div>

      {standaloneDetailNode}
      {logBodyNode}
    </>
  );
}
