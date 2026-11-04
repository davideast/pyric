// Loads the real `firebase` SDK from this checkout's node_modules for the
// replay tests: `firebase/app` and `firebase/auth` as Node resolves them, and
// Firestore's browser build, the one a page runs. Its WebChannel transport
// uses `fetch` streams, which Node and Bun have, so the browser build talks
// to the replay server here exactly as it would from a page.
//
// Call `routeFirebaseTo` before `loadSdk`: Auth takes `fetch` when it loads.
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export type FirebaseApp = typeof import('firebase/app');
export type FirebaseAuth = typeof import('firebase/auth');
export type FirebaseFirestore = typeof import('firebase/firestore');

export interface Sdk {
  app: FirebaseApp;
  auth: FirebaseAuth;
  firestore: FirebaseFirestore;
  /** The file Firestore loaded from, for the report. */
  firestoreEntry: string;
}

/** `@firebase/firestore`'s browser ESM build, found next to the Node build that `firebase/firestore` resolves to. */
export function firestoreBrowserEntry(): string {
  const firebaseFirestore = createRequire(import.meta.url).resolve('firebase/firestore');
  const nodeEntry = createRequire(firebaseFirestore).resolve('@firebase/firestore');
  return join(dirname(nodeEntry), 'index.esm.js');
}

export async function loadSdk(): Promise<Sdk> {
  const firestoreEntry = firestoreBrowserEntry();
  const app = (await import('firebase/app')) as FirebaseApp;
  const auth = (await import('firebase/auth')) as FirebaseAuth;
  const firestore = (await import(pathToFileURL(firestoreEntry).href)) as FirebaseFirestore;
  return { app, auth, firestore, firestoreEntry };
}
