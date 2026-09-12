/**
 * One listener's page (feature: Listeners), at `/traffic/listeners/<id>`.
 *
 * The Listeners tab answers what is attached; this page answers what one
 * listener watches and what it has been handing the app. It reads top to
 * bottom as one document: the target and its facts, the query the app wrote,
 * the incident when there is one, the three totals, then the deliveries over
 * time and the deliveries themselves.
 *
 * The deliveries reuse the Traffic timeline: the histogram buckets them, one
 * bar brushes an interval, and the rows under it narrow to that interval. A row
 * opens the paths it changed, one row at a time, and nothing opens inside it.
 *
 * Presentational: it takes the event snapshot, the window, and the clock as
 * props, so the page renders in a test without Studio's environment wiring.
 */

import { useMemo, useState } from 'react';
import { TrafficMetricCards, TrafficTimeline, type TimeWindow } from '@pyric/ui/traffic';
import { activeListeners, type ActiveListener, type SandboxEvent } from 'pyric/sandbox';
import { pushPath } from '../../shell/router.js';
import { toggleTimeFocus } from '../traffic/timeline-focus.js';
import { listenerDeliveryHistory } from './listener-delivery-docs.js';
import {
  deliveriesInInterval,
  deliveryTimelineEvents,
  intervalFacts,
} from './listener-delivery-timeline.js';
import { estimatedDocumentReads } from './listener-reads.js';
import {
  cardValueFormatter,
  listenerPageCards,
  listenerPageSeries,
  readsFootnote,
} from './listener-page-cards.js';
import { DeliveryRow, clockLabel } from './DeliveryRow.js';
import { IncidentBlock } from './IncidentBlock.js';
import { ListenerQueryBlock } from './ListenerQueryBlock.js';
import { elementLabel } from './listener-element.js';
import { formatListenerTarget, groupIdentityFor } from './listener-groups.js';
import { listenerFactLine } from './listener-facts.js';
import { listenerIncidents, incidentsForTarget } from './listener-incidents.js';
import { listenersTabHref, listenersTabTarget } from './listener-links.js';

const countFormatter = new Intl.NumberFormat();

function formatCount(value: number): string {
  return countFormatter.format(value);
}

/** One interval as the range it covers, on the clock the rows print. */
function rangeLabel(window: TimeWindow): string {
  return `${clockLabel(window.start)}–${clockLabel(window.end)}`;
}

/** How long ago, in the words the Traffic timeline's axis uses. */
function relAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** The link back to the tab this page drilled out of, above the headline. */
function BackToListeners() {
  return (
    <a
      className="traffic__listener-back"
      href={listenersTabHref()}
      data-pyric-page-back=""
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        pushPath(listenersTabTarget());
      }}
    >
      ← Listeners
    </a>
  );
}

export interface ListenerPageProps {
  events: readonly SandboxEvent[];
  listenerId: string;
  /** The window the Traffic surface computed; the histogram spans it. */
  window: TimeWindow;
  /** The clock the attach age is read against; defaults to now. */
  now?: number;
}

