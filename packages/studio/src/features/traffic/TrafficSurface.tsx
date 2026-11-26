/**
 * Traffic surface (S-TRAFFIC): `mocks/c-traffic.html` as a live surface.
 *
 * Coordinates URL-bound subtabs (`Timeline`, `Billable metrics`,
 * `Subscriptions` when observed, `Rules`, `Listeners`), ambient scope filters
 * (`?hide=studio`, `?from=`, Firestore database filter, timeline brush focus),
 * and the pre-cap traffic + subscription feeds.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTrafficGroups, type TimeWindow } from '@pyric/ui/traffic';
import {
  useStudioSubscriptionFeed,
  useStudioTrafficFeed,
} from '../../shell/studio-events.js';
import { useLiveHost } from '../../shell/live-status.js';
import { currentPath, pushPath, subscribeToLocation } from '../../shell/router.js';
import {
  filterByFirestoreDatabase,
  observedFirestoreDatabases,
  type FirestoreDatabaseFilter,
} from './firestore-database-filter.js';
import {
  filterByVerdict,
  filterStudioTraffic,
  rowNavigationTarget,
  type StudioTrafficEvent,
  type VerdictFilter,
} from './verdict.js';
import { queryWithInspect, selectedInspectId, toggleInspect } from './inspect-selection.js';
import { BillableMetricsView, RulesMetricsView } from './TrafficMetricsViews.js';
import { SubscriptionsMetricsView } from './SubscriptionsMetricsView.js';
import { shouldShowCapNotice } from './TrafficNotices.js';
import {
  ListenerPageSurface,
  ListenersSurface,
  drilledListenerId,
} from '../listeners/index.js';
import {
  queryForTrafficTab,
  trafficTabForView,
  trafficTabsFor,
  type TrafficTab,
  type TrafficTabOptions,
} from './traffic-tabs.js';
import { computeTrafficWindow } from './traffic-window.js';
import { trafficTimeFocus, toggleTimeFocus } from './timeline-focus.js';
import { FromSelect, useFromScope } from './TrafficLiveRow.js';
import { TrafficTimelineBody, opensTrafficRowDetail } from './TrafficTimelineBody.js';
import { inFromScope } from './live-row.js';
import './traffic.css';

export type { TrafficTab } from './traffic-tabs.js';

/** Resolve the active Traffic tab from a parsed location and observation state. */
export function trafficTabForLocation(
  location: {
    readonly tab: string;
    readonly rest: readonly string[];
    readonly query: Record<string, string | undefined>;
  },
  options?: TrafficTabOptions,
): TrafficTab {
  if (location.tab !== 'traffic') return 'timeline';
  if (drilledListenerId(location) !== undefined) return 'listeners';
  return trafficTabForView(location.query.view, options);
}

function deriveDrilledListener(): string | undefined {
  const { tab, rest } = currentPath();
  return drilledListenerId({ tab, rest });
}

function useDrilledListener(): string | undefined {
  return useSyncExternalStore<string | undefined>(
    subscribeToLocation,
    deriveDrilledListener,
    () => undefined,
  );
}

function useTrafficTab(
  subscriptionsObserved: boolean,
): readonly [TrafficTab, (tab: TrafficTab) => void] {
  const getSnapshot = useCallback(
    () => trafficTabForLocation(currentPath(), { subscriptionsObserved }),
    [subscriptionsObserved],
  );
  const active = useSyncExternalStore<TrafficTab>(
    subscribeToLocation,
    getSnapshot,
    () => 'timeline',
  );
  const setActive = useCallback((tab: TrafficTab) => {
    pushPath({ tab: 'traffic', query: queryForTrafficTab(currentPath().query, tab) });
  }, []);
  return [active, setActive] as const;
}

function useHideStudio(): readonly [boolean, () => void] {
  const hide = useSyncExternalStore(
    subscribeToLocation,
    () => currentPath().query.hide === 'studio',
    () => false,
  );
  const toggle = useCallback(() => {
    const query = { ...currentPath().query } as Record<string, string | undefined>;
    if (query.hide === 'studio') delete query.hide;
    else query.hide = 'studio';
    pushPath({ tab: 'traffic', query });
  }, []);
  return [hide, toggle] as const;
}

function useInspectParam(): string | null {
  return useSyncExternalStore(
    subscribeToLocation,
    () => selectedInspectId(currentPath().query),
    () => null,
  );
}

