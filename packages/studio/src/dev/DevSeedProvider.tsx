/**
 * Dev-seed context (Phase 0, F-SHELL).
 *
 * Resolves the in-page seeded sandbox once and exposes the data handles
 * (`Firestore` / `Auth` / `FirebaseStorage`) plus the unified event stream to
 * the surfaces via React context. This is what makes Studio reviewable without a
 * live `pyric dev`; the surfaces consume {@link useDevSeed} the same way they
 * will consume the real environment in production.
 *
 * GATING: the provider only seeds when `import.meta.env.DEV` is true. In a
 * production build it renders children with a `status: 'disabled'` context (and
 * `createSeededSandbox` is dynamically imported, so the seed + fixture data are
 * tree-shaken out of the prod bundle).
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SandboxEvent } from 'pyric/sandbox';
import { foldSessionEventLog } from '../events/fold.js';
import type { SeededHandles } from './seed.js';

export type DevSeedState =
  | { status: 'disabled'; handles: null; events: readonly SandboxEvent[] }
  | { status: 'pending'; handles: null; events: readonly SandboxEvent[] }
  | { status: 'ready'; handles: SeededHandles; events: readonly SandboxEvent[] }
  | { status: 'error'; handles: null; events: readonly SandboxEvent[]; error: Error };

const DevSeedContext = createContext<DevSeedState | null>(null);

const DISABLED: DevSeedState = { status: 'disabled', handles: null, events: [] };

export function DevSeedProvider({ children }: { children: ReactNode }) {
  // Outside DEV, skip seeding entirely; children still mount, surfaces fall
  // back to their (live-env or empty) path.
  if (!import.meta.env.DEV) {
    return (
      <DevSeedContext.Provider value={DISABLED}>
        {children}
      </DevSeedContext.Provider>
    );
  }
  return <DevSeedProviderImpl>{children}</DevSeedProviderImpl>;
}

function DevSeedProviderImpl({ children }: { children: ReactNode }) {
  const [handles, setHandles] = useState<SeededHandles | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [events, setEvents] = useState<readonly SandboxEvent[]>([]);

  // Seed once on mount. Dynamic import keeps the fixture out of prod bundles.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        const { createSeededSandbox } = await import('./seed.js');
        const resolved = await createSeededSandbox();
        if (cancelled) return;
        setHandles(resolved);
        // Seed the event log from history, then stay live on the stream.
        setEvents(resolved.sandbox.history());
        unsubscribe = resolved.sandbox.onEvent((event) => {
          // Fold through the session rule: "Reset session" emits a reset
          // session_boundary and clears sandbox.history(); this accumulated
          // mirror must drop the wiped session too (see `events/fold.ts`).
          setEvents((prev) => foldSessionEventLog(prev, event));
        });
      } catch (e) {
        if (!cancelled) {
          // Surface the cause to the console too; a failed fixture is a dev
          // signal, not something to swallow silently behind the error state.
          console.error('[pyric-studio] dev-seed failed:', e);
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const state = useMemo<DevSeedState>(() => {
    if (error) return { status: 'error', handles: null, events, error };
    if (!handles) return { status: 'pending', handles: null, events };
    return { status: 'ready', handles, events };
  }, [handles, error, events]);

  return (
    <DevSeedContext.Provider value={state}>{children}</DevSeedContext.Provider>
  );
}

/** Read the dev-seed state. Returns `disabled` when used outside a provider. */
export function useDevSeed(): DevSeedState {
  return useContext(DevSeedContext) ?? DISABLED;
}
