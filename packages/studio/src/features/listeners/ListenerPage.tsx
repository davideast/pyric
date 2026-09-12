/**
 * One listener's page (feature: Listeners), at `/traffic/listeners/<id>`.
 *
 * The Listeners tab answers "what is attached"; this page answers "what has
 * this one been handing my app". It keeps the tab's journal shape so the drill
 * in is the same document read closer: the story leads, the cards state the
 * totals, the chart is supporting evidence, the deliveries are the detail, and
 * the source boundary sits in the footer with the methodology on demand.
 *
 * The log is one row per delivery, newest first, each row expanding in place
 * into the paths that delivery handed the callback. Long histories page twenty
 * rows at a time through the stream's `traffic__show-more` disclosure, so the
 * row count stays bounded.
 *
 * Presentational: it takes the event snapshot, the window, and the clock as
 * props, so the page renders in a test without Studio's environment wiring.
 */

import { useMemo, useState } from 'react';
import {
  TrafficLineChart,
  TrafficMetricCards,
  type TimeWindow,
} from '@pyric/ui/traffic';
import { activeListeners, type SandboxEvent } from 'pyric/sandbox';
import { pushPath } from '../../shell/router.js';
import { deliveryMetrics } from './listener-metrics.js';
import {
  distinctDeliveredPaths,
  listenerDeliveryHistory,
  type ListenerDelivery,
} from './listener-delivery-docs.js';
import { DeliveredPathList } from './DeliveredPaths.js';
import { listenersTabHref, listenersTabTarget } from './listener-links.js';
import {
  formatDeliveryCounts,
  formatDocumentCount,
  listenerPageCards,
  listenerPageHeader,
} from './listener-page.js';

/** Deliveries revealed per press of the disclosure, matching the request
 *  stream's page size: enough to scan, bounded enough to stay a list. */
export const DELIVERY_PAGE = 20;

const countFormatter = new Intl.NumberFormat();
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});
const rangeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function formatCount(value: number): string {
  return countFormatter.format(value);
}

/** The link back to the tab this page drilled out of. */
function BackToListeners() {
  return (
    <div className="traffic__listener-drill-bar">
      <a
        className="traffic__inspector-title traffic__listener-drill-back"
        href={listenersTabHref()}
        data-pyric-listener-back=""
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          pushPath(listenersTabTarget());
        }}
      >
        Listeners
      </a>
    </div>
  );
}

