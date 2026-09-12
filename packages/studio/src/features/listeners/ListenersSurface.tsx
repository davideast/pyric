/**
 * Listeners surface (feature: Listeners). The Traffic tab strip renders this
 * for `?view=listeners`. It wires the live event stream and the runtime
 * chip's deep link (`?view=listeners&listener=<id>&target=<path>`, read off
 * the routed query) into the presentational `ListenersView`.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { useStudioEvents } from '../../shell/studio-events.js';
import { currentPath, locationKey, subscribeToLocation } from '../../shell/router.js';
import { ListenersView } from './ListenersView.js';
import { listenersDeepLinkFromQuery, type ListenersDeepLink } from './listeners-deep-link.js';

const CLOSED: ListenersDeepLink = { open: false };

function routedDeepLink(): ListenersDeepLink {
  return listenersDeepLinkFromQuery(currentPath().query);
}

export interface ListenersSurfaceProps {
  deepLink?: ListenersDeepLink;
}

export function ListenersSurface({ deepLink }: ListenersSurfaceProps) {
  const events = useStudioEvents();
  // The link lives in the URL, so back/forward and a chip click that lands on
  // an already-open Studio both move the selection (N4: the URL is the store).
  // The subscribed snapshot is the location string, not the parsed link:
  // `getSnapshot` has to be referentially stable between changes, and parsing
  // allocates a fresh object every call. Parse once per location instead.
  const key = useSyncExternalStore(subscribeToLocation, locationKey, () => '');
  const routed = useMemo(() => (key === '' ? CLOSED : routedDeepLink()), [key]);
  const link = deepLink ?? routed;
  const props: {
    events: readonly typeof events[number][];
    selectedListenerId?: string;
    initialTargetPrefix?: string;
  } = { events };
  if (link.listenerId !== undefined) props.selectedListenerId = link.listenerId;
  if (link.targetPrefix !== undefined) props.initialTargetPrefix = link.targetPrefix;
  return <ListenersView {...props} />;
}
