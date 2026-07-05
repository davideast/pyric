/**
 * Environment provider (T4).
 *
 * Resolves the Studio environment once, at the top of the tree, by calling
 * `createStudioEnvironment('local')` (the `local` mode `pyric serve --ui` uses).
 *
 * Crucially this TOLERATES the factory throwing: T3 implements the `local`
 * branch in parallel and the Phase-0 stub still throws "not implemented yet".
 * Rather than crash the whole app, we catch it and expose a discriminated
 * `status`:
 *
 *   - `ready`   : env resolved; panes can mount live `@pyric/ui` surfaces.
 *   - `pending` : resolving (effectively transient; the sync factory rarely
 *                 leaves us here, but the state exists for an async future).
 *   - `error`   : the factory threw (T3 not landed yet / misconfig). Panes show
 *                 a "local backend pending" empty state instead of crashing.
 *
 * Panes read this via {@link useEnvironment} and branch on `status`.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  createStudioEnvironment,
  type StudioEnvironment,
  type StudioMode,
} from '../env.js';

export type EnvironmentStatus = 'ready' | 'pending' | 'error';

export type EnvironmentState =
  | { status: 'ready'; env: StudioEnvironment; error: null }
  | { status: 'pending'; env: null; error: null }
  | { status: 'error'; env: null; error: Error };

const EnvironmentContext = createContext<EnvironmentState | null>(null);

/** Resolve the environment for `mode`, never throwing; failures become state. */
function resolveEnvironment(mode: StudioMode): EnvironmentState {
  try {
    const env = createStudioEnvironment(mode);
    return { status: 'ready', env, error: null };
  } catch (err) {
    return {
      status: 'error',
      env: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

export interface EnvironmentProviderProps {
  /** Defaults to `local`: the mode `pyric serve --ui` runs. */
  mode?: StudioMode;
  children: ReactNode;
}

export function EnvironmentProvider({
  mode = 'local',
  children,
}: EnvironmentProviderProps) {
  // The factory is synchronous today, so resolution is stable per `mode`.
  // Wrapped in `useMemo` so it's resolved once, not on every render.
  const state = useMemo(() => resolveEnvironment(mode), [mode]);

  return (
    <EnvironmentContext.Provider value={state}>
      {children}
    </EnvironmentContext.Provider>
  );
}

export function useEnvironment(): EnvironmentState {
  const ctx = useContext(EnvironmentContext);
  if (!ctx) {
    throw new Error(
      'useEnvironment must be used within an <EnvironmentProvider>',
    );
  }
  return ctx;
}