function extendSubscriptionWindow(
  base: TimeWindow,
  earliestTransitionAt: number | null,
  latestTransitionAt: number | null,
): TimeWindow {
  let start = base.start;
  let end = base.end;
  if (earliestTransitionAt !== null && earliestTransitionAt < start) {
    start = earliestTransitionAt;
  }
  if (latestTransitionAt !== null && latestTransitionAt + 1_000 > end) {
    end = latestTransitionAt + 1_000;
  }
  if (start === base.start && end === base.end) return base;
  return { start, end };
}

const PAGE_SIZE = 100;

export function TrafficSurface() {
  const trafficFeed = useStudioTrafficFeed();
  const subscriptionFeed = useStudioSubscriptionFeed();
  const subscriptionsObserved = subscriptionFeed.connectionsObservedByService.has('firestore');
  const visibleTabs = useMemo(
    () => trafficTabsFor({ subscriptionsObserved }),
    [subscriptionsObserved],
  );
  const allEvents = trafficFeed.events;
  const [tab, setTab] = useTrafficTab(subscriptionsObserved);
  const drilledListener = useDrilledListener();
  const [hideStudio, toggleHideStudio] = useHideStudio();
  const liveHost = useLiveHost();
  const isLiveHost = liveHost !== null;
  const [fromScope, setFromScope] = useFromScope();
  const withoutStudio = useMemo(
    () => filterStudioTraffic(allEvents, hideStudio),
    [allEvents, hideStudio],
  );
  const events = useMemo(
    () => (isLiveHost ? inFromScope(withoutStudio, fromScope) : withoutStudio),
    [withoutStudio, isLiveHost, fromScope],
  );
  const hiddenStudioCount = allEvents.length - withoutStudio.length;
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all');
  const [databaseFilter, setDatabaseFilter] = useState<FirestoreDatabaseFilter>('all');
  const namedDatabases = useMemo(() => observedFirestoreDatabases(events), [events]);
  const [timeFocus, setTimeFocus] = useState<TimeWindow | null>(null);
  const expandedId = useInspectParam();
  const [visibleRows, setVisibleRows] = useState(PAGE_SIZE);

  const openInspect = (id: string) => {
    pushPath({ tab: 'traffic', query: toggleInspect(currentPath().query, id) });
  };
  const closeInspect = () => {
    pushPath({ tab: 'traffic', query: queryWithInspect(currentPath().query, null) });
  };

  useEffect(() => {
    if (!expandedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeInspect();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId]);

  const window = useMemo<TimeWindow>(
    () => computeTrafficWindow(events, isLiveHost),
    [events, isLiveHost],
  );

  const focusedTraffic = useMemo(() => {
    if (!timeFocus) return null;
    return trafficTimeFocus(events, timeFocus);
  }, [events, timeFocus]);
  const focusedWindow = focusedTraffic?.window ?? null;
  const tableEvents = focusedTraffic?.events ?? events;
  const metricsWindow = focusedWindow ?? window;
  const subscriptionWindow = useMemo<TimeWindow>(() => {
    if (focusedWindow !== null) return focusedWindow;
    return extendSubscriptionWindow(
      window,
      subscriptionFeed.earliestTransitionAt,
      subscriptionFeed.latestTransitionAt,
    );
  }, [
    focusedWindow,
    window,
    subscriptionFeed.earliestTransitionAt,
    subscriptionFeed.latestTransitionAt,
  ]);

  let focusedInterval = null;
  if (focusedTraffic) {
    focusedInterval = {
      window: focusedTraffic.window,
      finding: focusedTraffic.finding,
      onClear: () => setTimeFocus(null),
    };
  }

  const ordered = useMemo(
    () =>
      filterByFirestoreDatabase(
        filterByVerdict(tableEvents, verdictFilter),
        databaseFilter,
      ).sort((a, b) => b.at - a.at),
    [tableEvents, verdictFilter, databaseFilter],
  );
  const { items } = useTrafficGroups({ events: ordered });
  const visibleItems = items.slice(0, visibleRows);
  const hiddenCount = items.length - visibleItems.length;
  const atCap = trafficFeed.capped;
  const showBillableCapNotice = shouldShowCapNotice(
    atCap,
    trafficFeed.uncoveredBeforeAt,
    focusedWindow,
  );
  const showRulesCapNotice = shouldShowCapNotice(
    trafficFeed.clientCapped,
    trafficFeed.rulesUncoveredBeforeAt,
    focusedWindow,
  );
  const showSubscriptionsCapNotice = shouldShowCapNotice(
    subscriptionFeed.capped,
    subscriptionFeed.uncoveredBeforeAt,
    focusedWindow,
  );

  const denied = events.filter((e) => e.result === 'deny').length;

  const onRowSelect = (e: StudioTrafficEvent) => {
    if (isLiveHost || opensTrafficRowDetail(e)) {
      openInspect(e.id);
      return;
    }
    const target = rowNavigationTarget(e);
    if (target !== null) pushPath(target);
  };

  const activeFromScope = isLiveHost ? fromScope : undefined;
  const expandedRowVisible =
    expandedId != null &&
    visibleItems.some((item) => item.type !== 'group' && item.event.id === expandedId);

  let fromSelectNode: ReactNode = null;
  if (isLiveHost) {
    fromSelectNode = (
      <FromSelect
        value={fromScope}
        onChange={setFromScope}
        clients={liveHost.clients ?? []}
        events={allEvents}
      />
    );
  }

  let hideStudioSuffix = '';
  if (hideStudio && hiddenStudioCount > 0) {
    hideStudioSuffix = ` (${hiddenStudioCount} hidden)`;
  }

  let bodyNode: ReactNode;
  if (drilledListener !== undefined) {
    bodyNode = (
      <ListenerPageSurface
        listenerId={drilledListener}
        window={window}
        hideStudio={hideStudio}
        fromScope={activeFromScope}
      />
    );
  } else if (tab === 'billable') {
    bodyNode = (
      <BillableMetricsView
        events={tableEvents}
        window={metricsWindow}
        focusedInterval={focusedInterval}
        capped={showBillableCapNotice}
      />
    );
  } else if (tab === 'subscriptions') {
    bodyNode = (
      <SubscriptionsMetricsView
        snapshot={subscriptionFeed}
        window={subscriptionWindow}
        focusedInterval={focusedInterval}
        capped={showSubscriptionsCapNotice}
        hideStudio={hideStudio}
        fromScope={activeFromScope}
        databaseFilter={databaseFilter}
      />
    );
  } else if (tab === 'rules') {
    bodyNode = (
      <RulesMetricsView
        events={tableEvents}
        window={metricsWindow}
        focusedInterval={focusedInterval}
        capped={showRulesCapNotice}
      />
    );
  } else if (tab === 'listeners') {
    bodyNode = (
      <ListenersSurface window={window} hideStudio={hideStudio} fromScope={activeFromScope} />
    );
  } else {
    bodyNode = (
      <TrafficTimelineBody
        events={events}
        window={window}
        timeFocus={timeFocus}
        onBrush={(nextWindow) => {
          setTimeFocus((current) => toggleTimeFocus(current, nextWindow));
          if (expandedId) closeInspect();
        }}
        focusedInterval={focusedInterval}
        hasFocusedTraffic={focusedTraffic !== null}
        atCap={atCap}
        denied={denied}
        verdictFilter={verdictFilter}
        onVerdictFilterChange={setVerdictFilter}
        databaseFilter={databaseFilter}
        namedDatabases={namedDatabases}
        onDatabaseFilterChange={setDatabaseFilter}
        expandedId={expandedId}
        expandedRowVisible={expandedRowVisible}
        isLiveHost={isLiveHost}
        liveHost={liveHost}
        itemsCount={items.length}
        visibleItems={visibleItems}
        hiddenCount={hiddenCount}
        pageSize={PAGE_SIZE}
        onShowMore={() => setVisibleRows((n) => n + PAGE_SIZE)}
        onRowSelect={onRowSelect}
        onCloseInspect={closeInspect}
      />
    );
  }

  return (
    <section data-pyric-ui="traffic-surface" className="traffic">
      <div className="traffic__tabs" role="tablist" aria-label="Traffic views">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="traffic__tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        {fromSelectNode}
        <button
          type="button"
          className="traffic__hide-studio"
          aria-pressed={hideStudio}
          onClick={toggleHideStudio}
          title="Hide ops issued by Pyric Studio's own viewers and editors"
        >
          Hide Studio traffic{hideStudioSuffix}
        </button>
      </div>
      {bodyNode}
    </section>
  );
}
