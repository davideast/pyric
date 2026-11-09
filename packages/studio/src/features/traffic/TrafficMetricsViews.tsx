/**
 * Traffic tab strip, views 2 + 3: "Billable metrics" and "Rules"
 * (Firebase Console "Usage" reference). Metric charts reuse the
 * `@pyric/ui/traffic` bucketing hooks; this module handles rendering,
 * mode-specific copy selection, and the Studio-specific Rules-bypass classifier.
 *
 * ── Rules-bypass classification ──
 * The shared metric hooks retain their legacy `isAdmin` callback name, but
 * Studio supplies the canonical Rules disposition. The metrics therefore do
 * not infer rule behavior from the operation's source or auth lens.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  TrafficLineChart,
  TrafficMetricCards,
  useBillableMetrics,
  useRtdbTransferMetrics,
  useRulesMetrics,
  type MetricPoint,
  type MetricSeries,
  type TimeWindow,
} from '@pyric/ui/traffic';
import {
  verdictFor,
  rulesDecisionEvents,
  queryProofUnsupportedCount,
  type StudioTrafficEvent,
} from './verdict.js';
import {
  liveBypassedCount,
  liveRulesDecisionEvents,
  localDriftCount,
  localUnevaluatedCount,
  productionDeniedCount,
} from './live-verdict.js';
import {
  billableStory,
  rtdbTransferStory,
  rulesStory,
  liveRulesStory,
  type MetricStory,
} from './metric-story.js';
import {
  BILLABLE_OPERATION_COPY,
  LIVE_RTDB_TRANSFER_COPY,
  RULES_PANEL_COPY,
  rulesDecisionSeriesForMode,
  type JournalPanelCopy,
  type TrafficHostMode,
} from './traffic-panel-copy.js';
import {
  TrafficCapNotice,
  TrafficTimeFocusBanner,
  type TrafficFocusedInterval,
} from './TrafficNotices.js';
import { useLiveHost } from '../../shell/live-status.js';

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

function isLiveOperationMeteredService(event: StudioTrafficEvent): boolean {
  const service = event.service ?? 'firestore';
  return service === 'firestore' || service === 'storage';
}

function isRtdbTransferService(event: StudioTrafficEvent): boolean {
  return event.service === 'rtdb' || event.service === 'database';
}

function RulesSummaryLine({
  mode,
  evaluatedCount,
  driftCount,
  unevaluatedCount,
  bypassedCount,
  deniedByProduction,
  unsupportedCount,
}: {
  mode: TrafficHostMode;
  evaluatedCount: number;
  driftCount: number;
  unevaluatedCount: number;
  bypassedCount: number;
  deniedByProduction: number;
  unsupportedCount: number;
}) {
  if (mode === 'sandbox') {
    return <p className="traffic__rules-summary">Query proof unsupported: {unsupportedCount}</p>;
  }
  const parts = [
    `Evaluated locally: ${formatMetricNumber(evaluatedCount)}`,
    `Unevaluated locally: ${formatMetricNumber(unevaluatedCount)}`,
    `Admin-bypassed: ${formatMetricNumber(bypassedCount)}`,
    `Drift with production: ${formatMetricNumber(driftCount)}`,
    `Denied by production: ${formatMetricNumber(deniedByProduction)}`,
  ];
  if (unsupportedCount > 0) {
    parts.push(`Query proof unsupported: ${formatMetricNumber(unsupportedCount)}`);
  }
  return (
    <p className="traffic__rules-summary" data-pyric-live-rules-summary="">
      {parts.join(' · ')}
    </p>
  );
}

/** Shared data-journal composition: observed story, direct totals, evidence,
 *  and a visible source boundary with methodology on demand. */
function JournalMetricPanel({
  copy,
  story,
  series,
  points,
  window,
  panelKey,
}: {
  copy: JournalPanelCopy;
  story: MetricStory;
  series: MetricSeries[];
  points: MetricPoint[];
  window: TimeWindow;
  panelKey?: string;
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
      data-pyric-billable-panel={panelKey}
    >
      <header className="traffic__metric-story">
        <p className="traffic__metric-eyebrow">{copy.eyebrow}</p>
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
        <p className="traffic__empty">{copy.emptyLabel}</p>
      ) : (
        <div className="traffic__metric-evidence">
          <div className="traffic__metric-evidence-header">
            <h4>{copy.evidenceTitle}</h4>
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
        <p className="traffic__metric-source">{copy.source}</p>
        <details className="traffic__metric-methodology">
          <summary>How this is counted</summary>
          <div>{copy.methodology}</div>
        </details>
      </footer>
    </section>
  );
}

