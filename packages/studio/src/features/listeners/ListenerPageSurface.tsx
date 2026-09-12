/**
 * The wiring for one listener's page (feature: Listeners). The Traffic surface
 * renders this when the path is `/traffic/listeners/<id>`; it reads the live
 * event stream and hands `ListenerPage` its snapshot.
 */

import { useStudioEvents } from '../../shell/studio-events.js';
import type { TimeWindow } from '@pyric/ui/traffic';
import { ListenerPage } from './ListenerPage.js';

export interface ListenerPageSurfaceProps {
  listenerId: string;
  /** The window the Traffic surface computed, shared with the metrics tabs. */
  window: TimeWindow;
}

export function ListenerPageSurface({ listenerId, window }: ListenerPageSurfaceProps) {
  const events = useStudioEvents();
  return <ListenerPage events={events} listenerId={listenerId} window={window} />;
}
