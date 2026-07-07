/**
 * Live session list for the home page. Subscribes to the user's
 * sessions in the sandbox, returns a stable array sorted most-recently-
 * updated first, plus a `loading` flag that flips to false after the
 * first snapshot fires.
 *
 * The persistence layer restores asynchronously; we wait on
 * `sessionsReady()` before attaching the subscription so the initial
 * snapshot reflects the restored state (otherwise the home page
 * briefly renders an empty list during the IndexedDB read).
 *
 * Also re-attaches when the active user id changes — a fresh sign-in
 * (GIS subject claim appears) shifts the userId, and we want the list
 * to immediately reflect the new namespace.
 */
import { useEffect, useState } from 'react';
import {
  getCurrentUserId,
  sessionsReady,
  subscribeSessions,
  type SessionMeta,
} from '~/lib/sessions';

export interface HomeSessionsState {
  sessions: SessionMeta[];
  loading: boolean;
  userId: string;
}

export function useHomeSessions(): HomeSessionsState {
  const [userId, setUserId] = useState(() => getCurrentUserId());
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);

  // Poll the user id every 500ms — the GIS sign-in flow doesn't yet
  // emit a change event we can subscribe to, so this picks up
  // sign-in transitions with a small lag. Cheap call (memory read +
  // string compare); not worth wiring into a dedicated event channel
  // for the home page's purposes.
  useEffect(() => {
    const id = setInterval(() => {
      const next = getCurrentUserId();
      if (next !== userId) setUserId(next);
    }, 500);
    return () => clearInterval(id);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      await sessionsReady();
      if (cancelled) return;
      unsubscribe = subscribeSessions(userId, (next) => {
        setSessions(next);
        setLoading(false);
      });
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [userId]);

  return { sessions, loading, userId };
}