/** Tab 2: operation-metered activity (plus bandwidth-metered RTDB transfers in Live Mode). */
export function BillableMetricsView({
  events,
  window,
  focusedInterval,
  capped,
}: {
  events: StudioTrafficEvent[];
  window: TimeWindow;
  focusedInterval?: TrafficFocusedInterval | null;
  capped?: boolean;
}) {
  const mode: TrafficHostMode = useLiveHost() !== null ? 'live' : 'sandbox';
  const operationEvents = useMemo(
    () =>
      events.filter((event) => {
        if (mode === 'live') return isLiveOperationMeteredService(event);
        return (event.service ?? 'firestore') === 'firestore';
      }),
    [events, mode],
  );
  const rtdbEvents = useMemo(() => {
    if (mode !== 'live') return [];
    return events.filter(isRtdbTransferService);
  }, [events, mode]);
  const operationMetrics = useBillableMetrics({
    events: operationEvents,
    window,
    isAdmin: isBypassedOp,
  });
  const rtdbMetrics = useRtdbTransferMetrics({
    events: rtdbEvents,
    window,
    isAdmin: isBypassedOp,
  });
  const operationStory = useMemo(
    () => billableStory(operationMetrics.series),
    [operationMetrics.series],
  );
  const rtdbStory = useMemo(
    () => rtdbTransferStory(rtdbMetrics.series),
    [rtdbMetrics.series],
  );

  const isCapped = capped === true;

  if (mode === 'sandbox') {
    return (
      <div className="traffic__metrics" data-pyric-ui="traffic-billable-view">
        {focusedInterval ? <TrafficTimeFocusBanner focus={focusedInterval} /> : null}
        <TrafficCapNotice capped={isCapped} scope="all" />
        <JournalMetricPanel
          copy={BILLABLE_OPERATION_COPY.sandbox}
          story={operationStory}
          series={operationMetrics.series}
          points={operationMetrics.points}
          window={window}
        />
      </div>
    );
  }

  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-billable-view">
      {focusedInterval ? <TrafficTimeFocusBanner focus={focusedInterval} /> : null}
      <TrafficCapNotice capped={isCapped} scope="all" />
      <JournalMetricPanel
        panelKey="operation"
        copy={BILLABLE_OPERATION_COPY.live}
        story={operationStory}
        series={operationMetrics.series}
        points={operationMetrics.points}
        window={window}
      />
      <JournalMetricPanel
        panelKey="bandwidth"
        copy={LIVE_RTDB_TRANSFER_COPY}
        story={rtdbStory}
        series={rtdbMetrics.series}
        points={rtdbMetrics.points}
        window={window}
      />
    </div>
  );
}

/** Tab 3: rules allow/deny metrics (or advisory local rules in Live Mode). */
export function RulesMetricsView({
  events,
  window,
  focusedInterval,
  capped,
}: {
  events: StudioTrafficEvent[];
  window: TimeWindow;
  focusedInterval?: TrafficFocusedInterval | null;
  capped?: boolean;
}) {
  const mode: TrafficHostMode = useLiveHost() !== null ? 'live' : 'sandbox';
  const evaluatedEvents = useMemo(() => {
    if (mode === 'live') return liveRulesDecisionEvents(events, window);
    return rulesDecisionEvents(events);
  }, [events, window, mode]);
  const rules = useRulesMetrics({ events: evaluatedEvents, window });
  const decisionSeries = useMemo(
    () => rulesDecisionSeriesForMode(rules.series, mode),
    [rules.series, mode],
  );
  const driftCount = useMemo(() => {
    if (mode !== 'live') return 0;
    return localDriftCount(events, window);
  }, [events, window, mode]);
  const unevaluatedCount = useMemo(() => {
    if (mode !== 'live') return 0;
    return localUnevaluatedCount(events, window);
  }, [events, window, mode]);
  const bypassedCount = useMemo(() => {
    if (mode !== 'live') return 0;
    return liveBypassedCount(events, window);
  }, [events, window, mode]);
  const deniedByProduction = useMemo(() => {
    if (mode !== 'live') return 0;
    return productionDeniedCount(events, window);
  }, [events, window, mode]);
  const unsupportedCount = useMemo(
    () => queryProofUnsupportedCount(events, window),
    [events, window],
  );
  const story = useMemo(() => {
    if (mode === 'live') {
      return liveRulesStory(decisionSeries, { driftCount, unevaluatedCount, bypassedCount });
    }
    return rulesStory(decisionSeries);
  }, [decisionSeries, mode, driftCount, unevaluatedCount, bypassedCount]);

  const isCapped = capped === true;

  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-rules-view">
      {focusedInterval ? <TrafficTimeFocusBanner focus={focusedInterval} /> : null}
      <TrafficCapNotice capped={isCapped} scope="rules" />
      <RulesSummaryLine
        mode={mode}
        evaluatedCount={story.total}
        driftCount={driftCount}
        unevaluatedCount={unevaluatedCount}
        bypassedCount={bypassedCount}
        deniedByProduction={deniedByProduction}
        unsupportedCount={unsupportedCount}
      />
      <JournalMetricPanel
        copy={RULES_PANEL_COPY[mode]}
        story={story}
        series={decisionSeries}
        points={rules.points}
        window={window}
      />
    </div>
  );
}