/** One delivery: the row, and the result set it expands into. */
function DeliveryRow({
  delivery,
  service,
  expanded,
  onToggle,
}: {
  delivery: ListenerDelivery;
  service: 'firestore' | 'database';
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li data-pyric-listener-delivery="" data-pyric-listener-delivery-at={delivery.at}>
      <button
        type="button"
        data-pyric-listener-delivery-row=""
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span data-pyric-listener-delivery-time="">{timeFormatter.format(delivery.at)}</span>
        <span data-pyric-listener-delivery-counts="">{formatDeliveryCounts(delivery)}</span>
        <span data-pyric-listener-delivery-size="">{formatDocumentCount(delivery.size)}</span>
      </button>
      {expanded ? (
        <div className="traffic__listener-delivery-detail">
          {delivery.docs.length === 0 ? (
            <p className="traffic__inspector-missing">Delivered an empty result.</p>
          ) : (
            <DeliveredPathList docs={delivery.docs} service={service} />
          )}
          <div className="traffic__listener-field">
            <span className="traffic__inspector-title">Rendered after each delivery</span>
            <div>
              <p className="traffic__inspector-missing" data-pyric-listener-rendered="">
                Not recorded yet.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export interface ListenerPageProps {
  events: readonly SandboxEvent[];
  listenerId: string;
  /** The window the Traffic surface computed; the chart is drawn over it. */
  window: TimeWindow;
  /** The clock the attach age is read against; defaults to now. */
  now?: number;
}

export function ListenerPage({ events, listenerId, window, now }: ListenerPageProps) {
  const [shown, setShown] = useState(DELIVERY_PAGE);
  const [expanded, setExpanded] = useState<readonly number[]>([]);

  const listener = useMemo(
    () => activeListeners(events).find((candidate) => candidate.id === listenerId),
    [events, listenerId],
  );
  const history = useMemo(
    () => listenerDeliveryHistory(events, listenerId),
    [events, listenerId],
  );
  const chart = useMemo(
    () => deliveryMetrics(events, listener ? [listener] : [], window),
    [events, listener, window],
  );

  if (listener === undefined) {
    return (
      <div className="traffic__metrics" data-pyric-ui="traffic-listener-page">
        <BackToListeners />
        <p className="traffic__empty" data-pyric-listener-missing="">
          This listener is not attached in this session.
        </p>
      </div>
    );
  }

  const header = listenerPageHeader(listener, now ?? Date.now());
  const cards = listenerPageCards({
    deliveries: history.length,
    documents: distinctDeliveredPaths(history),
    suppressed: listener.suppressedCount,
  });
  // Keyed by the delivery's position in the history rather than its
  // timestamp: two deliveries of one listener can land in the same
  // millisecond, and a key has to stay unique when they do.
  const newestFirst = history.map((delivery, index) => ({ delivery, index })).reverse();
  const visible = newestFirst.slice(0, shown);
  const hidden = newestFirst.length - visible.length;

  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-listener-page">
      <BackToListeners />
      <section className="traffic__metric-panel traffic__metric-panel--journal">
        <header className="traffic__metric-story">
          <p className="traffic__metric-eyebrow">{header.eyebrow}</p>
          <h3 className="traffic__metric-headline">{header.headline}</h3>
          <p className="traffic__metric-finding">{header.finding}</p>
        </header>

        <TrafficMetricCards
          series={cards}
          formatValue={formatCount}
          className="traffic__metric-cards traffic__metric-cards--journal traffic__metric-cards--3"
        />

        <div className="traffic__metric-evidence">
          <div className="traffic__metric-evidence-header">
            <h4>When this listener delivered</h4>
            <span>
              {rangeFormatter.format(window.start)}–{rangeFormatter.format(window.end)}
            </span>
          </div>
          {chart.total === 0 ? (
            <p className="traffic__empty">No deliveries in this window.</p>
          ) : (
            <>
              <TrafficLineChart
                points={chart.points}
                series={chart.series}
                omitZeroSeries
                formatValue={formatCount}
                formatTime={(value) => rangeFormatter.format(value)}
                className="traffic__chart traffic__chart--journal"
              />
              <div className="traffic__metric-axis" aria-hidden="true">
                <span>{rangeFormatter.format(window.start)}</span>
                <span>{rangeFormatter.format(window.end)}</span>
              </div>
            </>
          )}
        </div>

        {newestFirst.length === 0 ? (
          <p className="traffic__empty" data-pyric-listener-empty="">
            No deliveries yet.
          </p>
        ) : (
          <div className="traffic__log" data-pyric-ui="traffic-listener-deliveries">
            <ul className="traffic__listener-group">
              {visible.map((entry) => (
                <DeliveryRow
                  key={entry.index}
                  delivery={entry.delivery}
                  service={listener.service}
                  expanded={expanded.includes(entry.index)}
                  onToggle={() =>
                    setExpanded((current) =>
                      current.includes(entry.index)
                        ? current.filter((index) => index !== entry.index)
                        : [...current, entry.index],
                    )
                  }
                />
              ))}
            </ul>
            {hidden > 0 ? (
              <button
                type="button"
                className="traffic__show-more"
                data-pyric-listener-show-more=""
                onClick={() => setShown((current) => current + DELIVERY_PAGE)}
              >
                Show {formatCount(Math.min(hidden, DELIVERY_PAGE))} more
              </button>
            ) : null}
          </div>
        )}

        <footer className="traffic__metric-footer">
          <p className="traffic__metric-source">
            Source: sandbox delivery events · every delivery this session recorded for this
            listener
          </p>
          <details className="traffic__metric-methodology">
            <summary>How this is counted</summary>
            <div>
              <p>
                Every delivery event carries the result set the callback received: a Firestore
                delivery carries the documents in callback order, and a database delivery carries
                the value at the target path, whose keys are child paths when that value is an
                object. The paths listed under a delivery are that result set, not a re-read of
                the store.
              </p>
              <p>
                <strong>The labels come from the previous delivery.</strong> A path is{' '}
                <code>added</code> when the previous delivery did not carry it,{' '}
                <code>modified</code> when it did and the data differs, and <code>removed</code>{' '}
                when the previous delivery carried it and this one does not. A path whose data is
                identical carries no label. <code>Documents</code> counts distinct paths across
                the session, so a path delivered many times counts once.{' '}
                <code>Suppressed</code> counts re-evals the sandbox resolved to no observable
                change, which never reached the callback.
              </p>
            </div>
          </details>
        </footer>
      </section>
    </div>
  );
}
