/**
 * The RTDB surface's location: the database path lives in the URL.
 *
 * The Data feature keeps the focused Firestore document in the route's `rest`
 * segments (`features/data/navigation.tsx`), so a document link is an ordinary
 * shareable Studio URL. The RTDB viewer follows the same rule: `/rtdb/a/b/c`
 * focuses `/a/b/c`, `/rtdb` alone focuses the root, and clicking a node in the
 * tree pushes the new path through the shell's one history facade
 * (`shell/router.ts`). Both directions read and write the same codec, so the
 * address bar always names the focused path and back/forward work.
 *
 * The listener links (`features/listeners/listener-links.ts`) and the command
 * palette's database results both build this route shape.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { normalizeRtdbPath, rtdbPathSegments } from '@pyric/ui/rtdb';
import {
  currentPath,
  pushPath,
  subscribeToLocation,
} from '../../shell/router.js';

/** The shell tab the RTDB viewer lives behind. */
export const RTDB_TAB = 'rtdb';

/** The database path a routed location focuses. `/rtdb` alone is the root. */
export function rtdbPathForLocation(location: {
  readonly tab: string;
  readonly rest: readonly string[];
}): string {
  if (location.tab !== RTDB_TAB) return '/';
  return normalizeRtdbPath(location.rest.join('/'));
}

/** The routed target that focuses a database path. */
export function routeForRtdbPath(path: string): {
  tab: string;
  rest: string[];
} {
  return { tab: RTDB_TAB, rest: rtdbPathSegments(path) };
}

/**
 * Two-way bind the focused database path to the URL. The snapshot is a plain
 * string, so `useSyncExternalStore` needs no memoized reference.
 */
export function useRoutedRtdbPath(): readonly [string, (path: string) => void] {
  const path = useSyncExternalStore(
    subscribeToLocation,
    () => rtdbPathForLocation(currentPath()),
    () => '/',
  );

  const navigate = useCallback((next: string) => {
    pushPath(routeForRtdbPath(next));
  }, []);

  return [path, navigate] as const;
}
