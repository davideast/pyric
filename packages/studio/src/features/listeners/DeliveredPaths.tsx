/**
 * The paths one delivery handed the callback (feature: Listeners).
 *
 * Shared by the inspector's `Delivered` block and the drill-in page's log, so
 * a path reads the same in both: the path as the app wrote it, linked to the
 * record in the data viewer, with a change badge in the verdict pill's box.
 * An `unchanged` path carries no badge — it is the quiet case, and a badge on
 * every line would make the changes harder to find rather than easier.
 *
 * A link, not a button: these are ordinary Studio URLs, so middle-click and
 * copy-link work. `pushPath` on click keeps the in-app navigation one history
 * entry rather than a full reload.
 */

import type { ActiveListener } from 'pyric/sandbox';
import { pushPath } from '../../shell/router.js';
import type { DeliveredDoc } from './listener-delivery-docs.js';
import { documentHref, documentTargetFor } from './listener-links.js';

export function DeliveredPathLine({
  doc,
  service,
}: {
  doc: DeliveredDoc;
  service: ActiveListener['service'];
}) {
  const href = documentHref(service, doc.path);
  return (
    <a
      className="traffic__listener-doc"
      href={href}
      data-pyric-listener-doc={doc.path}
      data-pyric-listener-change={doc.change}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        pushPath(documentTargetFor(service, doc.path));
      }}
    >
      <span className="traffic__listener-mono">{doc.path}</span>
      {doc.change === 'unchanged' ? null : (
        <span className="traffic__listener-change" data-change={doc.change}>
          {doc.change}
        </span>
      )}
    </a>
  );
}

export function DeliveredPathList({
  docs,
  service,
}: {
  docs: readonly DeliveredDoc[];
  service: ActiveListener['service'];
}) {
  return (
    <div className="traffic__listener-docs" data-pyric-listener-docs="">
      {docs.map((doc) => (
        <DeliveredPathLine key={doc.path} doc={doc} service={service} />
      ))}
    </div>
  );
}
