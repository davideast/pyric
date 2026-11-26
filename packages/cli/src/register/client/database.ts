/** `firebase/database` in a Node process activated against a remote host (#1082): the served surface over the Node host. */
import './bootstrap.js';
import * as surface from '../../serve/entries/database-surface.js';
import { ensureRemoteServerAppSession } from './server-app-session.js';

export * from '../../serve/entries/database-surface.js';

export const getDatabase = ((...args: Parameters<typeof surface.getDatabase>) => {
  ensureRemoteServerAppSession(args[0]);
  return surface.getDatabase(...args);
}) as typeof surface.getDatabase;
