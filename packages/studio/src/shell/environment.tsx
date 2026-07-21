/**
 * Environment provider (T4).
 *
 * Resolves the Studio environment once, at the top of the tree, by calling
 * `createStudioEnvironment('local')` (the `local` mode `pyric dev --ui` uses).
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

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
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
const PENDING_ENVIRONMENT: EnvironmentState = {
  status: 'pending',
  env: null,
  error: null,
};

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
  /** Defaults to `local`: the mode `pyric dev --ui` runs. */
  mode?: StudioMode;
  children: ReactNode;
}

export function EnvironmentProvider({
  mode = 'local',
  children,
}: EnvironmentProviderProps) {
  // Resolve inside the effect so React Strict Mode can cleanly dispose its
  // development setup pass instead of abandoning render-created listeners.
  const [resolved, setResolved] = useState<{
    mode: StudioMode;
    state: EnvironmentState;
  } | null>(null);
  useEffect(() => {
    const state = resolveEnvironment(mode);
    setResolved({ mode, state });
    return () => {
      if (state.status === 'ready') state.env.dispose();
    };
  }, [mode]);

  // A mode change renders once before its effect runs. Do not expose the old,
  // soon-to-be-disposed environment during that render.
  const state = resolved?.mode === mode
    ? resolved.state
    : PENDING_ENVIRONMENT;

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
