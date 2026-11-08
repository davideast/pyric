/**
 * The wiring for one listener's page (feature: Listeners). The Traffic surface
 * renders this when the path is `/traffic/listeners/<id>`; it reads the live
 * event stream and hands `ListenerPage` its snapshot.
 */

import type { TimeWindow } from '@pyric/ui/traffic';
import { ListenerPage } from './ListenerPage.js';
import { useScopedListenerEvents } from './use-scoped-listener-events.js';

export interface ListenerPageSurfaceProps {
  listenerId: string;
  /** The window the Traffic surface computed, shared with the metrics tabs. */
  window: TimeWindow;
  /** The Traffic surface's `Hide Studio traffic` toggle. */
  hideStudio?: boolean;
  /** Live-host `From` client/user scope (`?from=`). */
  fromScope?: string | undefined;
}

export function ListenerPageSurface({
  listenerId,
  window,
  hideStudio,
  fromScope,
}: ListenerPageSurfaceProps) {
  const events = useScopedListenerEvents(fromScope);
  const props: {
    events: readonly typeof events[number][];
    listenerId: string;
    window: TimeWindow;
    hideStudio?: boolean;
  } = { events, listenerId, window };
  if (hideStudio !== undefined) props.hideStudio = hideStudio;
  return <ListenerPage {...props} />;
}
