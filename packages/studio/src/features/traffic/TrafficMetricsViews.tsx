/**
 * Traffic tab strip, views 2 + 3: "Billable metrics" and "Rules"
 * (Firebase Console "Usage" reference). Both metric charts reuse the
 * `@pyric/ui/traffic` bucketing hooks unchanged — this module is rendering
 * + the Studio-specific Rules-bypass classifier only.
 *
 * ── Rules-bypass classification ──
 * The shared metric hooks retain their legacy `isAdmin` callback name, but
 * Studio supplies the canonical Rules disposition. The metrics therefore do
 * not infer rule behavior from the operation's source or auth lens.
 *
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  TrafficLineChart,
  TrafficMetricCards,
  useBillableMetrics,
  useRulesMetrics,
  type MetricPoint,
  type MetricSeries,
  type TimeWindow,
} from '@pyric/ui/traffic';
import { verdictFor, type StudioTrafficEvent } from './verdict.js';
import { billableStory, rulesStory, type MetricStory } from './metric-story.js';

const metricNumberFormatter = new Intl.NumberFormat();
const metricTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function formatMetricNumber(value: number): string {
  return metricNumberFormatter.format(value);
}

function formatMetricTime(value: number): string {
  return metricTimeFormatter.format(value);
}

/** Shared bypass classifier: rules metrics exclude operations whose canonical
 * disposition says Rules were bypassed. */
function isBypassedOp(event: { origin?: string }): boolean {
  return verdictFor(event as unknown as StudioTrafficEvent) === 'bypassed';
}

function allZero(series: readonly MetricSeries[]): boolean {
  return series.every((s) => s.total === 0);
}

/** Shared data-journal composition: observed story, direct totals, evidence,
 *  and a visible source boundary with methodology on demand. */
function JournalMetricPanel({
  eyebrow,
  story,
  series,
  points,
  window,
  emptyLabel,
  evidenceTitle,
  source,
  methodology,
}: {
  eyebrow: string;
  story: MetricStory;
  series: MetricSeries[];
  points: MetricPoint[];
  window: TimeWindow;
  emptyLabel: string;
  evidenceTitle: string;
  source: string;
  methodology: ReactNode;
}) {
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(series.map((item) => item.key)),
  );
  const toggle = useCallback((key: string) => {
    setVisible((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <section
      className="traffic__metric-panel traffic__metric-panel--journal"
      data-pyric-ui="traffic-metric-panel"
    >
      <header className="traffic__metric-story">
        <p className="traffic__metric-eyebrow">{eyebrow}</p>
        <h3 className="traffic__metric-headline">{story.headline}</h3>
        <p className="traffic__metric-finding">{story.finding}</p>
      </header>

      <TrafficMetricCards
        series={series}
        visible={visible}
        onToggle={toggle}
        formatValue={formatMetricNumber}
        className={`traffic__metric-cards traffic__metric-cards--journal traffic__metric-cards--${series.length}`}
      />

      {allZero(series) ? (
        <p className="traffic__empty">{emptyLabel}</p>
      ) : (
        <div className="traffic__metric-evidence">
          <div className="traffic__metric-evidence-header">
            <h4>{evidenceTitle}</h4>
            <span>
              {formatMetricTime(window.start)}–{formatMetricTime(window.end)}
            </span>
          </div>
          <TrafficLineChart
            points={points}
            series={series}
            visible={visible}
            omitZeroSeries
            formatValue={formatMetricNumber}
            formatTime={formatMetricTime}
            className="traffic__chart traffic__chart--journal"
          />
          <div className="traffic__metric-axis" aria-hidden="true">
            <span>{formatMetricTime(window.start)}</span>
            <span>{formatMetricTime(window.end)}</span>
          </div>
        </div>
      )}

      <footer className="traffic__metric-footer">
        <p className="traffic__metric-source">{source}</p>
        <details className="traffic__metric-methodology">
          <summary>How this is counted</summary>
          <div>{methodology}</div>
        </details>
      </footer>
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
  // The billing semantics documented below are Firestore-specific. Storage and
  // RTDB operations can share method names but not Firestore's billing unit.
  const firestoreEvents = useMemo(
    () => events.filter((event) => (event.service ?? 'firestore') === 'firestore'),
    [events],
  );
  const metrics = useBillableMetrics({
    events: firestoreEvents,
    window,
    isAdmin: isBypassedOp,
  });
  const story = useMemo(() => billableStory(metrics.series), [metrics.series]);

  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-billable-view">
      <JournalMetricPanel
        eyebrow="Billable activity"
        story={story}
        series={metrics.series}
        points={metrics.points}
        window={window}
        emptyLabel="No reads, writes, or deletes in this session yet."
        evidenceTitle="When the activity happened"
        source="Source: Pyric Firestore sandbox events · Operation counts, not a Firebase invoice"
        methodology={
          <>
            <p>
              Counts successful Firestore sandbox <code>get</code>/<code>list</code>,{' '}
              <code>create</code>/<code>update</code>/<code>set</code>, and{' '}
              <code>delete</code>/<code>remove</code> operations in the displayed window.
              Rules-bypassed admin operations are included because they still execute.
            </p>
            <p>
              <strong>Read ops are a proxy, not billed document reads.</strong> Each{' '}
              <code>list</code> is counted once because the event does not report how many
              documents the query returned. This is observed sandbox activity, not a Firebase
              invoice.
            </p>
          </>
        }
      />
    </div>
  );
}

/** Tab 3: rules allow/deny/error metrics. */
export function RulesMetricsView({
  events,
  window,
}: {
  events: StudioTrafficEvent[];
  window: TimeWindow;
}) {
  const evaluatedEvents = useMemo(
    () => events.filter((event) => event.rulesDisposition.kind === 'evaluated'),
    [events],
  );
  const rules = useRulesMetrics({ events: evaluatedEvents, window });
  // `RulesDisposition` has only allow/deny verdicts. A runtime error is
  // explicitly `not-evaluated`, so the shared hook's generic error series is
  // not a Rules metric in Studio.
  const decisionSeries = useMemo(
    () => rules.series.filter((series) => series.key === 'allows' || series.key === 'denies'),
    [rules.series],
  );
  const story = useMemo(() => rulesStory(decisionSeries), [decisionSeries]);

  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-rules-view">
      <JournalMetricPanel
        eyebrow="Rules decisions"
        story={story}
        series={decisionSeries}
        points={rules.points}
        window={window}
        emptyLabel="No allow or deny decisions in this session yet."
        evidenceTitle="When Rules evaluated requests"
        source="Source: Pyric sandbox events · Evaluated Rules dispositions only"
        methodology={
          <>
            <p>
              Counts only operations whose canonical Rules disposition is{' '}
              <code>evaluated</code>, grouped by its <code>allow</code> or <code>deny</code>{' '}
              verdict.
            </p>
            <p>
              <strong>Bypasses and runtime failures are not Rules decisions.</strong> Admin
              bypasses, services without Rules, unsupported operations, and runtime errors are
              excluded because Rules did not produce a verdict.
            </p>
          </>
        }
      />
    </div>
  );
}
