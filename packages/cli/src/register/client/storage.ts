/** `firebase/storage` in a Node process activated against a remote host (#1082): the served surface over the Node host. */
import './bootstrap.js';
import * as surface from '../../serve/entries/storage-surface.js';
import { ensureRemoteServerAppSession } from './server-app-session.js';

export * from '../../serve/entries/storage-surface.js';

export const getStorage = ((...args: Parameters<typeof surface.getStorage>) => {
  ensureRemoteServerAppSession(args[0]);
  return surface.getStorage(...args);
}) as typeof surface.getStorage;
