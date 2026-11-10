/**
 * Serve discovery, shared: the ONE cached read of `/__pyric/init.json`.
 *
 * Only a `pyric dev` serve answers this route with JSON; it is how Studio
 * tells "served" from "dev-seed / review" (no server at all). Several
 * surfaces need slices of the payload — the shell's degraded-health chip,
 * Home's status chips (persistence mode, rules hash) — so the fetch happens
 * once, module-level, and everyone reads the same store.
 *
 * DEGRADES CLEANLY: in dev-seed / review the fetch fails or returns non-JSON
 * and the state settles on `absent`; consumers render nothing for it. No
 * feature may *require* this endpoint (dev-seed sanity).
 */

import { useSyncExternalStore } from 'react';

/** The slice of the serve init payload Studio surfaces read. Mirrors
 *  `@pyric/cli`' `InitPayload` (kept structural; no runtime import). */
export interface ServeInitDatabaseInstances {
  defaultInstance?: string;
  rules?: Record<string, unknown | null>;
}

export interface ServeInitPayload {
  rules?: string | null;
  rulesHash?: string | null;
  databaseRulesHash?: string | null;
  databaseInstances?: ServeInitDatabaseInstances | null;
  bridgeUrl?: string | null;
  sessionToken?: string;
  persist?: boolean;
  persistenceUnhealthy?: boolean;
  seed?: Record<string, Record<string, unknown>> | null;
}

/** Per-boot session capability token stamped into served Studio HTML, if present. */
export function stampedStudioSessionToken(): string | undefined {
  const token = (globalThis as { __PYRIC_WORKER_INIT__?: { sessionToken?: string } }).__PYRIC_WORKER_INIT__?.sessionToken;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/** Resolved session capability token from cached `/__pyric/init.json` or stamped HTML. */
export function studioSessionToken(): string | undefined {
  if (state.status === 'ready' && typeof state.payload.sessionToken === 'string' && state.payload.sessionToken.length > 0) {
    return state.payload.sessionToken;
  }
  return stampedStudioSessionToken();
}

/** Headers record carrying `x-pyric-session-token` when a session token is available. */
export function studioSessionHeaders(extraToken?: string | null): Record<string, string> | undefined {
  const explicit = typeof extraToken === 'string' && extraToken.length > 0 ? extraToken : undefined;
  const token = explicit ?? studioSessionToken();
  return token !== undefined ? { 'x-pyric-session-token': token } : undefined;
}

export type ServeInitState =
  | { status: 'loading'; payload: null }
  | { status: 'absent'; payload: null }
  | { status: 'ready'; payload: ServeInitPayload };

const LOADING: ServeInitState = { status: 'loading', payload: null };
const ABSENT: ServeInitState = { status: 'absent', payload: null };

let state: ServeInitState = LOADING;
let started = false;
const listeners = new Set<() => void>();

function set(next: ServeInitState): void {
  state = next;
  for (const cb of listeners) cb();
}

function start(): void {
  if (started) return;
  started = true;
  if (typeof fetch === 'undefined') {
    state = ABSENT;
    return;
  }
  const headers = studioSessionHeaders();
  (headers ? fetch('/__pyric/init.json', { headers }) : fetch('/__pyric/init.json'))
    .then(async (res) => {
      if (!res.ok) return set(ABSENT);
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json')) return set(ABSENT);
      const payload = (await res.json()) as ServeInitPayload;
      set({ status: 'ready', payload });
    })
    .catch(() => set(ABSENT));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  start();
  return () => listeners.delete(cb);
}

/** The serve init payload, fetched once. `absent` in dev-seed / review. */
export function useServeInit(): ServeInitState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Test seam: reset the module store (bun tests share module state). */
export function resetServeInitForTests(next: ServeInitState = LOADING): void {
  state = next;
  started = next !== LOADING;
}
