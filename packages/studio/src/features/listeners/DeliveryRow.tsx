/**
 * One delivery as a row in the log (feature: Listeners).
 *
 * The same row the Traffic stream uses, in the units a listener delivers:
 * when the callback ran, what moved, and how much it then held. Clicking a row
 * opens the paths it changed under it, the way a Traffic row opens its detail —
 * one row open at a time, and nothing to open inside the opened row.
 *
 * A path is split where the reader splits it: the collection prefix dims, the
 * identifier carries the line, and the whole path is a link into the data
 * viewer, so middle-click and copy-link work as they do on any Studio URL.
 */

import type { ActiveListener } from 'pyric/sandbox';
import { pushPath } from '../../shell/router.js';
import { deliveryMovement } from './listener-delivery-timeline.js';
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

/** The paths one delivery changed. The first delivery changed none: every path
 *  in it arrived, which its figures say. */
export function changedPaths(delivery: ListenerDelivery) {
  return delivery.initial ? [] : delivery.docs.filter((doc) => doc.change !== 'unchanged');
}

/**
 * One delivery: its time, what moved, and the snapshot it left. It opens on
 * click when it changed something, and the paths render under it.
 */
export function DeliveryRow({
  delivery,
  service,
  expanded = false,
  onToggle,
}: {
  delivery: ListenerDelivery;
  service: ActiveListener['service'];
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const changed = changedPaths(delivery);
  const open = expanded && changed.length > 0;
  return (
    <div className="traffic__delivery-entry" data-pyric-delivery-entry="">
      <button
        type="button"
        className="traffic__delivery-row"
        data-pyric-delivery-row=""
        data-pyric-delivery-at={delivery.at}
        data-pyric-selected={open ? '' : undefined}
        disabled={changed.length === 0 || onToggle === undefined}
        onClick={onToggle}
      >
        <span data-pyric-delivery-time="">{deliveryTimeFormatter.format(delivery.at)}</span>
        <span data-pyric-delivery-figures="">{deliveryMovement(delivery)}</span>
        <span data-pyric-delivery-snapshot="">{delivery.size} in snapshot</span>
      </button>
      {open ? (
        <div className="traffic__delivery-changes" data-pyric-delivery-changes="">
          {changed.map((doc) => (
            <div
              className="traffic__delivery-path"
              key={doc.path}
              data-pyric-delivery-path={doc.path}
            >
              <PathLink path={doc.path} service={service} />
              <span className="traffic__delivery-change" data-pyric-change={doc.change}>
                {doc.change}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
