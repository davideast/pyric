/**
 * Reads the active-listener event stream narrowed by the live Traffic `From`
 * client/user scope (`?from=`) when active.
 */
import { useMemo } from 'react';
import type { SandboxEvent } from 'pyric/sandbox';
import { useStudioEvents } from '../../shell/studio-events.js';
import { inRawEventFromScope } from '../traffic/live-row.js';

export function useScopedListenerEvents(fromScope?: string): readonly SandboxEvent[] {
  const allEvents = useStudioEvents('active-listeners');
  return useMemo(
    () => (fromScope === undefined ? allEvents : inRawEventFromScope(allEvents, fromScope)),
    [allEvents, fromScope],
  );
}
