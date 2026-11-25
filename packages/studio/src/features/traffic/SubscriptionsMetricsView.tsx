/**
 * Firestore subscription concurrency metrics view (#284).
 *
 * Scoped strictly to Firestore (`snapshotListeners` and `activeConnections`).
 * Renders a chart only when both listener and connection lifecycle series are
 * observed (`connectionsObserved === true`), never approximating connections
 * from listener count or SharedWorker page presence.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  TrafficLineChart,
  TrafficMetricCards,
  useSubscriptionMetrics,
  type MetricPoint,
  type MetricSeries,
  type SubscriptionConnectionRecord,
  type SubscriptionGaugeSnapshot,
  type SubscriptionListenerRecord,
  type TimeWindow,
} from '@pyric/ui/traffic';
import {
  inClientScope,
  scopeFromValue,
  type ScopedEventFields,
} from 'pyric/sandbox/internal';
import type { AuthState, EventActor, EventCaller } from 'pyric/sandbox';
import type { FirestoreDatabaseFilter } from './firestore-database-filter.js';
import {
  TrafficCapNotice,
  TrafficTimeFocusBanner,
  type TrafficFocusedInterval,
} from './TrafficNotices.js';

const numberFormatter = new Intl.NumberFormat();
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function formatCount(value: number): string {
  return numberFormatter.format(value);
}

function formatClock(value: number): string {
  return timeFormatter.format(value);
}

function countPhrase(count: number, singular: string, plural: string): string {
  const noun = count === 1 ? singular : plural;
  return `${formatCount(count)} ${noun}`;
}

function isStudioAttributed(entry: {
  readonly actor?: EventActor;
  readonly caller?: EventCaller;
}): boolean {
  if (entry.caller?.kind === 'studio') return true;
  if (entry.actor?.kind === 'studio') return true;
  return false;
}

function toScopedFields(entry: {
  readonly caller?: EventCaller;
  readonly auth?: AuthState;
}): ScopedEventFields {
  const out: { caller?: EventCaller; auth?: { uid: string } | null } = {};
  if (entry.caller !== undefined) out.caller = entry.caller;
  if (entry.auth === null) {
    out.auth = null;
  } else if (typeof entry.auth?.uid === 'string') {
    out.auth = { uid: entry.auth.uid };
  }
  return out;
}

function matchesAmbientScope(
  entry: {
    readonly scope: string;
    readonly actor?: EventActor;
    readonly caller?: EventCaller;
    readonly auth?: AuthState;
  },
  hideStudio: boolean,
  fromScope: string | undefined,
  databaseFilter: FirestoreDatabaseFilter,
): boolean {
  if (hideStudio && isStudioAttributed(entry)) return false;
  if (databaseFilter !== 'all' && entry.scope !== databaseFilter) return false;
  if (fromScope === undefined) return true;
  const parsed = scopeFromValue(fromScope);
  const keepsAll = parsed === null || parsed.kind === 'all' || parsed.kind === 'page';
  if (keepsAll) return true;
  return inClientScope(toScopedFields(entry), parsed);
}

function buildSubscriptionStory(
  peakListeners: number,
  peakConnections: number,
  currentListeners: number,
  currentConnections: number,
): { readonly headline: string; readonly finding: string } {
  if (peakListeners === 0 && peakConnections === 0) {
    return {
      headline: 'No Firestore subscription concurrency observed',
      finding:
        'Active Firestore snapshot listeners and client connections will appear here as they attach.',
    };
  }
  const peakListenerLabel = countPhrase(
    peakListeners,
    'Firestore snapshot listener',
    'Firestore snapshot listeners',
  );
  const peakConnectionLabel = countPhrase(
    peakConnections,
    'active connection',
    'active connections',
  );
  const currentListenerLabel = countPhrase(
    currentListeners,
    'snapshot listener',
    'snapshot listeners',
  );
  const currentConnectionLabel = countPhrase(
    currentConnections,
    'active connection',
    'active connections',
  );
  return {
    headline: `Peak of ${peakListenerLabel} across ${peakConnectionLabel}`,
    finding: `Active now: ${currentListenerLabel} across ${currentConnectionLabel}. Each bucket reports peak concurrent active state.`,
  };
}

function renderSubscriptionEvidence(
  hasNoConcurrency: boolean,
  points: readonly MetricPoint[],
  series: readonly MetricSeries[],
  visible: ReadonlySet<string>,
  window: TimeWindow,
): ReactNode {
  if (hasNoConcurrency) {
    return (
      <p className="traffic__empty">
        No Firestore snapshot listeners or active connections in this window.
      </p>
    );
  }
  return (
    <div className="traffic__metric-evidence">
      <div className="traffic__metric-evidence-header">
        <h4>Peak concurrent active per bucket</h4>
        <span>
          {formatClock(window.start)}-{formatClock(window.end)}
        </span>
      </div>
      <TrafficLineChart
        points={points}
        series={series}
        visible={visible}
        omitZeroSeries
        formatValue={formatCount}
        formatTime={formatClock}
        className="traffic__chart traffic__chart--journal"
      />
      <div className="traffic__metric-axis" aria-hidden="true">
        <span>{formatClock(window.start)}</span>
        <span>{formatClock(window.end)}</span>
      </div>
    </div>
  );
}

export interface SubscriptionsMetricsViewProps {
  readonly snapshot: SubscriptionGaugeSnapshot;
  readonly window: TimeWindow;
  readonly focusedInterval?: TrafficFocusedInterval | null;
  readonly capped?: boolean;
  readonly hideStudio?: boolean;
  readonly fromScope?: string;
  readonly databaseFilter?: FirestoreDatabaseFilter;
}

export function SubscriptionsMetricsView({
  snapshot,
  window,
  focusedInterval,
  capped,
  hideStudio = false,
  fromScope,
  databaseFilter = 'all',
}: SubscriptionsMetricsViewProps) {
  const includeListener = useCallback(
    (record: SubscriptionListenerRecord) =>
      matchesAmbientScope(record, hideStudio, fromScope, databaseFilter),
    [hideStudio, fromScope, databaseFilter],
  );
  const includeConnection = useCallback(
    (record: SubscriptionConnectionRecord) =>
      matchesAmbientScope(record, hideStudio, fromScope, databaseFilter),
    [hideStudio, fromScope, databaseFilter],
  );

  const metrics = useSubscriptionMetrics({
    snapshot,
    window,
    service: 'firestore',
    includeListener,
    includeConnection,
  });

  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(metrics.series.map((item) => item.key)),
  );
  const toggle = useCallback((key: string) => {
    setVisible((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const currentConnections = metrics.currentConnections ?? 0;
  const resolvedPeakConnections = metrics.peakConnections ?? 0;
  const story = useMemo(
    () =>
      buildSubscriptionStory(
        metrics.peakListeners,
        resolvedPeakConnections,
        metrics.currentListeners,
        currentConnections,
      ),
    [metrics.peakListeners, resolvedPeakConnections, metrics.currentListeners, currentConnections],
  );

  const isCapped = capped === true;
  let focusBanner: ReactNode = null;
  if (focusedInterval) {
    focusBanner = <TrafficTimeFocusBanner focus={focusedInterval} />;
  }

  if (!metrics.connectionsObserved || metrics.peakConnections === null) {
    const activeListenerText = countPhrase(
      metrics.currentListeners,
      'active Firestore snapshot listener',
      'active Firestore snapshot listeners',
    );
    return (
      <div
        className="traffic__metrics"
        data-pyric-ui="traffic-subscriptions-view"
        data-pyric-subscriptions-gated=""
      >
        {focusBanner}
        <TrafficCapNotice capped={isCapped} scope="all" />
        <section
          className="traffic__metric-panel traffic__metric-panel--journal"
          data-pyric-ui="traffic-metric-panel"
        >
          <header className="traffic__metric-story">
            <p className="traffic__metric-eyebrow">Firestore subscriptions</p>
            <h3 className="traffic__metric-headline">
              Active connection lifecycle is not yet observed
            </h3>
            <p className="traffic__metric-finding">
              Studio observed {activeListenerText} now (window peak:{' '}
              {formatCount(metrics.peakListeners)}), and withholds the subscription chart until
              explicit Firestore connection attach and detach events are observed.
            </p>
          </header>
          <footer className="traffic__metric-footer">
            <p className="traffic__metric-source">
              Source: Pyric Firestore listener lifecycle events - Connection series withheld until
              explicit connection instrumentation is active
            </p>
          </footer>
        </section>
      </div>
    );
  }

  const hasNoConcurrency = metrics.peakListeners === 0 && metrics.peakConnections === 0;

  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-subscriptions-view">
      {focusBanner}
      <TrafficCapNotice capped={isCapped} scope="all" />
      <p className="traffic__rules-summary" data-pyric-subscriptions-current="">
        Active now: {formatCount(metrics.currentListeners)} snapshot listeners |{' '}
        {formatCount(currentConnections)} active connections
      </p>
      <section
        className="traffic__metric-panel traffic__metric-panel--journal"
        data-pyric-ui="traffic-metric-panel"
      >
        <header className="traffic__metric-story">
          <p className="traffic__metric-eyebrow">Firestore subscriptions</p>
          <h3 className="traffic__metric-headline">{story.headline}</h3>
          <p className="traffic__metric-finding">{story.finding}</p>
        </header>

        <TrafficMetricCards
          series={metrics.series}
          visible={visible}
          onToggle={toggle}
          formatValue={formatCount}
          className={`traffic__metric-cards traffic__metric-cards--journal traffic__metric-cards--${metrics.series.length}`}
        />

        {renderSubscriptionEvidence(
          hasNoConcurrency,
          metrics.points,
          metrics.series,
          visible,
          window,
        )}

        <footer className="traffic__metric-footer">
          <p className="traffic__metric-source">
            Source: Pyric Firestore lifecycle events - Per-bucket peak active gauges (local
            buckets, not Cloud Monitoring 60s samples)
          </p>
          <details className="traffic__metric-methodology">
            <summary>How this is counted</summary>
            <div>
              <p>
                Scoped to <strong>Cloud Firestore</strong> only; Realtime Database listener events
                share the normalized lifecycle state reducer, and are excluded from this
                Firestore-scoped chart. Each bucket plots the{' '}
                <strong>peak concurrent active</strong> count reached during that local interval
                rather than an event count.
              </p>
              <p>
                <strong>Connection identity boundary:</strong> a mobile or web client SDK session
                shares one database stream connection across multiple snapshot listeners (ten
                listeners from one web client equal 10 listeners and 1 connection), while server
                client libraries use one connection per listener. Active connections come strictly
                from explicit connection lifecycle state, never from listener count or SharedWorker
                page presence, and local buckets appear immediately without Cloud Monitoring&apos;s
                60-second sampling cadence or visibility delay.
              </p>
            </div>
          </details>
        </footer>
      </section>
    </div>
  );
}
