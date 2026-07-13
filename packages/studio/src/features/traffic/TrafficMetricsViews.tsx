/**
 * Traffic tab strip, views 2 + 3: "Billable metrics" and "Subscriptions &
 * Rules" (Firebase Console "Usage" reference). Both metric charts reuse the
 * `@pyric/ui/traffic` bucketing hooks unchanged — this module is rendering
 * + the Studio-specific Rules-bypass classifier only.
 *
 * ── Rules-bypass classification ──
 * The shared metric hooks retain their legacy `isAdmin` callback name, but
 * Studio supplies the canonical Rules disposition. The metrics therefore do
 * not infer rule behavior from the operation's source or auth lens.
 *
 * ── Subscriptions gap (documented, not faked) ──
 * The Console reference charts two subscription metrics: peak snapshot
 * listeners and peak active connections. Neither is derivable honestly
 * today: `ListenerLifecycleEvent` (attach/detach/errored,
 * `pyric/sandbox`'s `types.ts`) exists at the sandbox layer, but
 * `studio-data.ts#isTrafficEvent` only admits `kind: 'request' | 'operation'`
 * — lifecycle events never reach `useStudioTraffic`, and `TrafficEvent`
 * itself has no lifecycle-kind variant to carry them if they did. Charting
 * a "peak listeners" number here would mean inventing data no observed
 * event supports, so this view names the gap instead: what's missing is
 * (1) widening `TrafficEvent`/`isTrafficEvent`/`toTrafficEvent` to carry
 * `ListenerLifecycleEvent`, and (2) a bucketing kernel that tracks
 * concurrent attach/detach state per bucket (a running count, not a
 * simple per-event tally like billable/rules metrics).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  TrafficLineChart,
  TrafficMetricCards,
  useBillableMetrics,
  useRulesMetrics,
  type MetricSeries,
  type TimeWindow,
} from '@pyric/ui/traffic';
import { verdictFor, type StudioTrafficEvent } from './verdict.js';

/** Shared bypass classifier: rules metrics exclude operations whose canonical
 * disposition says Rules were bypassed. */
function isBypassedOp(event: { origin?: string }): boolean {
  return verdictFor(event as unknown as StudioTrafficEvent) === 'bypassed';
}

function allZero(series: readonly MetricSeries[]): boolean {
  return series.every((s) => s.total === 0);
}

/** One metric chart: the total-cards legend (checkbox toggles) above a
 *  line chart, sharing one visibility set between the two. */
function MetricPanel({
  title,
  series,
  points,
  emptyLabel,
}: {
  title: string;
  series: MetricSeries[];
  points: { index: number; start: number; end: number }[];
  emptyLabel: string;
}) {
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(series.map((s) => s.key)),
  );
  const toggle = useCallback((key: string) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <section className="traffic__metric-panel" data-pyric-ui="traffic-metric-panel">
      <h3 className="traffic__metric-title">{title}</h3>
      <TrafficMetricCards
        series={series}
        visible={visible}
        onToggle={toggle}
        className="traffic__metric-cards"
      />
      {allZero(series) ? (
        <p className="traffic__empty">{emptyLabel}</p>
      ) : (
        <TrafficLineChart
          points={points}
          series={series}
          visible={visible}
          className="traffic__chart"
        />
      )}
    </section>
  );
}

/** Tab 2: reads / writes / deletes over the session window. */
export function BillableMetricsView({
  events,
  window,
}: {
  events: StudioTrafficEvent[];
  window: TimeWindow;
}) {
  const metrics = useBillableMetrics({ events, window, isAdmin: isBypassedOp });
  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-billable-view">
      <MetricPanel
        title="Billable metrics"
        series={metrics.series}
        points={metrics.points}
        emptyLabel="No reads, writes, or deletes in this session yet."
      />
      <p className="traffic__metric-note">
        "Read ops" counts <code>get</code>/<code>list</code> operations, not documents returned —
        a <code>list</code> event doesn't carry how many documents its query matched (see the
        gap note below), so this is an operation count, not a byte-accurate bill.
      </p>
    </div>
  );
}

/** Tab 3: rules allow/deny/error metrics + the honest subscriptions gap. */
export function SubscriptionsRulesView({
  events,
  window,
}: {
  events: StudioTrafficEvent[];
  window: TimeWindow;
}) {
  const rules = useRulesMetrics({ events, window, isAdmin: isBypassedOp });
  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-subscriptions-rules-view">
      <section className="traffic__metric-panel" data-pyric-ui="traffic-subscriptions-gap">
        <h3 className="traffic__metric-title">Subscription metrics</h3>
        <p className="traffic__empty">
          Not available yet: the event stream doesn't carry snapshot-listener lifecycle
          (attach/detach) or an active-connection count, so a "peak listeners" chart here would
          be invented, not observed. Charting this needs the sandbox's{' '}
          <code>ListenerLifecycleEvent</code> (attach/detach/errored) to reach the Traffic event
          stream — it's tracked internally but currently stops before{' '}
          <code>useStudioTraffic</code>.
        </p>
      </section>
      <MetricPanel
        title="Rules metrics"
        series={rules.series}
        points={rules.points}
        emptyLabel="No rule evaluations in this session yet."
      />
    </div>
  );
}
