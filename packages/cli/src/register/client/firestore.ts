/** `firebase/firestore` in a Node process activated against a remote host (#1082): the served surface over the Node host. */
import './bootstrap.js';
import * as surface from '../../serve/entries/firestore-surface.js';
import { ensureRemoteServerAppSession } from './server-app-session.js';

export * from '../../serve/entries/firestore-surface.js';

export const getFirestore = ((...args: Parameters<typeof surface.getFirestore>) => {
  ensureRemoteServerAppSession(args[0]);
  return surface.getFirestore(...args);
}) as typeof surface.getFirestore;

export const initializeFirestore = ((...args: Parameters<typeof surface.initializeFirestore>) => {
  ensureRemoteServerAppSession(args[0]);
  return surface.initializeFirestore(...args);
}) as typeof surface.initializeFirestore;
