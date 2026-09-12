/**
 * One listener's page (feature: Listeners), at `/traffic/listeners/<id>`.
 *
 * The Listeners tab answers what is attached; this page answers what one
 * listener has been handing the app. It keeps the tab's journal shape so the
 * drill in is the same document read closer, in five sections and no others:
 * the header names the target and its facts, the cards state the totals, the
 * chart is supporting evidence, the deliveries are the detail, and the
 * documents are what the deliveries add up to.
 *
 * Nothing on the page opens: a delivery is a time, its figures, and the paths
 * that changed, all of which fit on the line. Long histories page twenty
 * deliveries at a time through the stream's `traffic__show-more`, so the block
 * count stays bounded.
 *
 * Presentational: it takes the event snapshot, the window, and the clock as
 * props, so the page renders in a test without Studio's environment wiring.
 */

import { useMemo, useState } from 'react';
import { TrafficLineChart, type TimeWindow } from '@pyric/ui/traffic';
import { activeListeners, type ActiveListener, type SandboxEvent } from 'pyric/sandbox';
import { pushPath } from '../../shell/router.js';
import { deliveryMetrics } from './listener-metrics.js';
import {
  changedDocuments,
  deliveredDocumentReads,
  distinctDeliveredPaths,
  listenerDeliveryHistory,
} from './listener-delivery-docs.js';
import { DeliveryBlock, PathLink, deliveryTimeFormatter } from './DeliveryBlock.js';
import { IncidentBlock } from './IncidentBlock.js';
import type { ChangedDocument } from './listener-delivery-docs.js';

/** The last change kind, with how many changes the document had when more than one. */
function documentChangeLabel(document: ChangedDocument): string {
  const count = document.changes.length;
  return count > 1 ? `${document.last.change} ${count}×` : document.last.change;
}
import { elementLabel } from './listener-element.js';
import { formatListenerTarget, groupIdentityFor } from './listener-groups.js';
import { listenerFactLine } from './listener-facts.js';
import { listenerIncidents, incidentsForTarget } from './listener-incidents.js';
import { listenersTabHref, listenersTabTarget } from './listener-links.js';

/** Deliveries revealed per press of the disclosure, matching the request
 *  stream's page size: enough to scan, bounded enough to stay a list. */
export const DELIVERY_PAGE = 20;

const countFormatter = new Intl.NumberFormat();
const rangeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function formatCount(value: number): string {
  return countFormatter.format(value);
}

/** The four totals, in the order the cards render. */
const CARDS: ReadonlyArray<{ metric: string; label: string }> = [
  { metric: 'deliveries', label: 'Deliveries' },
  { metric: 'documents', label: 'Documents' },
  { metric: 'reads', label: 'Document reads' },
  { metric: 'suppressed', label: 'Suppressed' },
];

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
  /** The window the Traffic surface computed; the chart is drawn over it. */
  window: TimeWindow;
  /** The clock the attach age is read against; defaults to now. */
  now?: number;
}

export function ListenerPage({ events, listenerId, window, now }: ListenerPageProps) {
  const [shown, setShown] = useState(DELIVERY_PAGE);

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

  const totals: Record<string, number> = {
    deliveries: history.length,
    documents: distinctDeliveredPaths(history),
    reads: deliveredDocumentReads(history),
    suppressed: listener.suppressedCount,
  };
  const documents = changedDocuments(history);
  const snapshotSize = history.length === 0 ? 0 : history[history.length - 1]!.size;
  // Keyed by the delivery's position in the history rather than its
  // timestamp: two deliveries of one listener can land in the same
  // millisecond, and a key has to stay unique when they do.
  const newestFirst = history.map((delivery, index) => ({ delivery, index })).reverse();
  const visible = newestFirst.slice(0, shown);
  const hidden = newestFirst.length - visible.length;

  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-listener-page">
      <BackToListeners />
      <div className="traffic__metric-panel traffic__metric-panel--journal">
        <section className="traffic__metric-story" data-pyric-section="header">
          <h3 className="traffic__metric-headline">{formatListenerTarget(listener.target)}</h3>
          {incident === undefined ? null : (
            <IncidentBlock
              incident={incident}
              listener={listener}
              events={events}
              now={clock}
            />
          )}
          <p className="traffic__listener-facts" data-pyric-page-facts="">
            {listenerFactLine(facts, clock)}
          </p>
        </section>

        <section
          className="traffic__metric-cards traffic__metric-cards--journal"
          data-pyric-section="cards"
        >
          {CARDS.map((card) => (
            <span key={card.metric} data-pyric-metric-card="" data-metric={card.metric}>
              <span data-pyric-metric-label="">{card.label}</span>
              <span data-pyric-metric-value="">{formatCount(totals[card.metric] ?? 0)}</span>
            </span>
          ))}
        </section>

        <section className="traffic__metric-evidence" data-pyric-section="evidence">
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
        </section>

        {newestFirst.length === 0 ? null : (
          <section className="traffic__listener-section" data-pyric-section="deliveries">
            <p className="traffic__metric-eyebrow">Deliveries</p>
            <div className="traffic__log" data-pyric-delivery-log="">
              {visible.map((entry) => (
                <DeliveryBlock
                  key={entry.index}
                  delivery={entry.delivery}
                  service={listener.service}
                />
              ))}
              {hidden > 0 ? (
                <button
                  type="button"
                  className="traffic__show-more"
                  data-pyric-show-more=""
                  onClick={() => setShown((current) => current + DELIVERY_PAGE)}
                >
                  Show {formatCount(Math.min(hidden, DELIVERY_PAGE))} more
                </button>
              ) : null}
            </div>
          </section>
        )}

        {documents.length === 0 ? null : (
          <section className="traffic__listener-section" data-pyric-section="documents">
            <div className="traffic__listener-documents-head">
              <p className="traffic__metric-eyebrow">Documents</p>
              <span data-pyric-documents-figures="">
                {formatCount(snapshotSize)} in snapshot · {formatCount(documents.length)} changed
              </span>
            </div>
            <div className="traffic__listener-documents" data-pyric-document-list="">
              {documents.map((document) => (
                <div
                  className="traffic__listener-document"
                  key={document.path}
                  data-pyric-document={document.path}
                >
                  <PathLink path={document.path} service={listener.service} />
                  <span className="traffic__delivery-change" data-pyric-change={document.last.change}>
                    {documentChangeLabel(document)}
                  </span>
                  <span className="traffic__listener-document-time" data-pyric-document-time="">
                    {deliveryTimeFormatter.format(document.last.at)}
                  </span>
                </div>
              ))}
            </div>
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
                it arrived, so it lists none. <code>Documents</code> counts distinct paths across
                the session, and <code>Document reads</code> sums every snapshot's size, so a path
                delivered ten times is one document and ten reads. <code>Suppressed</code> counts
                re-evals the sandbox resolved to no observable change, which never reached the
                callback.
              </p>
            </div>
          </details>
        </footer>
      </div>
    </div>
  );
}
