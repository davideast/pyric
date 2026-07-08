import { createContext, createElement, useContext, type ReactNode } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  startAfter,
} from 'pyric/firestore';

/**
 * The modular Firestore functions the data hooks call, as an INJECTABLE bundle.
 *
 * WHY: the hooks default to the in-process `pyric/firestore` API, but Pyric
 * Studio's served mode drives the SAME ops over a SharedWorker via a PARALLEL
 * modular client (`pyric-tools/serve/worker`: its own `collection`/`getDocs`/...
 * over a `MessagePort`, and a `ClientDb` that is not a `pyric/firestore`
 * `Firestore`). Statically importing the in-process fns hardwires the hooks to
 * the in-page sandbox; reading them from this context lets a consumer inject the
 * worker client's fns so the hooks operate on the live worker backend without
 * the hooks (or the components) knowing which backend they hit.
 *
 * The bundle is typed to the in-process signatures. A worker bundle is adapted
 * (cast) to this shape at the Studio boundary: the worker handles + snapshots
 * are runtime-compatible at the surface the hooks use (`.id` / `.data()` /
 * `.docs` / `.ref`), which is the contract function-injection relies on.
 *
 * Default = the real `pyric/firestore` fns, so every existing consumer (the
 * dev-seed review build, tests, any app embedding `@pyric/ui`) is unchanged: no
 * provider needed unless you are swapping the backend.
 */
export type FirestoreApi = Pick<
  typeof import('pyric/firestore'),
  | 'addDoc'
  | 'collection'
  | 'deleteDoc'
  | 'doc'
  | 'getDoc'
  | 'getDocs'
  | 'limit'
  | 'query'
  | 'setDoc'
  | 'startAfter'
>;

const inProcessFirestoreApi: FirestoreApi = {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  startAfter,
};

const FirestoreApiContext = createContext<FirestoreApi>(inProcessFirestoreApi);

/** Read the active Firestore API bundle (defaults to in-process `pyric/firestore`). */
export function useFirestoreApi(): FirestoreApi {
  return useContext(FirestoreApiContext);
}

/**
 * Provide a Firestore API bundle to the subtree. Pyric Studio wraps its data
 * surface with this, supplying the in-process bundle for dev-seed review and the
 * SharedWorker client bundle under `pyric dev --ui`.
 */
export function FirestoreApiProvider({
  value,
  children,
}: {
  value: FirestoreApi;
  children: ReactNode;
}) {
  return createElement(FirestoreApiContext.Provider, { value }, children);
}