export function ListenerPage({ events, listenerId, window, now }: ListenerPageProps) {
  const [focus, setFocus] = useState<TimeWindow | null>(null);
  const [openDelivery, setOpenDelivery] = useState<number | null>(null);

  const listener = useMemo(
    () => activeListeners(events).find((candidate) => candidate.id === listenerId),
    [events, listenerId],
  );
  const history = useMemo(
    () => listenerDeliveryHistory(events, listenerId),
    [events, listenerId],
  );
  const incident = useMemo(() => {
    if (listener === undefined) return undefined;
    return incidentsForTarget(listenerIncidents(events), listener.target)[0];
  }, [events, listener]);

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

  const clock = now ?? Date.now();
  const element = elementLabel(listener.owners);
  const facts: {
    owner?: string;
    element?: string;
    service: ActiveListener['service'];
    attachedAt: number;
  } = { service: listener.service, attachedAt: listener.attachedAt };
  facts.owner = groupIdentityFor(listener).label;
  if (element !== undefined) facts.element = element;

  const target = formatListenerTarget(listener.target);
  const cards = listenerPageCards({
    deliveries: history.length,
    snapshot: history.length === 0 ? 0 : history[history.length - 1]!.size,
    reads: estimatedDocumentReads(history),
    service: listener.service,
    single: typeof listener.target === 'string' && listener.service === 'firestore',
  });
  const footnote = readsFootnote(listener.service);

  const timelineEvents = deliveryTimelineEvents(history, target);
  const shown = focus === null ? history : deliveriesInInterval(history, focus);
  // Keyed by the delivery's position in the history rather than its timestamp:
  // two deliveries of one listener can land in the same millisecond.
  const rows = history
    .map((delivery, index) => ({ delivery, index }))
    .filter(({ delivery }) => focus === null
      || (delivery.at >= focus.start && delivery.at < focus.end))
    .reverse();

  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-listener-page">
      <BackToListeners />
      <div className="traffic__metric-panel traffic__metric-panel--journal">
        <section className="traffic__metric-story" data-pyric-section="header">
          <h3 className="traffic__metric-headline" data-pyric-page-title="">{target}</h3>
          <p className="traffic__listener-facts" data-pyric-page-facts="">
            {listenerFactLine(facts, clock)}
          </p>
        </section>

        <ListenerQueryBlock listener={listener} />

        {incident === undefined ? null : (
          <IncidentBlock incident={incident} listener={listener} events={events} now={clock} />
        )}

        <section data-pyric-section="cards">
          <TrafficMetricCards
            series={listenerPageSeries(cards)}
            formatValue={cardValueFormatter(cards, formatCount)}
            className={`traffic__metric-cards traffic__metric-cards--journal${
              cards.length === 2 ? ' traffic__metric-cards--2' : ''
            }`}
          />
          {footnote === undefined ? null : (
            <p className="traffic__metric-source" data-pyric-metric-footnote="">{footnote}</p>
          )}
        </section>

        {history.length === 0 ? null : (
          <section className="traffic__listener-section" data-pyric-section="deliveries">
            <TrafficTimeline
              events={timelineEvents}
              window={window}
              brush={focus ?? undefined}
              onBrush={(bucket) => {
                setFocus((current) => toggleTimeFocus(current, bucket));
                setOpenDelivery(null);
              }}
              liveAt={window.end}
              bucketCount={36}
              className="traffic__timeline"
              axis={(spanned) => (
                <div className="traffic__tl-axis">
                  <span>{relAgo(spanned.start, clock)}</span>
                  <span>now</span>
                </div>
              )}
              renderBucketSummary={(bucket) => (
                <div className="traffic__bucket-summary">
                  <span>{rangeLabel(bucket)}</span>
                  <strong>{intervalFacts(deliveriesInInterval(history, bucket))[0]}</strong>
                </div>
              )}
            />

            {focus === null ? null : (
              <p className="traffic__listener-interval" data-pyric-interval="">
                <span className="traffic__time-focus-eyebrow">Selected interval</span>
                <span data-pyric-interval-facts="">
                  {[rangeLabel(focus), ...intervalFacts(shown)].join(' · ')}
                </span>
              </p>
            )}

            {rows.length === 0 ? null : (
              <div className="traffic__log" data-pyric-delivery-log="">
                {rows.map((entry) => (
                  <DeliveryRow
                    key={entry.index}
                    delivery={entry.delivery}
                    service={listener.service}
                    expanded={openDelivery === entry.index}
                    onToggle={() => setOpenDelivery(
                      openDelivery === entry.index ? null : entry.index,
                    )}
                  />
                ))}
              </div>
            )}
          </section>
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
                object. The paths under a delivery are that result set, not a re-read of the
                store.
              </p>
              <p>
                <strong>The labels come from the previous delivery.</strong> A path is{' '}
                <code>added</code> when the previous delivery did not carry it,{' '}
                <code>modified</code> when it did and the data differs, and <code>removed</code>{' '}
                when the previous delivery carried it and this one does not. A path whose data is
                identical is not listed. The first delivery is <code>initial</code>: every path in
                it arrived, so it lists none.
              </p>
              <p>
                Firestore charges a listener for the documents in its first snapshot, then for
                each document a later delivery adds or changes; a delivery that only drops
                documents costs nothing, and an empty first snapshot still costs one read. The
                estimate covers this session's deliveries, so a reconnect that re-read the result
                set and a second listener on the same query are not in it.
              </p>
            </div>
          </details>
        </footer>
      </div>
    </div>
  );
}
