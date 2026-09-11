/**
 * Listeners surface (feature: Listeners). Wires the live event stream and
 * the deep link (`?view=listeners&listener=<id>&target=<path>`, read once at
 * startup by the caller) into the presentational `ListenersView`.
 */

import { useStudioEvents } from '../../shell/studio-events.js';
import { ListenersView } from './ListenersView.js';
import type { ListenersDeepLink } from './listeners-deep-link.js';

export interface ListenersSurfaceProps {
  deepLink?: ListenersDeepLink;
}

export function ListenersSurface({ deepLink }: ListenersSurfaceProps) {
  const events = useStudioEvents();
  return (
    <ListenersView
      events={events}
      highlightListenerId={deepLink?.listenerId}
      initialTargetPrefix={deepLink?.targetPrefix}
    />
  );
}
