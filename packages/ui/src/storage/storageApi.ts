import { createContext, createElement, useContext, type ReactNode } from 'react';
import { ref, listAll, getMetadata, getBlob } from 'pyric/storage';

/**
 * The modular Storage fns the browse/inspect hooks call, as an INJECTABLE
 * bundle (same pattern as `@pyric/ui`'s FirestoreApi / AuthApi).
 *
 * Default = in-process `pyric/storage`, so existing consumers are unchanged.
 * Pyric Studio served mode injects the SharedWorker client bundle so the Storage
 * surface browses the live worker object store. These ops are already async, so
 * no sync/async wrinkle (unlike auth `listUsers`); the worker handles/refs are
 * runtime-compatible at the surface the hooks use (`.fullPath` / `.name`).
 *
 * NOTE the rules gate (`useStorageRulesGate`) is NOT here: it reads in-process
 * rules internals and no-ops on a handle without them (worker handles), which is
 * the correct degrade (the worker enforces read rules on `listAll` server-side).
 */
export type StorageApi = Pick<
  typeof import('pyric/storage'),
  'ref' | 'listAll' | 'getMetadata' | 'getBlob'
>;

const inProcessStorageApi: StorageApi = { ref, listAll, getMetadata, getBlob };

const StorageApiContext = createContext<StorageApi>(inProcessStorageApi);

/** Read the active Storage API bundle (defaults to in-process `pyric/storage`). */
export function useStorageApi(): StorageApi {
  return useContext(StorageApiContext);
}

/** Provide a Storage API bundle to the subtree (Studio's worker client). */
export function StorageApiProvider({
  value,
  children,
}: {
  value: StorageApi;
  children: ReactNode;
}) {
  return createElement(StorageApiContext.Provider, { value }, children);
}
