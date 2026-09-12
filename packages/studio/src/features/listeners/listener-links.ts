/**
 * The links the Listeners feature builds (feature: Listeners).
 *
 * Two kinds, both through the shell's one route codec (`shell/path.ts`) so a
 * listener link is an ordinary shareable Studio URL:
 *
 *   - a delivered path opens the record in the data viewer. A Firestore path
 *     routes to the document route the Data feature owns (`/firestore/<a>/<b>`,
 *     built from `routeForTarget` so the segment split matches the viewer's own
 *     parse); a database path routes to `/rtdb/<a>/<b>`, the shape the command
 *     palette's database results already target.
 *   - the drill-in page for one listener lives under the Traffic tab at
 *     `/traffic/listeners/<listenerId>`. The tab strip stays on Listeners
 *     while the path carries an id, and the tab's own deep link
 *     (`?view=listeners&listener=<id>`) is untouched by it.
 *
 * The listener id appears in the route and nowhere on screen: the page names
 * the target the app wrote.
 */

import { hrefFor } from '../../shell/router.js';
import { parseDocPath, routeForTarget } from '../data/navigation.js';

/** A routed target in the shape `shell/router.ts` serializes. */
export interface RoutedTarget {
  readonly tab: string;
  readonly rest?: readonly string[];
  readonly query?: Record<string, string | undefined>;
}

/** The first path segment under the Traffic tab that opens one listener. */
export const LISTENER_DRILL_SEGMENT = 'listeners';

/** The data-viewer route for one delivered path. */
export function documentTargetFor(
  service: 'firestore' | 'database',
  path: string,
): RoutedTarget {
  if (service === 'firestore') return routeForTarget({ view: 'firestore', path: parseDocPath(path) });
  return { tab: 'rtdb', rest: path.split('/').filter(Boolean) };
}

/** The data-viewer href for one delivered path. */
export function documentHref(service: 'firestore' | 'database', path: string): string {
  return hrefFor(documentTargetFor(service, path));
}

/** The drill-in route for one listener. */
export function listenerDrillTarget(listenerId: string): RoutedTarget {
  return { tab: 'traffic', rest: [LISTENER_DRILL_SEGMENT, listenerId] };
}

/** The route back to the Listeners tab from the drill-in page. */
export function listenersTabTarget(): RoutedTarget {
  return { tab: 'traffic', query: { view: 'listeners' } };
}

/** The href back to the Listeners tab. */
export function listenersTabHref(): string {
  return hrefFor(listenersTabTarget());
}

/** The listener a routed location drills into, or nothing when it does not.
 *  Reads the parsed path rather than `location` so it is testable. */
export function drilledListenerId(location: {
  readonly tab: string;
  readonly rest: readonly string[];
}): string | undefined {
  if (location.tab !== 'traffic') return undefined;
  if (location.rest[0] !== LISTENER_DRILL_SEGMENT) return undefined;
  const id = location.rest[1];
  return id === undefined || id === '' ? undefined : id;
}
