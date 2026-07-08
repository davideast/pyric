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
 *  `pyric-tools`' `InitPayload` (kept structural; no runtime import). */
export interface ServeInitPayload {
  rules?: string | null;
  rulesHash?: string | null;
  databaseRulesHash?: string | null;
  bridgeUrl?: string | null;
  persist?: boolean;
  seed?: Record<string, Record<string, unknown>> | null;
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
  fetch('/__pyric/init.json')
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
