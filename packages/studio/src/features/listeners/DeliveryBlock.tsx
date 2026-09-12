/**
 * One delivery, and the paths in it (feature: Listeners).
 *
 * Shared by the tab's inspector and the listener page's log, so a delivery
 * reads the same in both: when it landed, what moved, and one line per path
 * that changed. There is nothing to open — a delivery is three facts and a
 * short list, and a disclosure over that hides more than it saves.
 *
 * A path is split where the reader splits it: the collection prefix dims, the
 * identifier carries the line, and the whole path is a link into the data
 * viewer, so middle-click and copy-link work as they do on any Studio URL.
 */

import type { ActiveListener } from 'pyric/sandbox';
import { pushPath } from '../../shell/router.js';
import { deliveryFigures } from './listener-facts.js';
import type { ListenerDelivery } from './listener-delivery-docs.js';
import { documentHref, documentTargetFor } from './listener-links.js';

export const deliveryTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

/** The path split at its last separator: everything up to the identifier,
 *  then the identifier. */
export function splitPath(path: string): { prefix: string; id: string } {
  const cut = path.lastIndexOf('/');
  if (cut === -1) return { prefix: '', id: path };
  return { prefix: path.slice(0, cut + 1), id: path.slice(cut + 1) };
}

export function PathLink({
  path,
  service,
}: {
  path: string;
  service: ActiveListener['service'];
}) {
  const { prefix, id } = splitPath(path);
  return (
    <a
      className="traffic__listener-path-link"
      href={documentHref(service, path)}
      title={path}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        pushPath(documentTargetFor(service, path));
      }}
    >
      <span data-pyric-path={path}>
        <span data-pyric-path-prefix="">{prefix}</span>
        <span data-pyric-path-id="">{id}</span>
      </span>
    </a>
  );
}

/** One delivery: its time, its figures, and the paths it changed. The initial
 *  delivery lists none — every path in it arrived, which its figures say. */
export function DeliveryBlock({
  delivery,
  service,
}: {
  delivery: ListenerDelivery;
  service: ActiveListener['service'];
}) {
  const changed = delivery.initial
    ? []
    : delivery.docs.filter((doc) => doc.change !== 'unchanged');
  return (
    <div className="traffic__delivery" data-pyric-delivery="" data-pyric-delivery-at={delivery.at}>
      <div className="traffic__delivery-head">
        <span data-pyric-delivery-time="">{deliveryTimeFormatter.format(delivery.at)}</span>
        <span data-pyric-delivery-figures="">{deliveryFigures(delivery)}</span>
      </div>
      {changed.map((doc) => (
        <div className="traffic__delivery-path" key={doc.path} data-pyric-delivery-path={doc.path}>
          <PathLink path={doc.path} service={service} />
          <span className="traffic__delivery-change" data-pyric-change={doc.change}>
            {doc.change}
          </span>
        </div>
      ))}
    </div>
  );
}
